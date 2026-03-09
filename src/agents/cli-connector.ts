/**
 * CLI Agent Connector
 *
 * Executes custom agents as CLI child processes. The connector:
 * 1. Looks up the agent command from the AgentRegistry using graph_id
 * 2. Spawns the CLI process
 * 3. Writes the AgentRequest as JSON to stdin
 * 4. Reads the AgentResponse as JSON from stdout
 * 5. Collects stderr for error reporting
 * 6. Handles timeouts (kills the process and throws)
 * 7. Returns the parsed AgentResponse
 *
 * For streaming, the connector executes the agent synchronously and
 * then emits the response as SSE-compatible AgentStreamEvents.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { AgentRegistry } from './agent-registry.js';
import type {
  AgentRequest,
  AgentResponse,
  AgentStreamEvent,
} from './types.js';

export class CliAgentConnector {
  private registry: AgentRegistry;

  constructor(registry: AgentRegistry) {
    this.registry = registry;
  }

  /**
   * Execute a CLI agent with the given request.
   *
   * Spawns the agent process, sends the request via stdin, and collects
   * the response from stdout. Throws on timeout, non-zero exit code,
   * or unparseable output.
   */
  async executeAgent(graphId: string, request: AgentRequest): Promise<AgentResponse> {
    const config = this.registry.getAgentConfig(graphId);
    if (!config) {
      throw new Error(
        `No agent registered for graph_id "${graphId}". ` +
        `Registered agents: ${this.registry.getRegisteredGraphIds().join(', ') || '(none)'}`,
      );
    }

    const cwd = resolve(config.cwd);

    return new Promise<AgentResponse>((resolvePromise, rejectPromise) => {
      const child = spawn(config.command, config.args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // Timeout handler
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, config.timeout);

      // Collect stdout
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      // Collect stderr
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // Handle process exit
      child.on('close', (code: number | null) => {
        clearTimeout(timer);

        if (timedOut) {
          rejectPromise(
            new Error(
              `Agent "${graphId}" timed out after ${config.timeout}ms. ` +
              `stderr: ${stderr.trim() || '(empty)'}`,
            ),
          );
          return;
        }

        if (code !== 0) {
          rejectPromise(
            new Error(
              `Agent "${graphId}" exited with code ${code}. ` +
              `stderr: ${stderr.trim() || '(empty)'}`,
            ),
          );
          return;
        }

        // Parse stdout as JSON
        let response: AgentResponse;
        try {
          response = JSON.parse(stdout) as AgentResponse;
        } catch {
          rejectPromise(
            new Error(
              `Agent "${graphId}" returned invalid JSON on stdout. ` +
              `Raw output: ${stdout.substring(0, 500)}`,
            ),
          );
          return;
        }

        // Validate required fields
        if (!response.thread_id || !response.run_id || !Array.isArray(response.messages)) {
          rejectPromise(
            new Error(
              `Agent "${graphId}" response is missing required fields ` +
              `(thread_id, run_id, messages). Got: ${JSON.stringify(response).substring(0, 500)}`,
            ),
          );
          return;
        }

        resolvePromise(response);
      });

      // Handle spawn errors (e.g., command not found)
      child.on('error', (err: Error) => {
        clearTimeout(timer);
        rejectPromise(
          new Error(
            `Failed to spawn agent "${graphId}" (command: ${config.command}): ${err.message}`,
          ),
        );
      });

      // Write request to stdin and close it
      const requestJson = JSON.stringify(request);
      child.stdin.write(requestJson, () => {
        child.stdin.end();
      });
    });
  }

  /**
   * Execute a CLI agent and stream the response as SSE-compatible events.
   *
   * Runs the agent to completion, then emits the result as a sequence
   * of AgentStreamEvents: metadata -> values -> messages -> end.
   * On error, emits an error event instead.
   */
  async *streamAgent(
    graphId: string,
    request: AgentRequest,
  ): AsyncGenerator<AgentStreamEvent> {
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
      response = await this.executeAgent(graphId, request);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown agent error';
      yield {
        event: 'error',
        data: { message },
      };
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
    yield {
      event: 'end',
      data: null,
    };
  }
}
