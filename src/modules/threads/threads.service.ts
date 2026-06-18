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
import { reduceChannels, DEFAULT_CHANNEL_REDUCERS } from '../../agents/state-reducer.js';
import { projectThread, matchesValuesFilter } from './thread-projection.js';

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
   *
   * Returns the full canonical thread (incl. `values`/`interrupts`) by default,
   * matching the LangGraph contract; a caller narrows to a lean listing via
   * `select` (e.g. `select:["thread_id","metadata","status"]`). The projection is
   * applied here, at the service layer, so every storage provider returns an
   * identical row shape for a given `select` (ADR-0002, amended). `select` is also
   * passed down via SearchOptions so a provider can avoid materializing state when
   * the caller narrowed it away (azure-blob skips body downloads for lean listings).
   *
   * NOTE: the request `extract` field is NOT yet supported — it is accepted by
   * the schema but intentionally not applied (documented as deferred in ADR-0002,
   * Open follow-up). It is not silently consumed elsewhere; this is the single
   * point where it is acknowledged-and-deferred.
   *
   * The request `values` field is a canonical state *filter* (not a projection):
   * it is folded into `filters.values` and applied by the provider before
   * pagination so `total` and the returned page stay correct.
   */
  async search(params: SearchThreadsParams): Promise<SearchResult<Thread>> {
    const limit = params.limit ?? 10;
    const offset = params.offset ?? 0;

    const options: SearchOptions = {
      limit,
      offset,
      sortBy: params.sort_by,
      sortOrder: params.sort_order,
      metadata: params.metadata,
      select: params.select,
    };

    // If specific IDs are provided, resolve them with getById — implemented by
    // every provider. The legacy repository.searchByIds exists only on the
    // in-memory repository and crashes on the storage backends (azure-blob /
    // sqlite / sqlserver), which receive `this.repository` via a runtime cast.
    // Apply the same status/metadata/values filters as the main path so the two
    // routes return consistent rows.
    if (params.ids && params.ids.length > 0) {
      const fetched = await Promise.all(params.ids.map((id) => this.repository.getById(id)));
      let items = fetched.filter((t): t is Thread => t !== null);
      if (params.status !== undefined) {
        items = items.filter((t) => t.status === params.status);
      }
      if (params.metadata) {
        items = items.filter((t) => matchesValuesFilter(t.metadata, params.metadata!));
      }
      if (params.values !== undefined) {
        items = items.filter((t) => matchesValuesFilter(t.values, params.values!));
      }
      if (params.sort_by) {
        const dir = params.sort_order === 'desc' ? -1 : 1;
        const key = params.sort_by;
        items = [...items].sort((a, b) => {
          const av = (a as unknown as Record<string, unknown>)[key];
          const bv = (b as unknown as Record<string, unknown>)[key];
          if (av === bv) return 0;
          return (av! < bv! ? -1 : 1) * dir;
        });
      }
      const total = items.length;
      const page = items.slice(offset, offset + limit);
      return this.projectResult({ items: page, total }, params.select);
    }

    const filters: Record<string, unknown> = {};
    if (params.status !== undefined) filters.status = params.status;
    // Canonical `values` state filter — applied by the provider (cheap on
    // memory/sqlite/sqlserver; rejected with 501 on azure-blob, which would need
    // a full-container body scan — see AzureBlobThreadStorage.search).
    if (params.values !== undefined) filters.values = params.values;

    const result = await this.repository.search(options, filters);
    return this.projectResult(result, params.select);
  }

  /**
   * Apply the canonical `select` projection to a search result. Keeps `total`
   * untouched (it reflects the matched set, not the projected fields).
   */
  private projectResult(
    result: SearchResult<Thread>,
    select?: string[],
  ): SearchResult<Thread> {
    return {
      items: result.items.map((t) => projectThread(t, select)),
      total: result.total,
    };
  }

  /**
   * Count threads matching filters.
   */
  /**
   * Count threads matching filters. Honors the same `metadata`/`status`/`values`
   * filters as search so the count matches the searchable set (ADR-0002).
   */
  async count(params: CountThreadsParams): Promise<number> {
    const filters: Record<string, unknown> = {};
    if (params.metadata !== undefined) filters.metadata = params.metadata;
    if (params.status !== undefined) filters.status = params.status;
    if (params.values !== undefined) filters.values = params.values;

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

    // Get the current state to use as parent and as the merge base.
    const currentState = await this.repository.getState(threadId);
    const parentCheckpoint = currentState?.checkpoint ?? null;

    // Per-channel merge at the top level of `values`, emulating LangGraph's
    // reducer-routed `update_state` (the same flat model the run path uses).
    // `DEFAULT_CHANNEL_REDUCERS` is the single declared channel policy: `messages`
    // append (canonical `add_messages` shape), every other channel is `LastValue`.
    // So a partial manual update appends any messages it sends, replaces the state
    // channels it names, and retains every channel it omits (siblings are never
    // wiped). A deliberate state reset is still expressible by sending every state
    // channel. There is no nested `values.state` blob — graph state lives flat at
    // the top level, exactly as `runs.service.updateThreadState` persists it.
    //
    // NOTE: `append` is a plain concat — it does NOT dedupe/merge by message `id`
    // or honor `RemoveMessages` like a full `add_messages`. Re-sending a message
    // via POST /state double-adds it. Full add_messages fidelity is a separate,
    // deferred parity item (see Issues - Pending Items.md, P11).
    const currentValues = (currentState?.values as Record<string, unknown> | undefined) ?? {};
    const mergedValues = reduceChannels(currentValues, params.values, DEFAULT_CHANNEL_REDUCERS);

    const newState: ThreadState = {
      values: mergedValues,
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
      values: mergedValues,
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

    const items = await this.repository.getStateHistory(threadId, {
      limit: params.limit ?? 10,
      before: params.before as string | undefined,
      metadata: params.metadata as Record<string, unknown> | undefined,
    });
    return { items, total: items.length };
  }
}
