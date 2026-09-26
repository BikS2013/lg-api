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
import { ThreadsRepository, Thread } from '../threads/threads.repository.js';
import { RunStreamEmitter } from './runs.streaming.js';
import { loadStreamConfig, type StreamConfig } from './stream-config.js';
import { StreamManager } from '../../streaming/stream-manager.js';
import { AgentExecutor } from '../../agents/agent-executor.js';
import { AssistantResolver } from '../../agents/assistant-resolver.js';
import { RequestComposer } from '../../agents/request-composer.js';
import { reduceChannels } from '../../agents/state-reducer.js';
import type {
  AgentMessage,
  AgentRequest,
  AgentResponse,
  AgentWireEvent,
  StreamEvent as AgentStreamEvent,
} from '../../agents/types.js';
import type { Assistant } from '../assistants/assistants.repository.js';
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

/** `stream_mode` may be a string or an array; the LangGraph default is `values`. */
function normaliseStreamModes(raw: unknown): StreamMode[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const modes = list.filter((m): m is StreamMode => typeof m === 'string');
  return modes.length > 0 ? modes : ['values'];
}

/**
 * The graph node lg-api reports for an agent turn in `messages-tuple`
 * metadata and as the `updates` key, so consumers that filter tuple chunks by
 * node see one consistent name.
 */
const RESPOND_NODE = 'respond';

/**
 * Split a reply into word-sized chunks for typewriter delivery: each word
 * keeps its surrounding whitespace, so concat(chunks) === text (newlines kept).
 */
function typewriterChunks(text: string): string[] {
  return text.match(/\s*\S+\s*/g) ?? (text ? [text] : []);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RunsService {
  private streamManager: StreamManager;
  private streamEmitter: RunStreamEmitter;

  /**
   * @param streamConfig - `/runs/stream` knobs (stream-config.ts); read from
   *   the environment by default. Not used by any other endpoint.
   */
  constructor(
    private runsRepository: RunsRepository,
    private threadsRepository: ThreadsRepository,
    private agentExecutor: AgentExecutor,
    private assistantResolver: AssistantResolver,
    private requestComposer: RequestComposer,
    private streamConfig: StreamConfig = loadStreamConfig(),
  ) {
    this.streamManager = new StreamManager();
    this.streamEmitter = new RunStreamEmitter(this.streamManager, {
      heartbeatMs: streamConfig.heartbeatMs,
    });
  }

  /**
   * Abort the agent call of a run that is streaming live (the session's
   * cancel hook exists only there). No-op for every other run.
   */
  private cancelLiveRun(runId: string): void {
    const session = this.streamManager.getSession(runId);
    if (session && !session.closed) session.cancel?.();
  }

  /**
   * Create a stateful run (associated with a thread).
   * Resolves the assistant, composes the agent request, executes the agent,
   * and updates thread state with the response.
   */
  async createStateful(threadId: string, request: RunCreateRequest): Promise<Run> {
    // Verify thread exists (or create on the fly if `if_not_exists: "create"`).
    await this.ensureThread(threadId, request.if_not_exists);

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
          metadata: request.metadata ?? {},
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
          metadata: request.metadata ?? {},
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

    // A live /runs/stream run is still calling its agent: stop it too.
    this.cancelLiveRun(runId);
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
          this.cancelLiveRun(runId);
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
        this.cancelLiveRun(run.run_id);
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
  /**
   * Per the LangGraph Platform contract, `/runs/wait` returns the graph's final
   * state values at the response root (e.g. `{ messages: [...], <state_keys> }`).
   * No `{ run_id, status, result }` envelope — run metadata lives on
   * `GET /threads/:id/runs/:run_id`. See Issues - Pending Items.md
   * (LG-WAIT-FLATTEN).
   */
  async wait(
    threadId: string | null,
    request: RunCreateRequest,
  ): Promise<Record<string, unknown>> {
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
        // Verify thread exists (or create on the fly if `if_not_exists: "create"`).
        await this.ensureThread(threadId, request.if_not_exists);

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
        metadata: request.metadata ?? {},
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

      // Compose the final state values to return.
      // Stateful: read the just-updated thread state so the response reflects
      //   the canonical post-run state (all channels: messages + custom keys).
      // Stateless: build the values from the agent response since no thread
      //   state was persisted.
      let stateValues: Record<string, unknown>;
      if (threadId) {
        const updatedState = await this.threadsRepository.getState(threadId);
        stateValues = (updatedState?.['values'] as Record<string, unknown>) ?? {};
      } else {
        const stateless = (currentState['values'] as Record<string, unknown>) ?? {};
        const existing = (stateless['messages'] as unknown[]) ?? [];
        const inputMessages = ((request.input as Record<string, unknown>)?.['messages'] as unknown[]) ?? [];
        const normalizedInput = inputMessages.map((m) =>
          this.toLangChainMessage(m as Record<string, unknown>),
        );
        const responseMessages = agentResponse.messages.map((m) =>
          this.toLangChainMessage(m),
        );
        stateValues = {
          ...stateless,
          ...(agentResponse.state ?? {}),
          messages: [...existing, ...normalizedInput, ...responseMessages],
        };
      }

      return stateValues;
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
   * using real agent execution via the AgentExecutor. Agent events are
   * forwarded live as they arrive (streamLive).
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

    // Set thread to busy if stateful (auto-create if `if_not_exists: "create"`).
    if (threadId) {
      await this.ensureThread(threadId, request.if_not_exists);
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
        metadata: request.metadata ?? {},
      });

      // Set run to running
      await this.runsRepository.update(run.run_id, {
        status: 'running',
        updated_at: nowISO(),
      });

      // streamLive opens the SSE stream at once and reports its own failures
      // as SSE `error` events.
      await this.streamLive({ run, threadId, request, assistant, agentRequest, currentState, reply });
    } catch (error: unknown) {
      // Failure BEFORE the live SSE stream opened (state read / request
      // compose): plain HTTP error, run `error`, thread released.
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
   * The live part of `/runs/stream`: headers and `metadata` go out at once
   * and agent events are forwarded as they arrive, mapped onto the LangGraph
   * stream modes the client asked for:
   *
   *   values          initial input state right after `metadata`; full final state
   *   updates         `{respond: {...agent state, messages: [reply]}}`
   *   messages-tuple  `messages` = [AIMessageChunk, LangGraph-style metadata]
   *   messages        `messages/metadata`, `messages/partial` (accumulated
   *                   AIMessageChunk), `messages/complete`
   *   custom          the agent's `progress` payloads, unchanged
   *
   * Run lifetime: a client disconnect only detaches that connection (see
   * RunStreamEmitter.openSse); the agent call continues and its final
   * response is always persisted, so a side-effecting turn (e.g. one that
   * commits an external transaction) is never lost. Only the connector's timeout, or an explicit cancel
   * (POST …/runs/:run_id/cancel, or a join with `cancel_on_disconnect=true`),
   * aborts the agent call.
   *
   * Errors: headers are sent before the agent is called, so an agent failure
   * (502 / 504 on `/runs/wait`) arrives as HTTP 200 + an SSE `error` event
   * `{error, message}` (LG-STREAM-ERROR-EVENT).
   *
   * State is persisted exactly once, from the final AgentResponse, through
   * the same updateThreadState as `/runs/wait`, and BEFORE the reply is typed
   * out: the typed text is the saved text, so nothing shown is ever retracted.
   */
  private async streamLive(ctx: {
    run: Run;
    threadId: string | null;
    request: RunCreateRequest;
    assistant: Assistant;
    agentRequest: AgentRequest;
    currentState: Record<string, unknown>;
    reply: FastifyReply;
  }): Promise<void> {
    const { run, threadId, request, assistant, agentRequest, currentState, reply } = ctx;
    const runId = run.run_id;
    const cfg = this.streamConfig;
    const modes = normaliseStreamModes(request.stream_mode);
    const wantValues = modes.includes('values');
    const wantUpdates = modes.includes('updates');
    const wantCustom = modes.includes('custom');
    const wantTuple = modes.includes('messages-tuple');
    const wantPartial = modes.includes('messages');

    const sse = this.streamEmitter.openSse(reply, run, modes);
    const abort = new AbortController();
    sse.onCancel(() => abort.abort(new Error('Run cancelled')));

    // Normalise the input messages once, so the initial `values` event and
    // the persisted thread carry the same message ids. toLangChainMessage is
    // idempotent, so updateThreadState stores exactly what it would have
    // stored from the raw input.
    const input = (request.input as Record<string, unknown> | null | undefined) ?? null;
    const inputMessages = ((input?.['messages'] as unknown[] | undefined) ?? []).map((m) =>
      this.toLangChainMessage(m as Record<string, unknown>),
    );
    const persistRequest: RunCreateRequest = input && Array.isArray(input['messages'])
      ? { ...request, input: { ...input, messages: inputMessages } }
      : request;

    // `metadata` carries `{run_id, attempt}` per LangGraph spec (thread_id
    // retained for agent-chat-ui consumers).
    sse.emit('metadata', { run_id: runId, attempt: 1, thread_id: threadId });
    if (wantValues) {
      const priorValues = threadId ? ((currentState['values'] as Record<string, unknown>) ?? {}) : {};
      const priorMessages = (priorValues['messages'] as unknown[] | undefined) ?? [];
      sse.emit('values', { ...priorValues, messages: [...priorMessages, ...inputMessages] });
    }

    // Chunk metadata filled the way LangGraph fills it for a chat-model call
    // inside a single-node graph, plus lg-api's `source` of the text.
    const taskNs = `${RESPOND_NODE}:${generateId()}`;
    const chunkMetadata = (source?: string): Record<string, unknown> => ({
      thread_id: threadId,
      run_id: runId,
      assistant_id: assistant.assistant_id,
      graph_id: assistant.graph_id,
      run_attempt: 1,
      langgraph_step: 1,
      langgraph_node: RESPOND_NODE,
      langgraph_triggers: [`branch:to:${RESPOND_NODE}`],
      langgraph_path: ['__pregel_pull', RESPOND_NODE],
      langgraph_checkpoint_ns: taskNs,
      checkpoint_ns: taskNs,
      tags: [],
      ...(source ? { source } : {}),
    });
    const aiChunk = (id: string, content: string, additionalKwargs: unknown = {}) => ({
      content,
      additional_kwargs: additionalKwargs,
      response_metadata: {},
      type: 'AIMessageChunk',
      name: null,
      id,
      example: false,
      tool_calls: [],
      invalid_tool_calls: [],
      usage_metadata: null,
      tool_call_chunks: [],
    });

    // Text shown so far per message id, and which ids already had their
    // `messages/metadata` event.
    const accumulated = new Map<string, string>();
    const announced = new Set<string>();
    const emitText = (id: string, delta: string, source: string | undefined, additionalKwargs?: unknown) => {
      const text = (accumulated.get(id) ?? '') + delta;
      accumulated.set(id, text);
      if (wantTuple) sse.emit('messages', [aiChunk(id, delta, additionalKwargs), chunkMetadata(source)]);
      if (wantPartial) {
        if (!announced.has(id)) {
          announced.add(id);
          sse.emit('messages/metadata', { [id]: { metadata: chunkMetadata(source) } });
        }
        sse.emit('messages/partial', [aiChunk(id, text, additionalKwargs)]);
      }
    };
    // A handoff chunk carries the whole message text (see typeOut), so the
    // accumulated text is set, not appended to.
    const emitHandoff = (id: string, content: string, additionalKwargs: unknown) => {
      accumulated.set(id, content);
      if (wantTuple) sse.emit('messages', [aiChunk(id, content, additionalKwargs), chunkMetadata('final')]);
      if (wantPartial) {
        if (!announced.has(id)) {
          announced.add(id);
          sse.emit('messages/metadata', { [id]: { metadata: chunkMetadata('final') } });
        }
        sse.emit('messages/partial', [aiChunk(id, content, additionalKwargs)]);
      }
    };

    let agentResponse: AgentResponse | null = null;
    let persisted = false;
    try {
      for await (const ev of this.agentEvents(assistant.graph_id, agentRequest, abort.signal)) {
        switch (ev.event) {
          case 'progress':
            if (wantCustom) sse.emit('custom', ev.data);
            break;
          case 'token': {
            const { id, delta, source } = ev.data;
            if (!delta) break;
            // The runner's reconciliation token ('final' = nothing was
            // streamed live, 'reconcile' = the missing suffix) is the
            // authoritative reply text: it is always held and delivered by
            // typeOut after the state is persisted (below) — typed, or as one
            // chunk with the message's additional_kwargs.
            if (source === 'final' || source === 'reconcile') break;
            emitText(id, delta, source);
            break;
          }
          case 'replace': {
            const { id, content } = ev.data;
            accumulated.set(id, content);
            // `messages` (partial) carries the accumulated text, so a replace
            // is just another partial. The tuple protocol has no replace —
            // tell custom subscribers; the final `values` is authoritative.
            if (wantPartial) sse.emit('messages/partial', [aiChunk(id, content)]);
            if (wantCustom) sse.emit('custom', { type: 'message_replace', id, content, reason: ev.data.reason });
            break;
          }
          case 'final':
            agentResponse = ev.data;
            break;
          case 'error':
            throw new ApiError(502, `Agent stream error: ${ev.data?.message ?? 'unknown'}`);
        }
      }
      if (!agentResponse) throw new ApiError(502, 'Agent stream ended without a final response');

      // Persist once — identical to /runs/wait. From here on the turn is
      // saved: a later failure must not mark the run `error`.
      if (threadId) {
        await this.updateThreadState(threadId, persistRequest, agentResponse, currentState);
      }
      persisted = true;

      // Per the LangGraph stream contract, the `values` event carries the
      // FULL graph state values at root (LG-STREAM-FLATTEN-VALUES).
      let valuesPayload: Record<string, unknown>;
      if (threadId) {
        const updatedState = await this.threadsRepository.getState(threadId);
        valuesPayload = (updatedState?.['values'] as Record<string, unknown>) ?? {};
      } else {
        const responseMessages = agentResponse.messages.map((m) => this.toLangChainMessage(m));
        valuesPayload = {
          ...(agentResponse.state ?? {}),
          messages: [...inputMessages, ...responseMessages],
        };
      }

      // The run is finished and saved; typing the reply out is presentation.
      await this.markSavedRunDone(runId, threadId);

      // Take the reply messages from the persisted/returned values so their
      // ids match what /history and `values` carry.
      const valueMsgs = (valuesPayload['messages'] as Record<string, unknown>[] | undefined) ?? [];
      const finalAi = valueMsgs
        .slice(Math.max(0, valueMsgs.length - agentResponse.messages.length))
        .filter((m) => m['type'] === 'ai');

      if (wantTuple || wantPartial) {
        for (const m of finalAi) {
          await this.typeOut(m, { accumulated, emitText, emitHandoff, sse, wantCustom });
        }
      }
      if (wantPartial && finalAi.length > 0) sse.emit('messages/complete', finalAi);
      if (wantUpdates) {
        sse.emit('updates', { [RESPOND_NODE]: { ...(agentResponse.state ?? {}), messages: finalAi } });
      }
      if (wantValues) sse.emit('values', valuesPayload);
      if (cfg.endEvent) sse.emit('end', null);
    } catch (error: unknown) {
      // Headers are already on the wire: report the failure as an SSE
      // `error` event instead of a JSON body the client can no longer read.
      const message = error instanceof Error ? error.message : 'Unknown agent error';
      const cancelled = abort.signal.aborted;
      sse.emit('error', { error: cancelled ? 'Cancelled' : 'AgentError', message });
      if (persisted) {
        // The turn is saved; only reading it back or a status update failed.
        try {
          await this.markSavedRunDone(runId, threadId);
        } catch {
          // Swallow cleanup errors
        }
      } else {
        try {
          await this.runsRepository.update(runId, {
            status: cancelled ? 'interrupted' : 'error',
            updated_at: nowISO(),
          });
        } catch {
          // Swallow cleanup errors
        }
        if (threadId) {
          try {
            await this.threadsRepository.update(threadId, { status: 'idle', updated_at: nowISO() });
          } catch {
            // Swallow cleanup errors
          }
        }
      }
    } finally {
      sse.close();
    }
  }

  /**
   * Mark a live run whose turn is persisted as done: thread `idle`, run
   * `success` — unless it was cancelled meanwhile (POST …/cancel), in which
   * case the `interrupted` status is kept. The thread is released first so a
   * failing run update cannot leave it `busy`.
   */
  private async markSavedRunDone(runId: string, threadId: string | null): Promise<void> {
    if (threadId) {
      await this.threadsRepository.update(threadId, { status: 'idle', updated_at: nowISO() });
    }
    const current = await this.runsRepository.getById(runId);
    if (current?.status !== 'interrupted') {
      await this.runsRepository.update(runId, { status: 'success', updated_at: nowISO() });
    }
  }

  /**
   * Deliver the part of a final reply message that was not streamed live.
   * With the typewriter on it goes out word by word, paced so the whole
   * reply takes at most LG_API_TYPEWRITER_MAX_MS; the LAST chunk carries the
   * message's additional_kwargs (components, handoff flags) so a tuple-only
   * consumer gets them with the text; with the typewriter off the rest goes
   * out as that one chunk. A handoff message is always ONE chunk carrying
   * the FULL message content — even when a prefix was streamed live —
   * because consumers may turn the chunk flagged `is_handoff` into their
   * handoff event and take that chunk's content as the handoff text.
   * Legacy JSON-only agents stream nothing live, so their whole reply is typed.
   */
  private async typeOut(
    m: Record<string, unknown>,
    ctx: {
      accumulated: Map<string, string>;
      emitText: (id: string, delta: string, source: string | undefined, additionalKwargs?: unknown) => void;
      emitHandoff: (id: string, content: string, additionalKwargs: unknown) => void;
      sse: { emit(event: string, data: unknown): void; readonly hasSubscribers: boolean };
      wantCustom: boolean;
    },
  ): Promise<void> {
    const cfg = this.streamConfig;
    const id = String(m['id']);
    const content = typeof m['content'] === 'string' ? (m['content'] as string) : '';
    const kwargs = (m['additional_kwargs'] as Record<string, unknown> | undefined) ?? {};
    let shown = ctx.accumulated.get(id) ?? '';
    if (shown && !content.startsWith(shown)) {
      // Live text was wrong (deterministic override, guard): say so and
      // deliver the final text from the start.
      ctx.accumulated.set(id, '');
      shown = '';
      if (ctx.wantCustom) ctx.sse.emit('custom', { type: 'message_replace', id, content, reason: 'final_differs' });
    }
    if (kwargs['is_handoff'] === true) {
      ctx.emitHandoff(id, content, kwargs);
      return;
    }
    const rest = content.slice(shown.length);
    if (!rest && Object.keys(kwargs).length === 0) return;

    const chunks = !rest ? [''] : !cfg.typewriter ? [rest] : typewriterChunks(rest);
    const pace = chunks.length > 1 ? Math.min(cfg.typewriterChunkMs, cfg.typewriterMaxMs / chunks.length) : 0;
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      ctx.emitText(id, chunks[i], 'final', last ? kwargs : {});
      // Nobody is watching (client gone, no joiner): skip the pacing.
      if (pace > 0 && !last && ctx.sse.hasSubscribers) await sleep(pace);
    }
  }

  /** Executors without streamAgent (e.g. test doubles) degrade to execute() + final. */
  private async *agentEvents(
    graphId: string,
    agentRequest: AgentRequest,
    signal: AbortSignal,
  ): AsyncGenerator<AgentWireEvent> {
    if (typeof (this.agentExecutor as Partial<AgentExecutor>).streamAgent === 'function') {
      yield* this.agentExecutor.streamAgent(graphId, agentRequest, signal);
      return;
    }
    yield { event: 'final', data: await this.agentExecutor.execute(graphId, agentRequest) };
  }

  /**
   * Join a run's stream (`GET /threads/:thread_id/runs/:run_id/stream`, or
   * `GET /runs/:run_id/stream` for a stateless run when `threadId` is null).
   *
   * A run started with `/runs/stream` that is streaming (or finished
   * recently, within the 60 s replay window) is followed through its live
   * StreamManager session — see RunStreamEmitter.joinLive for the
   * Last-Event-ID / stream_mode / cancel_on_disconnect semantics; when there
   * is nothing to follow or replay the result is rebuilt from the stored
   * state: `metadata`, the FULL state `values`, then `end` (when
   * LG_API_STREAM_END_EVENT is on).
   *
   * A thread run without a live session (never streamed, e.g. a background
   * run, or its buffer expired) is answered exactly as before the live
   * stream existed (joinStoredRun).
   */
  async joinStream(
    threadId: string | null,
    runId: string,
    reply: FastifyReply,
    streamModes?: StreamMode[],
    lastEventId?: string,
    cancelOnDisconnect = false,
  ): Promise<void> {
    const run = await this.runsRepository.getById(runId);
    if (!run || (threadId !== null && run.thread_id !== threadId)) {
      throw new ApiError(404, threadId !== null
        ? `Run ${runId} not found in thread ${threadId}`
        : `Run ${runId} not found`);
    }

    if (threadId !== null && !this.streamManager.getSession(runId)?.live) {
      await this.joinStoredRun(threadId, run, reply, lastEventId);
      return;
    }

    if (this.streamEmitter.joinLive(reply, run, { lastEventId, streamModes, cancelOnDisconnect })) {
      return;
    }

    // No session to follow: the run was never streamed here, or it finished
    // and its replay buffer expired. Answer with the stored state.
    const events: Array<{ event: string; data: unknown }> = [
      { event: 'metadata', data: { run_id: runId, thread_id: run.thread_id } },
    ];
    if (run.thread_id && (!streamModes || streamModes.length === 0 || streamModes.includes('values'))) {
      const currentState = await this.threadsRepository.getState(run.thread_id);
      events.push({ event: 'values', data: (currentState?.['values'] as Record<string, unknown>) ?? {} });
    }
    if (this.streamConfig.endEvent) events.push({ event: 'end', data: null });
    this.streamEmitter.sendEvents(reply, run, events);
  }

  /**
   * Join of a thread run without a live session, unchanged from before the
   * live stream: with a Last-Event-ID and a buffered session (from an earlier
   * join), replay the events after it and end; otherwise `metadata`,
   * `values: {messages}` from the stored state, `end`.
   */
  private async joinStoredRun(
    threadId: string,
    run: Run,
    reply: FastifyReply,
    lastEventId?: string,
  ): Promise<void> {
    const runId = run.run_id;

    // Check if there is an existing session for replay
    if (lastEventId) {
      const existingSession = this.streamManager.getSession(runId);
      if (existingSession) {
        // Replay missed events via PassThrough so Fastify CORS plugin applies
        const { PassThrough } = await import('node:stream');
        const sseStream = new PassThrough();
        reply
          .code(200)
          .header('Content-Type', 'text/event-stream')
          .header('Cache-Control', 'no-cache')
          .header('Connection', 'keep-alive')
          .header('X-Accel-Buffering', 'no')
          .header('Content-Location', `/threads/${threadId}/runs/${runId}`)
          .send(sseStream);

        const missed = this.streamManager.getEventsAfter(runId, lastEventId);
        for (const event of missed) {
          sseStream.write(`event: ${event.event}\ndata: ${event.data}\nid: ${event.id}\n\n`);
        }
        sseStream.end();
        return;
      }
    }

    // No existing session: the run already completed and the session expired.
    // Emit the final state from thread history so the client gets the result.
    const currentState = await this.threadsRepository.getState(threadId);
    const stateValues = (currentState?.['values'] as Record<string, unknown>) ?? {};
    const messages = (stateValues['messages'] as unknown[]) ?? [];

    async function* completedRunStream(): AsyncGenerator<AgentStreamEvent> {
      yield { event: 'metadata', data: { run_id: runId, thread_id: threadId } };
      yield { event: 'values', data: { messages } };
      yield { event: 'end', data: null };
    }
    await this.streamEmitter.streamFromAgent(reply, run, completedRunStream());
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
    const responseMessages = agentResponse.messages.map((m) =>
      this.toLangChainMessage(m),
    );
    const allMessages = [
      ...existingMessages,
      ...inputMessages.map((m) => this.toLangChainMessage(m as Record<string, unknown>)),
      ...responseMessages,
    ];

    const now = nowISO();
    // Persist the agent's returned state at the **top level** of `values`
    // (LangGraph's canonical "input keys = graph state" convention), so it
    // round-trips as inherited state on the next run's compose. The agent
    // returns a full snapshot today; folding it into the prior top-level
    // `values` per-channel (default LastValue) keeps the persist side
    // partial-update-safe — a key the response omits is retained, not wiped.
    // `messages` stay a separate manual append (above) and overwrite last;
    // they are never routed through the state reduce.
    const reducedValues = agentResponse.state
      ? reduceChannels(stateValues, agentResponse.state)
      : { ...stateValues };
    const newValues = {
      ...reducedValues,
      messages: allMessages,
    };

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

  /**
   * Convert an internal AgentMessage (or a raw input-message-shaped object)
   * into the LangChain message shape that LangGraph Platform emits on the
   * wire. The SDK strictly deserializes these fields; missing keys cause
   * downstream clients (e.g. the NBG .NET orchestrator) to silently drop
   * messages.
   */
  private toLangChainMessage(m: Record<string, unknown> | AgentMessage): Record<string, unknown> {
    const obj = m as Record<string, unknown>;
    const rawRole = (obj['role'] as string | undefined) ?? '';
    const explicitType = obj['type'] as string | undefined;
    const type =
      explicitType ??
      (rawRole === 'assistant' ? 'ai' : rawRole === 'user' ? 'human' : rawRole === 'system' ? 'system' : 'human');
    const base: Record<string, unknown> = {
      content: obj['content'] ?? '',
      additional_kwargs: (obj['additional_kwargs'] as Record<string, unknown> | undefined) ?? {},
      response_metadata: (obj['response_metadata'] as Record<string, unknown> | undefined) ?? {},
      type,
      name: (obj['name'] as string | null | undefined) ?? null,
      id: (obj['id'] as string | undefined) ?? generateId(),
      example: (obj['example'] as boolean | undefined) ?? false,
    };
    if (type === 'ai') {
      return {
        ...base,
        tool_calls: (obj['tool_calls'] as unknown[] | undefined) ?? [],
        invalid_tool_calls: (obj['invalid_tool_calls'] as unknown[] | undefined) ?? [],
        usage_metadata: (obj['usage_metadata'] as Record<string, unknown> | null | undefined) ?? null,
      };
    }
    return base;
  }

  /**
   * Look up the thread referenced by a run request. If the thread does not
   * exist, honor the run body's `if_not_exists` field — matching the real
   * LangGraph Platform contract:
   *   - "create"  → create the thread on the fly with the given id and return it.
   *   - "reject"  → throw 404 (default; matches real LangGraph).
   *   - undefined → treated as "reject".
   *
   * Centralized here so createStateful / wait / streamRun all share the same
   * semantics. See Issues - Pending Items.md (LG-IF-NOT-EXISTS) for context.
   */
  private async ensureThread(
    threadId: string,
    ifNotExists: 'create' | 'reject' | undefined,
  ): Promise<Thread> {
    const existing = await this.threadsRepository.getById(threadId);
    if (existing) {
      return existing;
    }
    if (ifNotExists === 'create') {
      const now = nowISO();
      const thread: Thread = {
        thread_id: threadId,
        created_at: now,
        updated_at: now,
        metadata: {},
        status: 'idle',
        values: {},
      };
      return this.threadsRepository.create(threadId, thread);
    }
    throw new ApiError(404, `Thread ${threadId} not found`);
  }
}
