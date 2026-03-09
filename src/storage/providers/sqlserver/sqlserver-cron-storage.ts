/**
 * SQL Server Cron Storage Implementation
 *
 * Implements ICronStorage using the mssql package with parameterized queries.
 */

import * as sql from 'mssql';
import type {
  ICronStorage,
  SearchOptions,
  SearchResult,
} from '../../interfaces.js';
import type { Cron } from '../../../types/index.js';
import { resolveCreateArgs } from '../../compat.js';

export class SqlServerCronStorage implements ICronStorage {
  private pool: sql.ConnectionPool;

  constructor(pool: sql.ConnectionPool) {
    this.pool = pool;
  }

  async create(cronOrId: Cron | string, maybeCron?: unknown): Promise<Cron> {
    const cron = resolveCreateArgs<Cron>(cronOrId, maybeCron);
    const request = this.pool.request();
    request.input('cron_id', sql.NVarChar(36), cron.cron_id);
    request.input('assistant_id', sql.NVarChar(36), cron.assistant_id);
    request.input('thread_id', sql.NVarChar(36), cron.thread_id ?? null);
    request.input('schedule', sql.NVarChar(255), cron.schedule);
    request.input('created_at', sql.NVarChar, cron.created_at);
    request.input('updated_at', sql.NVarChar, cron.updated_at);
    request.input('metadata', sql.NVarChar(sql.MAX), JSON.stringify(cron.metadata));
    request.input('enabled', sql.Bit, cron.enabled ? 1 : 0);
    request.input('on_run_completed', sql.NVarChar(20), cron.on_run_completed ?? null);
    request.input('end_time', sql.NVarChar, cron.end_time ?? null);
    request.input('payload', sql.NVarChar(sql.MAX), cron.payload ? JSON.stringify(cron.payload) : null);
    request.input('user_id', sql.NVarChar(255), cron.user_id ?? null);
    request.input('next_run_date', sql.NVarChar, cron.next_run_date ?? null);

    await request.query(`
      INSERT INTO Cron (cron_id, assistant_id, thread_id, schedule, created_at, updated_at, metadata, enabled, on_run_completed, end_time, payload, user_id, next_run_date)
      VALUES (@cron_id, @assistant_id, @thread_id, @schedule, @created_at, @updated_at, @metadata, @enabled, @on_run_completed, @end_time, @payload, @user_id, @next_run_date)
    `);

    return cron;
  }

  async getById(cronId: string): Promise<Cron | null> {
    const request = this.pool.request();
    request.input('cron_id', sql.NVarChar(36), cronId);

    const result = await request.query<Record<string, unknown>>(
      'SELECT * FROM Cron WHERE cron_id = @cron_id',
    );

    if (result.recordset.length === 0) return null;
    return this.rowToCron(result.recordset[0]);
  }

  async update(cronId: string, updates: Partial<Cron>): Promise<Cron | null> {
    const existing = await this.getById(cronId);
    if (!existing) return null;

    const merged: Cron = { ...existing, ...updates };
    const now = new Date().toISOString();
    merged.updated_at = now;

    const request = this.pool.request();
    request.input('cron_id', sql.NVarChar(36), cronId);
    request.input('assistant_id', sql.NVarChar(36), merged.assistant_id);
    request.input('thread_id', sql.NVarChar(36), merged.thread_id ?? null);
    request.input('schedule', sql.NVarChar(255), merged.schedule);
    request.input('updated_at', sql.NVarChar, merged.updated_at);
    request.input('metadata', sql.NVarChar(sql.MAX), JSON.stringify(merged.metadata));
    request.input('enabled', sql.Bit, merged.enabled ? 1 : 0);
    request.input('on_run_completed', sql.NVarChar(20), merged.on_run_completed ?? null);
    request.input('end_time', sql.NVarChar, merged.end_time ?? null);
    request.input('payload', sql.NVarChar(sql.MAX), merged.payload ? JSON.stringify(merged.payload) : null);
    request.input('user_id', sql.NVarChar(255), merged.user_id ?? null);
    request.input('next_run_date', sql.NVarChar, merged.next_run_date ?? null);

    await request.query(`
      UPDATE Cron
      SET assistant_id = @assistant_id,
          thread_id = @thread_id,
          schedule = @schedule,
          updated_at = @updated_at,
          metadata = @metadata,
          enabled = @enabled,
          on_run_completed = @on_run_completed,
          end_time = @end_time,
          payload = @payload,
          user_id = @user_id,
          next_run_date = @next_run_date
      WHERE cron_id = @cron_id
    `);

    return merged;
  }

  async delete(cronId: string): Promise<boolean> {
    const request = this.pool.request();
    request.input('cron_id', sql.NVarChar(36), cronId);

    const result = await request.query(
      'DELETE FROM Cron WHERE cron_id = @cron_id',
    );

    return (result.rowsAffected[0] ?? 0) > 0;
  }

  async search(
    options: SearchOptions,
    filters?: Record<string, unknown>,
  ): Promise<SearchResult<Cron>> {
    const { whereClauses, request } = this.buildFilterClauses(
      this.pool.request(),
      filters,
      options.metadata,
    );

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const sortBy = options.sortBy ?? 'created_at';
    const sortOrder = options.sortOrder === 'asc' ? 'ASC' : 'DESC';

    // Count query
    const countResult = await request.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM Cron ${whereStr}`,
    );
    const total = countResult.recordset[0].total;

    // Data query with pagination
    const dataRequest = this.pool.request();
    const { request: dataReq } = this.buildFilterClauses(
      dataRequest,
      filters,
      options.metadata,
    );
    dataReq.input('offset', sql.Int, options.offset);
    dataReq.input('limit', sql.Int, options.limit);

    const dataResult = await dataReq.query<Record<string, unknown>>(`
      SELECT * FROM Cron ${whereStr}
      ORDER BY ${this.sanitizeColumnName(sortBy)} ${sortOrder}
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

    const items = dataResult.recordset.map((row) => this.rowToCron(row));
    return { items, total };
  }

  async count(filters?: Record<string, unknown>): Promise<number> {
    const { whereClauses, request } = this.buildFilterClauses(
      this.pool.request(),
      filters,
    );

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const result = await request.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM Cron ${whereStr}`,
    );

    return result.recordset[0].total;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private rowToCron(row: Record<string, unknown>): Cron {
    return {
      cron_id: row.cron_id as string,
      assistant_id: row.assistant_id as string,
      thread_id: (row.thread_id as string | null) ?? undefined,
      schedule: row.schedule as string,
      created_at: this.toISOString(row.created_at),
      updated_at: this.toISOString(row.updated_at),
      metadata: this.parseJson(row.metadata as string),
      enabled: Boolean(row.enabled),
      on_run_completed: (row.on_run_completed as Cron['on_run_completed']) ?? undefined,
      end_time: row.end_time ? this.toISOString(row.end_time) : undefined,
      payload: row.payload ? this.parseJson(row.payload as string) : undefined,
      user_id: (row.user_id as string | null) ?? undefined,
      next_run_date: row.next_run_date ? this.toISOString(row.next_run_date) : undefined,
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

  private sanitizeJsonPath(key: string): string {
    return key.replace(/[^a-zA-Z0-9_.]/g, '');
  }

  private buildFilterClauses(
    request: sql.Request,
    filters?: Record<string, unknown>,
    metadataFilters?: Record<string, unknown>,
  ): { whereClauses: string[]; request: sql.Request } {
    const whereClauses: string[] = [];

    if (filters) {
      if (filters.assistant_id !== undefined) {
        request.input('filter_assistant_id', sql.NVarChar(36), String(filters.assistant_id));
        whereClauses.push('assistant_id = @filter_assistant_id');
      }
      if (filters.thread_id !== undefined) {
        request.input('filter_thread_id', sql.NVarChar(36), String(filters.thread_id));
        whereClauses.push('thread_id = @filter_thread_id');
      }
      if (filters.enabled !== undefined) {
        request.input('filter_enabled', sql.Bit, filters.enabled ? 1 : 0);
        whereClauses.push('enabled = @filter_enabled');
      }
      if (filters.metadata && typeof filters.metadata === 'object') {
        const meta = filters.metadata as Record<string, unknown>;
        let i = 0;
        for (const [key, val] of Object.entries(meta)) {
          const paramName = `meta_f_${i}`;
          request.input(paramName, sql.NVarChar(sql.MAX), String(val));
          whereClauses.push(`JSON_VALUE(metadata, '$.${this.sanitizeJsonPath(key)}') = @${paramName}`);
          i++;
        }
      }
    }

    if (metadataFilters && typeof metadataFilters === 'object') {
      let i = 0;
      for (const [key, val] of Object.entries(metadataFilters)) {
        const paramName = `meta_s_${i}`;
        request.input(paramName, sql.NVarChar(sql.MAX), String(val));
        whereClauses.push(`JSON_VALUE(metadata, '$.${this.sanitizeJsonPath(key)}') = @${paramName}`);
        i++;
      }
    }

    return { whereClauses, request };
  }
}
