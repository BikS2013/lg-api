/**
 * RunsRepository
 *
 * Extends InMemoryRepository with run-specific operations:
 * list by thread_id, search by status.
 */

import { InMemoryRepository } from '../../repositories/in-memory.repository.js';
import type { SearchOptions, SearchResult } from '../../repositories/interfaces.js';

/** Inline Run type — will be replaced with the shared type from types/index.ts */
export interface Run {
  run_id: string;
  thread_id: string | null;
  assistant_id: string;
  created_at: string;
  updated_at: string;
  status: string;
  metadata: Record<string, unknown>;
  kwargs: Record<string, any>;
  multitask_strategy: string;
  [key: string]: any;
}

export class RunsRepository extends InMemoryRepository<Run> {
  /**
   * List runs belonging to a specific thread, with pagination and sorting.
   */
  async listByThreadId(threadId: string, options: SearchOptions): Promise<SearchResult<Run>> {
    return this.search(options, { thread_id: threadId });
  }

  /**
   * Search runs filtered by status.
   */
  async searchByStatus(status: string, options: SearchOptions): Promise<SearchResult<Run>> {
    return this.search(options, { status });
  }
}
