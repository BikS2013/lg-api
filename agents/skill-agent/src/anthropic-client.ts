import Anthropic from '@anthropic-ai/sdk';

/**
 * Options for calling the Anthropic Messages API.
 */
export interface AnthropicCallOptions {
  apiKey: string;
  model: string;
  maxTokens: number;
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/**
 * Result from an Anthropic Messages API call.
 */
export interface AnthropicCallResult {
  content: string;
  metadata: {
    model: string;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
    finish_reason: string;
    latency_ms: number;
    provider: 'anthropic';
    provider_response_id: string;
  };
}

/**
 * Call the Anthropic Messages API with the given options.
 *
 * Requires ANTHROPIC_API_KEY -- throws explicitly if missing.
 * No fallback values for any parameter.
 *
 * @param options - API call options
 * @returns The assistant's text response with metadata
 * @throws Error if the API key is missing or the API call fails
 */
export async function callAnthropic(options: AnthropicCallOptions): Promise<AnthropicCallResult> {
  if (!options.apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is required but was not provided. ' +
      'Set the ANTHROPIC_API_KEY environment variable.'
    );
  }

  const client = new Anthropic({ apiKey: options.apiKey });

  const startTime = Date.now();

  const response = await client.messages.create({
    model: options.model,
    max_tokens: options.maxTokens,
    system: options.systemPrompt,
    messages: options.messages,
  });

  const latencyMs = Date.now() - startTime;

  // Extract text content from response blocks
  const content = response.content
    .filter((block) => block.type === 'text')
    .map((block) => ('text' in block ? block.text : ''))
    .join('\n');

  const metadata = {
    model: response.model,
    usage: {
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.input_tokens + response.usage.output_tokens,
    },
    finish_reason: response.stop_reason ?? 'unknown',
    latency_ms: latencyMs,
    provider: 'anthropic' as const,
    provider_response_id: response.id,
  };

  return { content, metadata };
}
