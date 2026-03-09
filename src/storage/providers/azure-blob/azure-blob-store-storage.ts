/**
 * Azure Blob Store (Key-Value) Storage
 *
 * Implements hierarchical namespace-based key-value storage in Azure Blob:
 * - Each item: {namespace-joined-by-slash}/{key}.json
 * - Namespace listing via blob prefix enumeration
 *
 * Blob index tags: namespace (dot-joined), key.
 */

import type { ContainerClient } from '@azure/storage-blob';
import type { IStoreStorage, StoreItem, SearchResult } from '../../interfaces.js';
import type { SearchItem } from '../../../types/index.js';
import {
  uploadJson,
  downloadJson,
  deleteBlob,
  listBlobsByPrefix,
  buildTags,
} from './azure-blob-helpers.js';

/**
 * Internal representation of a store item as persisted in blob storage.
 * Includes the TTL expiration timestamp for lifecycle management.
 */
interface PersistedStoreItem {
  namespace: string[];
  key: string;
  value: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  expires_at?: string;
}

export class AzureBlobStoreStorage implements IStoreStorage {
  private containerClient: ContainerClient;

  constructor(containerClient: ContainerClient) {
    this.containerClient = containerClient;
  }

  async putItem(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
    index?: boolean | string[],
    ttl?: number,
  ): Promise<StoreItem> {
    const blobName = this.buildBlobName(namespace, key);
    const now = new Date().toISOString();

    const persisted: PersistedStoreItem = {
      namespace,
      key,
      value,
      created_at: now,
      updated_at: now,
    };

    // If TTL is specified, compute the expiration timestamp
    if (ttl !== undefined && ttl > 0) {
      const expiresAt = new Date(Date.now() + ttl * 1000);
      persisted.expires_at = expiresAt.toISOString();
    }

    // Check if item already exists (preserve created_at)
    const existing = await downloadJson<PersistedStoreItem>(this.containerClient, blobName);
    if (existing) {
      persisted.created_at = existing.created_at;
    }

    const tags = buildTags({
      namespace: namespace.join('.'),
      key,
    });

    await uploadJson(this.containerClient, blobName, persisted, tags);

    return {
      namespace,
      key,
      value,
      created_at: persisted.created_at,
      updated_at: persisted.updated_at,
    } as StoreItem;
  }

  async getItem(namespace: string[], key: string): Promise<StoreItem | null> {
    const blobName = this.buildBlobName(namespace, key);
    const persisted = await downloadJson<PersistedStoreItem>(this.containerClient, blobName);

    if (!persisted) {
      return null;
    }

    // Check TTL expiration
    if (persisted.expires_at && new Date(persisted.expires_at) <= new Date()) {
      // Item has expired; delete it and return null
      await deleteBlob(this.containerClient, blobName);
      return null;
    }

    return {
      namespace: persisted.namespace,
      key: persisted.key,
      value: persisted.value,
      created_at: persisted.created_at,
      updated_at: persisted.updated_at,
    } as StoreItem;
  }

  async deleteItem(namespace: string[], key: string): Promise<boolean> {
    const blobName = this.buildBlobName(namespace, key);
    return deleteBlob(this.containerClient, blobName);
  }

  async searchItems(
    namespacePrefix: string[],
    options: {
      filter?: Record<string, unknown>;
      limit?: number;
      offset?: number;
      query?: string;
    },
  ): Promise<SearchResult<SearchItem>> {
    const prefix = namespacePrefix.length > 0 ? namespacePrefix.join('/') + '/' : '';
    const blobs = await listBlobsByPrefix(this.containerClient, prefix);

    const items: SearchItem[] = [];
    const now = new Date();

    for (const blob of blobs) {
      if (!blob.name.endsWith('.json')) continue;

      const persisted = await downloadJson<PersistedStoreItem>(this.containerClient, blob.name);
      if (!persisted) continue;

      // Skip expired items
      if (persisted.expires_at && new Date(persisted.expires_at) <= now) {
        // Clean up expired item asynchronously (fire-and-forget)
        deleteBlob(this.containerClient, blob.name).catch(() => {
          // Ignore cleanup errors
        });
        continue;
      }

      // Apply value-level filters
      if (options.filter) {
        let matches = true;
        for (const [filterKey, filterValue] of Object.entries(options.filter)) {
          if (persisted.value[filterKey] !== filterValue) {
            matches = false;
            break;
          }
        }
        if (!matches) continue;
      }

      // Apply text query search (simple substring match on values)
      if (options.query) {
        const valueStr = JSON.stringify(persisted.value).toLowerCase();
        if (!valueStr.includes(options.query.toLowerCase())) {
          continue;
        }
      }

      items.push({
        namespace: persisted.namespace,
        key: persisted.key,
        value: persisted.value,
        created_at: persisted.created_at,
        updated_at: persisted.updated_at,
      } as SearchItem);
    }

    const total = items.length;
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 10;
    const paginatedItems = items.slice(offset, offset + limit);

    return { items: paginatedItems, total };
  }

  async listNamespaces(options: {
    prefix?: string[];
    suffix?: string[];
    maxDepth?: number;
    limit?: number;
    offset?: number;
  }): Promise<string[][]> {
    const searchPrefix = options.prefix ? options.prefix.join('/') + '/' : '';
    const blobs = await listBlobsByPrefix(this.containerClient, searchPrefix);

    // Extract unique namespaces from blob paths
    const namespaceSet = new Set<string>();

    for (const blob of blobs) {
      if (!blob.name.endsWith('.json')) continue;

      const persisted = await downloadJson<PersistedStoreItem>(this.containerClient, blob.name);
      if (!persisted) continue;

      // Skip expired items
      if (persisted.expires_at && new Date(persisted.expires_at) <= new Date()) continue;

      const ns = persisted.namespace;
      const nsKey = JSON.stringify(ns);
      namespaceSet.add(nsKey);
    }

    let namespaces = Array.from(namespaceSet).map((nsKey) => JSON.parse(nsKey) as string[]);

    // Apply suffix filter
    if (options.suffix && options.suffix.length > 0) {
      namespaces = namespaces.filter((ns) => {
        if (ns.length < options.suffix!.length) return false;
        const nsSuffix = ns.slice(ns.length - options.suffix!.length);
        return nsSuffix.every((part, idx) => part === options.suffix![idx]);
      });
    }

    // Apply maxDepth filter
    if (options.maxDepth !== undefined) {
      const baseDepth = options.prefix ? options.prefix.length : 0;
      namespaces = namespaces.filter((ns) => ns.length <= baseDepth + options.maxDepth!);
    }

    // Sort for deterministic output
    namespaces.sort((a, b) => a.join('/').localeCompare(b.join('/')));

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 100;
    return namespaces.slice(offset, offset + limit);
  }

  /**
   * Build the blob name from namespace and key.
   * Namespace parts are joined with '/', and the key is appended with .json extension.
   *
   * Example: namespace=["user", "123"], key="prefs" -> "user/123/prefs.json"
   */
  private buildBlobName(namespace: string[], key: string): string {
    const nsPart = namespace.join('/');
    return nsPart ? `${nsPart}/${key}.json` : `${key}.json`;
  }
}
