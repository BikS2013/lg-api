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
   * Filter items by metadata. An item matches if every key in the filter exists
   * in item.metadata with a deep-equal value.
   *
   * Uses deepEqual (not `===`) so an object/array-valued metadata filter behaves
   * identically on the search path (this method) and the count path
   * (filterByFields). A prior shallow `===` made count and search disagree for
   * nested metadata values — same conceptual filter, two implementations.
   */
  protected filterByMetadata(items: T[], metadata: Record<string, unknown>): T[] {
    return items.filter((item) => {
      const itemMetadata = (item as any).metadata;
      if (!itemMetadata || typeof itemMetadata !== 'object') {
        return false;
      }
      return Object.entries(metadata).every(
        ([key, value]) => deepEqual(itemMetadata[key], value)
      );
    });
  }

  /**
   * Filter items by top-level fields using shallow equality.
   */
  /**
   * Filter items by top-level fields.
   *
   * A primitive filter value is matched with shallow equality on the item's
   * same-named field (e.g. `status`). An object-valued filter (e.g. a `metadata`
   * or canonical `values` state filter) is matched per-key against the item's
   * same-named object field: the item matches when every key in the filter object
   * is deep-equal to the corresponding key on the item. This keeps the `values`
   * state filter correct and applied BEFORE pagination (ADR-0002), without
   * downloading or projecting anything extra.
   */
  protected filterByFields(items: T[], filters: Record<string, unknown>): T[] {
    return items.filter((item) =>
      Object.entries(filters).every(([key, value]) => {
        const actual = (item as any)[key];
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          if (actual === null || typeof actual !== 'object') {
            // An empty object filter matches anything; a non-empty one cannot
            // match a missing/non-object field.
            return Object.keys(value as Record<string, unknown>).length === 0;
          }
          return Object.entries(value as Record<string, unknown>).every(
            ([k, v]) => deepEqual((actual as Record<string, unknown>)[k], v),
          );
        }
        return actual === value;
      }),
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

/**
 * Structural deep equality for object-valued filter matching (metadata/values).
 * Sufficient for JSON-shaped data (primitives, arrays, plain objects).
 */
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
