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
import { getRepositoryRegistry } from '../../repositories/registry.js';
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
  const runsService = new RunsService(runsRepository, threadsRepository);

  // ---------------------------------------------------------------
  // 1. POST /threads/:thread_id/runs - Create stateful run
  // ---------------------------------------------------------------
  fastify.post<{
    Params: ThreadIdParams;
    Body: RunCreateRequest;
  }>('/threads/:thread_id/runs', {
    schema: {
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
      params: RunIdParamSchema,
    },
  }, async (request, reply) => {
    const { thread_id, run_id } = request.params;
    await runsService.delete(thread_id, run_id);
    return reply.code(204).send();
  });
}
