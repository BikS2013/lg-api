/**
 * SQL Server Store (Key-Value) Storage Implementation
 *
 * Implements IStoreStorage using the mssql package with parameterized queries.
 * Namespaces are stored as JSON array strings (e.g., '["user","123","documents"]').
 */

import * as sql from 'mssql';
import type {
  IStoreStorage,
  StoreItem,
  SearchResult,
} from '../../interfaces.js';
import type { SearchItem } from '../../../types/index.js';

export class SqlServerStoreStorage implements IStoreStorage {
  private pool: sql.ConnectionPool;

  constructor(pool: sql.ConnectionPool) {
    this.pool = pool;
  }

  async putItem(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
    _index?: boolean | string[],
    _ttl?: number,
  ): Promise<StoreItem> {
    const nsStr = JSON.stringify(namespace);
    const now = new Date().toISOString();
    const valueStr = JSON.stringify(value);

    // Use MERGE for upsert
    const request = this.pool.request();
    request.input('namespace', sql.NVarChar(900), nsStr);
    request.input('key', sql.NVarChar(255), key);
    request.input('value', sql.NVarChar(sql.MAX), valueStr);
    request.input('now', sql.NVarChar, now);

    await request.query(`
      MERGE StoreItem AS target
      USING (SELECT @namespace AS namespace, @key AS [key]) AS source
      ON target.namespace = source.namespace AND target.[key] = source.[key]
      WHEN MATCHED THEN
        UPDATE SET value = @value, updated_at = @now
      WHEN NOT MATCHED THEN
        INSERT (namespace, [key], value, created_at, updated_at)
        VALUES (@namespace, @key, @value, @now, @now);
    `);

    // Retrieve the item to get the actual created_at
    const getReq = this.pool.request();
    getReq.input('namespace', sql.NVarChar(900), nsStr);
    getReq.input('key', sql.NVarChar(255), key);
    const result = await getReq.query<Record<string, unknown>>(
      'SELECT * FROM StoreItem WHERE namespace = @namespace AND [key] = @key',
    );

    if (result.recordset.length > 0) {
      return this.rowToStoreItem(result.recordset[0]);
    }

    // Fallback (should not happen after MERGE)
    return {
      namespace,
      key,
      value,
      created_at: now,
      updated_at: now,
    };
  }

  async getItem(namespace: string[], key: string): Promise<StoreItem | null> {
    const nsStr = JSON.stringify(namespace);

    const request = this.pool.request();
    request.input('namespace', sql.NVarChar(900), nsStr);
    request.input('key', sql.NVarChar(255), key);

    const result = await request.query<Record<string, unknown>>(
      'SELECT * FROM StoreItem WHERE namespace = @namespace AND [key] = @key',
    );

    if (result.recordset.length === 0) return null;
    return this.rowToStoreItem(result.recordset[0]);
  }

  async deleteItem(namespace: string[], key: string): Promise<boolean> {
    const nsStr = JSON.stringify(namespace);

    const request = this.pool.request();
    request.input('namespace', sql.NVarChar(900), nsStr);
    request.input('key', sql.NVarChar(255), key);

    const result = await request.query(
      'DELETE FROM StoreItem WHERE namespace = @namespace AND [key] = @key',
    );

    return (result.rowsAffected[0] ?? 0) > 0;
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
    const prefixStr = JSON.stringify(namespacePrefix);
    // For prefix matching: remove the trailing ']' and use LIKE with '%'
    const likePattern = prefixStr.length > 2
      ? prefixStr.substring(0, prefixStr.length - 1) + '%'
      : '%';

    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const whereClauses: string[] = ['namespace LIKE @prefix'];
    const countReq = this.pool.request();
    countReq.input('prefix', sql.NVarChar(900), likePattern);

    const dataReq = this.pool.request();
    dataReq.input('prefix', sql.NVarChar(900), likePattern);

    // Apply value-level filters using JSON_VALUE
    if (options.filter && typeof options.filter === 'object') {
      let i = 0;
      for (const [key, val] of Object.entries(options.filter)) {
        const paramName = `filter_${i}`;
        const sanitizedKey = key.replace(/[^a-zA-Z0-9_.]/g, '');
        countReq.input(paramName, sql.NVarChar(sql.MAX), String(val));
        dataReq.input(paramName, sql.NVarChar(sql.MAX), String(val));
        whereClauses.push(`JSON_VALUE(value, '$.${sanitizedKey}') = @${paramName}`);
        i++;
      }
    }

    const whereStr = `WHERE ${whereClauses.join(' AND ')}`;

    // Count
    const countResult = await countReq.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM StoreItem ${whereStr}`,
    );
    const total = countResult.recordset[0].total;

    // Data
    dataReq.input('offset', sql.Int, offset);
    dataReq.input('limit', sql.Int, limit);

    const dataResult = await dataReq.query<Record<string, unknown>>(`
      SELECT * FROM StoreItem ${whereStr}
      ORDER BY updated_at DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

    const items: SearchItem[] = dataResult.recordset.map((row) => ({
      ...this.rowToStoreItem(row),
      score: undefined,
    }));

    return { items, total };
  }

  async listNamespaces(options: {
    prefix?: string[];
    suffix?: string[];
    maxDepth?: number;
    limit?: number;
    offset?: number;
  }): Promise<string[][]> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const whereClauses: string[] = [];
    const request = this.pool.request();

    if (options.prefix && options.prefix.length > 0) {
      const prefixStr = JSON.stringify(options.prefix);
      const likePattern = prefixStr.substring(0, prefixStr.length - 1) + '%';
      request.input('prefix', sql.NVarChar(900), likePattern);
      whereClauses.push('namespace LIKE @prefix');
    }

    if (options.suffix && options.suffix.length > 0) {
      const suffixStr = JSON.stringify(options.suffix);
      const likePattern = '%' + suffixStr.substring(1);
      request.input('suffix', sql.NVarChar(900), likePattern);
      whereClauses.push('namespace LIKE @suffix');
    }

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    request.input('offset', sql.Int, offset);
    request.input('limit', sql.Int, limit);

    const result = await request.query<{ namespace: string }>(`
      SELECT DISTINCT namespace FROM StoreItem ${whereStr}
      ORDER BY namespace
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

    let namespaces = result.recordset.map((row) => {
      try {
        return JSON.parse(row.namespace) as string[];
      } catch {
        return [row.namespace];
      }
    });

    // Apply maxDepth filter
    if (options.maxDepth !== undefined) {
      namespaces = namespaces.filter((ns) => ns.length <= options.maxDepth!);
    }

    return namespaces;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private rowToStoreItem(row: Record<string, unknown>): StoreItem {
    let namespace: string[];
    try {
      namespace = JSON.parse(row.namespace as string) as string[];
    } catch {
      namespace = [row.namespace as string];
    }

    return {
      namespace,
      key: row.key as string,
      value: this.parseJson(row.value as string),
      created_at: this.toISOString(row.created_at),
      updated_at: this.toISOString(row.updated_at),
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
}
