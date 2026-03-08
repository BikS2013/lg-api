/**
 * AssistantsRepository
 *
 * Extends InMemoryRepository with assistant-specific operations:
 * search by graph_id, search by name, version management.
 */

import { InMemoryRepository } from '../../repositories/in-memory.repository.js';
import type { SearchOptions, SearchResult } from '../../repositories/interfaces.js';

/** Inline Assistant type — will be replaced with the shared type from types/index.ts */
export interface Assistant {
  assistant_id: string;
  graph_id: string;
  config: Record<string, any>;
  context?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown>;
  version: number;
  name: string;
  description: string | null;
}

export class AssistantsRepository extends InMemoryRepository<Assistant> {
  /** Map of assistant_id -> array of version snapshots (ordered by version number) */
  private versions: Map<string, Assistant[]> = new Map();

  /**
   * Search assistants filtered by graph_id.
   */
  async searchByGraphId(graphId: string, options: SearchOptions): Promise<SearchResult<Assistant>> {
    return this.search(options, { graph_id: graphId });
  }

  /**
   * Search assistants by name (exact match).
   */
  async searchByName(name: string, options: SearchOptions): Promise<SearchResult<Assistant>> {
    return this.search(options, { name });
  }

  /**
   * Get all stored versions for a given assistant.
   */
  async getVersions(assistantId: string): Promise<Assistant[]> {
    const versionList = this.versions.get(assistantId);
    if (!versionList) {
      return [];
    }
    return versionList.map((v) => structuredClone(v));
  }

  /**
   * Add a version snapshot for an assistant.
   */
  async addVersion(assistantId: string, version: Assistant): Promise<void> {
    const existing = this.versions.get(assistantId) ?? [];
    existing.push(structuredClone(version));
    this.versions.set(assistantId, existing);
  }

  /**
   * Set the latest version of an assistant by restoring a previous version snapshot.
   * Finds the version snapshot matching the given version number and updates the
   * current assistant record with it.
   */
  async setLatestVersion(assistantId: string, version: number): Promise<Assistant | null> {
    const versionList = this.versions.get(assistantId);
    if (!versionList) {
      return null;
    }

    const targetVersion = versionList.find((v) => v.version === version);
    if (!targetVersion) {
      return null;
    }

    const now = new Date().toISOString();
    const updated: Assistant = {
      ...structuredClone(targetVersion),
      updated_at: now,
    };

    this.store.set(assistantId, structuredClone(updated));
    return structuredClone(updated);
  }

  /**
   * Override delete to also clean up version history.
   */
  async delete(id: string): Promise<boolean> {
    this.versions.delete(id);
    return super.delete(id);
  }
}
