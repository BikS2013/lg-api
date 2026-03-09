/**
 * Agent Request/Response Types
 *
 * Defines the JSON contract between the lg-api CLI agent connector
 * and external CLI agent processes. Agents receive an AgentRequest
 * on stdin and write an AgentResponse to stdout.
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
 * The JSON payload sent to the CLI agent process via stdin.
 */
export interface AgentRequest {
  thread_id: string;
  run_id: string;
  assistant_id: string;
  messages: AgentMessage[];
  documents?: AgentDocument[];
  metadata?: Record<string, unknown>;
}

/**
 * The JSON payload the CLI agent process writes to stdout.
 */
export interface AgentResponse {
  thread_id: string;
  run_id: string;
  messages: AgentMessage[];
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
 * Configuration for a registered CLI agent.
 */
export interface AgentConfig {
  command: string;
  args: string[];
  cwd: string;
  timeout: number;
  description?: string;
}
