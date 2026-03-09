/**
 * Storage Abstraction Layer Interfaces
 *
 * Defines entity-specific storage contracts and the combined storage provider interface.
 * All methods are async. Implementations must not use fallback values for configuration.
 */

import type { SearchOptions, SearchResult } from '../repositories/interfaces.js';
import type {
  Thread,
  ThreadState,
  Assistant,
  Run,
  Cron,
  Item,
  SearchItem,
} from '../types/index.js';

// Re-export for convenience so consumers can import from storage
export type { SearchOptions, SearchResult };

/**
 * Store item type used by IStoreStorage.
 * Aligns with the Item type but uses a more generic name for the storage layer.
 */
export type StoreItem = Item;

/**
 * Thread storage interface.
 * Manages threads, their state, state history, and copy operations.
 */
export interface IThreadStorage {
  create(thread: Thread): Promise<Thread>;
  getById(threadId: string): Promise<Thread | null>;
  update(threadId: string, updates: Partial<Thread>): Promise<Thread | null>;
  delete(threadId: string): Promise<boolean>;
  search(options: SearchOptions, filters?: Record<string, unknown>): Promise<SearchResult<Thread>>;
  count(filters?: Record<string, unknown>): Promise<number>;

  // Thread-specific
  getState(threadId: string): Promise<ThreadState | null>;
  addState(threadId: string, state: ThreadState): Promise<void>;
  getStateHistory(threadId: string, limit?: number, before?: string): Promise<ThreadState[]>;
  copyThread(sourceId: string, targetId: string): Promise<Thread>;
}

/**
 * Assistant storage interface.
 * Manages assistants and their version history.
 */
export interface IAssistantStorage {
  create(assistant: Assistant): Promise<Assistant>;
  getById(assistantId: string): Promise<Assistant | null>;
  update(assistantId: string, updates: Partial<Assistant>): Promise<Assistant | null>;
  delete(assistantId: string): Promise<boolean>;
  search(options: SearchOptions, filters?: Record<string, unknown>): Promise<SearchResult<Assistant>>;
  count(filters?: Record<string, unknown>): Promise<number>;

  // Assistant-specific
  getVersions(assistantId: string, limit?: number, offset?: number): Promise<SearchResult<Assistant>>;
  addVersion(assistantId: string, version: Assistant): Promise<void>;
  setLatestVersion(assistantId: string, version: number): Promise<Assistant | null>;
}

/**
 * Run storage interface.
 * Manages runs and supports listing by thread.
 */
export interface IRunStorage {
  create(run: Run): Promise<Run>;
  getById(runId: string): Promise<Run | null>;
  update(runId: string, updates: Partial<Run>): Promise<Run | null>;
  delete(runId: string): Promise<boolean>;
  listByThreadId(threadId: string, options: SearchOptions): Promise<SearchResult<Run>>;
  count(filters?: Record<string, unknown>): Promise<number>;
}

/**
 * Cron storage interface.
 * Manages scheduled cron jobs.
 */
export interface ICronStorage {
  create(cron: Cron): Promise<Cron>;
  getById(cronId: string): Promise<Cron | null>;
  update(cronId: string, updates: Partial<Cron>): Promise<Cron | null>;
  delete(cronId: string): Promise<boolean>;
  search(options: SearchOptions, filters?: Record<string, unknown>): Promise<SearchResult<Cron>>;
  count(filters?: Record<string, unknown>): Promise<number>;
}

/**
 * Store (key-value) storage interface.
 * Hierarchical namespace-based key-value store with optional indexing and TTL.
 */
export interface IStoreStorage {
  putItem(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
    index?: boolean | string[],
    ttl?: number,
  ): Promise<StoreItem>;
  getItem(namespace: string[], key: string): Promise<StoreItem | null>;
  deleteItem(namespace: string[], key: string): Promise<boolean>;
  searchItems(
    namespacePrefix: string[],
    options: {
      filter?: Record<string, unknown>;
      limit?: number;
      offset?: number;
      query?: string;
    },
  ): Promise<SearchResult<SearchItem>>;
  listNamespaces(options: {
    prefix?: string[];
    suffix?: string[];
    maxDepth?: number;
    limit?: number;
    offset?: number;
  }): Promise<string[][]>;
}

/**
 * Combined storage provider interface.
 * Provides access to all entity-specific storage implementations
 * and lifecycle methods for initialization and cleanup.
 */
export interface IStorageProvider {
  readonly name: string;
  threads: IThreadStorage;
  assistants: IAssistantStorage;
  runs: IRunStorage;
  crons: ICronStorage;
  store: IStoreStorage;
  initialize(): Promise<void>;
  close(): Promise<void>;
}
