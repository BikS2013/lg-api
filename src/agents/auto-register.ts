/**
 * Auto-Registration of Assistants from Agent Registry
 *
 * At server startup, iterates over all agents defined in agent-registry.yaml
 * and creates corresponding assistant records in the storage layer if they
 * do not already exist. This ensures that every registered agent is
 * discoverable as an assistant (and can be referenced by graph_id).
 */

import crypto from 'node:crypto';
import type { IAssistantStorage } from '../storage/interfaces.js';
import type { AgentConfig } from './types.js';
import type { AgentRegistry } from './agent-registry.js';

/**
 * Sensitive header name patterns. Header values whose names match
 * any of these substrings (case-insensitive) will be redacted.
 */
const SENSITIVE_PATTERNS = ['key', 'token', 'secret', 'auth'];

/**
 * Sanitize an agent config for storage in assistant metadata.
 * Redacts header values that look like secrets.
 */
function sanitizeConfig(config: AgentConfig): Record<string, unknown> {
  const copy = { ...config } as Record<string, unknown>;

  if (config.type === 'api' && config.headers) {
    const sanitizedHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(config.headers)) {
      const nameLower = name.toLowerCase();
      const isSensitive = SENSITIVE_PATTERNS.some((pat) => nameLower.includes(pat));
      sanitizedHeaders[name] = isSensitive ? '***REDACTED***' : value;
    }
    copy.headers = sanitizedHeaders;
  }

  return copy;
}

/**
 * Auto-register assistants for all agents in the registry.
 *
 * For each agent:
 * - If an assistant with the same graph_id already exists, skip it.
 * - Otherwise, create a new assistant with auto_registered metadata.
 *
 * Each agent is processed independently; one failure does not block others.
 */
export async function autoRegisterAssistants(
  registry: AgentRegistry,
  assistantStorage: IAssistantStorage,
): Promise<void> {
  const agents = registry.getRegisteredAgents();

  for (const [graphId, config] of agents) {
    try {
      // Check if an assistant with this graph_id already exists
      const existing = await assistantStorage.search(
        { limit: 1, offset: 0 },
        { graph_id: graphId },
      );

      if (existing.items.length > 0) {
        console.log(
          `[auto-register] Assistant for graph_id "${graphId}" already exists (id: ${existing.items[0].assistant_id}). Skipping.`,
        );
        continue;
      }

      // Create a new assistant
      const assistant = {
        assistant_id: crypto.randomUUID(),
        graph_id: graphId,
        name: config.description || graphId,
        description: `Auto-registered from agent-registry.yaml (type: ${config.type})`,
        config: {},
        metadata: {
          auto_registered: true,
          agent_type: config.type,
          agent_config: sanitizeConfig(config),
        },
        version: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      await assistantStorage.create(assistant);
      console.log(
        `[auto-register] Created assistant for graph_id "${graphId}" (id: ${assistant.assistant_id}).`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[auto-register] Failed to register assistant for graph_id "${graphId}": ${message}`,
      );
    }
  }
}
