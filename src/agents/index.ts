/**
 * CLI Agent Connector Module - Barrel Export
 *
 * Provides the building blocks for executing custom CLI agents
 * from the lg-api run lifecycle.
 */

export { AgentRegistry } from './agent-registry.js';
export { CliAgentConnector } from './cli-connector.js';
export { RequestComposer } from './request-composer.js';
export type {
  AgentRequest,
  AgentResponse,
  AgentMessage,
  AgentDocument,
  AgentStreamEvent,
  AgentConfig,
} from './types.js';
export type { ComposeRequestParams } from './request-composer.js';
