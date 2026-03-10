/**
 * API Agent Connector
 *
 * HTTP-based agent connector that sends the AgentRequest as a JSON POST
 * (or configured method) to the agent's URL endpoint and parses the
 * response as AgentResponse JSON.
 *
 * Uses native fetch (Node.js 18+) with AbortSignal.timeout() for timeout handling.
 * No external HTTP library dependency.
 *
 * For streaming: calls execute() internally and wraps the response into the
 * standard StreamEvent sequence (metadata -> values -> messages -> end).
 * True SSE streaming from the API agent is not supported in this phase.
 */

import type { IAgentConnector } from './agent-connector.interface.js';
import type {
  AgentConfig,
  ApiAgentConfig,
  AgentRequest,
  AgentResponse,
  StreamEvent,
} from '../types.js';
import { ApiError } from '../../errors/api-error.js';

export class ApiAgentConnector implements IAgentConnector {
  /**
   * Execute an API agent by sending an HTTP request.
   *
   * Error mapping:
   * - HTTP 4xx/5xx: ApiError(502, "Agent returned HTTP <status>: <body>")
   * - Timeout: ApiError(504, "Agent timed out after <timeout>ms")
   * - Network error: ApiError(502, "Agent connection failed: <message>")
   * - Invalid JSON: ApiError(502, "Agent returned invalid JSON: <snippet>")
   */
  async execute(config: AgentConfig, request: AgentRequest): Promise<AgentResponse> {
    if (config.type !== 'api') {
      throw new Error(
        `ApiAgentConnector received config with type "${config.type}", expected "api"`,
      );
    }

    const apiConfig = config as ApiAgentConfig;

    let response: Response;
    try {
      response = await fetch(apiConfig.url, {
        method: apiConfig.method,
        headers: {
          'Content-Type': 'application/json',
          ...apiConfig.headers,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(apiConfig.timeout),
      });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new ApiError(
          504,
          `Agent at ${apiConfig.url} timed out after ${apiConfig.timeout}ms`,
        );
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new ApiError(
        502,
        `Agent connection failed (${apiConfig.url}): ${message}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '(unreadable)');
      throw new ApiError(
        502,
        `Agent at ${apiConfig.url} returned HTTP ${response.status}: ${body.substring(0, 500)}`,
      );
    }

    let agentResponse: AgentResponse;
    const rawText = await response.text();
    try {
      agentResponse = JSON.parse(rawText) as AgentResponse;
    } catch {
      throw new ApiError(
        502,
        `Agent at ${apiConfig.url} returned invalid JSON: ${rawText.substring(0, 500)}`,
      );
    }

    // Validate required fields
    if (!agentResponse.thread_id || !agentResponse.run_id || !Array.isArray(agentResponse.messages)) {
      throw new ApiError(
        502,
        `Agent at ${apiConfig.url} response missing required fields (thread_id, run_id, messages)`,
      );
    }

    return agentResponse;
  }

  /**
   * Execute the API agent and wrap the response into SSE-compatible events.
   *
   * Follows the same event sequence as CliAgentConnector.stream():
   * metadata -> values -> messages (per message) -> end
   */
  async *stream(config: AgentConfig, request: AgentRequest): AsyncGenerator<StreamEvent> {
    if (config.type !== 'api') {
      throw new Error(
        `ApiAgentConnector received config with type "${config.type}", expected "api"`,
      );
    }

    // Emit metadata event first
    yield {
      event: 'metadata',
      data: {
        run_id: request.run_id,
        thread_id: request.thread_id,
      },
    };

    let response: AgentResponse;
    try {
      response = await this.execute(config, request);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown agent error';
      yield { event: 'error', data: { message } };
      return;
    }

    // Emit values event with the full response state
    yield {
      event: 'values',
      data: {
        messages: response.messages.map((msg) => ({
          type: msg.role === 'assistant' ? 'ai' : msg.role === 'user' ? 'human' : 'system',
          content: msg.content,
        })),
      },
    };

    // Emit individual messages
    for (const msg of response.messages) {
      yield {
        event: 'messages',
        data: [
          {
            type: msg.role === 'assistant' ? 'AIMessageChunk' : 'HumanMessageChunk',
            content: msg.content,
          },
        ],
      };
    }

    // Emit end event
    yield { event: 'end', data: null };
  }
}
