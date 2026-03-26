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
