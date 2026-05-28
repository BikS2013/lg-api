#!/usr/bin/env -S npx tsx
/**
 * Azure Blob Run Index Migration — F1
 *
 * One-time migration that walks every run blob in the Azure Blob runs
 * container and writes a per-run lookup pointer blob at `_lookup/{run_id}.json`.
 * This restores runId-by-id reachability for runs created by the pre-A1 code
 * path (the shared `_index.json`) under the new clean-cutover provider, which
 * no longer reads or writes `_index.json`.
 *
 * IMPORTANT: deployments with pre-A1 data MUST run this script BEFORE deploying
 * the new provider. Under the clean cutover there is no transitional read of
 * `_index.json`; pre-existing stateful runs whose pointers are not migrated
 * will not be reachable by id.
 *
 * Spec:          artifacts/specs/f1-runs-index-fix.md
 * Investigation: artifacts/research/2026-05-28-lg-api-azure-blob-multi-user-concurrency.md
 *
 * Properties:
 *   - Idempotent. A second run only touches blobs that don't already have a
 *     lookup pointer; everything else is skipped.
 *   - Read-only on existing run blobs and on `_index.json`. The legacy index
 *     is preserved (deletion is a future release / operator decision).
 *   - Exits 0 on success, 1 on any error.
 *
 * Usage:
 *   npx tsx scripts/migrate-azure-blob-run-index.ts
 *
 * Requirements:
 *   - storage-config.yaml configured with `provider: azure-blob` and reachable
 *     credentials (the same configuration the lg-api server uses).
 *   - All ${ENV_VAR} references in storage-config.yaml must be set.
 *
 * The script exits without doing anything if the configured provider is not
 * `azure-blob` — there is no migration to perform for memory / sqlite /
 * sqlserver providers.
 */

import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { loadStorageConfig } from '../src/storage/yaml-config-loader.js';
import type { AzureBlobConfig } from '../src/storage/config.js';
import {
  uploadJson,
  downloadJson,
  isNotFoundError,
} from '../src/storage/providers/azure-blob/azure-blob-helpers.js';

const RUNS_CONTAINER_SUFFIX = 'runs';
const LOOKUP_PREFIX = '_lookup/';
const LEGACY_INDEX_BLOB = '_index.json';

/**
 * Build a BlobServiceClient from the AzureBlobConfig using the same auth
 * priority as the production provider (managed identity > SAS > conn string).
 */
function createBlobServiceClient(config: AzureBlobConfig): BlobServiceClient {
  if (config.useManagedIdentity) {
    if (!config.accountName) {
      throw new Error(
        'Azure Blob configuration error: "accountName" is required when "useManagedIdentity" is true.',
      );
    }
    const accountUrl = `https://${config.accountName}.blob.core.windows.net`;
    return new BlobServiceClient(accountUrl, new DefaultAzureCredential());
  }

  if (config.sasToken) {
    if (!config.accountName) {
      throw new Error(
        'Azure Blob configuration error: "accountName" is required when using "sasToken".',
      );
    }
    const sas = config.sasToken.startsWith('?') ? config.sasToken : `?${config.sasToken}`;
    const accountUrl = `https://${config.accountName}.blob.core.windows.net${sas}`;
    return new BlobServiceClient(accountUrl);
  }

  if (config.connectionString) {
    return BlobServiceClient.fromConnectionString(config.connectionString);
  }

  throw new Error(
    'Azure Blob configuration error: no valid authentication method configured. ' +
    'Provide "connectionString", "sasToken" with "accountName", or set "useManagedIdentity" to true with "accountName".',
  );
}

/**
 * Determine whether a blob name represents a run blob that should be
 * migrated. We skip:
 *   - the legacy index blob (kept for transitional reads),
 *   - all existing lookup pointer blobs (don't recurse),
 *   - non-JSON blobs (defensive — every entity stored here is JSON today).
 */
function isMigratableRunBlob(name: string): boolean {
  if (!name.endsWith('.json')) return false;
  if (name === LEGACY_INDEX_BLOB) return false;
  if (name.startsWith(LOOKUP_PREFIX)) return false;
  return true;
}

/**
 * Try to read the run_id from a run blob's JSON content. We use the in-blob
 * field rather than parsing the blob name because the blob name format
 * (`{thread_id}/{run_id}.json` vs `stateless/{run_id}.json`) is contractual
 * but the JSON's `run_id` field is the authoritative identity.
 */
async function extractRunId(
  container: ContainerClient,
  blobName: string,
): Promise<string | null> {
  const data = await downloadJson<{ run_id?: unknown }>(container, blobName);
  if (!data || typeof data.run_id !== 'string' || data.run_id === '') {
    return null;
  }
  return data.run_id;
}

/**
 * Check whether a lookup blob already exists for this run_id. Used for
 * idempotency — a re-run of the script does not overwrite existing pointers.
 */
async function lookupExists(
  container: ContainerClient,
  runId: string,
): Promise<boolean> {
  const blockClient = container.getBlockBlobClient(`${LOOKUP_PREFIX}${runId}.json`);
  try {
    const props = await blockClient.getProperties();
    return props !== undefined;
  } catch (error: unknown) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('[migrate-azure-blob-run-index] Loading storage config...');
  const config = loadStorageConfig();

  if (config.provider !== 'azure-blob') {
    // eslint-disable-next-line no-console
    console.log(
      `[migrate-azure-blob-run-index] Provider is "${config.provider}" — no migration needed. Exiting.`,
    );
    return;
  }

  const azureConfig = config.azureBlob;
  if (!azureConfig) {
    throw new Error(
      'Storage config has provider "azure-blob" but no azureBlob section was resolved.',
    );
  }
  if (!azureConfig.containerPrefix) {
    throw new Error(
      'Azure Blob configuration error: "containerPrefix" is required. No fallback value is permitted.',
    );
  }

  const blobServiceClient = createBlobServiceClient(azureConfig);
  const containerName = `${azureConfig.containerPrefix}-${RUNS_CONTAINER_SUFFIX}`;
  const container = blobServiceClient.getContainerClient(containerName);

  // eslint-disable-next-line no-console
  console.log(
    `[migrate-azure-blob-run-index] Scanning container "${containerName}" for run blobs...`,
  );

  let scanned = 0;
  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for await (const blob of container.listBlobsFlat()) {
    if (!isMigratableRunBlob(blob.name)) {
      continue;
    }
    scanned++;

    try {
      const runId = await extractRunId(container, blob.name);
      if (!runId) {
        // eslint-disable-next-line no-console
        console.warn(
          `[migrate-azure-blob-run-index] Skipping "${blob.name}" — no parseable run_id in blob content.`,
        );
        errors++;
        continue;
      }

      if (await lookupExists(container, runId)) {
        skipped++;
        continue;
      }

      await uploadJson(
        container,
        `${LOOKUP_PREFIX}${runId}.json`,
        { path: blob.name },
      );
      migrated++;

      if (migrated % 100 === 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[migrate-azure-blob-run-index] Progress: ${migrated} migrated, ${skipped} skipped, ${errors} errors (${scanned} scanned).`,
        );
      }
    } catch (error: unknown) {
      errors++;
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(
        `[migrate-azure-blob-run-index] Error processing "${blob.name}": ${message}`,
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[migrate-azure-blob-run-index] Done. [migrated ${migrated} runs] [skipped ${skipped} already-migrated] [errors ${errors}] [scanned ${scanned}]`,
  );

  if (errors > 0) {
    throw new Error(`Migration completed with ${errors} error(s).`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`[migrate-azure-blob-run-index] FAILED: ${message}`);
  process.exit(1);
});
