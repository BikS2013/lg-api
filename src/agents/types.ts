/**
 * Agent Request/Response Types
 *
 * Defines the JSON contract between the lg-api agent connectors
 * and external agent processes. Agents receive an AgentRequest
 * and return an AgentResponse.
 */

/**
 * Metadata returned by the LLM provider alongside a completion response.
 * All fields are optional — agents populate only what the provider supplies.
 */
export interface LlmResponseMetadata {
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  finish_reason?: string;
  latency_ms?: number;
  provider?: string;
  provider_response_id?: string;
}

/**
 * A single message in the agent conversation.
 */
export interface AgentMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  response_metadata?: LlmResponseMetadata;
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
  event:
    | 'metadata'
    | 'values'
    | 'updates'
    | 'messages'
    | 'messages/partial'
    | 'messages/complete'
    | 'messages/metadata'
    | 'custom'
    | 'end'
    | 'error';
  data: unknown;
}

/**
 * Incremental events an agent can send over the NDJSON wire (one JSON object
 * per line, `Content-Type: application/x-ndjson`) before its final
 * AgentResponse. lg-api maps these onto LangGraph SSE events according to the
 * run's `stream_mode`. An agent sends NDJSON only when the request carried
 * `Accept: application/x-ndjson` (the `/runs/stream` path); otherwise it
 * answers with the plain JSON AgentResponse. Contract:
 *   - `progress` — opaque progress payload, passed through unchanged as a
 *                  `custom` event (e.g. `{type: 'status', text}` status lines).
 *   - `token`    — text delta for the assistant message `id`. The concatenation
 *                  of all deltas for an id equals the final message content,
 *                  unless a `replace` for that id follows. `source` 'final'
 *                  (nothing was streamed live) and 'reconcile' (the missing
 *                  suffix) mark the runner's reconciliation of the final text.
 *   - `replace`  — the text streamed so far for `id` is wrong; `content` is
 *                  the authoritative text so far.
 *   - `final`    — the complete AgentResponse (exactly once, last).
 *   - `error`    — agent-side failure after the stream opened.
 */
export type AgentWireEvent =
  | { event: 'progress'; data: Record<string, unknown> }
  | { event: 'token'; data: { id: string; delta: string; source?: string } }
  | { event: 'replace'; data: { id: string; content: string; reason?: string } }
  | { event: 'final'; data: AgentResponse }
  | { event: 'error'; data: { message: string } };

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
  name?: string;
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
