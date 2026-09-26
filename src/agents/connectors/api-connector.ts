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
 * stream(): calls execute() internally and wraps the response into the
 * standard StreamEvent sequence (metadata -> values -> messages -> end).
 *
 * streamAgent(): incremental streaming for `/runs/stream`. Only this path asks
 * the agent for NDJSON (`Accept: application/x-ndjson`); execute() sends
 * exactly the request it always has, so `/runs/wait` and background runs are
 * unaffected.
 */

import type { IAgentConnector } from './agent-connector.interface.js';
import type {
  AgentConfig,
  ApiAgentConfig,
  AgentRequest,
  AgentResponse,
  AgentWireEvent,
  StreamEvent,
} from '../types.js';
import { ApiError } from '../../errors/api-error.js';
import { generateId } from '../../utils/uuid.util.js';

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
          id: generateId(),
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
            id: generateId(),
          },
        ],
      };
    }

    // Emit end event
    yield { event: 'end', data: null };
  }

  /**
   * Incremental streaming of an API agent.
   *
   * Sends `Accept: application/x-ndjson, application/json;q=0.9`. An agent
   * that speaks NDJSON (e.g. lg-agent-sdk-ts `runAgentHttpStreaming`) answers
   * with `Content-Type: application/x-ndjson` and writes one AgentWireEvent
   * per line, ending with `{event:'final', data: AgentResponse}`; each line is
   * yielded as soon as it arrives. An agent that ignores the Accept header
   * answers `application/json` exactly as it does for execute() and is
   * surfaced as a single `final` event — legacy agents keep working unchanged.
   *
   * The request is aborted only by the configured agent timeout (covering the
   * whole response, as in execute()) or by `signal` — an explicit
   * cancellation, never a mere client disconnect.
   *
   * Error mapping is the same as execute(), plus:
   * - Malformed NDJSON line: ApiError(502, "... sent an invalid NDJSON line")
   * - Stream closed without `final`: ApiError(502, "... without a final event")
   */
  async *streamAgent(
    config: AgentConfig,
    request: AgentRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentWireEvent> {
    if (config.type !== 'api') {
      throw new Error(
        `ApiAgentConnector received config with type "${config.type}", expected "api"`,
      );
    }
    const apiConfig = config as ApiAgentConfig;
    const timeoutSignal = AbortSignal.timeout(apiConfig.timeout);
    const combined = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
    const transportError = (error: unknown, what: string): ApiError => {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        return new ApiError(504, `Agent at ${apiConfig.url} timed out after ${apiConfig.timeout}ms`);
      }
      if (signal?.aborted) {
        return new ApiError(499, `Agent call to ${apiConfig.url} was cancelled`);
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      return new ApiError(502, `${what} (${apiConfig.url}): ${message}`);
    };

    let response: Response;
    try {
      response = await fetch(apiConfig.url, {
        method: apiConfig.method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson, application/json;q=0.9',
          ...apiConfig.headers,
        },
        body: JSON.stringify(request),
        signal: combined,
      });
    } catch (error: unknown) {
      throw transportError(error, 'Agent connection failed');
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '(unreadable)');
      throw new ApiError(
        502,
        `Agent at ${apiConfig.url} returned HTTP ${response.status}: ${body.substring(0, 500)}`,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/x-ndjson') || !response.body) {
      // Legacy agent: one JSON AgentResponse, validated exactly like execute().
      let rawText: string;
      try {
        rawText = await response.text();
      } catch (error: unknown) {
        throw transportError(error, 'Agent response failed');
      }
      let agentResponse: AgentResponse;
      try {
        agentResponse = JSON.parse(rawText) as AgentResponse;
      } catch {
        throw new ApiError(502, `Agent at ${apiConfig.url} returned invalid JSON: ${rawText.substring(0, 500)}`);
      }
      this.assertResponse(apiConfig, agentResponse);
      yield { event: 'final', data: agentResponse };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let sawFinal = false;
    let finished = false;
    const parseLine = (line: string): AgentWireEvent | null => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      let event: AgentWireEvent;
      try {
        event = JSON.parse(trimmed) as AgentWireEvent;
      } catch {
        throw new ApiError(502, `Agent at ${apiConfig.url} sent an invalid NDJSON line: ${trimmed.substring(0, 200)}`);
      }
      if (event.event === 'final') {
        this.assertResponse(apiConfig, event.data);
        sawFinal = true;
      }
      return event;
    };
    try {
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error: unknown) {
          throw transportError(error, 'Agent stream failed');
        }
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const event = parseLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          if (event) yield event;
        }
      }
      finished = true;
      const tail = parseLine(buffer + decoder.decode());
      if (tail) yield tail;
    } finally {
      // Stopped early (bad line, consumer gave up): release the connection.
      if (!finished) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (!sawFinal) {
      throw new ApiError(502, `Agent at ${apiConfig.url} closed the NDJSON stream without a final event`);
    }
  }

  private assertResponse(apiConfig: ApiAgentConfig, agentResponse: AgentResponse): void {
    if (!agentResponse || !agentResponse.thread_id || !agentResponse.run_id || !Array.isArray(agentResponse.messages)) {
      throw new ApiError(
        502,
        `Agent at ${apiConfig.url} response missing required fields (thread_id, run_id, messages)`,
      );
    }
  }
}
