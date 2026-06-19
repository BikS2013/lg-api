/**
 * SQLite Thread Storage Implementation
 *
 * Implements IThreadStorage using better-sqlite3 synchronous API
 * wrapped in async methods.
 */

import type Database from 'better-sqlite3';
import type {
  IThreadStorage,
  SearchOptions,
  SearchResult,
} from '../../interfaces.js';
import type { Thread, ThreadState } from '../../../types/index.js';
import { resolveCreateArgs } from '../../compat.js';

export class SqliteThreadStorage implements IThreadStorage {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  async create(threadOrId: Thread | string, maybeThread?: unknown): Promise<Thread> {
    const thread = resolveCreateArgs<Thread>(threadOrId, maybeThread);
    const stmt = this.db.prepare(`
      INSERT INTO Thread (thread_id, created_at, updated_at, metadata, status, "values", interrupts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      thread.thread_id,
      thread.created_at,
      thread.updated_at,
      JSON.stringify(thread.metadata),
      thread.status,
      thread.values != null ? JSON.stringify(thread.values) : null,
      thread.interrupts != null ? JSON.stringify(thread.interrupts) : null,
    );
    return structuredClone(thread);
  }

  async getById(threadId: string): Promise<Thread | null> {
    const stmt = this.db.prepare('SELECT * FROM Thread WHERE thread_id = ?');
    const row = stmt.get(threadId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToThread(row);
  }

  async update(threadId: string, updates: Partial<Thread>): Promise<Thread | null> {
    const existing = await this.getById(threadId);
    if (!existing) return null;

    const merged: Thread = { ...existing, ...updates, updated_at: updates.updated_at ?? new Date().toISOString() };
    const stmt = this.db.prepare(`
      UPDATE Thread
      SET created_at = ?, updated_at = ?, metadata = ?, status = ?, "values" = ?, interrupts = ?
      WHERE thread_id = ?
    `);
    stmt.run(
      merged.created_at,
      merged.updated_at,
      JSON.stringify(merged.metadata),
      merged.status,
      merged.values != null ? JSON.stringify(merged.values) : null,
      merged.interrupts != null ? JSON.stringify(merged.interrupts) : null,
      threadId,
    );
    return structuredClone(merged);
  }

  async delete(threadId: string): Promise<boolean> {
    const stmt = this.db.prepare('DELETE FROM Thread WHERE thread_id = ?');
    const result = stmt.run(threadId);
    return result.changes > 0;
  }

  async search(
    options: SearchOptions,
    filters?: Record<string, unknown>,
  ): Promise<SearchResult<Thread>> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    // Metadata filtering
    if (options.metadata) {
      for (const [key, value] of Object.entries(options.metadata)) {
        conditions.push(`json_extract(metadata, ?) = ?`);
        params.push(`$.${key}`, typeof value === 'string' ? value : JSON.stringify(value));
      }
    }

    // Additional filters
    if (filters) {
      this.appendFilterConditions(filters, conditions, params);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sortBy = options.sortBy ?? 'created_at';
    const sortOrder = options.sortOrder ?? 'desc';

    // Count total
    const countStmt = this.db.prepare(`SELECT COUNT(*) as cnt FROM Thread ${whereClause}`);
    const countRow = countStmt.get(...params) as { cnt: number };
    const total = countRow.cnt;

    // Fetch page
    const selectStmt = this.db.prepare(
      `SELECT * FROM Thread ${whereClause} ORDER BY ${sortBy} ${sortOrder} LIMIT ? OFFSET ?`,
    );
    const rows = selectStmt.all(...params, options.limit, options.offset) as Record<string, unknown>[];

    return {
      items: rows.map((r) => this.rowToThread(r)),
      total,
    };
  }

  async count(filters?: Record<string, unknown>): Promise<number> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters) {
      this.appendFilterConditions(filters, conditions, params);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const stmt = this.db.prepare(`SELECT COUNT(*) as cnt FROM Thread ${whereClause}`);
    const row = stmt.get(...params) as { cnt: number };
    return row.cnt;
  }

  /**
   * Translate the shared filter bag into SQL WHERE conditions (pushed into the
   * query, so LIMIT/OFFSET paginate the filtered set). Supports `status`, the
   * `metadata` object filter, and the canonical `values` state filter — each
   * matched with json_extract so the page and count stay consistent (ADR-0002).
   */
  private appendFilterConditions(
    filters: Record<string, unknown>,
    conditions: string[],
    params: unknown[],
  ): void {
    for (const [key, value] of Object.entries(filters)) {
      if (key === 'metadata' || key === 'values') {
        const column = key === 'metadata' ? 'metadata' : '"values"';
        const objFilter = value as Record<string, unknown>;
        for (const [fKey, fValue] of Object.entries(objFilter)) {
          // json_extract returns JSON text for objects/arrays; compare against a
          // JSON-encoded expectation for non-strings so nested filters work.
          conditions.push(`json_extract(${column}, ?) = ?`);
          params.push(`$.${fKey}`, typeof fValue === 'string' ? fValue : JSON.stringify(fValue));
        }
      } else if (key === 'status') {
        conditions.push('status = ?');
        params.push(value);
      }
    }
  }

  async getState(threadId: string): Promise<ThreadState | null> {
    const stmt = this.db.prepare(
      `SELECT * FROM ThreadState WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    );
    const row = stmt.get(threadId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToThreadState(row);
  }

  async addState(threadId: string, state: ThreadState): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO ThreadState (thread_id, "values", next, checkpoint, metadata, created_at, parent_checkpoint, tasks, interrupts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      threadId,
      JSON.stringify(state.values),
      JSON.stringify(state.next),
      JSON.stringify(state.checkpoint),
      JSON.stringify(state.metadata),
      state.created_at,
      state.parent_checkpoint != null ? JSON.stringify(state.parent_checkpoint) : null,
      JSON.stringify(state.tasks),
      state.interrupts != null ? JSON.stringify(state.interrupts) : null,
    );
  }

  async getStateHistory(
    threadId: string,
    options?: { limit?: number; before?: string; metadata?: Record<string, unknown> },
  ): Promise<ThreadState[]> {
    const conditions: string[] = ['thread_id = ?'];
    const params: unknown[] = [threadId];

    if (options?.before) {
      conditions.push('created_at < ?');
      params.push(options.before);
    }

    const effectiveLimit = options?.limit ?? 100;
    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const stmt = this.db.prepare(
      `SELECT * FROM ThreadState ${whereClause} ORDER BY created_at DESC, id DESC LIMIT ?`,
    );
    let rows = stmt.all(...params, effectiveLimit) as Record<string, unknown>[];
    let items = rows.map((r) => this.rowToThreadState(r));

    if (options?.metadata) {
      items = items.filter((s) =>
        Object.entries(options.metadata!).every(([k, v]) =>
          (s.metadata as Record<string, unknown>)?.[k] === v,
        ),
      );
    }

    return items;
  }

  async copyThread(sourceId: string, targetId: string): Promise<Thread> {
    const source = await this.getById(sourceId);
    if (!source) {
      throw new Error(`Thread not found: ${sourceId}`);
    }

    const now = new Date().toISOString();
    const copied: Thread = {
      ...structuredClone(source),
      thread_id: targetId,
      created_at: now,
      updated_at: now,
    };

    await this.create(copied);

    // Copy all state history
    const stateHistory = await this.getStateHistory(sourceId);
    for (const state of stateHistory.reverse()) {
      await this.addState(targetId, structuredClone(state));
    }

    return copied;
  }

  private rowToThread(row: Record<string, unknown>): Thread {
    return {
      thread_id: row.thread_id as string,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      metadata: JSON.parse(row.metadata as string),
      status: row.status as Thread['status'],
      values: row.values != null ? JSON.parse(row.values as string) : undefined,
      interrupts: row.interrupts != null ? JSON.parse(row.interrupts as string) : undefined,
    };
  }

  private rowToThreadState(row: Record<string, unknown>): ThreadState {
    return {
      values: JSON.parse(row.values as string),
      next: JSON.parse(row.next as string),
      checkpoint: JSON.parse(row.checkpoint as string),
      metadata: JSON.parse(row.metadata as string),
      created_at: row.created_at as string,
      parent_checkpoint: row.parent_checkpoint != null
        ? JSON.parse(row.parent_checkpoint as string)
        : undefined,
      tasks: JSON.parse(row.tasks as string),
      interrupts: row.interrupts != null
        ? JSON.parse(row.interrupts as string)
        : undefined,
    };
  }
}
