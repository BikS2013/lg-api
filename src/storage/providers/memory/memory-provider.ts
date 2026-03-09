/**
 * In-Memory Storage Provider
 *
 * Wraps the existing in-memory repository implementations into the
 * IStorageProvider abstraction. Each entity storage adapter delegates
 * to the corresponding repository class.
 *
 * NOTE: The existing repositories use their own inline types (with plain `string`
 * for status/enum fields) rather than the stricter TypeBox-derived types from
 * types/index.ts. This is documented as issue P1 in "Issues - Pending Items.md".
 * The adapters use type assertions to bridge this gap until P1 is resolved.
 */

import type {
  IStorageProvider,
  IThreadStorage,
  IAssistantStorage,
  IRunStorage,
  ICronStorage,
  IStoreStorage,
  StoreItem,
  SearchOptions,
  SearchResult,
} from '../../interfaces.js';
import type {
  Thread,
  ThreadState,
  Assistant,
  Run,
  Cron,
  SearchItem,
} from '../../../types/index.js';
import { ThreadsRepository } from '../../../modules/threads/threads.repository.js';
import type { Thread as RepoThread, ThreadState as RepoThreadState } from '../../../modules/threads/threads.repository.js';
import { AssistantsRepository } from '../../../modules/assistants/assistants.repository.js';
import type { Assistant as RepoAssistant } from '../../../modules/assistants/assistants.repository.js';
import { RunsRepository } from '../../../modules/runs/runs.repository.js';
import type { Run as RepoRun } from '../../../modules/runs/runs.repository.js';
import { CronsRepository } from '../../../modules/crons/crons.repository.js';
import type { Cron as RepoCron } from '../../../modules/crons/crons.repository.js';
import { StoreRepository } from '../../../modules/store/store.repository.js';

// ---------------------------------------------------------------------------
// Thread Storage Adapter
// ---------------------------------------------------------------------------

class MemoryThreadStorage implements IThreadStorage {
  private repo: ThreadsRepository;

  constructor(repo: ThreadsRepository) {
    this.repo = repo;
  }

  async create(thread: Thread): Promise<Thread> {
    const result = await this.repo.create(thread.thread_id, thread as unknown as RepoThread);
    return result as unknown as Thread;
  }

  async getById(threadId: string): Promise<Thread | null> {
    const result = await this.repo.getById(threadId);
    return result as unknown as Thread | null;
  }

  async update(threadId: string, updates: Partial<Thread>): Promise<Thread | null> {
    const result = await this.repo.update(threadId, updates as Partial<RepoThread>);
    return result as unknown as Thread | null;
  }

  async delete(threadId: string): Promise<boolean> {
    return this.repo.delete(threadId);
  }

  async search(
    options: SearchOptions,
    filters?: Record<string, unknown>,
  ): Promise<SearchResult<Thread>> {
    const result = await this.repo.search(options, filters);
    return result as unknown as SearchResult<Thread>;
  }

  async count(filters?: Record<string, unknown>): Promise<number> {
    return this.repo.count(filters);
  }

  async getState(threadId: string): Promise<ThreadState | null> {
    const result = await this.repo.getState(threadId);
    return result as unknown as ThreadState | null;
  }

  async addState(threadId: string, state: ThreadState): Promise<void> {
    return this.repo.addState(threadId, state as unknown as RepoThreadState);
  }

  async getStateHistory(threadId: string, limit?: number, before?: string): Promise<ThreadState[]> {
    // The existing repo uses SearchOptions for getStateHistory.
    // We adapt the simplified interface (limit, before) to it.
    const options: SearchOptions = {
      limit: limit ?? 100,
      offset: 0,
      sortOrder: 'desc',
    };

    const result = await this.repo.getStateHistory(threadId, options);
    const items = result.items as unknown as ThreadState[];

    // If 'before' is specified, filter to states created before that timestamp
    if (before) {
      return items.filter((s) => s.created_at < before);
    }

    return items;
  }

  async copyThread(sourceId: string, targetId: string): Promise<Thread> {
    const copied = await this.repo.copyThread(sourceId, targetId);
    if (!copied) {
      throw new Error(`Thread not found: ${sourceId}`);
    }
    return copied as unknown as Thread;
  }
}

// ---------------------------------------------------------------------------
// Assistant Storage Adapter
// ---------------------------------------------------------------------------

class MemoryAssistantStorage implements IAssistantStorage {
  private repo: AssistantsRepository;

  constructor(repo: AssistantsRepository) {
    this.repo = repo;
  }

  async create(assistant: Assistant): Promise<Assistant> {
    const result = await this.repo.create(
      assistant.assistant_id,
      assistant as unknown as RepoAssistant,
    );
    return result as unknown as Assistant;
  }

  async getById(assistantId: string): Promise<Assistant | null> {
    const result = await this.repo.getById(assistantId);
    return result as unknown as Assistant | null;
  }

  async update(assistantId: string, updates: Partial<Assistant>): Promise<Assistant | null> {
    const result = await this.repo.update(assistantId, updates as Partial<RepoAssistant>);
    return result as unknown as Assistant | null;
  }

  async delete(assistantId: string): Promise<boolean> {
    return this.repo.delete(assistantId);
  }

  async search(
    options: SearchOptions,
    filters?: Record<string, unknown>,
  ): Promise<SearchResult<Assistant>> {
    const result = await this.repo.search(options, filters);
    return result as unknown as SearchResult<Assistant>;
  }

  async count(filters?: Record<string, unknown>): Promise<number> {
    return this.repo.count(filters);
  }

  async getVersions(
    assistantId: string,
    limit?: number,
    offset?: number,
  ): Promise<SearchResult<Assistant>> {
    const allVersions = await this.repo.getVersions(assistantId);
    const total = allVersions.length;
    const start = offset ?? 0;
    const end = limit !== undefined ? start + limit : undefined;
    const items = allVersions.slice(start, end) as unknown as Assistant[];
    return { items, total };
  }

  async addVersion(assistantId: string, version: Assistant): Promise<void> {
    return this.repo.addVersion(assistantId, version as unknown as RepoAssistant);
  }

  async setLatestVersion(assistantId: string, version: number): Promise<Assistant | null> {
    const result = await this.repo.setLatestVersion(assistantId, version);
    return result as unknown as Assistant | null;
  }
}

// ---------------------------------------------------------------------------
// Run Storage Adapter
// ---------------------------------------------------------------------------

class MemoryRunStorage implements IRunStorage {
  private repo: RunsRepository;

  constructor(repo: RunsRepository) {
    this.repo = repo;
  }

  async create(run: Run): Promise<Run> {
    const result = await this.repo.create(run.run_id, run as unknown as RepoRun);
    return result as unknown as Run;
  }

  async getById(runId: string): Promise<Run | null> {
    const result = await this.repo.getById(runId);
    return result as unknown as Run | null;
  }

  async update(runId: string, updates: Partial<Run>): Promise<Run | null> {
    const result = await this.repo.update(runId, updates as Partial<RepoRun>);
    return result as unknown as Run | null;
  }

  async delete(runId: string): Promise<boolean> {
    return this.repo.delete(runId);
  }

  async listByThreadId(threadId: string, options: SearchOptions): Promise<SearchResult<Run>> {
    const result = await this.repo.listByThreadId(threadId, options);
    return result as unknown as SearchResult<Run>;
  }

  async count(filters?: Record<string, unknown>): Promise<number> {
    return this.repo.count(filters);
  }
}

// ---------------------------------------------------------------------------
// Cron Storage Adapter
// ---------------------------------------------------------------------------

class MemoryCronStorage implements ICronStorage {
  private repo: CronsRepository;

  constructor(repo: CronsRepository) {
    this.repo = repo;
  }

  async create(cron: Cron): Promise<Cron> {
    const result = await this.repo.create(cron.cron_id, cron as unknown as RepoCron);
    return result as unknown as Cron;
  }

  async getById(cronId: string): Promise<Cron | null> {
    const result = await this.repo.getById(cronId);
    return result as unknown as Cron | null;
  }

  async update(cronId: string, updates: Partial<Cron>): Promise<Cron | null> {
    const result = await this.repo.update(cronId, updates as Partial<RepoCron>);
    return result as unknown as Cron | null;
  }

  async delete(cronId: string): Promise<boolean> {
    return this.repo.delete(cronId);
  }

  async search(
    options: SearchOptions,
    filters?: Record<string, unknown>,
  ): Promise<SearchResult<Cron>> {
    const result = await this.repo.search(options, filters);
    return result as unknown as SearchResult<Cron>;
  }

  async count(filters?: Record<string, unknown>): Promise<number> {
    return this.repo.count(filters);
  }
}

// ---------------------------------------------------------------------------
// Store Storage Adapter
// ---------------------------------------------------------------------------

class MemoryStoreStorage implements IStoreStorage {
  private repo: StoreRepository;

  constructor(repo: StoreRepository) {
    this.repo = repo;
  }

  async putItem(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
    index?: boolean | string[],
    ttl?: number,
  ): Promise<StoreItem> {
    return this.repo.putItem(namespace, key, value, index, ttl);
  }

  async getItem(namespace: string[], key: string): Promise<StoreItem | null> {
    return this.repo.getItem(namespace, key);
  }

  async deleteItem(namespace: string[], key: string): Promise<boolean> {
    return this.repo.deleteItem(namespace, key);
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
    return this.repo.searchItems(namespacePrefix, options);
  }

  async listNamespaces(options: {
    prefix?: string[];
    suffix?: string[];
    maxDepth?: number;
    limit?: number;
    offset?: number;
  }): Promise<string[][]> {
    return this.repo.listNamespaces(options);
  }
}

// ---------------------------------------------------------------------------
// In-Memory Storage Provider
// ---------------------------------------------------------------------------

export class InMemoryStorageProvider implements IStorageProvider {
  readonly name = 'memory';

  threads: IThreadStorage;
  assistants: IAssistantStorage;
  runs: IRunStorage;
  crons: ICronStorage;
  store: IStoreStorage;

  constructor() {
    this.threads = new MemoryThreadStorage(new ThreadsRepository());
    this.assistants = new MemoryAssistantStorage(new AssistantsRepository());
    this.runs = new MemoryRunStorage(new RunsRepository());
    this.crons = new MemoryCronStorage(new CronsRepository());
    this.store = new MemoryStoreStorage(new StoreRepository());
  }

  async initialize(): Promise<void> {
    // No initialization needed for in-memory storage
  }

  async close(): Promise<void> {
    // No cleanup needed for in-memory storage
  }
}
