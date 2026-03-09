/**
 * SQLite Cron Storage Implementation
 *
 * Implements ICronStorage using better-sqlite3 synchronous API
 * wrapped in async methods.
 */

import type Database from 'better-sqlite3';
import type {
  ICronStorage,
  SearchOptions,
  SearchResult,
} from '../../interfaces.js';
import type { Cron } from '../../../types/index.js';

export class SqliteCronStorage implements ICronStorage {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  async create(cron: Cron): Promise<Cron> {
    const stmt = this.db.prepare(`
      INSERT INTO Cron (cron_id, assistant_id, thread_id, schedule, created_at, updated_at,
        metadata, enabled, on_run_completed, end_time, payload, user_id, next_run_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      cron.cron_id,
      cron.assistant_id,
      cron.thread_id ?? null,
      cron.schedule,
      cron.created_at,
      cron.updated_at,
      JSON.stringify(cron.metadata),
      cron.enabled ? 1 : 0,
      cron.on_run_completed ?? null,
      cron.end_time ?? null,
      cron.payload != null ? JSON.stringify(cron.payload) : null,
      cron.user_id ?? null,
      cron.next_run_date ?? null,
    );
    return structuredClone(cron);
  }

  async getById(cronId: string): Promise<Cron | null> {
    const stmt = this.db.prepare('SELECT * FROM Cron WHERE cron_id = ?');
    const row = stmt.get(cronId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToCron(row);
  }

  async update(cronId: string, updates: Partial<Cron>): Promise<Cron | null> {
    const existing = await this.getById(cronId);
    if (!existing) return null;

    const merged: Cron = {
      ...existing,
      ...updates,
      updated_at: updates.updated_at ?? new Date().toISOString(),
    };

    const stmt = this.db.prepare(`
      UPDATE Cron
      SET assistant_id = ?, thread_id = ?, schedule = ?, created_at = ?, updated_at = ?,
          metadata = ?, enabled = ?, on_run_completed = ?, end_time = ?,
          payload = ?, user_id = ?, next_run_date = ?
      WHERE cron_id = ?
    `);
    stmt.run(
      merged.assistant_id,
      merged.thread_id ?? null,
      merged.schedule,
      merged.created_at,
      merged.updated_at,
      JSON.stringify(merged.metadata),
      merged.enabled ? 1 : 0,
      merged.on_run_completed ?? null,
      merged.end_time ?? null,
      merged.payload != null ? JSON.stringify(merged.payload) : null,
      merged.user_id ?? null,
      merged.next_run_date ?? null,
      cronId,
    );
    return structuredClone(merged);
  }

  async delete(cronId: string): Promise<boolean> {
    const stmt = this.db.prepare('DELETE FROM Cron WHERE cron_id = ?');
    const result = stmt.run(cronId);
    return result.changes > 0;
  }

  async search(
    options: SearchOptions,
    filters?: Record<string, unknown>,
  ): Promise<SearchResult<Cron>> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.metadata) {
      for (const [key, value] of Object.entries(options.metadata)) {
        conditions.push(`json_extract(metadata, ?) = ?`);
        params.push(`$.${key}`, typeof value === 'string' ? value : JSON.stringify(value));
      }
    }

    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        if (key === 'metadata') {
          const metaFilters = value as Record<string, unknown>;
          for (const [mKey, mValue] of Object.entries(metaFilters)) {
            conditions.push(`json_extract(metadata, ?) = ?`);
            params.push(`$.${mKey}`, typeof mValue === 'string' ? mValue : JSON.stringify(mValue));
          }
        } else if (key === 'assistant_id') {
          conditions.push('assistant_id = ?');
          params.push(value);
        } else if (key === 'thread_id') {
          conditions.push('thread_id = ?');
          params.push(value);
        } else if (key === 'enabled') {
          conditions.push('enabled = ?');
          params.push(value ? 1 : 0);
        }
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sortBy = options.sortBy ?? 'created_at';
    const sortOrder = options.sortOrder ?? 'desc';

    const countStmt = this.db.prepare(`SELECT COUNT(*) as cnt FROM Cron ${whereClause}`);
    const countRow = countStmt.get(...params) as { cnt: number };
    const total = countRow.cnt;

    const selectStmt = this.db.prepare(
      `SELECT * FROM Cron ${whereClause} ORDER BY ${sortBy} ${sortOrder} LIMIT ? OFFSET ?`,
    );
    const rows = selectStmt.all(...params, options.limit, options.offset) as Record<string, unknown>[];

    return {
      items: rows.map((r) => this.rowToCron(r)),
      total,
    };
  }

  async count(filters?: Record<string, unknown>): Promise<number> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        if (key === 'metadata') {
          const metaFilters = value as Record<string, unknown>;
          for (const [mKey, mValue] of Object.entries(metaFilters)) {
            conditions.push(`json_extract(metadata, ?) = ?`);
            params.push(`$.${mKey}`, typeof mValue === 'string' ? mValue : JSON.stringify(mValue));
          }
        } else if (key === 'assistant_id') {
          conditions.push('assistant_id = ?');
          params.push(value);
        } else if (key === 'thread_id') {
          conditions.push('thread_id = ?');
          params.push(value);
        } else if (key === 'enabled') {
          conditions.push('enabled = ?');
          params.push(value ? 1 : 0);
        }
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const stmt = this.db.prepare(`SELECT COUNT(*) as cnt FROM Cron ${whereClause}`);
    const row = stmt.get(...params) as { cnt: number };
    return row.cnt;
  }

  private rowToCron(row: Record<string, unknown>): Cron {
    return {
      cron_id: row.cron_id as string,
      assistant_id: row.assistant_id as string,
      thread_id: row.thread_id != null ? (row.thread_id as string) : undefined,
      schedule: row.schedule as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      metadata: JSON.parse(row.metadata as string),
      enabled: (row.enabled as number) === 1,
      on_run_completed: (row.on_run_completed as Cron['on_run_completed']) ?? undefined,
      end_time: row.end_time != null ? (row.end_time as string) : undefined,
      payload: row.payload != null ? JSON.parse(row.payload as string) : undefined,
      user_id: row.user_id != null ? (row.user_id as string) : undefined,
      next_run_date: row.next_run_date != null ? (row.next_run_date as string) : undefined,
    };
  }
}
