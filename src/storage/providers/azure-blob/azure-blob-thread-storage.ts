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

import type { ContainerClient } from '@azure/storage-blob';
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
  buildTags,
  applyFilters,
  sortItems,
  paginate,
} from './azure-blob-helpers.js';
import { resolveCreateArgs } from '../../compat.js';

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
    await uploadJson(this.containerClient, blobName, thread, tags);
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

    await uploadJsonWithEtag(this.containerClient, blobName, updated, existing.etag, tags);
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
    // List all thread blobs (they match {uuid}.json pattern at root level)
    const allBlobs = await listBlobsByPrefix(this.containerClient, '');
    const threadBlobs = allBlobs.filter(
      (b) => b.name.endsWith('.json') && !b.name.includes('_history/'),
    );

    // Download all threads
    const threads: Thread[] = [];
    for (const blob of threadBlobs) {
      const thread = await downloadJson<Thread>(this.containerClient, blob.name);
      if (thread) {
        threads.push(thread);
      }
    }

    // Apply metadata-based filters client-side
    const filtered = applyFilters(threads as unknown as Record<string, unknown>[], filters) as unknown as Thread[];

    // Apply sorting
    const sorted = sortItems(
      filtered as unknown as Record<string, unknown>[],
      options.sortBy,
      options.sortOrder,
    ) as unknown as Thread[];

    const total = sorted.length;

    // Apply pagination
    const items = paginate(sorted, options.offset, options.limit);

    return { items, total };
  }

  async count(filters?: Record<string, unknown>): Promise<number> {
    if (!filters || Object.keys(filters).length === 0) {
      // Count thread blobs by prefix enumeration
      const allBlobs = await listBlobsByPrefix(this.containerClient, '');
      return allBlobs.filter(
        (b) => b.name.endsWith('.json') && !b.name.includes('_history/'),
      ).length;
    }

    // With filters, must download and filter
    const result = await this.search({ limit: Number.MAX_SAFE_INTEGER, offset: 0 }, filters);
    return result.total;
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
    limit?: number,
    before?: string,
  ): Promise<ThreadState[]> {
    const prefix = `${threadId}_history/`;
    const blobs = await listBlobsByPrefix(this.containerClient, prefix);

    // Sort descending by name (ISO timestamp-based)
    blobs.sort((a, b) => b.name.localeCompare(a.name));

    // Download states
    const states: ThreadState[] = [];
    for (const blob of blobs) {
      const state = await downloadJson<ThreadState>(this.containerClient, blob.name);
      if (state) {
        // If 'before' is specified, filter to states created before that timestamp
        if (before && state.created_at >= before) {
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
