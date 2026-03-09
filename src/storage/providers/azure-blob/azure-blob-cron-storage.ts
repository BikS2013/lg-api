/**
 * Azure Blob Cron Storage
 *
 * Stores cron jobs in Azure Blob Storage with a flat naming pattern:
 * - Each cron: {cron_id}.json
 *
 * Blob index tags are used for: cronId, assistantId, threadId.
 */

import type { ContainerClient } from '@azure/storage-blob';
import type { ICronStorage, SearchOptions, SearchResult } from '../../interfaces.js';
import type { Cron } from '../../../types/index.js';
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

export class AzureBlobCronStorage implements ICronStorage {
  private containerClient: ContainerClient;

  constructor(containerClient: ContainerClient) {
    this.containerClient = containerClient;
  }

  async create(cron: Cron): Promise<Cron> {
    const blobName = `${cron.cron_id}.json`;
    const tags = buildTags({
      cronId: cron.cron_id,
      assistantId: cron.assistant_id,
      threadId: cron.thread_id ?? '',
    });
    await uploadJson(this.containerClient, blobName, cron, tags);
    return cron;
  }

  async getById(cronId: string): Promise<Cron | null> {
    const blobName = `${cronId}.json`;
    return downloadJson<Cron>(this.containerClient, blobName);
  }

  async update(cronId: string, updates: Partial<Cron>): Promise<Cron | null> {
    const blobName = `${cronId}.json`;
    const existing = await downloadJsonWithEtag<Cron>(this.containerClient, blobName);
    if (!existing) {
      return null;
    }

    const updated: Cron = { ...existing.data, ...updates, updated_at: new Date().toISOString() };
    const tags = buildTags({
      cronId: updated.cron_id,
      assistantId: updated.assistant_id,
      threadId: updated.thread_id ?? '',
    });

    await uploadJsonWithEtag(this.containerClient, blobName, updated, existing.etag, tags);
    return updated;
  }

  async delete(cronId: string): Promise<boolean> {
    const blobName = `${cronId}.json`;
    return deleteBlob(this.containerClient, blobName);
  }

  async search(
    options: SearchOptions,
    filters?: Record<string, unknown>,
  ): Promise<SearchResult<Cron>> {
    // List all cron blobs
    const allBlobs = await listBlobsByPrefix(this.containerClient, '');
    const cronBlobs = allBlobs.filter((b) => b.name.endsWith('.json'));

    // Download all crons
    const crons: Cron[] = [];
    for (const blob of cronBlobs) {
      const cron = await downloadJson<Cron>(this.containerClient, blob.name);
      if (cron) {
        crons.push(cron);
      }
    }

    // Apply filters client-side
    const filtered = applyFilters(
      crons as unknown as Record<string, unknown>[],
      filters,
    ) as unknown as Cron[];

    // Apply sorting
    const sorted = sortItems(
      filtered as unknown as Record<string, unknown>[],
      options.sortBy,
      options.sortOrder,
    ) as unknown as Cron[];

    const total = sorted.length;
    const items = paginate(sorted, options.offset, options.limit);

    return { items, total };
  }

  async count(filters?: Record<string, unknown>): Promise<number> {
    if (!filters || Object.keys(filters).length === 0) {
      const allBlobs = await listBlobsByPrefix(this.containerClient, '');
      return allBlobs.filter((b) => b.name.endsWith('.json')).length;
    }

    const result = await this.search({ limit: Number.MAX_SAFE_INTEGER, offset: 0 }, filters);
    return result.total;
  }
}
