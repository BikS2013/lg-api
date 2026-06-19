/**
 * Azure Blob Thread Storage
 *
 * Stores threads in Azure Blob Storage with a flat naming pattern:
 * - Thread data: {thread_id}.json
 * - Thread state history: {thread_id}_history/{ISO-timestamp}.json
 *
 * This flat structure keeps all thread files in the same virtual directory,
 * enabling sorting by creation/update timestamp and efficient enumeration.
 *
 * Blob index tags are used for server-side search on: threadId, status, createdDate, updatedDate.
 * Complex metadata queries fall back to client-side filtering.
 */

import type { BlobItem, ContainerClient } from '@azure/storage-blob';
import type { IThreadStorage, SearchOptions, SearchResult } from '../../interfaces.js';
import type { Thread, ThreadState } from '../../../types/index.js';
import {
  uploadJson,
  downloadJson,
  downloadJsonWithEtag,
  uploadJsonWithEtag,
  deleteBlob,
  deleteBlobsByPrefix,
  listBlobsByPrefix,
  listBlobsByPrefixWithTags,
  mapWithConcurrency,
  buildTags,
  applyFilters,
  sortItems,
  paginate,
} from './azure-blob-helpers.js';
import { resolveCreateArgs } from '../../compat.js';
import { selectIncludesState } from '../../../modules/threads/thread-projection.js';
import { ApiError } from '../../../errors/api-error.js';

/** Blob-metadata key carrying the thread's status (Azure metadata values are strings). */
const META_STATUS = 'threadstatus';
/** Blob-metadata key carrying the thread's JSON-encoded `metadata` object. */
const META_METADATA = 'threadmetadata';
/** Blob-metadata keys for timestamps, mirrored from tags for row assembly. */
const META_CREATED_AT = 'threadcreatedat';
const META_UPDATED_AT = 'threadupdatedat';

/**
 * Max simultaneous blob-body downloads in the legacy-recovery and page-hydration
 * paths. Bounds the worst case (a listing over blobs written before metadata
 * persistence) to seconds without flooding the storage account with hundreds of
 * concurrent requests.
 */
const RECOVERY_CONCURRENCY = 32;

/**
 * Azure caps the TOTAL custom metadata on a blob (all names + values) at 8 KiB,
 * and metadata travels as HTTP headers (ASCII). A thread write must NEVER fail
 * because of metadata, so we (a) ASCII-escape the JSON value and (b) if the bag
 * would still exceed the cap, persist NO metadata at all rather than letting the
 * upload 400. Keep headroom under the hard 8192 limit.
 */
const MAX_BLOB_METADATA_BYTES = 8000;

/**
 * JSON.stringify with every non-ASCII code unit escaped to \uXXXX, so the value
 * is always valid ASCII for an Azure metadata (HTTP header) value and still
 * round-trips through JSON.parse. (JSON.stringify alone leaves non-ASCII as-is.)
 */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value ?? {}).replace(
    /[\u0080-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

/**
 * Build the Azure blob-metadata bag persisted alongside each thread blob so that
 * search()/count() can reconstruct metadata-only rows from a listing without
 * downloading the (large) body. See ADR-0002.
 *
 * Returns an EMPTY bag when the thread's `metadata` is too large to fit Azure's
 * 8 KiB metadata cap — the caller then writes the blob with no custom metadata,
 * the write succeeds, and search recovers this one thread via a body download
 * (blobToThread() returns null on a missing bag). This is the guarantee that a
 * normal thread create/update/run-turn can never fail on account of metadata.
 */
export function buildThreadMetadata(thread: Thread): Record<string, string> {
  const bag: Record<string, string> = {
    [META_STATUS]: thread.status,
    [META_METADATA]: asciiJson(thread.metadata ?? {}),
    [META_CREATED_AT]: thread.created_at,
    [META_UPDATED_AT]: thread.updated_at,
  };
  const bytes = Object.entries(bag).reduce(
    (n, [k, v]) => n + k.length + Buffer.byteLength(v, 'utf8'),
    0,
  );
  if (bytes > MAX_BLOB_METADATA_BYTES) {
    // Never fail the write — drop the bag; this thread is served via body recovery.
    console.warn(
      `[azure-blob-thread-storage] thread ${thread.thread_id} metadata is ${bytes}B ` +
        `(> ${MAX_BLOB_METADATA_BYTES}B cap); persisting blob without queryable metadata ` +
        `(search will recover it from the body).`,
    );
    return {};
  }
  return bag;
}

/**
 * Reconstruct a metadata-only Thread (no `values`/`interrupts`) from a listed
 * blob's name + persisted blob-metadata. Returns null when the blob predates the
 * metadata-persistence change (no `threadstatus`), signalling the caller to fall
 * back to a single-blob body download for that legacy blob only.
 */
function blobToThread(blob: BlobItem): Thread | null {
  const meta = blob.metadata;
  if (!meta || meta[META_STATUS] === undefined) {
    return null;
  }
  const threadId = blob.name.replace(/\.json$/, '');
  let metadata: Record<string, unknown> = {};
  if (meta[META_METADATA] !== undefined) {
    try {
      metadata = JSON.parse(meta[META_METADATA]) as Record<string, unknown>;
    } catch (error) {
      // Corrupt metadata blob entry — log and fall back to an empty object
      // rather than failing the whole listing.
      console.error(
        `[azure-blob-thread-storage] failed to parse ${META_METADATA} for blob ${blob.name}:`,
        error,
      );
    }
  }
  return {
    thread_id: threadId,
    created_at: meta[META_CREATED_AT] ?? blob.properties.createdOn?.toISOString() ?? '',
    updated_at: meta[META_UPDATED_AT] ?? blob.properties.lastModified?.toISOString() ?? '',
    metadata,
    status: meta[META_STATUS] as Thread['status'],
  };
}

/**
 * Nested key-value match for the `metadata` filter: a thread matches when every
 * key in the filter is deep-equal to the corresponding key on the thread's
 * metadata. Mirrors the in-memory/sql provider semantics so behavior is
 * provider-agnostic.
 */
function matchesMetadataFilter(
  metadata: Record<string, unknown> | undefined,
  filter: Record<string, unknown>,
): boolean {
  const m = metadata ?? {};
  return Object.entries(filter).every(([key, expected]) => deepEqual(m[key], expected));
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => deepEqual(aObj[k], bObj[k]));
}

export class AzureBlobThreadStorage implements IThreadStorage {
  private containerClient: ContainerClient;

  constructor(containerClient: ContainerClient) {
    this.containerClient = containerClient;
  }

  async create(threadOrId: Thread | string, maybeThread?: unknown): Promise<Thread> {
    const thread = resolveCreateArgs<Thread>(threadOrId, maybeThread);
    const blobName = `${thread.thread_id}.json`;
    const tags = buildTags({
      threadId: thread.thread_id,
      status: thread.status,
      createdDate: thread.created_at,
      updatedDate: thread.updated_at,
    });
    // Persist queryable fields as blob metadata so search()/count() can build
    // metadata-only rows from a listing WITHOUT downloading the (large) body.
    // See ADR-0002 and buildThreadMetadata.
    await uploadJson(this.containerClient, blobName, thread, tags, buildThreadMetadata(thread));
    return thread;
  }

  async getById(threadId: string): Promise<Thread | null> {
    const blobName = `${threadId}.json`;
    return downloadJson<Thread>(this.containerClient, blobName);
  }

  async update(threadId: string, updates: Partial<Thread>): Promise<Thread | null> {
    const blobName = `${threadId}.json`;
    const existing = await downloadJsonWithEtag<Thread>(this.containerClient, blobName);
    if (!existing) {
      return null;
    }

    const updated: Thread = { ...existing.data, ...updates, updated_at: new Date().toISOString() };
    const tags = buildTags({
      threadId: updated.thread_id,
      status: updated.status,
      createdDate: updated.created_at,
      updatedDate: updated.updated_at,
    });

    // Re-persist queryable blob metadata on every update so a listing reflects
    // the current status/metadata without a body download (ADR-0002).
    await uploadJsonWithEtag(
      this.containerClient,
      blobName,
      updated,
      existing.etag,
      tags,
      buildThreadMetadata(updated),
    );
    return updated;
  }

  async delete(threadId: string): Promise<boolean> {
    // Delete the thread blob
    const threadDeleted = await deleteBlob(this.containerClient, `${threadId}.json`);
    // Delete all associated history blobs
    const historyCount = await deleteBlobsByPrefix(this.containerClient, `${threadId}_history/`);
    return threadDeleted || historyCount > 0;
  }

  async search(
    options: SearchOptions,
    filters?: Record<string, unknown>,
  ): Promise<SearchResult<Thread>> {
    // The canonical `values` state filter cannot be satisfied on azure-blob
    // without downloading every thread body (a full-container scan — exactly the
    // hang ADR-0002 fixes). Reject it explicitly rather than silently ignoring or
    // re-introducing the scan. Open follow-up in ADR-0002: support via a body
    // download of an already-bounded candidate set.
    if (filters && filters.values !== undefined) {
      throw new ApiError(
        501,
        'The `values` state filter is not supported on the azure-blob storage backend',
        'Filtering threads by graph state would require downloading every thread body. Filter by `metadata`/`status` instead, or fetch state via GET /threads/{thread_id}/state.',
      );
    }

    // List thread blobs WITH their tags and metadata — no body download. This is
    // the page-bounded path: we build the matched set from name + blob-metadata +
    // tags, paginate, and only THEN download bodies for the page if state was
    // requested via `select` (ADR-0002).
    const allBlobs = await listBlobsByPrefixWithTags(this.containerClient, '');
    const threadBlobs = allBlobs.filter(
      (b) => b.name.endsWith('.json') && !b.name.includes('_history/'),
    );

    // Assemble metadata-only rows from blob metadata/tags. Blobs predating the
    // metadata-persistence change carry no thread metadata; recover those (and
    // only those) by downloading their own body, with bounded concurrency so the
    // listing finishes in seconds — never an unconditional sequential
    // full-container scan. These legacy blobs self-heal on their next update()
    // (which writes the metadata bag); new threads are born with it.
    const rows: Thread[] = [];
    const legacyBlobs: BlobItem[] = [];
    for (const blob of threadBlobs) {
      const row = blobToThread(blob);
      if (row === null) {
        legacyBlobs.push(blob);
      } else {
        rows.push(row);
      }
    }
    if (legacyBlobs.length > 0) {
      const recovered = await mapWithConcurrency(legacyBlobs, RECOVERY_CONCURRENCY, (blob) =>
        downloadJson<Thread>(this.containerClient, blob.name),
      );
      for (const body of recovered) {
        if (body) rows.push(body);
      }
    }

    // Apply the `status` filter (shallow top-level match) against the assembled
    // metadata-only rows. `options.metadata` is a nested key-value filter applied
    // separately below — both run before pagination so the page/total are
    // correct (ADR-0002).
    let filtered = applyFilters(
      rows as unknown as Record<string, unknown>[],
      filters,
    ) as unknown as Thread[];

    if (options.metadata && Object.keys(options.metadata).length > 0) {
      filtered = filtered.filter((t) =>
        matchesMetadataFilter(t.metadata, options.metadata!),
      );
    }

    // Sort, then total, then paginate to the page — BEFORE any body download.
    const sorted = sortItems(
      filtered as unknown as Record<string, unknown>[],
      options.sortBy,
      options.sortOrder,
    ) as unknown as Thread[];

    const total = sorted.length;
    const page = paginate(sorted, options.offset, options.limit);

    // Only now, and only if the caller opted into state via `select`, download
    // the page's bodies (≤ limit blobs) to materialize `values`/`interrupts`.
    if (selectIncludesState(options.select)) {
      const hydrated = await mapWithConcurrency(page, RECOVERY_CONCURRENCY, async (row) => {
        const body = await downloadJson<Thread>(this.containerClient, `${row.thread_id}.json`);
        return body ?? row;
      });
      return { items: hydrated, total };
    }

    return { items: page, total };
  }

  async count(filters?: Record<string, unknown>): Promise<number> {
    if (filters && filters.values !== undefined) {
      throw new ApiError(
        501,
        'The `values` state filter is not supported on the azure-blob storage backend',
        'Counting threads by graph state would require downloading every thread body. Filter by `metadata`/`status` instead.',
      );
    }

    if (!filters || Object.keys(filters).length === 0) {
      // Count thread blobs by prefix enumeration (no body download).
      const allBlobs = await listBlobsByPrefix(this.containerClient, '');
      return allBlobs.filter(
        (b) => b.name.endsWith('.json') && !b.name.includes('_history/'),
      ).length;
    }

    // With filters, count from blob metadata/tags — NOT from a body scan. The
    // `metadata` object filter and `status` are both resolvable from the listing.
    const allBlobs = await listBlobsByPrefixWithTags(this.containerClient, '');
    const threadBlobs = allBlobs.filter(
      (b) => b.name.endsWith('.json') && !b.name.includes('_history/'),
    );

    const statusFilter = typeof filters.status === 'string' ? filters.status : undefined;
    const metadataFilter =
      filters.metadata && typeof filters.metadata === 'object'
        ? (filters.metadata as Record<string, unknown>)
        : undefined;

    // Assemble rows from metadata; recover legacy blobs (no metadata) in
    // bounded-parallel rather than a sequential full scan. See search().
    const rows: Thread[] = [];
    const legacyBlobs: BlobItem[] = [];
    for (const blob of threadBlobs) {
      const row = blobToThread(blob);
      if (row === null) {
        legacyBlobs.push(blob);
      } else {
        rows.push(row);
      }
    }
    if (legacyBlobs.length > 0) {
      const recovered = await mapWithConcurrency(legacyBlobs, RECOVERY_CONCURRENCY, (blob) =>
        downloadJson<Thread>(this.containerClient, blob.name),
      );
      for (const body of recovered) {
        if (body) rows.push(body);
      }
    }

    return rows.filter((row) => {
      if (statusFilter !== undefined && row.status !== statusFilter) return false;
      if (metadataFilter && !matchesMetadataFilter(row.metadata, metadataFilter)) return false;
      return true;
    }).length;
  }

  async getState(threadId: string): Promise<ThreadState | null> {
    // Get the latest state from history
    const prefix = `${threadId}_history/`;
    const blobs = await listBlobsByPrefix(this.containerClient, prefix);

    if (blobs.length === 0) {
      return null;
    }

    // Sort by blob name descending (ISO timestamp names sort lexicographically)
    blobs.sort((a, b) => b.name.localeCompare(a.name));

    // Download the latest
    return downloadJson<ThreadState>(this.containerClient, blobs[0].name);
  }

  async addState(threadId: string, state: ThreadState): Promise<void> {
    const timestamp = state.created_at ?? new Date().toISOString();
    // Replace colons in the timestamp to make it a valid blob name
    const safeName = timestamp.replace(/:/g, '-');
    const blobName = `${threadId}_history/${safeName}.json`;
    await uploadJson(this.containerClient, blobName, state);
  }

  async getStateHistory(
    threadId: string,
    options?: { limit?: number; before?: string; metadata?: Record<string, unknown> },
  ): Promise<ThreadState[]> {
    const prefix = `${threadId}_history/`;
    const blobs = await listBlobsByPrefix(this.containerClient, prefix);

    // Sort descending by name (ISO timestamp-based)
    blobs.sort((a, b) => b.name.localeCompare(a.name));

    const limit = options?.limit;
    const before = options?.before;
    const metadata = options?.metadata;

    // Download states
    const states: ThreadState[] = [];
    for (const blob of blobs) {
      const state = await downloadJson<ThreadState>(this.containerClient, blob.name);
      if (state) {
        if (before && state.created_at >= before) {
          continue;
        }
        if (metadata && !Object.entries(metadata).every(([k, v]) =>
          (state.metadata as Record<string, unknown>)?.[k] === v,
        )) {
          continue;
        }
        states.push(state);
        if (limit !== undefined && states.length >= limit) {
          break;
        }
      }
    }

    return states;
  }

  async copyThread(sourceId: string, targetId: string): Promise<Thread> {
    // Download the source thread
    const sourceThread = await downloadJson<Thread>(this.containerClient, `${sourceId}.json`);
    if (!sourceThread) {
      throw new Error(`Thread not found: ${sourceId}`);
    }

    // Create a copy with the target thread ID
    const now = new Date().toISOString();
    const copiedThread: Thread = {
      ...sourceThread,
      thread_id: targetId,
      created_at: now,
      updated_at: now,
    };

    // Upload the copied thread
    await this.create(copiedThread);

    // Copy all state history blobs
    const sourcePrefix = `${sourceId}_history/`;
    const historyBlobs = await listBlobsByPrefix(this.containerClient, sourcePrefix);

    for (const blob of historyBlobs) {
      const state = await downloadJson<ThreadState>(this.containerClient, blob.name);
      if (state) {
        // Replace source prefix with target prefix in blob name
        const targetBlobName = blob.name.replace(sourcePrefix, `${targetId}_history/`);
        await uploadJson(this.containerClient, targetBlobName, state);
      }
    }

    return copiedThread;
  }
}
