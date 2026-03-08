/**
 * StoreRepository
 *
 * Does NOT extend InMemoryRepository — uses a composite key structure
 * (namespace + key) for a hierarchical key-value store.
 */

import type { SearchResult } from '../../repositories/interfaces.js';

/** An item stored in the Store. */
export interface Item {
  namespace: string[];
  key: string;
  value: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** An item returned from search, with optional score. */
export interface SearchItem extends Item {
  score?: number;
}

/** Internal storage entry with optional indexing and TTL metadata. */
interface StorageEntry {
  item: Item;
  indexed: boolean;
  indexFields?: string[];
  expiresAt?: number; // Unix timestamp in ms
}

export interface StoreSearchOptions {
  filter?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  query?: string;
}

export interface ListNamespacesOptions {
  prefix?: string[];
  suffix?: string[];
  maxDepth?: number;
  limit?: number;
  offset?: number;
}

export class StoreRepository {
  /** Map with composite key (namespace joined by '.' + ':' + key) -> StorageEntry */
  private store: Map<string, StorageEntry> = new Map();

  /**
   * Build a composite key from namespace array and key string.
   */
  private buildCompositeKey(namespace: string[], key: string): string {
    return `${namespace.join('.')}:${key}`;
  }

  /**
   * Put (create or update) an item.
   */
  async putItem(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
    index?: boolean | string[],
    ttl?: number
  ): Promise<Item> {
    const compositeKey = this.buildCompositeKey(namespace, key);
    const now = new Date().toISOString();
    const existing = this.store.get(compositeKey);

    const item: Item = {
      namespace: [...namespace],
      key,
      value: structuredClone(value),
      created_at: existing?.item.created_at ?? now,
      updated_at: now,
    };

    const entry: StorageEntry = {
      item: structuredClone(item),
      indexed: Array.isArray(index) ? true : (index ?? false),
      indexFields: Array.isArray(index) ? [...index] : undefined,
      expiresAt: ttl ? Date.now() + ttl * 1000 : undefined,
    };

    this.store.set(compositeKey, entry);
    return structuredClone(item);
  }

  /**
   * Get a single item by namespace and key.
   */
  async getItem(namespace: string[], key: string): Promise<Item | null> {
    const compositeKey = this.buildCompositeKey(namespace, key);
    const entry = this.store.get(compositeKey);
    if (!entry) {
      return null;
    }

    // Check TTL expiration
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(compositeKey);
      return null;
    }

    return structuredClone(entry.item);
  }

  /**
   * Delete an item by namespace and key.
   */
  async deleteItem(namespace: string[], key: string): Promise<boolean> {
    const compositeKey = this.buildCompositeKey(namespace, key);
    return this.store.delete(compositeKey);
  }

  /**
   * Search items under a namespace prefix, with optional filter, pagination, and query.
   */
  async searchItems(
    namespacePrefix: string[],
    options: StoreSearchOptions = {}
  ): Promise<SearchResult<SearchItem>> {
    const { filter, limit = 10, offset = 0, query } = options;
    const prefixStr = namespacePrefix.join('.');

    // Collect non-expired items matching the namespace prefix
    const matchingItems: SearchItem[] = [];

    for (const [compositeKey, entry] of this.store.entries()) {
      // Check TTL expiration
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        this.store.delete(compositeKey);
        continue;
      }

      const itemNsStr = entry.item.namespace.join('.');

      // Match if item namespace starts with the prefix (or prefix is empty)
      if (prefixStr.length > 0 && !itemNsStr.startsWith(prefixStr)) {
        continue;
      }

      // Apply filter (shallow match on item value)
      if (filter) {
        const matches = Object.entries(filter).every(
          ([k, v]) => entry.item.value[k] === v
        );
        if (!matches) {
          continue;
        }
      }

      const searchItem: SearchItem = {
        ...structuredClone(entry.item),
      };

      // Basic text search on value fields (simple substring match)
      if (query) {
        const valueStr = JSON.stringify(entry.item.value).toLowerCase();
        if (!valueStr.includes(query.toLowerCase())) {
          continue;
        }
        // Assign a basic relevance score (1.0 for match)
        searchItem.score = 1.0;
      }

      matchingItems.push(searchItem);
    }

    const total = matchingItems.length;
    const items = matchingItems.slice(offset, offset + limit);

    return { items, total };
  }

  /**
   * List distinct namespaces, optionally filtered by prefix, suffix, and maxDepth.
   */
  async listNamespaces(options: ListNamespacesOptions = {}): Promise<string[][]> {
    const { prefix, suffix, maxDepth, limit = 100, offset = 0 } = options;

    // Collect all unique namespaces
    const namespaceSet = new Set<string>();

    for (const [, entry] of this.store.entries()) {
      // Check TTL expiration
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        continue;
      }

      const ns = entry.item.namespace;

      // Apply prefix filter
      if (prefix && prefix.length > 0) {
        const matches = prefix.every((part, i) => ns[i] === part);
        if (!matches) {
          continue;
        }
      }

      // Apply suffix filter
      if (suffix && suffix.length > 0) {
        const nsEnd = ns.slice(-suffix.length);
        const matches = suffix.every((part, i) => nsEnd[i] === part);
        if (!matches) {
          continue;
        }
      }

      // Apply maxDepth — truncate namespace to maxDepth components
      if (maxDepth !== undefined && maxDepth > 0) {
        const truncated = ns.slice(0, maxDepth);
        namespaceSet.add(truncated.join('.'));
      } else {
        namespaceSet.add(ns.join('.'));
      }
    }

    // Convert back to arrays, sort, and paginate
    const allNamespaces = Array.from(namespaceSet)
      .sort()
      .map((nsStr) => nsStr.split('.'));

    return allNamespaces.slice(offset, offset + limit);
  }
}
