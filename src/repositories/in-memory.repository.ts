/**
 * InMemoryRepository<T>
 *
 * Generic in-memory implementation of IRepository using Map<string, T>.
 * Supports metadata filtering (shallow match), sorting by any string field,
 * and pagination with limit/offset.
 */

import type { IRepository, SearchOptions, SearchResult } from './interfaces.js';

export class InMemoryRepository<T extends Record<string, any>> implements IRepository<T> {
  protected store: Map<string, T> = new Map();

  async create(id: string, item: T): Promise<T> {
    this.store.set(id, structuredClone(item));
    return structuredClone(item);
  }

  async getById(id: string): Promise<T | null> {
    const item = this.store.get(id);
    return item ? structuredClone(item) : null;
  }

  async update(id: string, updates: Partial<T>): Promise<T | null> {
    const existing = this.store.get(id);
    if (!existing) {
      return null;
    }
    const updated = { ...existing, ...updates } as T;
    this.store.set(id, structuredClone(updated));
    return structuredClone(updated);
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  async search(options: SearchOptions, filters?: Record<string, unknown>): Promise<SearchResult<T>> {
    let items = Array.from(this.store.values());

    // Apply metadata filtering (shallow match)
    if (options.metadata) {
      items = this.filterByMetadata(items, options.metadata);
    }

    // Apply additional filters (shallow match on top-level fields)
    if (filters) {
      items = this.filterByFields(items, filters);
    }

    const total = items.length;

    // Apply sorting
    if (options.sortBy) {
      items = this.sortItems(items, options.sortBy, options.sortOrder ?? 'asc');
    }

    // Apply pagination
    items = items.slice(options.offset, options.offset + options.limit);

    return {
      items: items.map((item) => structuredClone(item)),
      total,
    };
  }

  async count(filters?: Record<string, unknown>): Promise<number> {
    if (!filters) {
      return this.store.size;
    }
    const items = this.filterByFields(Array.from(this.store.values()), filters);
    return items.length;
  }

  async list(options: SearchOptions): Promise<SearchResult<T>> {
    return this.search(options);
  }

  /**
   * Filter items by metadata using shallow matching.
   * An item matches if every key in the filter exists in item.metadata with the same value.
   */
  protected filterByMetadata(items: T[], metadata: Record<string, unknown>): T[] {
    return items.filter((item) => {
      const itemMetadata = (item as any).metadata;
      if (!itemMetadata || typeof itemMetadata !== 'object') {
        return false;
      }
      return Object.entries(metadata).every(
        ([key, value]) => itemMetadata[key] === value
      );
    });
  }

  /**
   * Filter items by top-level fields using shallow equality.
   */
  protected filterByFields(items: T[], filters: Record<string, unknown>): T[] {
    return items.filter((item) =>
      Object.entries(filters).every(([key, value]) => (item as any)[key] === value)
    );
  }

  /**
   * Sort items by a given field name.
   */
  protected sortItems(items: T[], sortBy: string, sortOrder: 'asc' | 'desc'): T[] {
    return [...items].sort((a, b) => {
      const aVal = (a as any)[sortBy];
      const bVal = (b as any)[sortBy];

      if (aVal === bVal) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;

      const comparison = aVal < bVal ? -1 : 1;
      return sortOrder === 'asc' ? comparison : -comparison;
    });
  }
}
