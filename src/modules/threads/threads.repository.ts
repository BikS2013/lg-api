/**
 * ThreadsRepository
 *
 * Extends InMemoryRepository with thread-specific operations:
 * search by status, search by IDs, thread state management, deep copy.
 */

import { InMemoryRepository } from '../../repositories/in-memory.repository.js';
import type { SearchOptions, SearchResult } from '../../repositories/interfaces.js';

/** Inline Thread type — will be replaced with the shared type from types/index.ts */
export interface Thread {
  thread_id: string;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
  status: string;
  values?: Record<string, unknown>;
  interrupts?: Array<{ value: unknown; id: string }>;
}

/** Inline ThreadState type — will be replaced with the shared type from types/index.ts */
export interface ThreadState {
  values: Record<string, unknown>;
  next: string[];
  checkpoint: {
    thread_id: string;
    checkpoint_ns: string;
    checkpoint_id: string;
    checkpoint_map?: Record<string, string>;
  };
  metadata: Record<string, unknown>;
  created_at: string;
  parent_checkpoint?: {
    thread_id: string;
    checkpoint_ns: string;
    checkpoint_id: string;
    checkpoint_map?: Record<string, string>;
  } | null;
  tasks: Array<Record<string, any>>;
  interrupts?: Array<{ value: unknown; id: string }>;
}

export class ThreadsRepository extends InMemoryRepository<Thread> {
  /** Map of thread_id -> array of state entries (ordered by insertion time) */
  private states: Map<string, ThreadState[]> = new Map();

  /**
   * Search threads filtered by status.
   */
  async searchByStatus(status: string, options: SearchOptions): Promise<SearchResult<Thread>> {
    return this.search(options, { status });
  }

  /**
   * Search threads that match any of the given IDs.
   */
  async searchByIds(ids: string[], options: SearchOptions): Promise<SearchResult<Thread>> {
    const idSet = new Set(ids);
    let items = Array.from(this.store.values()).filter((thread) =>
      idSet.has(thread.thread_id)
    );

    // Apply metadata filtering if provided
    if (options.metadata) {
      items = this.filterByMetadata(items, options.metadata);
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

  /**
   * Get the latest state for a thread.
   */
  async getState(threadId: string): Promise<ThreadState | null> {
    const stateHistory = this.states.get(threadId);
    if (!stateHistory || stateHistory.length === 0) {
      return null;
    }
    return structuredClone(stateHistory[stateHistory.length - 1]);
  }

  /**
   * Add a state entry for a thread.
   */
  async addState(threadId: string, state: ThreadState): Promise<void> {
    const existing = this.states.get(threadId) ?? [];
    existing.push(structuredClone(state));
    this.states.set(threadId, existing);
  }

  /**
   * Get state history for a thread with pagination.
   */
  async getStateHistory(
    threadId: string,
    options: SearchOptions
  ): Promise<SearchResult<ThreadState>> {
    const stateHistory = this.states.get(threadId) ?? [];

    // Return in reverse chronological order (most recent first)
    const reversed = [...stateHistory].reverse();
    const total = reversed.length;
    const items = reversed.slice(options.offset, options.offset + options.limit);

    return {
      items: items.map((s) => structuredClone(s)),
      total,
    };
  }

  /**
   * Deep copy a thread and its state history to a new thread ID.
   */
  async copyThread(threadId: string, newThreadId: string): Promise<Thread | null> {
    const original = this.store.get(threadId);
    if (!original) {
      return null;
    }

    const now = new Date().toISOString();
    const copied: Thread = {
      ...structuredClone(original),
      thread_id: newThreadId,
      created_at: now,
      updated_at: now,
    };

    this.store.set(newThreadId, structuredClone(copied));

    // Deep copy state history
    const originalStates = this.states.get(threadId);
    if (originalStates) {
      const copiedStates = originalStates.map((state) => {
        const cloned = structuredClone(state);
        // Update the thread_id in the checkpoint
        if (cloned.checkpoint) {
          cloned.checkpoint.thread_id = newThreadId;
        }
        return cloned;
      });
      this.states.set(newThreadId, copiedStates);
    }

    return structuredClone(copied);
  }

  /**
   * Override delete to also clean up state history.
   */
  async delete(id: string): Promise<boolean> {
    this.states.delete(id);
    return super.delete(id);
  }
}
