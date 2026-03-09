export interface AgentRequest {
  thread_id: string;
  run_id: string;
  assistant_id: string;
  messages: Message[];
  documents?: Document[];
  metadata?: Record<string, unknown>;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
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
