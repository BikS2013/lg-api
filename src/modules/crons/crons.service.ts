/**
 * CronsService
 *
 * Business logic layer for cron job management.
 * Handles creation, update, deletion, search, and counting of cron entries.
 * Note: No actual scheduling is performed — this stores cron metadata only.
 */

import { CronsRepository } from './crons.repository.js';
import type { Cron } from './crons.repository.js';
import type { SearchOptions } from '../../repositories/interfaces.js';
import { generateId } from '../../utils/uuid.util.js';
import { ApiError } from '../../errors/api-error.js';

export interface CreateCronData {
  assistant_id: string;
  schedule: string;
  input?: Record<string, unknown>;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  context?: Record<string, unknown>;
  checkpoint_during?: boolean;
  interrupt_before?: string[] | '*';
  interrupt_after?: string[] | '*';
  webhook?: string | null;
  multitask_strategy?: string;
  end_time?: string | null;
  enabled?: boolean;
  on_run_completed?: string;
  stream_mode?: string[];
  stream_subgraphs?: boolean;
  stream_resumable?: boolean;
  durability?: string;
}

export interface UpdateCronData {
  schedule?: string;
  input?: Record<string, unknown>;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  enabled?: boolean;
  end_time?: string | null;
  on_run_completed?: string;
}

export interface SearchCronsOptions {
  assistant_id?: string;
  thread_id?: string;
  enabled?: boolean;
  limit?: number;
  offset?: number;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  select?: string[];
}

export interface CountCronsFilters {
  assistant_id?: string;
  thread_id?: string;
}

export class CronsService {
  constructor(private readonly repository: CronsRepository) {}

  /**
   * Create a new cron job entry.
   * If threadId is provided, it creates a stateful cron bound to that thread.
   * If threadId is null, it creates a stateless cron.
   */
  async createCron(threadId: string | null, data: CreateCronData): Promise<Cron> {
    const now = new Date().toISOString();
    const cronId = generateId();

    const payload: Record<string, any> = {};
    if (data.input !== undefined) payload.input = data.input;
    if (data.config !== undefined) payload.config = data.config;
    if (data.context !== undefined) payload.context = data.context;
    if (data.checkpoint_during !== undefined) payload.checkpoint_during = data.checkpoint_during;
    if (data.interrupt_before !== undefined) payload.interrupt_before = data.interrupt_before;
    if (data.interrupt_after !== undefined) payload.interrupt_after = data.interrupt_after;
    if (data.webhook !== undefined) payload.webhook = data.webhook;
    if (data.multitask_strategy !== undefined) payload.multitask_strategy = data.multitask_strategy;
    if (data.stream_mode !== undefined) payload.stream_mode = data.stream_mode;
    if (data.stream_subgraphs !== undefined) payload.stream_subgraphs = data.stream_subgraphs;
    if (data.stream_resumable !== undefined) payload.stream_resumable = data.stream_resumable;
    if (data.durability !== undefined) payload.durability = data.durability;

    const cron: Cron = {
      cron_id: cronId,
      assistant_id: data.assistant_id,
      thread_id: threadId,
      user_id: null,
      payload,
      schedule: data.schedule,
      next_run_date: now, // Set next_run_date to current time as baseline
      end_time: data.end_time ?? null,
      created_at: now,
      updated_at: now,
      metadata: data.metadata ?? {},
      enabled: data.enabled ?? true,
      on_run_completed: data.on_run_completed,
    };

    return this.repository.create(cronId, cron);
  }

  /**
   * Delete a cron job by ID.
   * Throws 404 if the cron does not exist.
   */
  async deleteCron(cronId: string): Promise<void> {
    const existing = await this.repository.getById(cronId);
    if (!existing) {
      throw new ApiError(404, `Cron ${cronId} not found`);
    }
    await this.repository.delete(cronId);
  }

  /**
   * Update a cron job by ID.
   * Throws 404 if the cron does not exist.
   */
  async updateCron(cronId: string, data: UpdateCronData): Promise<Cron> {
    const existing = await this.repository.getById(cronId);
    if (!existing) {
      throw new ApiError(404, `Cron ${cronId} not found`);
    }

    const updates: Partial<Cron> = {
      updated_at: new Date().toISOString(),
    };

    if (data.schedule !== undefined) updates.schedule = data.schedule;
    if (data.metadata !== undefined) updates.metadata = data.metadata;
    if (data.enabled !== undefined) updates.enabled = data.enabled;
    if (data.end_time !== undefined) updates.end_time = data.end_time;
    if (data.on_run_completed !== undefined) updates.on_run_completed = data.on_run_completed;

    // Update payload fields if provided
    if (data.input !== undefined || data.config !== undefined) {
      const existingPayload = existing.payload ?? {};
      const updatedPayload = { ...existingPayload };
      if (data.input !== undefined) updatedPayload.input = data.input;
      if (data.config !== undefined) updatedPayload.config = data.config;
      updates.payload = updatedPayload;
    }

    const updated = await this.repository.update(cronId, updates);
    if (!updated) {
      throw new ApiError(404, `Cron ${cronId} not found`);
    }

    return updated;
  }

  /**
   * Search crons with optional filtering, sorting, and pagination.
   */
  async searchCrons(options: SearchCronsOptions): Promise<{ items: Cron[]; total: number }> {
    const limit = options.limit ?? 10;
    const offset = options.offset ?? 0;

    const filters: Record<string, unknown> = {};
    if (options.assistant_id !== undefined) filters.assistant_id = options.assistant_id;
    if (options.thread_id !== undefined) filters.thread_id = options.thread_id;
    if (options.enabled !== undefined) filters.enabled = options.enabled;

    const searchOptions: SearchOptions = {
      limit,
      offset,
      sortBy: options.sort_by,
      sortOrder: options.sort_order,
    };

    const result = await this.repository.search(searchOptions, filters);

    // Apply field selection if requested
    if (options.select && options.select.length > 0) {
      const selectedFields = options.select;
      result.items = result.items.map((item) => {
        const filtered: Record<string, any> = {};
        for (const field of selectedFields) {
          if (field in item) {
            filtered[field] = (item as Record<string, any>)[field];
          }
        }
        return filtered as Cron;
      });
    }

    return result;
  }

  /**
   * Count crons matching the given filters.
   */
  async countCrons(filters: CountCronsFilters): Promise<number> {
    const repoFilters: Record<string, unknown> = {};
    if (filters.assistant_id !== undefined) repoFilters.assistant_id = filters.assistant_id;
    if (filters.thread_id !== undefined) repoFilters.thread_id = filters.thread_id;

    return this.repository.count(
      Object.keys(repoFilters).length > 0 ? repoFilters : undefined
    );
  }
}
