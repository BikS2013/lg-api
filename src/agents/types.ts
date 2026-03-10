/**
 * Agent Request/Response Types
 *
 * Defines the JSON contract between the lg-api agent connectors
 * and external agent processes. Agents receive an AgentRequest
 * and return an AgentResponse.
 */

/**
 * A single message in the agent conversation.
 */
export interface AgentMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * A document attached to the agent request (e.g., RAG context).
 */
export interface AgentDocument {
  id: string;
  title?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * The JSON payload sent to the agent process.
 */
export interface AgentRequest {
  thread_id: string;
  run_id: string;
  assistant_id: string;
  messages: AgentMessage[];
  documents?: AgentDocument[];
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * The JSON payload the agent process returns.
 */
export interface AgentResponse {
  thread_id: string;
  run_id: string;
  messages: AgentMessage[];
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * A single streaming event emitted by the connector.
 * Maps to SSE event types used by the LangGraph streaming protocol.
 */
export interface AgentStreamEvent {
  event: 'metadata' | 'values' | 'messages' | 'end' | 'error';
  data: unknown;
}

/**
 * A generic streaming event emitted by any agent connector.
 */
export interface StreamEvent {
  event: string;
  data: unknown;
}

// ---------------------------------------------------------------------------
// Agent Configuration — Discriminated Union
// ---------------------------------------------------------------------------

/**
 * Base configuration shared by all agent types.
 */
export interface BaseAgentConfig {
  type: string;
  timeout: number;
  description?: string;
}

/**
 * Configuration for a CLI-based agent (spawned as a child process).
 */
export interface CliAgentConfig extends BaseAgentConfig {
  type: 'cli';
  command: string;
  args: string[];
  cwd: string;
}

/**
 * Configuration for an API-based agent (called via HTTP).
 */
export interface ApiAgentConfig extends BaseAgentConfig {
  type: 'api';
  url: string;
  method: string;
  headers?: Record<string, string>;
}

/**
 * Discriminated union of all supported agent configuration types.
 */
export type AgentConfig = CliAgentConfig | ApiAgentConfig;
