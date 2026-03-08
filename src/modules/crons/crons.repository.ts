/**
 * CronsRepository
 *
 * Extends InMemoryRepository with cron-specific operations:
 * search by assistant_id, search by thread_id.
 */

import { InMemoryRepository } from '../../repositories/in-memory.repository.js';
import type { SearchOptions, SearchResult } from '../../repositories/interfaces.js';

/** Inline Cron type — will be replaced with the shared type from types/index.ts */
export interface Cron {
  cron_id: string;
  assistant_id: string;
  thread_id: string | null;
  user_id: string | null;
  payload: Record<string, any>;
  schedule: string;
  next_run_date: string | null;
  end_time: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
  [key: string]: any;
}

export class CronsRepository extends InMemoryRepository<Cron> {
  /**
   * Search crons filtered by assistant_id.
   */
  async searchByAssistantId(
    assistantId: string,
    options: SearchOptions
  ): Promise<SearchResult<Cron>> {
    return this.search(options, { assistant_id: assistantId });
  }

  /**
   * Search crons filtered by thread_id.
   */
  async searchByThreadId(
    threadId: string,
    options: SearchOptions
  ): Promise<SearchResult<Cron>> {
    return this.search(options, { thread_id: threadId });
  }
}
