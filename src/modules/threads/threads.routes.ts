/**
 * Threads Route Plugin
 *
 * Registers all thread-related HTTP endpoints as a Fastify plugin.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  ThreadSchema,
  ThreadStateSchema,
  CreateThreadRequestSchema,
  UpdateThreadRequestSchema,
  SearchThreadsRequestSchema,
  CountThreadsRequestSchema,
  CopyThreadRequestSchema,
  PruneThreadsRequestSchema,
  UpdateThreadStateRequestSchema,
  ThreadHistoryRequestSchema,
  ThreadIdParamSchema,
  GetThreadQuerySchema,
  GetStateQuerySchema,
} from '../../schemas/thread.schema.js';
import { ErrorResponseSchema } from '../../schemas/common.schema.js';
import { ThreadsService } from './threads.service.js';
import { getRepositoryRegistry } from '../../repositories/registry.js';
import { setPaginationHeaders } from '../../utils/pagination.util.js';

const threadsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const { threads: repository } = getRepositoryRegistry();
  const service = new ThreadsService(repository);
  // POST /threads -> create
  fastify.route({
    method: 'POST',
    url: '/threads',
    schema: {
      tags: ['Threads'],
      summary: 'Create a new conversation thread',
      description: `Creates a new persistent conversation thread. A thread is a stateful container that maintains graph state across multiple run invocations, enabling multi-turn conversations and long-running workflows.

In the LangGraph Platform, threads store **state history** (checkpoints), **metadata** (key-value pairs for filtering), **status** (idle, busy, interrupted, error), and **values** (current state such as message history).

Threads can be created empty, with metadata for multi-tenant filtering, or with prepopulated state via \`supersteps\`. Thread IDs are UUIDs, auto-generated if not provided. Threads persist indefinitely unless explicitly deleted or pruned.`,
      body: CreateThreadRequestSchema,
      response: {
        200: ThreadSchema,
        409: ErrorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const body = request.body as any;
      const thread = await service.create(body);
      return reply.status(200).send(thread);
    },
  });

  // GET /threads/:thread_id -> get
  fastify.route({
    method: 'GET',
    url: '/threads/:thread_id',
    schema: {
      tags: ['Threads'],
      summary: 'Retrieve a thread by ID',
      description: `Retrieves the metadata and current status for a specific thread. This endpoint returns thread-level information but not the full state or history (use GET /threads/:thread_id/state for that).

In the LangGraph Platform, the GET thread operation is a lightweight way to check thread existence, retrieve metadata, or verify thread status before creating a run. The response includes \`thread_id\`, \`created_at\`, \`updated_at\`, \`metadata\`, and \`status\` (one of "idle", "busy", "interrupted", "error").

The status field reflects the most recent run's outcome. Threads do not automatically transition out of "error" status; a new successful run is required. Returns 404 if the thread does not exist.`,
      params: ThreadIdParamSchema,
      querystring: GetThreadQuerySchema,
      response: {
        200: ThreadSchema,
        404: ErrorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const { thread_id } = request.params as { thread_id: string };
      const thread = await service.get(thread_id);
      return reply.status(200).send(thread);
    },
  });

  // PATCH /threads/:thread_id -> update
  fastify.route({
    method: 'PATCH',
    url: '/threads/:thread_id',
    schema: {
      tags: ['Threads'],
      summary: 'Update thread metadata',
      description: `Updates the metadata for an existing thread. This endpoint modifies only the \`metadata\` field; it does not modify thread state (use POST /threads/:thread_id/state for state updates).

In the LangGraph Platform, thread metadata is used for organization, filtering, and application-specific tagging such as user IDs, session IDs, and environment tags. The operation performs a **merge**: new keys are added, existing keys are updated, and absent keys are left unchanged. To remove a metadata key, explicitly set it to null.

Metadata updates do not create new checkpoints or affect thread state. The thread's \`updated_at\` timestamp is updated. Returns 404 if the thread does not exist.`,
      params: ThreadIdParamSchema,
      body: UpdateThreadRequestSchema,
      response: {
        200: ThreadSchema,
        404: ErrorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const { thread_id } = request.params as { thread_id: string };
      const body = request.body as any;
      const thread = await service.update(thread_id, body);
      return reply.status(200).send(thread);
    },
  });

  // DELETE /threads/:thread_id -> delete
  fastify.route({
    method: 'DELETE',
    url: '/threads/:thread_id',
    schema: {
      tags: ['Threads'],
      summary: 'Permanently delete a thread',
      description: `Deletes a thread and all its associated state history, checkpoints, and metadata. This operation is irreversible and should be used with caution.

In the LangGraph Platform, deleting a thread removes all checkpoints (state snapshots), all metadata, thread configuration, and the thread record itself. Active runs are not cancelled automatically, and scheduled cron jobs targeting the deleted thread will fail on next execution.

Before deletion, consider exporting important conversation data via GET /threads/:thread_id/state or /history. Returns 204 No Content on success, 404 if the thread does not exist.`,
      params: ThreadIdParamSchema,
      response: {
        204: Type.Null(),
        404: ErrorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const { thread_id } = request.params as { thread_id: string };
      await service.delete(thread_id);
      return reply.status(204).send();
    },
  });

  // POST /threads/search -> search
  fastify.route({
    method: 'POST',
    url: '/threads/search',
    schema: {
      tags: ['Threads'],
      summary: 'Search and filter threads',
      description: `Searches for threads matching specified filters and returns a paginated list. Supports metadata filtering, status filtering, sorting, and pagination for multi-tenant applications and conversation management UIs.

In the LangGraph Platform, applications often manage thousands of threads across multiple users, sessions, or environments. Filter by \`metadata\` (exact match key-value pairs), \`status\` ("idle", "busy", "interrupted", "error"), and \`graph_id\`. Control pagination with \`limit\` (1-1000, default 10) and \`offset\`, and sorting with \`sort_by\` and \`sort_order\`.

Empty filters return all threads subject to the limit. Large result sets should use pagination to avoid timeouts. Response includes pagination headers.`,
      body: SearchThreadsRequestSchema,
      response: {
        200: Type.Array(ThreadSchema),
      },
    },
    handler: async (request, reply) => {
      const body = request.body as any;
      const result = await service.search(body);
      const limit = body.limit ?? 10;
      const offset = body.offset ?? 0;
      setPaginationHeaders(reply, result.total, offset, limit);
      return reply.status(200).send(result.items);
    },
  });

  // POST /threads/count -> count
  fastify.route({
    method: 'POST',
    url: '/threads/count',
    schema: {
      tags: ['Threads'],
      summary: 'Count threads matching filters',
      description: `Returns the total count of threads matching specified filters. Accepts the same filter parameters as POST /threads/search (\`metadata\`, \`status\`, \`graph_id\`) but returns only an integer count instead of full thread objects.

In the LangGraph Platform, the count endpoint is used for pagination UI (e.g., "Page 1 of 10"), quota enforcement (checking thread limits), and dashboard metrics (active conversation counts). Unlike search, count does not support pagination, sorting, or field selection.

Count is computed at query time and deleted threads are excluded.`,
      body: CountThreadsRequestSchema,
      response: {
        200: Type.Integer(),
      },
    },
    handler: async (request, reply) => {
      const body = request.body as any;
      const count = await service.count(body);
      return reply.status(200).send(count);
    },
  });

  // POST /threads/:thread_id/copy -> copy
  fastify.route({
    method: 'POST',
    url: '/threads/:thread_id/copy',
    schema: {
      tags: ['Threads'],
      summary: 'Clone a thread with its state history',
      description: `Creates a new thread that is an exact copy of an existing thread, including all state history and checkpoints up to the point of copy. The new thread is fully independent and can diverge from the original.

In the LangGraph Platform, copying threads enables branching conversations for "what if" scenarios, A/B testing different agent responses, creating templates from seed threads, and copying production threads to test environments for debugging. Optionally provide \`metadata\` in the request body to replace the original metadata.

The new thread gets a new UUID, starts with status "idle", and state values are deep-copied. The copy operation is atomic and does not trigger graph execution. Returns 404 if the source thread does not exist.`,
      params: ThreadIdParamSchema,
      body: CopyThreadRequestSchema,
      response: {
        200: ThreadSchema,
        404: ErrorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const { thread_id } = request.params as { thread_id: string };
      const thread = await service.copy(thread_id);
      return reply.status(200).send(thread);
    },
  });

  // POST /threads/prune -> prune
  fastify.route({
    method: 'POST',
    url: '/threads/prune',
    schema: {
      tags: ['Threads'],
      summary: 'Delete old or inactive threads in bulk',
      description: `Bulk deletes threads matching specified criteria. Designed for storage management and cleanup of inactive conversations that accumulate over time.

In the LangGraph Platform, threads persist indefinitely by default. Filter targets with \`metadata\` (exact match), \`status\`, \`created_before\`, and \`updated_before\` (ISO 8601 timestamps). Use \`limit\` to cap the number of deletions per operation and \`dry_run\` to preview impact without actually deleting.

Deletion is irreversible; use \`dry_run\` first to verify the scope. Active runs are not cancelled, so threads with "busy" status should be handled carefully. Returns 204 No Content on success.`,
      body: PruneThreadsRequestSchema,
      response: {
        204: Type.Null(),
      },
    },
    handler: async (request, reply) => {
      const body = request.body as any;
      await service.prune(body);
      return reply.status(204).send();
    },
  });

  // GET /threads/:thread_id/state -> getState
  fastify.route({
    method: 'GET',
    url: '/threads/:thread_id/state',
    schema: {
      tags: ['Threads'],
      summary: 'Get the current state of a thread',
      description: `Retrieves the current state values and checkpoint metadata for a thread at its most recent checkpoint, including all accumulated data from past runs.

In the LangGraph Platform, thread state is the core of stateful execution. The response includes **values** (the graph's state object such as message arrays and tool outputs), **next** (nodes scheduled to execute next, empty if idle), **checkpoint** (ID, timestamp, namespace), **metadata** (source node, step number), and **created_at**.

Optionally pass \`checkpoint_id\` to retrieve state at a specific historical checkpoint instead of the latest. If the thread has never run, values may be empty or contain defaults. Returns 404 if the thread does not exist.`,
      params: ThreadIdParamSchema,
      querystring: GetStateQuerySchema,
      response: {
        200: ThreadStateSchema,
        404: ErrorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const { thread_id } = request.params as { thread_id: string };
      const { subgraphs } = (request.query as { subgraphs?: boolean }) ?? {};
      const state = await service.getState(thread_id, subgraphs);
      return reply.status(200).send(state);
    },
  });

  // POST /threads/:thread_id/state -> updateState
  fastify.route({
    method: 'POST',
    url: '/threads/:thread_id/state',
    schema: {
      tags: ['Threads'],
      summary: 'Manually update thread state',
      description: `Manually modifies the state of a thread by creating a new checkpoint with updated values. This enables direct state manipulation outside of normal graph execution, useful for corrections, admin overrides, and testing.

In the LangGraph Platform, thread state is normally updated only by graph execution. This endpoint provides an "escape hatch" to inject state changes programmatically. Provide \`values\` (merged with existing state), optional \`as_node\` (node name to attribute the update to), and optional \`checkpoint_id\` (for branching from a specific checkpoint).

State updates do not trigger graph execution. Subsequent runs will see the updated state. Updates are atomic and versioned, so they can be reverted via checkpoint rollback. Returns 404 if the thread does not exist.`,
      params: ThreadIdParamSchema,
      body: UpdateThreadStateRequestSchema,
      response: {
        200: Type.Record(Type.String(), Type.Unknown()),
        404: ErrorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const { thread_id } = request.params as { thread_id: string };
      const body = request.body as any;
      const result = await service.updateState(thread_id, body);
      return reply.status(200).send(result);
    },
  });

  // POST /threads/:thread_id/history -> getHistory
  fastify.route({
    method: 'POST',
    url: '/threads/:thread_id/history',
    schema: {
      tags: ['Threads'],
      summary: 'Get state history (checkpoints) of a thread',
      description: `Retrieves the complete checkpoint history for a thread, showing every state snapshot from all past runs. Enables time-travel debugging, execution audits, and state replay.

In the LangGraph Platform, checkpoints are created at configurable intervals during graph execution. Each checkpoint captures the full state, metadata (step number, source node, writes performed), parent checkpoint reference, and timestamp. Filter with \`limit\` (default 10), \`offset\`, \`before\` (checkpoint_id), and \`metadata\`.

Results are returned in reverse chronological order (newest first). Large threads may have thousands of checkpoints, so use pagination. Checkpoints include full state, so history responses can be large. Returns 404 if the thread does not exist.`,
      params: ThreadIdParamSchema,
      body: ThreadHistoryRequestSchema,
      response: {
        200: Type.Array(ThreadStateSchema),
        404: ErrorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const { thread_id } = request.params as { thread_id: string };
      const body = request.body as any;
      const result = await service.getHistory(thread_id, body);
      const limit = body.limit ?? 10;
      setPaginationHeaders(reply, result.total, 0, limit);
      return reply.status(200).send(result.items);
    },
  });

  // GET /threads/:thread_id/stream -> stub (501 - SSE handled by runs module)
  fastify.route({
    method: 'GET',
    url: '/threads/:thread_id/stream',
    schema: {
      tags: ['Threads'],
      summary: 'Stream thread events via SSE (not implemented)',
      description: `Reserved endpoint for streaming real-time events from a thread via Server-Sent Events, independent of a specific run. Currently returns **501 Not Implemented**.

In the LangGraph Platform API specification, thread streaming would enable clients to subscribe to all events on a thread across multiple runs and receive notifications when runs start or complete. However, the standard pattern for streaming is to stream individual runs via POST /threads/:thread_id/runs/stream (new runs) or GET /threads/:thread_id/runs/:run_id/stream (existing runs).

For real-time updates in your application, use the run streaming endpoints instead. Thread-level streaming is not commonly needed because runs are the unit of execution and event generation.`,
      params: ThreadIdParamSchema,
      response: {
        501: ErrorResponseSchema,
      },
    },
    handler: async (_request, reply) => {
      return reply.status(501).send({ detail: 'SSE streaming is handled by the runs module' });
    },
  });
};

export default threadsRoutes;
