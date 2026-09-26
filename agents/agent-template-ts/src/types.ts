export interface AgentMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  response_metadata?: Record<string, unknown>;
}

export interface AgentDocument {
  id: string;
  title?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface AgentRequest {
  thread_id: string;
  run_id: string;
  assistant_id: string;
  messages: AgentMessage[];
  documents?: AgentDocument[];
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface AgentResponse {
  thread_id: string;
  run_id: string;
  messages: AgentMessage[];
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type AgentHandler = (request: AgentRequest) => Promise<AgentResponse>;

/**
 * One line of the NDJSON response a streaming agent sends lg-api
 * (`Content-Type: application/x-ndjson`), ending with exactly one `final`
 * (or an `error`). See runAgentHttpStreaming.
 */
export type AgentWireEvent =
  | { event: 'progress'; data: Record<string, unknown> }
  | { event: 'token'; data: { id: string; delta: string; source?: string } }
  | { event: 'replace'; data: { id: string; content: string; reason?: string } }
  | { event: 'final'; data: AgentResponse }
  | { event: 'error'; data: { message: string } };
