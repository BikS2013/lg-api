/**
 * Azure Blob Run Storage
 *
 * Stores runs in Azure Blob Storage with the following naming pattern:
 * - Thread-associated runs: {thread_id}/{run_id}.json (grouped by thread for listing)
 * - Stateless runs: stateless/{run_id}.json
 *
 * Blob index tags are used for: runId, threadId, status, assistantId.
 *
 * runId -> blob path resolution uses per-run pointer blobs under the `_lookup/`
 * prefix (one tiny blob per run, written once at create, deleted at delete,
 * never mutated). This replaces a historical shared `_index.json` whose
 * read-modify-write semantics dropped entries under concurrent creates.
 *
 * Clean cutover: the legacy `_index.json` is neither read nor written by this
 * provider. Runs created by the previous code exist only in that old index, so
 * they are not reachable by id after this change; fresh deployments are
 * unaffected. (Back-filling `_lookup/` pointers from existing run blobs is
 * straightforward but intentionally out of scope here.)
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
    // Order matters: write the run blob first, the lookup pointer second.
    // If the lookup write fails, the run blob still exists at its canonical
    // path (a pointer can be re-derived from it later if needed).
    // The reverse asymmetry (lookup exists, run blob missing) cannot arise:
    // an upload failure on the run blob throws before the lookup write runs.
    await uploadJson(this.containerClient, blobName, run, tags);
    await this.writeLookup(run.run_id, blobName);
    return run;
  }

  async getById(runId: string): Promise<Run | null> {
    // Primary path: per-run pointer blob written by create().
    const blobPath = await this.lookupBlobPath(runId);
    if (blobPath) {
      const run = await downloadJson<Run>(this.containerClient, blobPath);
      if (run) return run;
    }

    // Deterministic stateless path: stateless runs always live at
    // stateless/{run_id}.json — no pointer indirection needed.
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

    if (result) {
      // Best-effort cleanup of the lookup pointer. deleteBlob is idempotent
      // (returns false on 404), so a missing lookup blob — e.g., a run created
      // by the OLD code path that never wrote one — is a no-op.
      await this.deleteLookup(runId);
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
    // Fast path: an unfiltered count is exactly the number of per-run lookup
    // pointers. Each run writes exactly one `_lookup/{run_id}.json` at create and
    // removes it at delete, so the `_lookup/` prefix is a 1:1 census of runs
    // reachable by id. Enumerating that prefix lists ~half the blobs that listing
    // the whole container would (a run blob *and* a pointer exist per run), and it
    // is consistent with getById: a run with no pointer is not reachable by id and
    // is not counted.
    if (!filters || Object.keys(filters).length === 0) {
      const pointers = await listBlobsByPrefix(this.containerClient, '_lookup/');
      return pointers.length;
    }

    // Filtered counts need run contents, so enumerate the run blobs themselves —
    // everything except the lookup pointers and any orphan `_index.json` left by
    // an older deployment — then download and apply the filters.
    const allBlobs = await listBlobsByPrefix(this.containerClient, '');
    const runBlobs = allBlobs.filter(
      (b) =>
        b.name.endsWith('.json') &&
        b.name !== '_index.json' &&
        !b.name.startsWith('_lookup/'),
    );

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
   * Resolve the blob path for a run by reading its per-run lookup pointer,
   * then falling back to the deterministic stateless path.
   */
  private async resolveBlobPath(runId: string): Promise<string | null> {
    // Primary: per-run lookup pointer.
    const pointerPath = await this.lookupBlobPath(runId);
    if (pointerPath) {
      return pointerPath;
    }

    // Fallback: deterministic stateless path.
    const statelessPath = `stateless/${runId}.json`;
    const statelessRun = await downloadJson<Run>(this.containerClient, statelessPath);
    if (statelessRun) {
      return statelessPath;
    }

    return null;
  }

  /**
   * Build the canonical lookup blob path for a given run_id.
   *
   * Lookup blobs live under the `_lookup/` prefix in the runs container and
   * each contains a single field — `{ "path": "<canonical run blob path>" }`.
   * They are written once at create() time, deleted once at delete() time,
   * and never mutated in between.
   */
  private lookupBlobName(runId: string): string {
    return `_lookup/${runId}.json`;
  }

  /**
   * Write the per-run lookup pointer blob.
   *
   * Unconditional single-writer PUT to a unique blob name — no read-modify-write,
   * no shared key, no race. Replaces the historical `updateIndex()`.
   */
  private async writeLookup(runId: string, blobPath: string): Promise<void> {
    await uploadJson(this.containerClient, this.lookupBlobName(runId), { path: blobPath });
  }

  /**
   * Read the per-run lookup pointer blob and return the run blob's path.
   *
   * Returns null if the lookup blob does not exist — the signal for a
   * never-existed run, or for a run created by the previous code (which wrote
   * no pointer; see the clean-cutover note in the file header).
   */
  private async lookupBlobPath(runId: string): Promise<string | null> {
    const pointer = await downloadJson<{ path: string }>(
      this.containerClient,
      this.lookupBlobName(runId),
    );
    return pointer?.path ?? null;
  }

  /**
   * Delete the per-run lookup pointer blob.
   *
   * `deleteBlob` is idempotent (returns false on 404), so a missing pointer
   * is a no-op.
   */
  private async deleteLookup(runId: string): Promise<void> {
    await deleteBlob(this.containerClient, this.lookupBlobName(runId));
  }
}
