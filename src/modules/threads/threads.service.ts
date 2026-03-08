/**
 * ThreadsService
 *
 * Business logic for the Threads API.
 * Delegates persistence to ThreadsRepository.
 */

import type { ThreadsRepository, Thread, ThreadState } from './threads.repository.js';
import type { SearchOptions, SearchResult } from '../../repositories/interfaces.js';
import { ApiError } from '../../errors/api-error.js';
import { generateId } from '../../utils/uuid.util.js';
import { nowISO } from '../../utils/date.util.js';

export interface CreateThreadParams {
  metadata?: Record<string, unknown>;
  thread_id?: string;
  if_exists?: 'raise' | 'do_nothing' | 'update';
  supersteps?: number;
  graph_id?: string;
  ttl?: { strategy?: string; seconds?: number; at?: string };
}

export interface UpdateThreadParams {
  metadata?: Record<string, unknown>;
  ttl?: { strategy?: string; seconds?: number; at?: string };
}

export interface SearchThreadsParams {
  metadata?: Record<string, unknown>;
  values?: Record<string, unknown>;
  ids?: string[];
  status?: string;
  limit?: number;
  offset?: number;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  select?: string[];
  extract?: string[];
}

export interface CountThreadsParams {
  metadata?: Record<string, unknown>;
  values?: Record<string, unknown>;
  status?: string;
}

export interface UpdateThreadStateParams {
  values: Record<string, unknown>;
  as_node?: string;
  checkpoint?: {
    thread_id: string;
    checkpoint_ns: string;
    checkpoint_id: string;
    checkpoint_map?: Record<string, string>;
  };
  checkpoint_id?: string;
}

export interface ThreadHistoryParams {
  limit?: number;
  before?: string;
  metadata?: Record<string, unknown>;
  checkpoint?: {
    thread_id: string;
    checkpoint_ns: string;
    checkpoint_id: string;
    checkpoint_map?: Record<string, string>;
  };
}

export interface PruneThreadsParams {
  thread_ids?: string[];
  strategy?: 'delete' | 'archive';
}

export class ThreadsService {
  constructor(private readonly repository: ThreadsRepository) {}

  /**
   * Create a new thread. Handles if_exists logic:
   * - raise (default): throw 409 if thread_id already exists
   * - do_nothing: return existing thread unchanged
   * - update: update the existing thread with the provided fields
   */
  async create(params: CreateThreadParams): Promise<Thread> {
    const id = params.thread_id ?? generateId();
    const now = nowISO();

    // Check for existing thread
    const existing = await this.repository.getById(id);

    if (existing) {
      const ifExists = params.if_exists ?? 'raise';

      if (ifExists === 'raise') {
        throw new ApiError(409, `Thread ${id} already exists`);
      }

      if (ifExists === 'do_nothing') {
        return existing;
      }

      // ifExists === 'update'
      const updates: Partial<Thread> = {
        updated_at: now,
      };
      if (params.metadata !== undefined) updates.metadata = params.metadata;

      const updated = await this.repository.update(id, updates);
      if (!updated) {
        throw new ApiError(404, `Thread ${id} not found`);
      }

      return updated;
    }

    // Create new thread
    const thread: Thread = {
      thread_id: id,
      created_at: now,
      updated_at: now,
      metadata: params.metadata ?? {},
      status: 'idle',
      values: {},
    };

    return this.repository.create(id, thread);
  }

  /**
   * Get a thread by ID.
   */
  async get(threadId: string): Promise<Thread> {
    const thread = await this.repository.getById(threadId);
    if (!thread) {
      throw new ApiError(404, `Thread ${threadId} not found`);
    }
    return thread;
  }

  /**
   * Update an existing thread.
   */
  async update(threadId: string, params: UpdateThreadParams): Promise<Thread> {
    const existing = await this.repository.getById(threadId);
    if (!existing) {
      throw new ApiError(404, `Thread ${threadId} not found`);
    }

    const now = nowISO();
    const updates: Partial<Thread> = {
      updated_at: now,
    };
    if (params.metadata !== undefined) updates.metadata = params.metadata;

    const updated = await this.repository.update(threadId, updates);
    if (!updated) {
      throw new ApiError(404, `Thread ${threadId} not found`);
    }

    return updated;
  }

  /**
   * Delete a thread.
   */
  async delete(threadId: string): Promise<void> {
    const existed = await this.repository.delete(threadId);
    if (!existed) {
      throw new ApiError(404, `Thread ${threadId} not found`);
    }
  }

  /**
   * Search threads with filters and pagination.
   */
  async search(params: SearchThreadsParams): Promise<SearchResult<Thread>> {
    const limit = params.limit ?? 10;
    const offset = params.offset ?? 0;

    // If specific IDs are provided, use searchByIds
    if (params.ids && params.ids.length > 0) {
      const options: SearchOptions = {
        limit,
        offset,
        sortBy: params.sort_by,
        sortOrder: params.sort_order,
        metadata: params.metadata,
      };
      return this.repository.searchByIds(params.ids, options);
    }

    const options: SearchOptions = {
      limit,
      offset,
      sortBy: params.sort_by,
      sortOrder: params.sort_order,
      metadata: params.metadata,
    };

    const filters: Record<string, unknown> = {};
    if (params.status !== undefined) filters.status = params.status;

    return this.repository.search(options, filters);
  }

  /**
   * Count threads matching filters.
   */
  async count(params: CountThreadsParams): Promise<number> {
    const filters: Record<string, unknown> = {};
    if (params.metadata !== undefined) filters.metadata = params.metadata;
    if (params.status !== undefined) filters.status = params.status;

    return this.repository.count(Object.keys(filters).length > 0 ? filters : undefined);
  }

  /**
   * Deep copy a thread to a new thread ID.
   */
  async copy(threadId: string): Promise<Thread> {
    const existing = await this.repository.getById(threadId);
    if (!existing) {
      throw new ApiError(404, `Thread ${threadId} not found`);
    }

    const newId = generateId();
    const copied = await this.repository.copyThread(threadId, newId);
    if (!copied) {
      throw new ApiError(404, `Thread ${threadId} not found`);
    }

    return copied;
  }

  /**
   * Prune threads. Deletes threads by IDs or all idle threads.
   */
  async prune(params: PruneThreadsParams): Promise<void> {
    if (params.thread_ids && params.thread_ids.length > 0) {
      for (const id of params.thread_ids) {
        await this.repository.delete(id);
      }
    }
    // If no specific IDs, this is a no-op for now (pruning all is complex)
  }

  /**
   * Get the current state for a thread. Returns a dummy ThreadState if none exists.
   */
  async getState(threadId: string, _subgraphs?: boolean): Promise<ThreadState> {
    const thread = await this.repository.getById(threadId);
    if (!thread) {
      throw new ApiError(404, `Thread ${threadId} not found`);
    }

    const state = await this.repository.getState(threadId);
    if (state) {
      return state;
    }

    // Return dummy initial state
    const now = nowISO();
    return {
      values: thread.values ?? {},
      next: [],
      checkpoint: {
        thread_id: threadId,
        checkpoint_ns: '',
        checkpoint_id: generateId(),
      },
      metadata: thread.metadata,
      created_at: now,
      parent_checkpoint: null,
      tasks: [],
    };
  }

  /**
   * Update the state of a thread. Stores a new state entry.
   */
  async updateState(threadId: string, params: UpdateThreadStateParams): Promise<Record<string, unknown>> {
    const thread = await this.repository.getById(threadId);
    if (!thread) {
      throw new ApiError(404, `Thread ${threadId} not found`);
    }

    const now = nowISO();
    const checkpointId = params.checkpoint_id ?? generateId();

    // Get the current state to use as parent
    const currentState = await this.repository.getState(threadId);
    const parentCheckpoint = currentState?.checkpoint ?? null;

    const newState: ThreadState = {
      values: params.values,
      next: [],
      checkpoint: params.checkpoint ?? {
        thread_id: threadId,
        checkpoint_ns: '',
        checkpoint_id: checkpointId,
      },
      metadata: {
        source: 'update',
        step: currentState ? (currentState.tasks?.length ?? 0) + 1 : 1,
        writes: params.values,
        ...(params.as_node ? { as_node: params.as_node } : {}),
      },
      created_at: now,
      parent_checkpoint: parentCheckpoint,
      tasks: [],
    };

    await this.repository.addState(threadId, newState);

    // Update thread values and timestamp
    await this.repository.update(threadId, {
      values: params.values,
      updated_at: now,
    } as Partial<Thread>);

    return { checkpoint: newState.checkpoint };
  }

  /**
   * Get state history for a thread with pagination.
   */
  async getHistory(threadId: string, params: ThreadHistoryParams): Promise<SearchResult<ThreadState>> {
    const thread = await this.repository.getById(threadId);
    if (!thread) {
      throw new ApiError(404, `Thread ${threadId} not found`);
    }

    const limit = params.limit ?? 10;
    const offset = 0;

    const options: SearchOptions = {
      limit,
      offset,
    };

    return this.repository.getStateHistory(threadId, options);
  }
}
