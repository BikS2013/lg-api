/**
 * Azure Blob Assistant Storage
 *
 * Stores assistants in Azure Blob Storage with the following naming pattern:
 * - Current assistant: {assistant_id}/current.json
 * - Version history: {assistant_id}/versions/{version}.json
 *
 * Blob index tags are used for server-side search on: assistantId, graphId, name.
 */

import type { ContainerClient } from '@azure/storage-blob';
import type { IAssistantStorage, SearchOptions, SearchResult } from '../../interfaces.js';
import type { Assistant } from '../../../types/index.js';
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

export class AzureBlobAssistantStorage implements IAssistantStorage {
  private containerClient: ContainerClient;

  constructor(containerClient: ContainerClient) {
    this.containerClient = containerClient;
  }

  async create(assistantOrId: Assistant | string, maybeAssistant?: unknown): Promise<Assistant> {
    const assistant = resolveCreateArgs<Assistant>(assistantOrId, maybeAssistant);
    const blobName = `${assistant.assistant_id}/current.json`;
    const tags = buildTags({
      assistantId: assistant.assistant_id,
      graphId: assistant.graph_id,
      name: assistant.name,
    });
    await uploadJson(this.containerClient, blobName, assistant, tags);
    return assistant;
  }

  async getById(assistantId: string): Promise<Assistant | null> {
    const blobName = `${assistantId}/current.json`;
    return downloadJson<Assistant>(this.containerClient, blobName);
  }

  async update(assistantId: string, updates: Partial<Assistant>): Promise<Assistant | null> {
    const blobName = `${assistantId}/current.json`;
    const existing = await downloadJsonWithEtag<Assistant>(this.containerClient, blobName);
    if (!existing) {
      return null;
    }

    const updated: Assistant = { ...existing.data, ...updates, updated_at: new Date().toISOString() };
    const tags = buildTags({
      assistantId: updated.assistant_id,
      graphId: updated.graph_id,
      name: updated.name,
    });

    await uploadJsonWithEtag(this.containerClient, blobName, updated, existing.etag, tags);
    return updated;
  }

  async delete(assistantId: string): Promise<boolean> {
    // Delete the current blob and all version blobs
    const prefix = `${assistantId}/`;
    const count = await deleteBlobsByPrefix(this.containerClient, prefix);
    return count > 0;
  }

  async search(
    options: SearchOptions,
    filters?: Record<string, unknown>,
  ): Promise<SearchResult<Assistant>> {
    // List all current assistant blobs
    const allBlobs = await listBlobsByPrefix(this.containerClient, '');
    const assistantBlobs = allBlobs.filter((b) => b.name.endsWith('/current.json'));

    // Download all assistants, skipping invalid/corrupt blobs
    const assistants: Assistant[] = [];
    for (const blob of assistantBlobs) {
      const assistant = await downloadJson<Assistant>(this.containerClient, blob.name);
      if (assistant && typeof assistant === 'object' && assistant.assistant_id) {
        assistants.push(assistant);
      }
    }

    // Apply filters client-side
    const filtered = applyFilters(
      assistants as unknown as Record<string, unknown>[],
      filters,
    ) as unknown as Assistant[];

    // Apply sorting
    const sorted = sortItems(
      filtered as unknown as Record<string, unknown>[],
      options.sortBy,
      options.sortOrder,
    ) as unknown as Assistant[];

    const total = sorted.length;
    const items = paginate(sorted, options.offset, options.limit);

    return { items, total };
  }

  async count(filters?: Record<string, unknown>): Promise<number> {
    if (!filters || Object.keys(filters).length === 0) {
      const allBlobs = await listBlobsByPrefix(this.containerClient, '');
      return allBlobs.filter((b) => b.name.endsWith('/current.json')).length;
    }

    const result = await this.search({ limit: Number.MAX_SAFE_INTEGER, offset: 0 }, filters);
    return result.total;
  }

  async getVersions(
    assistantId: string,
    limit?: number,
    offset?: number,
  ): Promise<SearchResult<Assistant>> {
    const prefix = `${assistantId}/versions/`;
    const blobs = await listBlobsByPrefix(this.containerClient, prefix);

    // Sort by blob name (version number) descending
    blobs.sort((a, b) => {
      const versionA = this.extractVersion(a.name);
      const versionB = this.extractVersion(b.name);
      return versionB - versionA;
    });

    // Download all versions
    const versions: Assistant[] = [];
    for (const blob of blobs) {
      const version = await downloadJson<Assistant>(this.containerClient, blob.name);
      if (version) {
        versions.push(version);
      }
    }

    const total = versions.length;
    const start = offset ?? 0;
    const end = limit !== undefined ? start + limit : undefined;
    const items = versions.slice(start, end);

    return { items, total };
  }

  async addVersion(assistantId: string, version: Assistant): Promise<void> {
    const versionNum = version.version ?? 1;
    const blobName = `${assistantId}/versions/${versionNum}.json`;
    await uploadJson(this.containerClient, blobName, version);
  }

  async setLatestVersion(assistantId: string, version: number): Promise<Assistant | null> {
    // Download the requested version
    const versionBlobName = `${assistantId}/versions/${version}.json`;
    const versionData = await downloadJson<Assistant>(this.containerClient, versionBlobName);
    if (!versionData) {
      return null;
    }

    // Download the current blob with etag for optimistic concurrency
    const currentBlobName = `${assistantId}/current.json`;
    const existing = await downloadJsonWithEtag<Assistant>(this.containerClient, currentBlobName);
    if (!existing) {
      return null;
    }

    // Update current to match the requested version
    const updated: Assistant = { ...versionData, updated_at: new Date().toISOString() };
    const tags = buildTags({
      assistantId: updated.assistant_id,
      graphId: updated.graph_id,
      name: updated.name,
    });

    await uploadJsonWithEtag(this.containerClient, currentBlobName, updated, existing.etag, tags);
    return updated;
  }

  /**
   * Extract version number from a version blob name like "{id}/versions/3.json".
   */
  private extractVersion(blobName: string): number {
    const match = blobName.match(/\/versions\/(\d+)\.json$/);
    return match ? parseInt(match[1], 10) : 0;
  }
}
