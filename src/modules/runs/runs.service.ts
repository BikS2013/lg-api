/**
 * RunsService - Business logic for run management.
 *
 * Handles run lifecycle: creation, status transitions, cancellation,
 * deletion, waiting, and streaming. Coordinates with ThreadsRepository
 * to manage thread status (busy/idle) during run execution.
 *
 * Wired to the agent execution pipeline: resolves assistants, composes
 * agent requests, executes agents via AgentExecutor, and updates thread
 * state with agent responses.
 */

import type { Static } from '@sinclair/typebox';
import type { FastifyReply } from 'fastify';
import { RunsRepository, Run } from './runs.repository.js';
import { ThreadsRepository } from '../threads/threads.repository.js';
import { RunStreamEmitter } from './runs.streaming.js';
import { StreamManager } from '../../streaming/stream-manager.js';
import { AgentExecutor } from '../../agents/agent-executor.js';
import { AssistantResolver } from '../../agents/assistant-resolver.js';
import { RequestComposer } from '../../agents/request-composer.js';
import type { AgentResponse } from '../../agents/types.js';
import type { RunStatus, StreamMode } from '../../types/index.js';
import { generateId } from '../../utils/uuid.util.js';
import { nowISO } from '../../utils/date.util.js';
import { ApiError } from '../../errors/api-error.js';
import type {
  RunCreateRequestSchema,
  ListRunsQuerySchema,
  CancelRunRequestSchema,
  BulkCancelRunsRequestSchema,
} from '../../schemas/run.schema.js';

type RunCreateRequest = Static<typeof RunCreateRequestSchema>;
type ListRunsQuery = Static<typeof ListRunsQuerySchema>;
type CancelRunRequest = Static<typeof CancelRunRequestSchema>;
type BulkCancelRunsRequest = Static<typeof BulkCancelRunsRequestSchema>;

export class RunsService {
  private streamManager: StreamManager;
  private streamEmitter: RunStreamEmitter;

  constructor(
    private runsRepository: RunsRepository,
    private threadsRepository: ThreadsRepository,
    private agentExecutor: AgentExecutor,
    private assistantResolver: AssistantResolver,
    private requestComposer: RequestComposer,
  ) {
    this.streamManager = new StreamManager();
    this.streamEmitter = new RunStreamEmitter(this.streamManager);
  }

  /**
   * Create a stateful run (associated with a thread).
   * Resolves the assistant, composes the agent request, executes the agent,
   * and updates thread state with the response.
   */
  async createStateful(threadId: string, request: RunCreateRequest): Promise<Run> {
    // Verify thread exists
    const thread = await this.threadsRepository.getById(threadId);
    if (!thread) {
      throw new ApiError(404, `Thread ${threadId} not found`);
    }

    // Resolve assistant early so the run record stores the real UUID
    const assistant = await this.assistantResolver.resolve(request.assistant_id);

    const now = nowISO();
    const run: Run = {
      run_id: generateId(),
      thread_id: threadId,
      assistant_id: assistant.assistant_id,
      created_at: now,
      updated_at: now,
      status: 'pending',
      metadata: request.metadata ?? {},
      kwargs: {
        input: request.input ?? null,
        config: request.config ?? {},
        stream_mode: request.stream_mode ?? ['values'],
        interrupt_before: request.interrupt_before,
        interrupt_after: request.interrupt_after,
        webhook: request.webhook ?? null,
      },
      multitask_strategy: request.multitask_strategy ?? 'reject',
    };

    const created = await this.runsRepository.create(run.run_id, run);

    // Set thread to busy
    await this.threadsRepository.update(threadId, {
      status: 'busy',
      updated_at: nowISO(),
    });

    // Execute agent in background (non-blocking)
    setImmediate(async () => {
      try {
        // Get thread state for conversation history
        let currentState: Record<string, unknown> = { values: {} };
        try {
          const threadState = await this.threadsRepository.getState(threadId);
          if (threadState) {
            currentState = threadState as unknown as Record<string, unknown>;
          }
        } catch {
          // Default to empty state if no state exists
        }

        // Compose agent request
        const agentRequest = await this.requestComposer.composeRequest({
          threadId,
          runId: run.run_id,
          assistantId: assistant.assistant_id,
          input: (request.input as Record<string, unknown>) ?? {},
          threadState: currentState,
        });

        // Set run to running
        await this.runsRepository.update(run.run_id, {
          status: 'running',
          updated_at: nowISO(),
        });

        // Execute agent
        const agentResponse = await this.agentExecutor.execute(assistant.graph_id, agentRequest);

        // Update thread state with response messages
        await this.updateThreadState(threadId, request, agentResponse, currentState);

        // Set run to success
        await this.runsRepository.update(run.run_id, {
          status: 'success',
          updated_at: nowISO(),
        });

        // Set thread to idle
        await this.threadsRepository.update(threadId, {
          status: 'idle',
          updated_at: nowISO(),
        });
      } catch (error: unknown) {
        // Set run to error
        try {
          await this.runsRepository.update(run.run_id, {
            status: 'error',
            updated_at: nowISO(),
          });
          await this.threadsRepository.update(threadId, {
            status: 'idle',
            updated_at: nowISO(),
          });
        } catch {
          // Swallow cleanup errors
        }
      }
    });

    return created;
  }

  /**
   * Create a stateless run (no thread association).
   * Resolves the assistant, composes the request, and executes the agent.
   */
  async createStateless(request: RunCreateRequest): Promise<Run> {
    // Resolve assistant early so the run record stores the real UUID
    const assistant = await this.assistantResolver.resolve(request.assistant_id);

    const now = nowISO();
    const run: Run = {
      run_id: generateId(),
      thread_id: null,
      assistant_id: assistant.assistant_id,
      created_at: now,
      updated_at: now,
      status: 'pending',
      metadata: request.metadata ?? {},
      kwargs: {
        input: request.input ?? null,
        config: request.config ?? {},
        stream_mode: request.stream_mode ?? ['values'],
        interrupt_before: request.interrupt_before,
        interrupt_after: request.interrupt_after,
        webhook: request.webhook ?? null,
      },
      multitask_strategy: request.multitask_strategy ?? 'reject',
    };

    const created = await this.runsRepository.create(run.run_id, run);

    // Execute agent in background (non-blocking)
    setImmediate(async () => {
      try {
        const agentRequest = await this.requestComposer.composeRequest({
          threadId: run.run_id, // Use run_id as pseudo thread_id for stateless
          runId: run.run_id,
          assistantId: assistant.assistant_id,
          input: (request.input as Record<string, unknown>) ?? {},
        });

        await this.runsRepository.update(run.run_id, {
          status: 'running',
          updated_at: nowISO(),
        });

        await this.agentExecutor.execute(assistant.graph_id, agentRequest);

        await this.runsRepository.update(run.run_id, {
          status: 'success',
          updated_at: nowISO(),
        });
      } catch {
        try {
          await this.runsRepository.update(run.run_id, {
            status: 'error',
            updated_at: nowISO(),
          });
        } catch {
          // Swallow cleanup errors
        }
      }
    });

    return created;
  }

  /**
   * Batch create multiple stateless runs.
   */
  async createBatch(requests: RunCreateRequest[]): Promise<Run[]> {
    const runs: Run[] = [];
    for (const request of requests) {
      const run = await this.createStateless(request);
      runs.push(run);
    }
    return runs;
  }

  /**
   * Get a specific run by thread ID and run ID.
   */
  async get(threadId: string, runId: string): Promise<Run> {
    const run = await this.runsRepository.getById(runId);
    if (!run || run.thread_id !== threadId) {
      throw new ApiError(404, `Run ${runId} not found in thread ${threadId}`);
    }
    return run;
  }

  /**
   * List runs for a thread with pagination and optional status filtering.
   */
  async list(
    threadId: string,
    query: ListRunsQuery,
  ): Promise<{ items: Run[]; total: number; offset: number; limit: number }> {
    const limit = query.limit ?? 10;
    const offset = query.offset ?? 0;

    const filters: Record<string, unknown> = {};
    if (query.status) {
      filters.status = query.status;
    }

    const result = await this.runsRepository.listByThreadId(threadId, {
      limit,
      offset,
      sortBy: 'created_at',
      sortOrder: 'desc',
      ...filters,
    });

    return {
      items: result.items,
      total: result.total,
      offset,
      limit,
    };
  }

  /**
   * Cancel a specific run.
   */
  async cancel(
    threadId: string,
    runId: string,
    _request: CancelRunRequest,
  ): Promise<void> {
    const run = await this.runsRepository.getById(runId);
    if (!run || run.thread_id !== threadId) {
      throw new ApiError(404, `Run ${runId} not found in thread ${threadId}`);
    }

    if (run.status === 'success' || run.status === 'error') {
      throw new ApiError(409, `Run ${runId} is already in terminal state: ${run.status}`);
    }

    await this.runsRepository.update(runId, {
      status: 'interrupted',
      updated_at: nowISO(),
    });

    // Restore thread to idle
    await this.threadsRepository.update(threadId, {
      status: 'idle',
      updated_at: nowISO(),
    });
  }

  /**
   * Bulk cancel runs matching the given criteria.
   */
  async bulkCancel(request: BulkCancelRunsRequest): Promise<void> {
    const filters: Record<string, unknown> = {};
    if (request.thread_id) filters.thread_id = request.thread_id;
    if (request.status) filters.status = request.status;

    // If specific run IDs are provided, cancel those
    if (request.run_ids && request.run_ids.length > 0) {
      for (const runId of request.run_ids) {
        const run = await this.runsRepository.getById(runId);
        if (run && run.status !== 'success' && run.status !== 'error') {
          await this.runsRepository.update(runId, {
            status: 'interrupted',
            updated_at: nowISO(),
          });
        }
      }
      return;
    }

    // Otherwise, search by filters and cancel matching runs
    const result = await this.runsRepository.search(
      { limit: 1000, offset: 0 },
      filters,
    );

    for (const run of result.items) {
      if (run.status !== 'success' && run.status !== 'error') {
        await this.runsRepository.update(run.run_id, {
          status: 'interrupted',
          updated_at: nowISO(),
        });
      }
    }
  }

  /**
   * Join a run: wait for it to reach a terminal state and return it.
   */
  async join(threadId: string, runId: string): Promise<Run> {
    const run = await this.runsRepository.getById(runId);
    if (!run || run.thread_id !== threadId) {
      throw new ApiError(404, `Run ${runId} not found in thread ${threadId}`);
    }

    // Poll for completion if still in progress
    if (run.status === 'pending' || run.status === 'running') {
      const maxWait = 120_000; // 2 minutes max
      const pollInterval = 500;
      let waited = 0;

      while (waited < maxWait) {
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        waited += pollInterval;

        const updated = await this.runsRepository.getById(runId);
        if (updated && updated.status !== 'pending' && updated.status !== 'running') {
          return updated;
        }
      }

      // Return whatever state we have after timeout
      const finalCheck = await this.runsRepository.getById(runId);
      if (finalCheck) return finalCheck;
    }

    return run;
  }

  /**
   * Delete a run.
   */
  async delete(threadId: string, runId: string): Promise<void> {
    const run = await this.runsRepository.getById(runId);
    if (!run || run.thread_id !== threadId) {
      throw new ApiError(404, `Run ${runId} not found in thread ${threadId}`);
    }

    const deleted = await this.runsRepository.delete(runId);
    if (!deleted) {
      throw new ApiError(404, `Run ${runId} not found`);
    }
  }

  /**
   * Wait for a run: creates a run, executes the agent synchronously,
   * and returns the result with agent response messages.
   */
  async wait(
    threadId: string | null,
    request: RunCreateRequest,
  ): Promise<{ run_id: string; thread_id: string | null; status: RunStatus; result: Record<string, unknown> }> {
    // Resolve assistant
    const assistant = await this.assistantResolver.resolve(request.assistant_id);

    const now = nowISO();
    const runId = generateId();

    // Create run record with resolved assistant UUID
    const run: Run = {
      run_id: runId,
      thread_id: threadId,
      assistant_id: assistant.assistant_id,
      created_at: now,
      updated_at: now,
      status: 'pending',
      metadata: request.metadata ?? {},
      kwargs: {
        input: request.input ?? null,
        config: request.config ?? {},
        stream_mode: request.stream_mode ?? ['values'],
        interrupt_before: request.interrupt_before,
        interrupt_after: request.interrupt_after,
        webhook: request.webhook ?? null,
      },
      multitask_strategy: request.multitask_strategy ?? 'reject',
    };

    await this.runsRepository.create(run.run_id, run);

    try {
      // Get thread state if stateful
      let currentState: Record<string, unknown> = { values: {} };
      if (threadId) {
        // Verify thread exists
        const thread = await this.threadsRepository.getById(threadId);
        if (!thread) {
          throw new ApiError(404, `Thread ${threadId} not found`);
        }

        // Set thread to busy
        await this.threadsRepository.update(threadId, {
          status: 'busy',
          updated_at: nowISO(),
        });

        try {
          const threadState = await this.threadsRepository.getState(threadId);
          if (threadState) {
            currentState = threadState as unknown as Record<string, unknown>;
          }
        } catch {
          // Default to empty state
        }
      }

      // Compose agent request
      const agentRequest = await this.requestComposer.composeRequest({
        threadId: threadId ?? runId,
        runId,
        assistantId: assistant.assistant_id,
        input: (request.input as Record<string, unknown>) ?? {},
        threadState: threadId ? currentState : undefined,
      });

      // Set run to running
      await this.runsRepository.update(runId, {
        status: 'running',
        updated_at: nowISO(),
      });

      // Execute agent synchronously
      const agentResponse = await this.agentExecutor.execute(assistant.graph_id, agentRequest);

      // Update thread state if stateful
      if (threadId) {
        await this.updateThreadState(threadId, request, agentResponse, currentState);

        // Set thread to idle
        await this.threadsRepository.update(threadId, {
          status: 'idle',
          updated_at: nowISO(),
        });
      }

      // Set run to success
      await this.runsRepository.update(runId, {
        status: 'success',
        updated_at: nowISO(),
      });

      return {
        run_id: runId,
        thread_id: threadId,
        status: 'success' as RunStatus,
        result: {
          messages: agentResponse.messages.map((m) => ({
            type: m.role === 'assistant' ? 'ai' : m.role === 'user' ? 'human' : 'system',
            content: m.content,
            id: generateId(),
            ...(m.response_metadata ? { response_metadata: m.response_metadata } : {}),
          })),
        },
      };
    } catch (error: unknown) {
      // Set run to error
      await this.runsRepository.update(runId, {
        status: 'error',
        updated_at: nowISO(),
      });

      // Restore thread to idle if stateful
      if (threadId) {
        try {
          await this.threadsRepository.update(threadId, {
            status: 'idle',
            updated_at: nowISO(),
          });
        } catch {
          // Swallow cleanup errors
        }
      }

      throw error;
    }
  }

  /**
   * Stream a run: creates a run and streams SSE events to the client
   * using real agent execution via the AgentExecutor.
   */
  async streamRun(
    threadId: string | null,
    request: RunCreateRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // Resolve assistant
    const assistant = await this.assistantResolver.resolve(request.assistant_id);

    const now = nowISO();
    const runId = generateId();

    // Create run record with resolved assistant UUID
    const run: Run = {
      run_id: runId,
      thread_id: threadId,
      assistant_id: assistant.assistant_id,
      created_at: now,
      updated_at: now,
      status: 'pending',
      metadata: request.metadata ?? {},
      kwargs: {
        input: request.input ?? null,
        config: request.config ?? {},
        stream_mode: request.stream_mode ?? ['values'],
        interrupt_before: request.interrupt_before,
        interrupt_after: request.interrupt_after,
        webhook: request.webhook ?? null,
      },
      multitask_strategy: request.multitask_strategy ?? 'reject',
    };

    await this.runsRepository.create(run.run_id, run);

    // Set thread to busy if stateful
    if (threadId) {
      const thread = await this.threadsRepository.getById(threadId);
      if (!thread) {
        throw new ApiError(404, `Thread ${threadId} not found`);
      }
      await this.threadsRepository.update(threadId, {
        status: 'busy',
        updated_at: nowISO(),
      });
    }

    try {
      // Get thread state if stateful
      let currentState: Record<string, unknown> = { values: {} };
      if (threadId) {
        try {
          const threadState = await this.threadsRepository.getState(threadId);
          if (threadState) {
            currentState = threadState as unknown as Record<string, unknown>;
          }
        } catch {
          // Default to empty state
        }
      }

      // Compose agent request
      const agentRequest = await this.requestComposer.composeRequest({
        threadId: threadId ?? runId,
        runId,
        assistantId: assistant.assistant_id,
        input: (request.input as Record<string, unknown>) ?? {},
        threadState: threadId ? currentState : undefined,
      });

      // Set run to running
      await this.runsRepository.update(run.run_id, {
        status: 'running',
        updated_at: nowISO(),
      });

      // Stream agent events to client via SSE
      // Collect the agent response from the stream to update thread state afterwards
      const agentStream = this.agentExecutor.stream(assistant.graph_id, agentRequest);

      // Use the stream emitter to handle SSE writing
      await this.streamEmitter.streamFromAgent(reply, run, agentStream);

      // After streaming completes, update thread state if stateful
      // Since we streamed, we need to get the final response.
      // The stream already emitted values and messages events.
      // For thread state update with streaming, we re-execute to get the full response.
      // However, since CLI agents run-to-completion before streaming, the stream
      // already contains the full response. We need to capture it from the stream events.
      // For now, if stateful, we execute the agent again to get the response for state update.
      // TODO: Optimize by capturing response from stream events instead of re-executing.
      if (threadId) {
        try {
          // Re-compose the request to execute synchronously for state capture
          const syncRequest = await this.requestComposer.composeRequest({
            threadId,
            runId,
            assistantId: assistant.assistant_id,
            input: (request.input as Record<string, unknown>) ?? {},
            threadState: currentState,
          });
          const agentResponse = await this.agentExecutor.execute(assistant.graph_id, syncRequest);
          await this.updateThreadState(threadId, request, agentResponse, currentState);
        } catch {
          // State update failure after successful stream is non-fatal
        }
      }

      // Set run to success
      await this.runsRepository.update(run.run_id, {
        status: 'success',
        updated_at: nowISO(),
      });

      // Set thread to idle if stateful
      if (threadId) {
        await this.threadsRepository.update(threadId, {
          status: 'idle',
          updated_at: nowISO(),
        });
      }
    } catch (error: unknown) {
      // Set run to error
      try {
        await this.runsRepository.update(run.run_id, {
          status: 'error',
          updated_at: nowISO(),
        });
      } catch {
        // Swallow cleanup errors
      }

      // Set thread to idle if stateful
      if (threadId) {
        try {
          await this.threadsRepository.update(threadId, {
            status: 'idle',
            updated_at: nowISO(),
          });
        } catch {
          // Swallow cleanup errors
        }
      }

      throw error;
    }
  }

  /**
   * Join a run's stream: reconnect to an existing run's SSE stream.
   */
  async joinStream(
    threadId: string,
    runId: string,
    reply: FastifyReply,
    streamModes?: StreamMode[],
    lastEventId?: string,
  ): Promise<void> {
    const run = await this.runsRepository.getById(runId);
    if (!run || run.thread_id !== threadId) {
      throw new ApiError(404, `Run ${runId} not found in thread ${threadId}`);
    }

    // Check if there is an existing session for replay
    if (lastEventId) {
      const existingSession = this.streamManager.getSession(runId);
      if (existingSession) {
        // Replay missed events
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        const missed = this.streamManager.getEventsAfter(runId, lastEventId);
        for (const event of missed) {
          reply.raw.write(`event: ${event.event}\n`);
          reply.raw.write(`data: ${event.data}\n`);
          reply.raw.write(`id: ${event.id}\n`);
          reply.raw.write('\n');
        }
        reply.raw.end();
        return;
      }
    }

    // No existing session: stream fresh events using the stream emitter
    const modes = streamModes ?? ['values'];
    await this.streamEmitter.streamRun(reply, run, modes, lastEventId);
  }

  /**
   * Update thread state with agent response messages.
   * Appends input messages and response messages to the existing conversation history.
   */
  private async updateThreadState(
    threadId: string,
    request: RunCreateRequest,
    agentResponse: AgentResponse,
    currentState: Record<string, unknown>,
  ): Promise<void> {
    const stateValues = (currentState?.['values'] as Record<string, unknown>) ?? {};
    const existingMessages = (stateValues['messages'] as unknown[]) || [];
    const inputMessages = ((request.input as Record<string, unknown>)?.['messages'] as unknown[]) || [];
    const responseMessages = agentResponse.messages.map((m) => ({
      type: m.role === 'assistant' ? 'ai' : m.role === 'user' ? 'human' : 'system',
      content: m.content,
      ...(m.response_metadata ? { response_metadata: m.response_metadata } : {}),
    }));
    const allMessages = [...existingMessages, ...inputMessages, ...responseMessages];

    const now = nowISO();
    const newValues = { ...stateValues, messages: allMessages, ...(agentResponse.state || {}) };

    // Write to state history (used by getState for next run's context)
    await this.threadsRepository.addState(threadId, {
      values: newValues,
      next: [],
      checkpoint: {
        thread_id: threadId,
        checkpoint_ns: '',
        checkpoint_id: generateId(),
      },
      metadata: { source: 'run' },
      created_at: now,
      parent_checkpoint: (currentState?.['checkpoint'] as { thread_id: string; checkpoint_ns: string; checkpoint_id: string } | null) ?? null,
      tasks: [],
    });

    // Also update the thread entity's values
    await this.threadsRepository.update(threadId, {
      values: newValues,
      updated_at: now,
    });
  }
}
