/**
 * Assistant Resolver
 *
 * Resolves an assistant by UUID (assistant_id) or by graph_id string.
 * Used by the run execution pipeline to allow clients to pass either
 * a real assistant UUID or a graph_id alias (e.g., "passthrough").
 */

import type { IAssistantStorage } from '../storage/interfaces.js';
import type { Assistant } from '../modules/assistants/assistants.repository.js';
import { ApiError } from '../errors/api-error.js';

export class AssistantResolver {
  constructor(private readonly assistantStorage: IAssistantStorage) {}

  /**
   * Resolve an assistant by UUID or graph_id.
   *
   * 1. Try to find by UUID first (direct lookup).
   * 2. If not found, try to find by graph_id (search).
   * 3. If neither, throw a 404 ApiError.
   */
  async resolve(assistantIdOrGraphId: string): Promise<Assistant> {
    // Step 1: Try direct lookup by assistant_id (UUID)
    const byId = await this.assistantStorage.getById(assistantIdOrGraphId);
    if (byId) {
      return byId;
    }

    // Step 2: Try search by graph_id
    const searchResult = await this.assistantStorage.search(
      { limit: 1, offset: 0 },
      { graph_id: assistantIdOrGraphId },
    );

    if (searchResult.items.length > 0) {
      return searchResult.items[0];
    }

    // Step 3: Not found
    throw new ApiError(404, `Assistant not found: ${assistantIdOrGraphId}`);
  }
}
