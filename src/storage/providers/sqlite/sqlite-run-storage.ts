/**
 * SQLite Run Storage Implementation
 *
 * Implements IRunStorage using better-sqlite3 synchronous API
 * wrapped in async methods.
 */

import type Database from 'better-sqlite3';
import type {
  IRunStorage,
  SearchOptions,
  SearchResult,
} from '../../interfaces.js';
import type { Run } from '../../../types/index.js';

export class SqliteRunStorage implements IRunStorage {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  async create(run: Run): Promise<Run> {
    const stmt = this.db.prepare(`
      INSERT INTO Run (run_id, thread_id, assistant_id, created_at, updated_at, status, metadata, multitask_strategy, kwargs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      run.run_id,
      run.thread_id ?? null,
      run.assistant_id,
      run.created_at,
      run.updated_at,
      run.status,
      JSON.stringify(run.metadata),
      run.multitask_strategy ?? null,
      run.kwargs != null ? JSON.stringify(run.kwargs) : null,
    );
    return structuredClone(run);
  }

  async getById(runId: string): Promise<Run | null> {
    const stmt = this.db.prepare('SELECT * FROM Run WHERE run_id = ?');
    const row = stmt.get(runId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToRun(row);
  }

  async update(runId: string, updates: Partial<Run>): Promise<Run | null> {
    const existing = await this.getById(runId);
    if (!existing) return null;

    const merged: Run = {
      ...existing,
      ...updates,
      updated_at: updates.updated_at ?? new Date().toISOString(),
    };

    const stmt = this.db.prepare(`
      UPDATE Run
      SET thread_id = ?, assistant_id = ?, created_at = ?, updated_at = ?,
          status = ?, metadata = ?, multitask_strategy = ?, kwargs = ?
      WHERE run_id = ?
    `);
    stmt.run(
      merged.thread_id ?? null,
      merged.assistant_id,
      merged.created_at,
      merged.updated_at,
      merged.status,
      JSON.stringify(merged.metadata),
      merged.multitask_strategy ?? null,
      merged.kwargs != null ? JSON.stringify(merged.kwargs) : null,
      runId,
    );
    return structuredClone(merged);
  }

  async delete(runId: string): Promise<boolean> {
    const stmt = this.db.prepare('DELETE FROM Run WHERE run_id = ?');
    const result = stmt.run(runId);
    return result.changes > 0;
  }

  async listByThreadId(threadId: string, options: SearchOptions): Promise<SearchResult<Run>> {
    const conditions: string[] = ['thread_id = ?'];
    const params: unknown[] = [threadId];

    if (options.metadata) {
      for (const [key, value] of Object.entries(options.metadata)) {
        conditions.push(`json_extract(metadata, ?) = ?`);
        params.push(`$.${key}`, typeof value === 'string' ? value : JSON.stringify(value));
      }
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const sortBy = options.sortBy ?? 'created_at';
    const sortOrder = options.sortOrder ?? 'desc';

    const countStmt = this.db.prepare(`SELECT COUNT(*) as cnt FROM Run ${whereClause}`);
    const countRow = countStmt.get(...params) as { cnt: number };
    const total = countRow.cnt;

    const selectStmt = this.db.prepare(
      `SELECT * FROM Run ${whereClause} ORDER BY ${sortBy} ${sortOrder} LIMIT ? OFFSET ?`,
    );
    const rows = selectStmt.all(...params, options.limit, options.offset) as Record<string, unknown>[];

    return {
      items: rows.map((r) => this.rowToRun(r)),
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
        } else if (key === 'status') {
          conditions.push('status = ?');
          params.push(value);
        } else if (key === 'thread_id') {
          conditions.push('thread_id = ?');
          params.push(value);
        }
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const stmt = this.db.prepare(`SELECT COUNT(*) as cnt FROM Run ${whereClause}`);
    const row = stmt.get(...params) as { cnt: number };
    return row.cnt;
  }

  private rowToRun(row: Record<string, unknown>): Run {
    return {
      run_id: row.run_id as string,
      thread_id: row.thread_id as string | null,
      assistant_id: row.assistant_id as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      status: row.status as Run['status'],
      metadata: JSON.parse(row.metadata as string),
      multitask_strategy: (row.multitask_strategy as Run['multitask_strategy']) ?? undefined,
      kwargs: row.kwargs != null ? JSON.parse(row.kwargs as string) : undefined,
    };
  }
}
