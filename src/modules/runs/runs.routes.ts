/**
 * Runs Routes - Fastify plugin registering all 14 run endpoints.
 *
 * Includes CRUD operations, batch creation, streaming (SSE),
 * wait, join, and cancellation routes.
 */

import type { FastifyInstance } from 'fastify';
import type { Static } from '@sinclair/typebox';
import {
  RunSchema,
  RunCreateRequestSchema,
  RunBatchRequestSchema,
  ListRunsQuerySchema,
  CancelRunRequestSchema,
  BulkCancelRunsRequestSchema,
  RunIdParamSchema,
  JoinStreamQuerySchema,
  RunWaitResponseSchema,
} from '../../schemas/run.schema.js';
import { ThreadIdParamSchema } from '../../schemas/thread.schema.js';
import { Type } from '@sinclair/typebox';
import { RunsService } from './runs.service.js';
import { getRepositoryRegistry, getStorageProvider } from '../../repositories/registry.js';
import { AgentRegistry } from '../../agents/agent-registry.js';
import { AgentExecutor } from '../../agents/agent-executor.js';
import { AssistantResolver } from '../../agents/assistant-resolver.js';
import { RequestComposer } from '../../agents/request-composer.js';
import { setPaginationHeaders } from '../../utils/pagination.util.js';
import type { StreamMode } from '../../types/index.js';

// Derived static types
type RunCreateRequest = Static<typeof RunCreateRequestSchema>;
type ListRunsQuery = Static<typeof ListRunsQuerySchema>;
type CancelRunRequest = Static<typeof CancelRunRequestSchema>;
type BulkCancelRunsRequest = Static<typeof BulkCancelRunsRequestSchema>;
type RunIdParams = Static<typeof RunIdParamSchema>;
type ThreadIdParams = Static<typeof ThreadIdParamSchema>;
type JoinStreamQuery = Static<typeof JoinStreamQuerySchema>;

// Combined thread_id param for routes that only need thread_id
const ThreadIdOnlyParamSchema = Type.Object({
  thread_id: Type.String({ format: 'uuid' }),
});

export default async function registerRunRoutes(fastify: FastifyInstance): Promise<void> {
  const { runs: runsRepository, threads: threadsRepository } = getRepositoryRegistry();
  const storage = getStorageProvider();
  const registry = new AgentRegistry();
  const assistantResolver = new AssistantResolver(storage.assistants);
  const agentExecutor = new AgentExecutor(registry);
  const requestComposer = new RequestComposer();
  const runsService = new RunsService(runsRepository, threadsRepository, agentExecutor, assistantResolver, requestComposer);

  // ---------------------------------------------------------------
  // 1. POST /threads/:thread_id/runs - Create stateful run
  // ---------------------------------------------------------------
  fastify.post<{
    Params: ThreadIdParams;
    Body: RunCreateRequest;
  }>('/threads/:thread_id/runs', {
    schema: {
      tags: ['Runs'],
      summary: 'Create and execute a run on a thread',
      description: `Creates and executes a new **stateful** run on an existing thread. A run invokes an assistant's graph with specific input within the context of a thread's accumulated state. This is the primary endpoint for multi-turn agent interactions.

In the LangGraph Platform, stateful runs load the thread's current state, execute the graph, update the thread with results, and create checkpoints. Key parameters: \`assistant_id\` (required), \`input\`, \`config\`, \`metadata\`, and \`multitask_strategy\` ("reject", "enqueue", "interrupt").

Execution is asynchronous by default. Use POST /threads/:thread_id/runs/wait for synchronous behavior or POST /threads/:thread_id/runs/stream for real-time SSE updates.`,
      params: ThreadIdOnlyParamSchema,
      body: RunCreateRequestSchema,
      response: { 200: RunSchema },
    },
  }, async (request, reply) => {
    const { thread_id } = request.params;
    const run = await runsService.createStateful(thread_id, request.body);
    return reply.code(200).send(run);
  });

  // ---------------------------------------------------------------
  // 2. POST /runs - Create stateless run
  // ---------------------------------------------------------------
  fastify.post<{
    Body: RunCreateRequest;
  }>('/runs', {
    schema: {
      tags: ['Runs'],
      summary: 'Create and execute a stateless run (no thread)',
      description: `Creates and executes a **stateless** run without a thread. Stateless runs are ephemeral: they do not persist state before or after execution. Each stateless run is fully independent.

In the LangGraph Platform, stateless runs are used for one-off requests, batch processing, and exposing agents as pure functions (input to output) without session management. A temporary thread is created internally, the run executes, and the thread is discarded after completion.

Key parameters include \`assistant_id\` (required) and \`input\` (required). Stateless runs are faster to initialize (no state loading) and support unlimited parallelism.`,
      body: RunCreateRequestSchema,
      response: { 200: RunSchema },
    },
  }, async (request, reply) => {
    const run = await runsService.createStateless(request.body);
    return reply.code(200).send(run);
  });

  // ---------------------------------------------------------------
  // 3. POST /threads/:thread_id/runs/stream - Stream stateful run (SSE)
  // ---------------------------------------------------------------
  fastify.post<{
    Params: ThreadIdParams;
    Body: RunCreateRequest;
  }>('/threads/:thread_id/runs/stream', {
    schema: {
      tags: ['Runs'],
      summary: 'Create and stream a stateful run via SSE',
      description: `Creates a new run on a thread and streams execution events in real-time using Server-Sent Events (SSE). This is the streaming variant of POST /threads/:thread_id/runs.

In the LangGraph Platform, streaming enables real-time UIs where users see agent progress as it happens. The \`stream_mode\` parameter controls event granularity: **values** emits full state after each node, **messages** emits incremental LLM tokens for typewriter effect, **events** emits lifecycle events, and **debug** emits all internal events.

The connection remains open until the run completes or the client disconnects. Response uses Content-Type \`text/event-stream\` with typed events including \`metadata\`, \`values\`, \`messages/partial\`, \`error\`, and \`end\`.`,
      params: ThreadIdOnlyParamSchema,
      body: RunCreateRequestSchema,
    },
  }, async (request, reply) => {
    const { thread_id } = request.params;
    await runsService.streamRun(thread_id, request.body, reply);
    // Do not call reply.send() - response already written via raw
  });

  // ---------------------------------------------------------------
  // 4. POST /runs/stream - Stream stateless run (SSE)
  // ---------------------------------------------------------------
  fastify.post<{
    Body: RunCreateRequest;
  }>('/runs/stream', {
    schema: {
      tags: ['Runs'],
      summary: 'Create and stream a stateless run via SSE',
      description: `Creates a **stateless** run (no thread) and streams execution events in real-time using Server-Sent Events (SSE). This is the streaming variant of POST /runs.

In the LangGraph Platform, stateless streaming is used for one-off agent requests where you want real-time updates but don't need persistent state. A temporary thread is created, used for the run, and discarded after completion. All \`stream_mode\` options (values, messages, events, debug) are supported.

Stateless streaming runs are fully independent with no state accumulation. Lower latency than stateful streaming due to no state loading overhead. Response format is identical to POST /threads/:thread_id/runs/stream.`,
      body: RunCreateRequestSchema,
    },
  }, async (request, reply) => {
    await runsService.streamRun(null, request.body, reply);
    // Do not call reply.send() - response already written via raw
  });

  // ---------------------------------------------------------------
  // 5. POST /threads/:thread_id/runs/wait - Wait for stateful run
  // ---------------------------------------------------------------
  fastify.post<{
    Params: ThreadIdParams;
    Body: RunCreateRequest;
  }>('/threads/:thread_id/runs/wait', {
    schema: {
      tags: ['Runs'],
      summary: 'Create a stateful run and wait for completion',
      description: `Creates a new run on a thread and blocks until execution completes. This is the synchronous variant of POST /threads/:thread_id/runs, useful when you need the final result immediately without streaming.

In the LangGraph Platform, the "wait" endpoints provide a request-response programming model: send input, wait for processing, receive output. The HTTP connection remains open while the run executes, and the response is sent only after the run reaches a terminal status (**success**, **error**, or **interrupted**).

Long-running runs may timeout based on HTTP client/server timeout settings. If the client disconnects, the run continues in the background. Use POST /threads/:thread_id/runs/:run_id/cancel to stop it.`,
      params: ThreadIdOnlyParamSchema,
      body: RunCreateRequestSchema,
      response: { 200: RunWaitResponseSchema },
    },
  }, async (request, reply) => {
    const { thread_id } = request.params;
    const result = await runsService.wait(thread_id, request.body);
    return reply.code(200).send(result);
  });

  // ---------------------------------------------------------------
  // 6. POST /runs/wait - Wait for stateless run
  // ---------------------------------------------------------------
  fastify.post<{
    Body: RunCreateRequest;
  }>('/runs/wait', {
    schema: {
      tags: ['Runs'],
      summary: 'Create a stateless run and wait for completion',
      description: `Creates a **stateless** run (no thread) and blocks until execution completes. This is the synchronous variant of POST /runs, providing the simplest way to invoke an agent: send input, get output.

In the LangGraph Platform, stateless wait provides a pure request-response model. A temporary thread is created, the run executes, the response is returned, and the thread is discarded. No state persists after the response.

This is the simplest programming model: pure input/output with no follow-up queries to thread state. Lower latency than stateful wait (no state loading) but cannot resume conversations.`,
      body: RunCreateRequestSchema,
      response: { 200: RunWaitResponseSchema },
    },
  }, async (request, reply) => {
    const result = await runsService.wait(null, request.body);
    return reply.code(200).send(result);
  });

  // ---------------------------------------------------------------
  // 7. POST /runs/batch - Batch create runs
  // ---------------------------------------------------------------
  fastify.post<{
    Body: RunCreateRequest[];
  }>('/runs/batch', {
    schema: {
      tags: ['Runs'],
      summary: 'Create multiple stateless runs in a single request',
      description: `Creates multiple **stateless** runs in a single batch request. This endpoint is optimized for bulk processing where you need to run the same or different assistants on many independent inputs.

In the LangGraph Platform, batch runs are executed in parallel on available queue workers, making this significantly faster than creating runs sequentially. All runs are stateless (temporary threads, no state persistence) and independent: one failure does not affect others.

The request returns immediately with run objects in "pending" status. Use GET /threads/:thread_id/runs/:run_id to poll individual run results after completion.`,
      body: RunBatchRequestSchema,
      response: { 200: Type.Array(RunSchema) },
    },
  }, async (request, reply) => {
    const runs = await runsService.createBatch(request.body);
    return reply.code(200).send(runs);
  });

  // ---------------------------------------------------------------
  // 8. GET /threads/:thread_id/runs - List runs
  // ---------------------------------------------------------------
  fastify.get<{
    Params: ThreadIdParams;
    Querystring: ListRunsQuery;
  }>('/threads/:thread_id/runs', {
    schema: {
      tags: ['Runs'],
      summary: 'List all runs for a thread',
      description: `Retrieves a list of all runs that have been executed on a specific thread. Supports pagination via \`limit\` and \`offset\` query parameters, and filtering by \`status\`.

In the LangGraph Platform, threads accumulate runs over time. The runs list provides a chronological view of all agent invocations on a thread, useful for audit trails, debugging, and conversation history. Runs are returned in reverse chronological order (newest first).

Stateless runs do not appear in this listing as they have no persistent thread. Pagination headers are included in the response for navigating large result sets.`,
      params: ThreadIdOnlyParamSchema,
      querystring: ListRunsQuerySchema,
      response: { 200: Type.Array(RunSchema) },
    },
  }, async (request, reply) => {
    const { thread_id } = request.params;
    const result = await runsService.list(thread_id, request.query);
    setPaginationHeaders(reply, result.total, result.offset, result.limit);
    return reply.code(200).send(result.items);
  });

  // ---------------------------------------------------------------
  // 9. GET /threads/:thread_id/runs/:run_id - Get run
  // ---------------------------------------------------------------
  fastify.get<{
    Params: RunIdParams;
  }>('/threads/:thread_id/runs/:run_id', {
    schema: {
      tags: ['Runs'],
      summary: 'Retrieve a specific run by ID',
      description: `Retrieves the full details of a specific run, including its current status, configuration, and timestamps. Useful for polling run status, retrieving results after background execution, or debugging failures.

In the LangGraph Platform, run status progresses through: **pending** (queued), **running** (executing), and a terminal state of **success**, **error**, **interrupted**, or **cancelled**. The response includes \`run_id\`, \`thread_id\`, \`assistant_id\`, \`status\`, \`created_at\`, \`started_at\`, and \`ended_at\`.

Returns 404 if the run or thread does not exist.`,
      params: RunIdParamSchema,
      response: { 200: RunSchema },
    },
  }, async (request, reply) => {
    const { thread_id, run_id } = request.params;
    const run = await runsService.get(thread_id, run_id);
    return reply.code(200).send(run);
  });

  // ---------------------------------------------------------------
  // 10. POST /threads/:thread_id/runs/:run_id/cancel - Cancel run
  // ---------------------------------------------------------------
  fastify.post<{
    Params: RunIdParams;
    Body: CancelRunRequest;
  }>('/threads/:thread_id/runs/:run_id/cancel', {
    schema: {
      tags: ['Runs'],
      summary: 'Cancel an in-progress run',
      description: `Cancels a running or pending run on a thread. The run is terminated gracefully: any in-progress work is finalized and the run status is set to "cancelled".

In the LangGraph Platform, if the run is **pending** it is removed from the queue. If **running**, the worker is signaled to stop at the next checkpoint boundary and partial state is saved. If already completed, the request succeeds with no effect (idempotent). The thread remains in a valid state and can accept new runs after cancellation.

Cancellation is asynchronous: the response is immediate but the run may take a few seconds to fully stop. Returns 204 on success, 404 if run or thread does not exist.`,
      params: RunIdParamSchema,
      body: CancelRunRequestSchema,
    },
  }, async (request, reply) => {
    const { thread_id, run_id } = request.params;
    await runsService.cancel(thread_id, run_id, request.body);
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------
  // 11. POST /runs/cancel - Bulk cancel runs
  // ---------------------------------------------------------------
  fastify.post<{
    Body: BulkCancelRunsRequest;
  }>('/runs/cancel', {
    schema: {
      tags: ['Runs'],
      summary: 'Cancel multiple runs by filter',
      description: `Cancels multiple runs matching specified filters in a single request. This is the bulk variant of POST /threads/:thread_id/runs/:run_id/cancel.

In the LangGraph Platform, bulk cancellation supports filters such as \`status\`, \`metadata\`, \`thread_id\`, and \`assistant_id\`. A \`limit\` parameter prevents accidental mass cancellation. Use cases include emergency stop of all running runs, cancelling runs for a specific user via metadata, or cleaning up pending runs before maintenance.

Cancellation is asynchronous and eventual. Already completed runs are not affected. Use with caution as bulk cancellation can disrupt production workloads.`,
      body: BulkCancelRunsRequestSchema,
    },
  }, async (request, reply) => {
    await runsService.bulkCancel(request.body);
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------
  // 12. GET /threads/:thread_id/runs/:run_id/join - Join run (wait for completion)
  // ---------------------------------------------------------------
  fastify.get<{
    Params: RunIdParams;
  }>('/threads/:thread_id/runs/:run_id/join', {
    schema: {
      tags: ['Runs'],
      summary: 'Wait for an existing run to complete',
      description: `Blocks and waits for an already-created run to reach a terminal status (**success**, **error**, **interrupted**, or **cancelled**). This is the "wait after create" pattern, useful when you create a run asynchronously and later want its result synchronously.

In the LangGraph Platform, the join operation complements asynchronous run creation. If the run is already completed, the response is immediate. If pending or running, the HTTP connection blocks until completion. This enables workflows like: start multiple runs in parallel, then join each to collect results.

Subject to HTTP timeout limits. If the run never completes, the join request hangs until timeout. For real-time updates, use streaming endpoints instead. Returns 404 if run or thread does not exist.`,
      params: RunIdParamSchema,
      response: { 200: RunSchema },
    },
  }, async (request, reply) => {
    const { thread_id, run_id } = request.params;
    const run = await runsService.join(thread_id, run_id);
    return reply.code(200).send(run);
  });

  // ---------------------------------------------------------------
  // 13. GET /threads/:thread_id/runs/:run_id/stream - Join run stream (SSE)
  // ---------------------------------------------------------------
  fastify.get<{
    Params: RunIdParams;
    Querystring: JoinStreamQuery;
  }>('/threads/:thread_id/runs/:run_id/stream', {
    schema: {
      tags: ['Runs'],
      summary: 'Join an existing run\'s SSE stream',
      description: `Connects to the SSE stream of an already-running run. This enables clients to reconnect after disconnection or to "join" a run started by another client. Supports resumability via the \`Last-Event-ID\` header.

In the LangGraph Platform, SSE streams are resumable. If the run is still executing, events are streamed in real-time. If completed, the final events are sent and the stream closes. If pending, the stream waits until execution begins. The \`stream_mode\` query parameter can override the original stream mode.

Use cases include reconnecting after network interruption, multiple viewers monitoring the same run, and delayed join where a user navigates away and returns later. Returns 404 if run or thread does not exist.`,
      params: RunIdParamSchema,
      querystring: JoinStreamQuerySchema,
    },
  }, async (request, reply) => {
    const { thread_id, run_id } = request.params;
    const streamModes = request.query.stream_mode as StreamMode[] | undefined;
    const lastEventId = request.query.last_event_id
      ?? request.headers['last-event-id'] as string | undefined;

    await runsService.joinStream(
      thread_id,
      run_id,
      reply,
      streamModes,
      lastEventId,
    );
    // Do not call reply.send() - response already written via raw
  });

  // ---------------------------------------------------------------
  // 14. DELETE /threads/:thread_id/runs/:run_id - Delete run
  // ---------------------------------------------------------------
  fastify.delete<{
    Params: RunIdParams;
  }>('/threads/:thread_id/runs/:run_id', {
    schema: {
      tags: ['Runs'],
      summary: 'Delete a run record',
      description: `Permanently deletes a run record and its associated metadata. This does not affect the thread's state (which was already updated by the run), only the run record itself.

In the LangGraph Platform, run deletion is used for audit log cleanup, privacy compliance (removing runs with sensitive data), and test cleanup after CI. The run record is permanently and irreversibly deleted, and will no longer appear in GET /threads/:thread_id/runs listings.

Active runs should be cancelled before deletion. Deleting a run does not revert thread state; use checkpoint rollback for that. Returns 204 on success, 404 if run does not exist.`,
      params: RunIdParamSchema,
    },
  }, async (request, reply) => {
    const { thread_id, run_id } = request.params;
    await runsService.delete(thread_id, run_id);
    return reply.code(204).send();
  });
}
