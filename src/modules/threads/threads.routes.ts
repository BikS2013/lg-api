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
