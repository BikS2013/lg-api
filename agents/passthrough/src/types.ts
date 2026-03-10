export interface AgentRequest {
  thread_id: string;
  run_id: string;
  assistant_id: string;
  messages: Message[];
  documents?: Document[];
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Metadata from a single LLM invocation, attached to the response message.
 */
export interface LlmResponseMetadata {
  /** The model identifier as reported by the provider (e.g., "gpt-4o", "claude-3-opus") */
  model?: string;

  /** Token usage breakdown */
  usage?: {
    /** Number of tokens in the prompt */
    prompt_tokens?: number;
    /** Number of tokens in the completion */
    completion_tokens?: number;
    /** Total tokens consumed (prompt + completion) */
    total_tokens?: number;
  };

  /** Why the model stopped generating (e.g., "stop", "length", "content_filter") */
  finish_reason?: string;

  /** Wall-clock latency of the LLM call in milliseconds */
  latency_ms?: number;

  /** The LLM provider that served the request (e.g., "azure-openai", "openai", "anthropic", "google") */
  provider?: string;

  /** Provider-specific response ID (e.g., OpenAI's response id) */
  provider_response_id?: string;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** LLM invocation metadata -- present only on assistant messages returned by agents */
  response_metadata?: LlmResponseMetadata;
}

export interface Document {
  id: string;
  title?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface AgentResponse {
  thread_id: string;
  run_id: string;
  messages: Message[];
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type LlmProvider = 'azure-openai' | 'openai' | 'anthropic' | 'google';

export interface AzureOpenAIConfig {
  apiKey: string;
  endpoint: string;
  deploymentName: string;
  apiVersion: string;
  temperature: number;
  maxTokens: number;
}

export interface OpenAIConfig {
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface GoogleConfig {
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface LlmConfig {
  provider: LlmProvider;
  profile: string;
  providerConfig: AzureOpenAIConfig | OpenAIConfig | AnthropicConfig | GoogleConfig;
}
