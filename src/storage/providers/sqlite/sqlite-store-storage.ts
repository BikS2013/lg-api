/**
 * SQLite Store (Key-Value) Storage Implementation
 *
 * Implements IStoreStorage using better-sqlite3 synchronous API
 * wrapped in async methods.
 *
 * Namespaces are stored as JSON array strings (e.g., '["users","prefs"]').
 */

import type Database from 'better-sqlite3';
import type {
  IStoreStorage,
  StoreItem,
  SearchResult,
} from '../../interfaces.js';
import type { SearchItem } from '../../../types/index.js';

export class SqliteStoreStorage implements IStoreStorage {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  async putItem(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
    _index?: boolean | string[],
    _ttl?: number,
  ): Promise<StoreItem> {
    const nsKey = JSON.stringify(namespace);
    const now = new Date().toISOString();

    const existingStmt = this.db.prepare(
      'SELECT created_at FROM StoreItem WHERE namespace = ? AND key = ?',
    );
    const existing = existingStmt.get(nsKey, key) as { created_at: string } | undefined;
    const createdAt = existing?.created_at ?? now;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO StoreItem (namespace, key, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(nsKey, key, JSON.stringify(value), createdAt, now);

    return {
      namespace,
      key,
      value,
      created_at: createdAt,
      updated_at: now,
    };
  }

  async getItem(namespace: string[], key: string): Promise<StoreItem | null> {
    const nsKey = JSON.stringify(namespace);
    const stmt = this.db.prepare(
      'SELECT * FROM StoreItem WHERE namespace = ? AND key = ?',
    );
    const row = stmt.get(nsKey, key) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToStoreItem(row);
  }

  async deleteItem(namespace: string[], key: string): Promise<boolean> {
    const nsKey = JSON.stringify(namespace);
    const stmt = this.db.prepare(
      'DELETE FROM StoreItem WHERE namespace = ? AND key = ?',
    );
    const result = stmt.run(nsKey, key);
    return result.changes > 0;
  }

  async searchItems(
    namespacePrefix: string[],
    options: {
      filter?: Record<string, unknown>;
      limit?: number;
      offset?: number;
      query?: string;
    },
  ): Promise<SearchResult<SearchItem>> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    // Namespace prefix matching: the stored JSON array must start with the prefix elements
    if (namespacePrefix.length > 0) {
      // Build a LIKE pattern: '["elem1","elem2"' (without closing bracket)
      // so that ["elem1","elem2","anything"] matches
      const prefixStr = JSON.stringify(namespacePrefix);
      // Remove the trailing ']' and use LIKE
      const likePattern = prefixStr.slice(0, -1) + '%';
      conditions.push('namespace LIKE ?');
      params.push(likePattern);
    }

    // Filter on JSON value fields
    if (options.filter) {
      for (const [key, value] of Object.entries(options.filter)) {
        conditions.push(`json_extract(value, ?) = ?`);
        params.push(`$.${key}`, typeof value === 'string' ? value : JSON.stringify(value));
      }
    }

    // Simple text query on value
    if (options.query) {
      conditions.push('value LIKE ?');
      params.push(`%${options.query}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const countStmt = this.db.prepare(`SELECT COUNT(*) as cnt FROM StoreItem ${whereClause}`);
    const countRow = countStmt.get(...params) as { cnt: number };
    const total = countRow.cnt;

    const selectStmt = this.db.prepare(
      `SELECT * FROM StoreItem ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    );
    const rows = selectStmt.all(...params, limit, offset) as Record<string, unknown>[];

    return {
      items: rows.map((r) => this.rowToSearchItem(r)),
      total,
    };
  }

  async listNamespaces(options: {
    prefix?: string[];
    suffix?: string[];
    maxDepth?: number;
    limit?: number;
    offset?: number;
  }): Promise<string[][]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.prefix && options.prefix.length > 0) {
      const prefixStr = JSON.stringify(options.prefix);
      const likePattern = prefixStr.slice(0, -1) + '%';
      conditions.push('namespace LIKE ?');
      params.push(likePattern);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const stmt = this.db.prepare(
      `SELECT DISTINCT namespace FROM StoreItem ${whereClause} ORDER BY namespace`,
    );
    let rows = stmt.all(...params) as { namespace: string }[];

    // Parse all namespaces
    let namespaces = rows.map((r) => JSON.parse(r.namespace) as string[]);

    // Apply suffix filter
    if (options.suffix && options.suffix.length > 0) {
      const suffix = options.suffix;
      namespaces = namespaces.filter((ns) => {
        if (ns.length < suffix.length) return false;
        const nsSuffix = ns.slice(ns.length - suffix.length);
        return nsSuffix.every((val, idx) => val === suffix[idx]);
      });
    }

    // Apply maxDepth filter
    if (options.maxDepth != null) {
      namespaces = namespaces.filter((ns) => ns.length <= options.maxDepth!);
    }

    // Apply pagination
    const offset = options.offset ?? 0;
    const limit = options.limit ?? namespaces.length;
    namespaces = namespaces.slice(offset, offset + limit);

    return namespaces;
  }

  private rowToStoreItem(row: Record<string, unknown>): StoreItem {
    return {
      namespace: JSON.parse(row.namespace as string),
      key: row.key as string,
      value: JSON.parse(row.value as string),
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  private rowToSearchItem(row: Record<string, unknown>): SearchItem {
    return {
      namespace: JSON.parse(row.namespace as string),
      key: row.key as string,
      value: JSON.parse(row.value as string),
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }
}
