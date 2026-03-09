/**
 * SQLite Assistant Storage Implementation
 *
 * Implements IAssistantStorage using better-sqlite3 synchronous API
 * wrapped in async methods.
 */

import type Database from 'better-sqlite3';
import type {
  IAssistantStorage,
  SearchOptions,
  SearchResult,
} from '../../interfaces.js';
import type { Assistant } from '../../../types/index.js';

export class SqliteAssistantStorage implements IAssistantStorage {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  async create(assistant: Assistant): Promise<Assistant> {
    const stmt = this.db.prepare(`
      INSERT INTO Assistant (assistant_id, graph_id, config, context, created_at, updated_at, metadata, version, name, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      assistant.assistant_id,
      assistant.graph_id,
      JSON.stringify(assistant.config),
      assistant.context != null ? JSON.stringify(assistant.context) : null,
      assistant.created_at,
      assistant.updated_at,
      JSON.stringify(assistant.metadata),
      assistant.version,
      assistant.name,
      assistant.description ?? null,
    );
    return structuredClone(assistant);
  }

  async getById(assistantId: string): Promise<Assistant | null> {
    const stmt = this.db.prepare('SELECT * FROM Assistant WHERE assistant_id = ?');
    const row = stmt.get(assistantId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToAssistant(row);
  }

  async update(assistantId: string, updates: Partial<Assistant>): Promise<Assistant | null> {
    const existing = await this.getById(assistantId);
    if (!existing) return null;

    const merged: Assistant = {
      ...existing,
      ...updates,
      updated_at: updates.updated_at ?? new Date().toISOString(),
    };

    const stmt = this.db.prepare(`
      UPDATE Assistant
      SET graph_id = ?, config = ?, context = ?, created_at = ?, updated_at = ?,
          metadata = ?, version = ?, name = ?, description = ?
      WHERE assistant_id = ?
    `);
    stmt.run(
      merged.graph_id,
      JSON.stringify(merged.config),
      merged.context != null ? JSON.stringify(merged.context) : null,
      merged.created_at,
      merged.updated_at,
      JSON.stringify(merged.metadata),
      merged.version,
      merged.name,
      merged.description ?? null,
      assistantId,
    );
    return structuredClone(merged);
  }

  async delete(assistantId: string): Promise<boolean> {
    const stmt = this.db.prepare('DELETE FROM Assistant WHERE assistant_id = ?');
    const result = stmt.run(assistantId);
    return result.changes > 0;
  }

  async search(
    options: SearchOptions,
    filters?: Record<string, unknown>,
  ): Promise<SearchResult<Assistant>> {
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
        } else if (key === 'graph_id') {
          conditions.push('graph_id = ?');
          params.push(value);
        } else if (key === 'name') {
          conditions.push('name = ?');
          params.push(value);
        }
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sortBy = options.sortBy ?? 'created_at';
    const sortOrder = options.sortOrder ?? 'desc';

    const countStmt = this.db.prepare(`SELECT COUNT(*) as cnt FROM Assistant ${whereClause}`);
    const countRow = countStmt.get(...params) as { cnt: number };
    const total = countRow.cnt;

    const selectStmt = this.db.prepare(
      `SELECT * FROM Assistant ${whereClause} ORDER BY ${sortBy} ${sortOrder} LIMIT ? OFFSET ?`,
    );
    const rows = selectStmt.all(...params, options.limit, options.offset) as Record<string, unknown>[];

    return {
      items: rows.map((r) => this.rowToAssistant(r)),
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
        } else if (key === 'graph_id') {
          conditions.push('graph_id = ?');
          params.push(value);
        } else if (key === 'name') {
          conditions.push('name = ?');
          params.push(value);
        }
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const stmt = this.db.prepare(`SELECT COUNT(*) as cnt FROM Assistant ${whereClause}`);
    const row = stmt.get(...params) as { cnt: number };
    return row.cnt;
  }

  async getVersions(
    assistantId: string,
    limit?: number,
    offset?: number,
  ): Promise<SearchResult<Assistant>> {
    const effectiveLimit = limit ?? 100;
    const effectiveOffset = offset ?? 0;

    const countStmt = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM AssistantVersion WHERE assistant_id = ?`,
    );
    const countRow = countStmt.get(assistantId) as { cnt: number };
    const total = countRow.cnt;

    const stmt = this.db.prepare(
      `SELECT * FROM AssistantVersion WHERE assistant_id = ? ORDER BY version DESC LIMIT ? OFFSET ?`,
    );
    const rows = stmt.all(assistantId, effectiveLimit, effectiveOffset) as Record<string, unknown>[];

    return {
      items: rows.map((r) => this.rowToAssistant(r)),
      total,
    };
  }

  async addVersion(assistantId: string, version: Assistant): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO AssistantVersion (assistant_id, graph_id, config, context, created_at, updated_at, metadata, version, name, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      assistantId,
      version.graph_id,
      JSON.stringify(version.config),
      version.context != null ? JSON.stringify(version.context) : null,
      version.created_at,
      version.updated_at,
      JSON.stringify(version.metadata),
      version.version,
      version.name,
      version.description ?? null,
    );
  }

  async setLatestVersion(assistantId: string, version: number): Promise<Assistant | null> {
    const versionStmt = this.db.prepare(
      `SELECT * FROM AssistantVersion WHERE assistant_id = ? AND version = ?`,
    );
    const versionRow = versionStmt.get(assistantId, version) as Record<string, unknown> | undefined;
    if (!versionRow) return null;

    const versionData = this.rowToAssistant(versionRow);
    const now = new Date().toISOString();

    const updateStmt = this.db.prepare(`
      UPDATE Assistant
      SET graph_id = ?, config = ?, context = ?, updated_at = ?,
          metadata = ?, version = ?, name = ?, description = ?
      WHERE assistant_id = ?
    `);
    updateStmt.run(
      versionData.graph_id,
      JSON.stringify(versionData.config),
      versionData.context != null ? JSON.stringify(versionData.context) : null,
      now,
      JSON.stringify(versionData.metadata),
      versionData.version,
      versionData.name,
      versionData.description ?? null,
      assistantId,
    );

    return this.getById(assistantId);
  }

  private rowToAssistant(row: Record<string, unknown>): Assistant {
    return {
      assistant_id: row.assistant_id as string,
      graph_id: row.graph_id as string,
      config: JSON.parse(row.config as string),
      context: row.context != null ? JSON.parse(row.context as string) : undefined,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      metadata: JSON.parse(row.metadata as string),
      version: row.version as number,
      name: row.name as string,
      description: row.description as string | null,
    };
  }
}
