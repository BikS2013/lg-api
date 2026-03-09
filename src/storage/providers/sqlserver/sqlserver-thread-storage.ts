/**
 * SQL Server Thread Storage Implementation
 *
 * Implements IThreadStorage using the mssql package with parameterized queries.
 */

import * as sql from 'mssql';
import type {
  IThreadStorage,
  SearchOptions,
  SearchResult,
} from '../../interfaces.js';
import type { Thread, ThreadState } from '../../../types/index.js';

export class SqlServerThreadStorage implements IThreadStorage {
  private pool: sql.ConnectionPool;

  constructor(pool: sql.ConnectionPool) {
    this.pool = pool;
  }

  async create(thread: Thread): Promise<Thread> {
    const request = this.pool.request();
    request.input('thread_id', sql.NVarChar(36), thread.thread_id);
    request.input('created_at', sql.NVarChar, thread.created_at);
    request.input('updated_at', sql.NVarChar, thread.updated_at);
    request.input('metadata', sql.NVarChar(sql.MAX), JSON.stringify(thread.metadata));
    request.input('status', sql.NVarChar(20), thread.status);
    request.input('values', sql.NVarChar(sql.MAX), thread.values ? JSON.stringify(thread.values) : null);
    request.input('interrupts', sql.NVarChar(sql.MAX), thread.interrupts ? JSON.stringify(thread.interrupts) : null);

    await request.query(`
      INSERT INTO Thread (thread_id, created_at, updated_at, metadata, status, [values], interrupts)
      VALUES (@thread_id, @created_at, @updated_at, @metadata, @status, @values, @interrupts)
    `);

    return thread;
  }

  async getById(threadId: string): Promise<Thread | null> {
    const request = this.pool.request();
    request.input('thread_id', sql.NVarChar(36), threadId);

    const result = await request.query<Record<string, unknown>>(
      'SELECT * FROM Thread WHERE thread_id = @thread_id',
    );

    if (result.recordset.length === 0) return null;
    return this.rowToThread(result.recordset[0]);
  }

  async update(threadId: string, updates: Partial<Thread>): Promise<Thread | null> {
    const existing = await this.getById(threadId);
    if (!existing) return null;

    const merged: Thread = { ...existing, ...updates };
    const now = new Date().toISOString();
    merged.updated_at = now;

    const request = this.pool.request();
    request.input('thread_id', sql.NVarChar(36), threadId);
    request.input('updated_at', sql.NVarChar, merged.updated_at);
    request.input('metadata', sql.NVarChar(sql.MAX), JSON.stringify(merged.metadata));
    request.input('status', sql.NVarChar(20), merged.status);
    request.input('values', sql.NVarChar(sql.MAX), merged.values ? JSON.stringify(merged.values) : null);
    request.input('interrupts', sql.NVarChar(sql.MAX), merged.interrupts ? JSON.stringify(merged.interrupts) : null);

    await request.query(`
      UPDATE Thread
      SET updated_at = @updated_at,
          metadata = @metadata,
          status = @status,
          [values] = @values,
          interrupts = @interrupts
      WHERE thread_id = @thread_id
    `);

    return merged;
  }

  async delete(threadId: string): Promise<boolean> {
    const request = this.pool.request();
    request.input('thread_id', sql.NVarChar(36), threadId);

    const result = await request.query(
      'DELETE FROM Thread WHERE thread_id = @thread_id',
    );

    return (result.rowsAffected[0] ?? 0) > 0;
  }

  async search(
    options: SearchOptions,
    filters?: Record<string, unknown>,
  ): Promise<SearchResult<Thread>> {
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
      `SELECT COUNT(*) AS total FROM Thread ${whereStr}`,
    );
    const total = countResult.recordset[0].total;

    // Data query with pagination
    const dataRequest = this.pool.request();
    // Re-add inputs for the data query
    const { request: dataReq } = this.buildFilterClauses(
      dataRequest,
      filters,
      options.metadata,
    );
    dataReq.input('offset', sql.Int, options.offset);
    dataReq.input('limit', sql.Int, options.limit);

    const dataResult = await dataReq.query<Record<string, unknown>>(`
      SELECT * FROM Thread ${whereStr}
      ORDER BY ${this.sanitizeColumnName(sortBy)} ${sortOrder}
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

    const items = dataResult.recordset.map((row) => this.rowToThread(row));
    return { items, total };
  }

  async count(filters?: Record<string, unknown>): Promise<number> {
    const { whereClauses, request } = this.buildFilterClauses(
      this.pool.request(),
      filters,
    );

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const result = await request.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM Thread ${whereStr}`,
    );

    return result.recordset[0].total;
  }

  async getState(threadId: string): Promise<ThreadState | null> {
    const request = this.pool.request();
    request.input('thread_id', sql.NVarChar(36), threadId);

    const result = await request.query<Record<string, unknown>>(`
      SELECT TOP 1 * FROM ThreadState
      WHERE thread_id = @thread_id
      ORDER BY created_at DESC
    `);

    if (result.recordset.length === 0) return null;
    return this.rowToThreadState(result.recordset[0]);
  }

  async addState(threadId: string, state: ThreadState): Promise<void> {
    const request = this.pool.request();
    request.input('thread_id', sql.NVarChar(36), threadId);
    request.input('values', sql.NVarChar(sql.MAX), JSON.stringify(state.values));
    request.input('next', sql.NVarChar(sql.MAX), JSON.stringify(state.next));
    request.input('checkpoint', sql.NVarChar(sql.MAX), JSON.stringify(state.checkpoint));
    request.input('metadata', sql.NVarChar(sql.MAX), JSON.stringify(state.metadata));
    request.input('created_at', sql.NVarChar, state.created_at);
    request.input('parent_checkpoint', sql.NVarChar(sql.MAX),
      state.parent_checkpoint ? JSON.stringify(state.parent_checkpoint) : null);
    request.input('tasks', sql.NVarChar(sql.MAX), JSON.stringify(state.tasks));
    request.input('interrupts', sql.NVarChar(sql.MAX),
      state.interrupts ? JSON.stringify(state.interrupts) : null);

    await request.query(`
      INSERT INTO ThreadState (thread_id, [values], next, checkpoint, metadata, created_at, parent_checkpoint, tasks, interrupts)
      VALUES (@thread_id, @values, @next, @checkpoint, @metadata, @created_at, @parent_checkpoint, @tasks, @interrupts)
    `);
  }

  async getStateHistory(
    threadId: string,
    limit?: number,
    before?: string,
  ): Promise<ThreadState[]> {
    const request = this.pool.request();
    request.input('thread_id', sql.NVarChar(36), threadId);

    const clauses = ['thread_id = @thread_id'];
    if (before) {
      request.input('before', sql.NVarChar, before);
      clauses.push('created_at < @before');
    }

    const fetchLimit = limit ?? 100;
    request.input('limit', sql.Int, fetchLimit);

    const result = await request.query<Record<string, unknown>>(`
      SELECT * FROM ThreadState
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC
      OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY
    `);

    return result.recordset.map((row) => this.rowToThreadState(row));
  }

  async copyThread(sourceId: string, targetId: string): Promise<Thread> {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin();

    try {
      // Get source thread
      const getReq = transaction.request();
      getReq.input('source_id', sql.NVarChar(36), sourceId);
      const sourceResult = await getReq.query<Record<string, unknown>>(
        'SELECT * FROM Thread WHERE thread_id = @source_id',
      );

      if (sourceResult.recordset.length === 0) {
        throw new Error(`Thread not found: ${sourceId}`);
      }

      const source = this.rowToThread(sourceResult.recordset[0]);
      const now = new Date().toISOString();

      const newThread: Thread = {
        ...source,
        thread_id: targetId,
        created_at: now,
        updated_at: now,
      };

      // Insert new thread
      const insertReq = transaction.request();
      insertReq.input('thread_id', sql.NVarChar(36), newThread.thread_id);
      insertReq.input('created_at', sql.NVarChar, newThread.created_at);
      insertReq.input('updated_at', sql.NVarChar, newThread.updated_at);
      insertReq.input('metadata', sql.NVarChar(sql.MAX), JSON.stringify(newThread.metadata));
      insertReq.input('status', sql.NVarChar(20), newThread.status);
      insertReq.input('values', sql.NVarChar(sql.MAX), newThread.values ? JSON.stringify(newThread.values) : null);
      insertReq.input('interrupts', sql.NVarChar(sql.MAX), newThread.interrupts ? JSON.stringify(newThread.interrupts) : null);

      await insertReq.query(`
        INSERT INTO Thread (thread_id, created_at, updated_at, metadata, status, [values], interrupts)
        VALUES (@thread_id, @created_at, @updated_at, @metadata, @status, @values, @interrupts)
      `);

      // Copy thread states
      const statesReq = transaction.request();
      statesReq.input('source_id', sql.NVarChar(36), sourceId);
      const statesResult = await statesReq.query<Record<string, unknown>>(
        'SELECT * FROM ThreadState WHERE thread_id = @source_id ORDER BY created_at ASC',
      );

      for (const stateRow of statesResult.recordset) {
        const copyReq = transaction.request();
        copyReq.input('thread_id', sql.NVarChar(36), targetId);
        copyReq.input('values', sql.NVarChar(sql.MAX), stateRow.values as string);
        copyReq.input('next', sql.NVarChar(sql.MAX), stateRow.next as string);
        copyReq.input('checkpoint', sql.NVarChar(sql.MAX), stateRow.checkpoint as string);
        copyReq.input('metadata', sql.NVarChar(sql.MAX), stateRow.metadata as string);
        copyReq.input('created_at', sql.NVarChar, (stateRow.created_at as Date).toISOString());
        copyReq.input('parent_checkpoint', sql.NVarChar(sql.MAX), stateRow.parent_checkpoint as string | null);
        copyReq.input('tasks', sql.NVarChar(sql.MAX), stateRow.tasks as string);
        copyReq.input('interrupts', sql.NVarChar(sql.MAX), stateRow.interrupts as string | null);

        await copyReq.query(`
          INSERT INTO ThreadState (thread_id, [values], next, checkpoint, metadata, created_at, parent_checkpoint, tasks, interrupts)
          VALUES (@thread_id, @values, @next, @checkpoint, @metadata, @created_at, @parent_checkpoint, @tasks, @interrupts)
        `);
      }

      await transaction.commit();
      return newThread;
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private rowToThread(row: Record<string, unknown>): Thread {
    return {
      thread_id: row.thread_id as string,
      created_at: this.toISOString(row.created_at),
      updated_at: this.toISOString(row.updated_at),
      metadata: this.parseJson(row.metadata as string) as Record<string, unknown>,
      status: row.status as Thread['status'],
      values: row.values ? this.parseJson(row.values as string) as Record<string, unknown> : undefined,
      interrupts: row.interrupts ? this.parseJsonAs<Thread['interrupts']>(row.interrupts as string) : undefined,
    };
  }

  private rowToThreadState(row: Record<string, unknown>): ThreadState {
    return {
      values: this.parseJson(row.values as string) as Record<string, unknown>,
      next: this.parseJsonAs<string[]>(row.next as string) ?? [],
      checkpoint: this.parseJsonAs<ThreadState['checkpoint']>(row.checkpoint as string) as ThreadState['checkpoint'],
      metadata: this.parseJson(row.metadata as string) as Record<string, unknown>,
      created_at: this.toISOString(row.created_at),
      parent_checkpoint: row.parent_checkpoint
        ? this.parseJsonAs<ThreadState['parent_checkpoint']>(row.parent_checkpoint as string)
        : undefined,
      tasks: this.parseJsonAs<ThreadState['tasks']>(row.tasks as string) ?? [],
      interrupts: row.interrupts ? this.parseJsonAs<ThreadState['interrupts']>(row.interrupts as string) : undefined,
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

  private parseJsonAs<T>(value: string | null | undefined): T {
    if (!value) return undefined as unknown as T;
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined as unknown as T;
    }
  }

  private toISOString(value: unknown): string {
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }

  private sanitizeColumnName(name: string): string {
    // Allow only alphanumeric and underscore to prevent SQL injection in ORDER BY
    const sanitized = name.replace(/[^a-zA-Z0-9_]/g, '');
    // Wrap reserved words in brackets
    if (sanitized.toLowerCase() === 'values') return '[values]';
    return sanitized;
  }

  private buildFilterClauses(
    request: sql.Request,
    filters?: Record<string, unknown>,
    metadataFilters?: Record<string, unknown>,
  ): { whereClauses: string[]; request: sql.Request } {
    const whereClauses: string[] = [];

    if (filters) {
      if (filters.status !== undefined) {
        request.input('filter_status', sql.NVarChar(20), String(filters.status));
        whereClauses.push('status = @filter_status');
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

  private sanitizeJsonPath(key: string): string {
    // Prevent injection in JSON_VALUE paths
    return key.replace(/[^a-zA-Z0-9_.]/g, '');
  }
}
