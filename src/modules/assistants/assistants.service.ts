/**
 * AssistantsService
 *
 * Business logic for the Assistants API.
 * Delegates persistence to AssistantsRepository.
 */

import type { AssistantsRepository, Assistant } from './assistants.repository.js';
import type { SearchOptions, SearchResult } from '../../repositories/interfaces.js';
import { ApiError } from '../../errors/api-error.js';
import { generateId } from '../../utils/uuid.util.js';
import { nowISO } from '../../utils/date.util.js';

export interface CreateAssistantParams {
  graph_id: string;
  assistant_id?: string;
  config?: Record<string, any>;
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  if_exists?: 'raise' | 'do_nothing' | 'update';
  name?: string;
  description?: string | null;
}

export interface UpdateAssistantParams {
  graph_id?: string;
  config?: Record<string, any>;
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  name?: string;
  description?: string | null;
}

export interface SearchAssistantsParams {
  metadata?: Record<string, unknown>;
  graph_id?: string;
  name?: string;
  limit?: number;
  offset?: number;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  select?: string[];
}

export interface CountAssistantsParams {
  metadata?: Record<string, unknown>;
  graph_id?: string;
  name?: string;
}

export interface ListVersionsParams {
  metadata?: Record<string, unknown>;
  limit?: number;
  offset?: number;
}

export class AssistantsService {
  constructor(private readonly repository: AssistantsRepository) {}

  /**
   * Create a new assistant. Handles if_exists logic:
   * - raise (default): throw 409 if assistant_id already exists
   * - do_nothing: return existing assistant unchanged
   * - update: update the existing assistant with the provided fields
   */
  async create(params: CreateAssistantParams): Promise<Assistant> {
    const id = params.assistant_id ?? generateId();
    const now = nowISO();

    // Check for existing assistant
    const existing = await this.repository.getById(id);

    if (existing) {
      const ifExists = params.if_exists ?? 'raise';

      if (ifExists === 'raise') {
        throw new ApiError(409, `Assistant ${id} already exists`);
      }

      if (ifExists === 'do_nothing') {
        return existing;
      }

      // ifExists === 'update'
      const updates: Partial<Assistant> = {
        updated_at: now,
      };
      if (params.graph_id !== undefined) updates.graph_id = params.graph_id;
      if (params.config !== undefined) updates.config = params.config;
      if (params.context !== undefined) updates.context = params.context;
      if (params.metadata !== undefined) updates.metadata = params.metadata;
      if (params.name !== undefined) updates.name = params.name;
      if (params.description !== undefined) updates.description = params.description;

      // Bump version
      updates.version = existing.version + 1;

      const updated = await this.repository.update(id, updates);
      if (!updated) {
        throw new ApiError(404, `Assistant ${id} not found`);
      }

      // Store version snapshot
      await this.repository.addVersion(id, updated);

      return updated;
    }

    // Create new assistant
    const assistant: Assistant = {
      assistant_id: id,
      graph_id: params.graph_id,
      config: params.config ?? {},
      context: params.context,
      created_at: now,
      updated_at: now,
      metadata: params.metadata ?? {},
      version: 1,
      name: params.name ?? `assistant-${id.substring(0, 8)}`,
      description: params.description ?? null,
    };

    const created = await this.repository.create(id, assistant);

    // Store initial version snapshot
    await this.repository.addVersion(id, created);

    return created;
  }

  /**
   * Get an assistant by ID.
   */
  async get(assistantId: string): Promise<Assistant> {
    const assistant = await this.repository.getById(assistantId);
    if (!assistant) {
      throw new ApiError(404, `Assistant ${assistantId} not found`);
    }
    return assistant;
  }

  /**
   * Update an existing assistant. Creates a new version.
   */
  async update(assistantId: string, params: UpdateAssistantParams): Promise<Assistant> {
    const existing = await this.repository.getById(assistantId);
    if (!existing) {
      throw new ApiError(404, `Assistant ${assistantId} not found`);
    }

    const now = nowISO();
    const updates: Partial<Assistant> = {
      updated_at: now,
      version: existing.version + 1,
    };

    if (params.graph_id !== undefined) updates.graph_id = params.graph_id;
    if (params.config !== undefined) updates.config = params.config;
    if (params.context !== undefined) updates.context = params.context;
    if (params.metadata !== undefined) updates.metadata = params.metadata;
    if (params.name !== undefined) updates.name = params.name;
    if (params.description !== undefined) updates.description = params.description;

    const updated = await this.repository.update(assistantId, updates);
    if (!updated) {
      throw new ApiError(404, `Assistant ${assistantId} not found`);
    }

    // Store version snapshot
    await this.repository.addVersion(assistantId, updated);

    return updated;
  }

  /**
   * Delete an assistant. The delete_threads flag is accepted but
   * thread deletion is not implemented yet (just deletes the assistant).
   */
  async delete(assistantId: string, _deleteThreads?: boolean): Promise<void> {
    const existed = await this.repository.delete(assistantId);
    if (!existed) {
      throw new ApiError(404, `Assistant ${assistantId} not found`);
    }
  }

  /**
   * Search assistants with filters and pagination.
   */
  async search(params: SearchAssistantsParams): Promise<SearchResult<Assistant>> {
    const limit = params.limit ?? 10;
    const offset = params.offset ?? 0;

    const options: SearchOptions = {
      limit,
      offset,
      sortBy: params.sort_by,
      sortOrder: params.sort_order,
      metadata: params.metadata,
    };

    const filters: Record<string, unknown> = {};
    if (params.graph_id !== undefined) filters.graph_id = params.graph_id;
    if (params.name !== undefined) filters.name = params.name;

    return this.repository.search(options, filters);
  }

  /**
   * Count assistants matching filters.
   */
  async count(params: CountAssistantsParams): Promise<number> {
    const filters: Record<string, unknown> = {};
    if (params.metadata !== undefined) filters.metadata = params.metadata;
    if (params.graph_id !== undefined) filters.graph_id = params.graph_id;
    if (params.name !== undefined) filters.name = params.name;

    return this.repository.count(Object.keys(filters).length > 0 ? filters : undefined);
  }

  /**
   * Get graph definition for an assistant. Returns a dummy graph JSON.
   */
  async getGraph(assistantId: string, _xray?: boolean | number): Promise<Record<string, unknown>> {
    const assistant = await this.repository.getById(assistantId);
    if (!assistant) {
      throw new ApiError(404, `Assistant ${assistantId} not found`);
    }

    return {
      nodes: [
        { id: '__start__', type: 'start', data: '__start__' },
        { id: '__end__', type: 'end', data: '__end__' },
        { id: 'agent', type: 'runnable', data: { id: ['langgraph', 'utils', 'RunnableCallable'], name: 'agent' } },
      ],
      edges: [
        { source: '__start__', target: 'agent' },
        { source: 'agent', target: '__end__' },
      ],
    };
  }

  /**
   * Get schemas for an assistant. Returns a dummy schema JSON.
   */
  async getSchemas(assistantId: string): Promise<Record<string, unknown>> {
    const assistant = await this.repository.getById(assistantId);
    if (!assistant) {
      throw new ApiError(404, `Assistant ${assistantId} not found`);
    }

    return {
      graph_id: assistant.graph_id,
      input_schema: { type: 'object', properties: {} },
      output_schema: { type: 'object', properties: {} },
      state_schema: { type: 'object', properties: {} },
      config_schema: { type: 'object', properties: {} },
    };
  }

  /**
   * Get subgraphs for an assistant. Returns empty object (stub).
   */
  async getSubgraphs(
    assistantId: string,
    _namespace?: string,
    _recurse?: boolean
  ): Promise<Record<string, unknown>> {
    const assistant = await this.repository.getById(assistantId);
    if (!assistant) {
      throw new ApiError(404, `Assistant ${assistantId} not found`);
    }

    return {};
  }

  /**
   * List versions of an assistant with optional metadata filter and pagination.
   */
  async listVersions(
    assistantId: string,
    params: ListVersionsParams
  ): Promise<SearchResult<Assistant>> {
    const assistant = await this.repository.getById(assistantId);
    if (!assistant) {
      throw new ApiError(404, `Assistant ${assistantId} not found`);
    }

    let versions = await this.repository.getVersions(assistantId);

    // Filter by metadata if provided
    if (params.metadata) {
      const meta = params.metadata;
      versions = versions.filter((v) => {
        if (!v.metadata) return false;
        return Object.entries(meta).every(
          ([key, value]) => v.metadata[key] === value
        );
      });
    }

    const total = versions.length;
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 10;
    const items = versions.slice(offset, offset + limit);

    return { items, total };
  }

  /**
   * Set the latest version of an assistant by restoring a previous version snapshot.
   */
  async setLatestVersion(assistantId: string, version: number): Promise<Assistant> {
    const assistant = await this.repository.getById(assistantId);
    if (!assistant) {
      throw new ApiError(404, `Assistant ${assistantId} not found`);
    }

    const updated = await this.repository.setLatestVersion(assistantId, version);
    if (!updated) {
      throw new ApiError(404, `Version ${version} not found for assistant ${assistantId}`);
    }

    return updated;
  }
}
