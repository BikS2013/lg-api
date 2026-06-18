/**
 * Repository Layer Interfaces
 *
 * Defines the generic repository contract used by all domain-specific repositories.
 * All methods are async and return Promises for future-proofing (e.g., swapping to a real DB).
 */

export interface SearchOptions {
  limit: number;
  offset: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  metadata?: Record<string, unknown>;
  /**
   * Canonical `select` field list (ThreadSelectField[]). Threaded through to
   * storage providers so a provider can decide whether expensive state fields
   * must be materialized (e.g. azure-blob skips body downloads when only
   * metadata is requested). The final wire projection is still applied by the
   * service layer so all providers return an identical row shape. See ADR-0002.
   */
  select?: string[];
}

export interface SearchResult<T> {
  items: T[];
  total: number;
}

export interface IRepository<T> {
  create(id: string, item: T): Promise<T>;
  getById(id: string): Promise<T | null>;
  update(id: string, updates: Partial<T>): Promise<T | null>;
  delete(id: string): Promise<boolean>;
  search(options: SearchOptions, filters?: Record<string, unknown>): Promise<SearchResult<T>>;
  count(filters?: Record<string, unknown>): Promise<number>;
  list(options: SearchOptions): Promise<SearchResult<T>>;
}
