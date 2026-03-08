/**
 * StoreService
 *
 * Business logic layer for the hierarchical key-value store.
 * Delegates storage operations to StoreRepository.
 */

import {
  StoreRepository,
  type Item,
  type SearchItem,
  type StoreSearchOptions,
  type ListNamespacesOptions,
} from './store.repository.js';

export class StoreService {
  constructor(private readonly repository: StoreRepository) {}

  /**
   * Put (create or update) an item in the store.
   */
  async putItem(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
    index?: boolean | string[],
    ttl?: number
  ): Promise<Item> {
    return this.repository.putItem(namespace, key, value, index, ttl);
  }

  /**
   * Get a single item by namespace and key.
   * If refreshTtl is true, re-put the item to refresh its TTL (not yet implemented at repo level).
   */
  async getItem(
    namespace: string[],
    key: string,
    refreshTtl?: boolean
  ): Promise<Item | null> {
    const item = await this.repository.getItem(namespace, key);

    // refreshTtl would re-touch the item to extend its TTL.
    // Currently the repository does not expose a refreshTtl method,
    // so we re-put the item with the same value if it exists and refreshTtl is true.
    if (item && refreshTtl) {
      await this.repository.putItem(namespace, key, item.value);
    }

    return item;
  }

  /**
   * Delete an item by namespace and key.
   */
  async deleteItem(namespace: string[], key: string): Promise<void> {
    await this.repository.deleteItem(namespace, key);
  }

  /**
   * Search items under a namespace prefix with optional filtering, pagination, and query.
   */
  async searchItems(
    namespacePrefix: string[],
    options: StoreSearchOptions = {}
  ): Promise<{ items: SearchItem[]; total: number }> {
    return this.repository.searchItems(namespacePrefix, options);
  }

  /**
   * List distinct namespaces with optional prefix/suffix filtering, max depth, and pagination.
   */
  async listNamespaces(options: ListNamespacesOptions = {}): Promise<string[][]> {
    return this.repository.listNamespaces(options);
  }
}
