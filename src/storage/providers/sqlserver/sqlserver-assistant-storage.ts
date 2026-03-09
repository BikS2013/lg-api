/**
 * SQL Server Assistant Storage Implementation
 *
 * Implements IAssistantStorage using the mssql package with parameterized queries.
 */

import * as sql from 'mssql';
import type {
  IAssistantStorage,
  SearchOptions,
  SearchResult,
} from '../../interfaces.js';
import type { Assistant } from '../../../types/index.js';

export class SqlServerAssistantStorage implements IAssistantStorage {
  private pool: sql.ConnectionPool;

  constructor(pool: sql.ConnectionPool) {
    this.pool = pool;
  }

  async create(assistant: Assistant): Promise<Assistant> {
    const request = this.pool.request();
    request.input('assistant_id', sql.NVarChar(36), assistant.assistant_id);
    request.input('graph_id', sql.NVarChar(255), assistant.graph_id);
    request.input('config', sql.NVarChar(sql.MAX), JSON.stringify(assistant.config));
    request.input('context', sql.NVarChar(sql.MAX), assistant.context ? JSON.stringify(assistant.context) : null);
    request.input('created_at', sql.NVarChar, assistant.created_at);
    request.input('updated_at', sql.NVarChar, assistant.updated_at);
    request.input('metadata', sql.NVarChar(sql.MAX), JSON.stringify(assistant.metadata));
    request.input('version', sql.Int, assistant.version);
    request.input('name', sql.NVarChar(255), assistant.name);
    request.input('description', sql.NVarChar(sql.MAX), assistant.description ?? null);

    await request.query(`
      INSERT INTO Assistant (assistant_id, graph_id, config, context, created_at, updated_at, metadata, version, name, description)
      VALUES (@assistant_id, @graph_id, @config, @context, @created_at, @updated_at, @metadata, @version, @name, @description)
    `);

    return assistant;
  }

  async getById(assistantId: string): Promise<Assistant | null> {
    const request = this.pool.request();
    request.input('assistant_id', sql.NVarChar(36), assistantId);

    const result = await request.query<Record<string, unknown>>(
      'SELECT * FROM Assistant WHERE assistant_id = @assistant_id',
    );

    if (result.recordset.length === 0) return null;
    return this.rowToAssistant(result.recordset[0]);
  }

  async update(assistantId: string, updates: Partial<Assistant>): Promise<Assistant | null> {
    const existing = await this.getById(assistantId);
    if (!existing) return null;

    const merged: Assistant = { ...existing, ...updates };
    const now = new Date().toISOString();
    merged.updated_at = now;

    const request = this.pool.request();
    request.input('assistant_id', sql.NVarChar(36), assistantId);
    request.input('graph_id', sql.NVarChar(255), merged.graph_id);
    request.input('config', sql.NVarChar(sql.MAX), JSON.stringify(merged.config));
    request.input('context', sql.NVarChar(sql.MAX), merged.context ? JSON.stringify(merged.context) : null);
    request.input('updated_at', sql.NVarChar, merged.updated_at);
    request.input('metadata', sql.NVarChar(sql.MAX), JSON.stringify(merged.metadata));
    request.input('version', sql.Int, merged.version);
    request.input('name', sql.NVarChar(255), merged.name);
    request.input('description', sql.NVarChar(sql.MAX), merged.description ?? null);

    await request.query(`
      UPDATE Assistant
      SET graph_id = @graph_id,
          config = @config,
          context = @context,
          updated_at = @updated_at,
          metadata = @metadata,
          version = @version,
          name = @name,
          description = @description
      WHERE assistant_id = @assistant_id
    `);

    return merged;
  }

  async delete(assistantId: string): Promise<boolean> {
    const request = this.pool.request();
    request.input('assistant_id', sql.NVarChar(36), assistantId);

    const result = await request.query(
      'DELETE FROM Assistant WHERE assistant_id = @assistant_id',
    );

    return (result.rowsAffected[0] ?? 0) > 0;
  }

  async search(
    options: SearchOptions,
    filters?: Record<string, unknown>,
  ): Promise<SearchResult<Assistant>> {
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
      `SELECT COUNT(*) AS total FROM Assistant ${whereStr}`,
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
      SELECT * FROM Assistant ${whereStr}
      ORDER BY ${this.sanitizeColumnName(sortBy)} ${sortOrder}
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

    const items = dataResult.recordset.map((row) => this.rowToAssistant(row));
    return { items, total };
  }

  async count(filters?: Record<string, unknown>): Promise<number> {
    const { whereClauses, request } = this.buildFilterClauses(
      this.pool.request(),
      filters,
    );

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const result = await request.query<{ total: number }>(
      `SELECT COUNT(*) AS total FROM Assistant ${whereStr}`,
    );

    return result.recordset[0].total;
  }

  async getVersions(
    assistantId: string,
    limit?: number,
    offset?: number,
  ): Promise<SearchResult<Assistant>> {
    const countReq = this.pool.request();
    countReq.input('assistant_id', sql.NVarChar(36), assistantId);
    const countResult = await countReq.query<{ total: number }>(
      'SELECT COUNT(*) AS total FROM AssistantVersion WHERE assistant_id = @assistant_id',
    );
    const total = countResult.recordset[0].total;

    const dataReq = this.pool.request();
    dataReq.input('assistant_id', sql.NVarChar(36), assistantId);
    dataReq.input('offset', sql.Int, offset ?? 0);
    dataReq.input('limit', sql.Int, limit ?? 100);

    const dataResult = await dataReq.query<Record<string, unknown>>(`
      SELECT * FROM AssistantVersion
      WHERE assistant_id = @assistant_id
      ORDER BY version DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `);

    const items = dataResult.recordset.map((row) => this.rowToAssistant(row));
    return { items, total };
  }

  async addVersion(assistantId: string, version: Assistant): Promise<void> {
    const request = this.pool.request();
    request.input('assistant_id', sql.NVarChar(36), assistantId);
    request.input('graph_id', sql.NVarChar(255), version.graph_id);
    request.input('config', sql.NVarChar(sql.MAX), JSON.stringify(version.config));
    request.input('context', sql.NVarChar(sql.MAX), version.context ? JSON.stringify(version.context) : null);
    request.input('created_at', sql.NVarChar, version.created_at);
    request.input('updated_at', sql.NVarChar, version.updated_at);
    request.input('metadata', sql.NVarChar(sql.MAX), JSON.stringify(version.metadata));
    request.input('version', sql.Int, version.version);
    request.input('name', sql.NVarChar(255), version.name);
    request.input('description', sql.NVarChar(sql.MAX), version.description ?? null);

    await request.query(`
      INSERT INTO AssistantVersion (assistant_id, graph_id, config, context, created_at, updated_at, metadata, version, name, description)
      VALUES (@assistant_id, @graph_id, @config, @context, @created_at, @updated_at, @metadata, @version, @name, @description)
    `);
  }

  async setLatestVersion(assistantId: string, version: number): Promise<Assistant | null> {
    const transaction = new sql.Transaction(this.pool);
    await transaction.begin();

    try {
      // Get the version record
      const versionReq = transaction.request();
      versionReq.input('assistant_id', sql.NVarChar(36), assistantId);
      versionReq.input('version', sql.Int, version);

      const versionResult = await versionReq.query<Record<string, unknown>>(`
        SELECT * FROM AssistantVersion
        WHERE assistant_id = @assistant_id AND version = @version
      `);

      if (versionResult.recordset.length === 0) {
        await transaction.rollback();
        return null;
      }

      const versionRow = versionResult.recordset[0];
      const now = new Date().toISOString();

      // Update the main assistant record
      const updateReq = transaction.request();
      updateReq.input('assistant_id', sql.NVarChar(36), assistantId);
      updateReq.input('graph_id', sql.NVarChar(255), versionRow.graph_id as string);
      updateReq.input('config', sql.NVarChar(sql.MAX), versionRow.config as string);
      updateReq.input('context', sql.NVarChar(sql.MAX), versionRow.context as string | null);
      updateReq.input('metadata', sql.NVarChar(sql.MAX), versionRow.metadata as string);
      updateReq.input('version', sql.Int, version);
      updateReq.input('name', sql.NVarChar(255), versionRow.name as string);
      updateReq.input('description', sql.NVarChar(sql.MAX), versionRow.description as string | null);
      updateReq.input('updated_at', sql.NVarChar, now);

      await updateReq.query(`
        UPDATE Assistant
        SET graph_id = @graph_id,
            config = @config,
            context = @context,
            metadata = @metadata,
            version = @version,
            name = @name,
            description = @description,
            updated_at = @updated_at
        WHERE assistant_id = @assistant_id
      `);

      await transaction.commit();

      return this.getById(assistantId);
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private rowToAssistant(row: Record<string, unknown>): Assistant {
    return {
      assistant_id: row.assistant_id as string,
      graph_id: row.graph_id as string,
      config: this.parseJson(row.config as string),
      context: row.context ? this.parseJson(row.context as string) : undefined,
      created_at: this.toISOString(row.created_at),
      updated_at: this.toISOString(row.updated_at),
      metadata: this.parseJson(row.metadata as string),
      version: row.version as number,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
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
      if (filters.graph_id !== undefined) {
        request.input('filter_graph_id', sql.NVarChar(255), String(filters.graph_id));
        whereClauses.push('graph_id = @filter_graph_id');
      }
      if (filters.name !== undefined) {
        request.input('filter_name', sql.NVarChar(255), String(filters.name));
        whereClauses.push('name = @filter_name');
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
