/**
 * Azure Blob Run Storage
 *
 * Stores runs in Azure Blob Storage with the following naming pattern:
 * - Thread-associated runs: {thread_id}/{run_id}.json (grouped by thread for listing)
 * - Stateless runs: stateless/{run_id}.json
 *
 * Blob index tags are used for: runId, threadId, status, assistantId.
 */

import type { ContainerClient } from '@azure/storage-blob';
import type { IRunStorage, SearchOptions, SearchResult } from '../../interfaces.js';
import type { Run } from '../../../types/index.js';
import {
  uploadJson,
  downloadJson,
  downloadJsonWithEtag,
  uploadJsonWithEtag,
  deleteBlob,
  listBlobsByPrefix,
  buildTags,
  applyFilters,
  sortItems,
  paginate,
} from './azure-blob-helpers.js';
import { resolveCreateArgs } from '../../compat.js';

/** Index blob that maps run_id to its blob path for direct lookup. */
interface RunIndex {
  [runId: string]: string;
}

export class AzureBlobRunStorage implements IRunStorage {
  private containerClient: ContainerClient;

  constructor(containerClient: ContainerClient) {
    this.containerClient = containerClient;
  }

  async create(runOrId: Run | string, maybeRun?: unknown): Promise<Run> {
    const run = resolveCreateArgs<Run>(runOrId, maybeRun);
    const blobName = this.buildBlobName(run);
    const tags = buildTags({
      runId: run.run_id,
      threadId: run.thread_id ?? 'stateless',
      status: run.status,
      assistantId: run.assistant_id,
    });
    await uploadJson(this.containerClient, blobName, run, tags);

    // Update the run index for direct lookup by run_id
    await this.updateIndex(run.run_id, blobName);

    return run;
  }

  async getById(runId: string): Promise<Run | null> {
    // Look up the blob path from the index
    const blobPath = await this.lookupIndex(runId);
    if (blobPath) {
      const run = await downloadJson<Run>(this.containerClient, blobPath);
      if (run) return run;
    }

    // Fallback: search in stateless directory
    const statelessPath = `stateless/${runId}.json`;
    return downloadJson<Run>(this.containerClient, statelessPath);
  }

  async update(runId: string, updates: Partial<Run>): Promise<Run | null> {
    // Look up the blob path
    const blobPath = await this.resolveBlobPath(runId);
    if (!blobPath) {
      return null;
    }

    const existing = await downloadJsonWithEtag<Run>(this.containerClient, blobPath);
    if (!existing) {
      return null;
    }

    const updated: Run = { ...existing.data, ...updates, updated_at: new Date().toISOString() };
    const tags = buildTags({
      runId: updated.run_id,
      threadId: updated.thread_id ?? 'stateless',
      status: updated.status,
      assistantId: updated.assistant_id,
    });

    await uploadJsonWithEtag(this.containerClient, blobPath, updated, existing.etag, tags);
    return updated;
  }

  async delete(runId: string): Promise<boolean> {
    const blobPath = await this.resolveBlobPath(runId);
    if (!blobPath) {
      return false;
    }

    const result = await deleteBlob(this.containerClient, blobPath);

    // Remove from index
    if (result) {
      await this.removeFromIndex(runId);
    }

    return result;
  }

  async listByThreadId(threadId: string, options: SearchOptions): Promise<SearchResult<Run>> {
    const prefix = `${threadId}/`;
    const blobs = await listBlobsByPrefix(this.containerClient, prefix);

    // Filter out non-run blobs (the prefix might match other patterns in shared containers)
    const runBlobs = blobs.filter((b) => b.name.endsWith('.json'));

    // Download all runs for this thread
    const runs: Run[] = [];
    for (const blob of runBlobs) {
      const run = await downloadJson<Run>(this.containerClient, blob.name);
      if (run) {
        runs.push(run);
      }
    }

    // Apply sorting
    const sorted = sortItems(
      runs as unknown as Record<string, unknown>[],
      options.sortBy,
      options.sortOrder,
    ) as unknown as Run[];

    const total = sorted.length;
    const items = paginate(sorted, options.offset, options.limit);

    return { items, total };
  }

  async count(filters?: Record<string, unknown>): Promise<number> {
    // List all blobs and count
    const allBlobs = await listBlobsByPrefix(this.containerClient, '');
    const runBlobs = allBlobs.filter(
      (b) => b.name.endsWith('.json') && b.name !== '_index.json',
    );

    if (!filters || Object.keys(filters).length === 0) {
      return runBlobs.length;
    }

    // With filters, download and filter
    const runs: Run[] = [];
    for (const blob of runBlobs) {
      const run = await downloadJson<Run>(this.containerClient, blob.name);
      if (run) {
        runs.push(run);
      }
    }

    const filtered = applyFilters(runs as unknown as Record<string, unknown>[], filters);
    return filtered.length;
  }

  /**
   * Build the blob name for a run based on whether it's thread-associated or stateless.
   */
  private buildBlobName(run: Run): string {
    if (run.thread_id) {
      return `${run.thread_id}/${run.run_id}.json`;
    }
    return `stateless/${run.run_id}.json`;
  }

  /**
   * Resolve the blob path for a run by checking the index, then falling back to search.
   */
  private async resolveBlobPath(runId: string): Promise<string | null> {
    // Check index first
    const indexPath = await this.lookupIndex(runId);
    if (indexPath) {
      return indexPath;
    }

    // Fallback: check stateless
    const statelessPath = `stateless/${runId}.json`;
    const statelessRun = await downloadJson<Run>(this.containerClient, statelessPath);
    if (statelessRun) {
      return statelessPath;
    }

    return null;
  }

  /**
   * Update the run index blob with a new run_id -> blob_path mapping.
   */
  private async updateIndex(runId: string, blobPath: string): Promise<void> {
    const indexBlobName = '_index.json';
    const existing = await downloadJson<RunIndex>(this.containerClient, indexBlobName);
    const index: RunIndex = existing ?? {};
    index[runId] = blobPath;
    await uploadJson(this.containerClient, indexBlobName, index);
  }

  /**
   * Look up a run's blob path from the index.
   */
  private async lookupIndex(runId: string): Promise<string | null> {
    const indexBlobName = '_index.json';
    const index = await downloadJson<RunIndex>(this.containerClient, indexBlobName);
    if (index && index[runId]) {
      return index[runId];
    }
    return null;
  }

  /**
   * Remove a run_id from the index.
   */
  private async removeFromIndex(runId: string): Promise<void> {
    const indexBlobName = '_index.json';
    const index = await downloadJson<RunIndex>(this.containerClient, indexBlobName);
    if (index && index[runId]) {
      delete index[runId];
      await uploadJson(this.containerClient, indexBlobName, index);
    }
  }
}
