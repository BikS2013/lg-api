/**
 * SQL Server Run Storage Implementation
 *
 * Implements IRunStorage using the mssql package with parameterized queries.
 */

import * as sql from 'mssql';
import type {
  IRunStorage,
  SearchOptions,
  SearchResult,
} from '../../interfaces.js';
import type { Run } from '../../../types/index.js';

export class SqlServerRunStorage implements IRunStorage {
  private pool: sql.ConnectionPool;

  constructor(pool: sql.ConnectionPool) {
    this.pool = pool;
  }

  async create(run: Run): Promise<Run> {
    const request = this.pool.request();
    request.input('run_id', sql.NVarChar(36), run.run_id);
    request.input('thread_id', sql.NVarChar(36), run.thread_id ?? null);
    request.input('assistant_id', sql.NVarChar(36), run.assistant_id);
    request.input('created_at', sql.NVarChar, run.created_at);
    request.input('updated_at', sql.NVarChar, run.updated_at);
    request.input('status', sql.NVarChar(20), run.status);
    request.input('metadata', sql.NVarChar(sql.MAX), JSON.stringify(run.metadata));
    request.input('multitask_strategy', sql.NVarChar(20), run.multitask_strategy ?? null);
    request.input('kwargs', sql.NVarChar(sql.MAX), run.kwargs ? JSON.stringify(run.kwargs) : null);

    await request.query(`
      INSERT INTO Run (run_id, thread_id, assistant_id, created_at, updated_at, status, metadata, multitask_strategy, kwargs)
      VALUES (@run_id, @thread_id, @assistant_id, @created_at, @updated_at, @status, @metadata, @multitask_strategy, @kwargs)
    `);

    return run;
  }

  async getById(runId: string): Promise<Run | null> {
    const request = this.pool.request();
    request.input('run_id', sql.NVarChar(36), runId);

    const result = await request.query<Record<string, unknown>>(
      'SELECT * FROM Run WHERE run_id = @run_id',
    );

    if (result.recordset.length === 0) return null;
    return this.rowToRun(result.recordset[0]);
  }

  async update(runId: string, updates: Partial<Run>): Promise<Run | null> {
    const existing = await this.getById(runId);
    if (!existing) return null;

    const merged: Run = { ...existing, ...updates };
    const now = new Date().toISOString();
    merged.updated_at = now;

    const request = this.pool.request();
    request.input('run_id', sql.NVarChar(36), runId);
    request.input('thread_id', sql.NVarChar(36), merged.thread_id ?? null);
    request.input('assistant_id', sql.NVarChar(36), merged.assistant_id);
    request.input('updated_at', sql.NVarChar, merged.updated_at);
    request.input('status', sql.NVarChar(20), merged.status);
    request.input('metadata', sql.NVarChar(sql.MAX), JSON.stringify(merged.metadata));
    request.input('multitask_strategy', sql.NVarChar(20), merged.multitask_strategy ?? null);
    request.input('kwargs', sql.NVarChar(sql.MAX), merged.kwargs ? JSON.stringify(merged.kwargs) : null);

    await request.query(`
      UPDATE Run
      SET thread_id = @thread_id,
          assistant_id = @assistant_id,
          updated_at = @updated_at,
          status = @status,
          metadata = @metadata,
          multitask_strategy = @multitask_strategy,
          kwargs = @kwargs
      WHERE run_id = @run_id
    `);

    return merged;
  }

  async delete(runId: string): Promise<boolean> {
    const request = this.pool.request();
    request.input('run_id', sql.NVarChar(36), runId);

    const result = await request.query(
      'DELETE FROM Run WHERE run_id = @run_id',
    );

    return (result.rowsAffected[0] ?? 0) > 0;
  }

  async listByThreadId(
    threadId: string,
    options: SearchOptions,
  ): Promise<SearchResult<Run>> {
    // Count
    const countReq = this.pool.request();
    countReq.input('thread_id', sql.NVarChar(36), threadId);
    const countResult = await countReq.query<{ total: number }>(
      'SELECT COUNT(*) AS total FROM Run WHERE thread_id = @thread_id',
    );
    const total = countResult.recordset[0].total;

    // Data
    const sortBy = options.sortBy ?? 'created_at';
    const sortOrder = options.sortOrder === 'asc' ? 'ASC' : 'DESC';

    const dataReq = this.pool.request();
    dataReq.input('thread_id', sql.NVarChar(36), threadId);
    dataReq.input('offset', sql.Int, options.offset);
    dataReq.input('limit', sql.Int, options.limit);

    const dataResult = await dataReq.query<Record<string, unknown>>(`
      SELECT * FROM Run
      WHERE thread_id = @thread_id
      ORDER BY ${this.sanitizeColumnName(sortBy)} ${sortOrder}
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

    const items = dataResult.recordset.map((row) => this.rowToRun(row));
    return { items, total };
  }

  async count(filters?: Record<string, unknown>): Promise<number> {
    const { whereClauses, request } = this.buildFilterClauses(
      this.pool.request(),
      filters,
    );

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const result = await request.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM Run ${whereStr}`,
    );

    return result.recordset[0].total;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private rowToRun(row: Record<string, unknown>): Run {
    return {
      run_id: row.run_id as string,
      thread_id: (row.thread_id as string | null) ?? null,
      assistant_id: row.assistant_id as string,
      created_at: this.toISOString(row.created_at),
      updated_at: this.toISOString(row.updated_at),
      status: row.status as Run['status'],
      metadata: this.parseJson(row.metadata as string),
      multitask_strategy: (row.multitask_strategy as Run['multitask_strategy']) ?? undefined,
      kwargs: row.kwargs ? this.parseJson(row.kwargs as string) : undefined,
    };
  }

  private parseJson(value: string | null | undefined): Record<string, unknown> {
    if (!value) return {};
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private toISOString(value: unknown): string {
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }

  private sanitizeColumnName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, '');
  }

  private buildFilterClauses(
    request: sql.Request,
    filters?: Record<string, unknown>,
  ): { whereClauses: string[]; request: sql.Request } {
    const whereClauses: string[] = [];

    if (filters) {
      if (filters.status !== undefined) {
        request.input('filter_status', sql.NVarChar(20), String(filters.status));
        whereClauses.push('status = @filter_status');
      }
      if (filters.thread_id !== undefined) {
        request.input('filter_thread_id', sql.NVarChar(36), String(filters.thread_id));
        whereClauses.push('thread_id = @filter_thread_id');
      }
      if (filters.assistant_id !== undefined) {
        request.input('filter_assistant_id', sql.NVarChar(36), String(filters.assistant_id));
        whereClauses.push('assistant_id = @filter_assistant_id');
      }
    }

    return { whereClauses, request };
  }
}
