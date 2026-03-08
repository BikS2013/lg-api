/**
 * Crons Routes
 *
 * Fastify plugin that registers all cron-related API endpoints.
 *
 * Endpoints:
 *   POST   /threads/:thread_id/runs/crons  -> create stateful cron
 *   POST   /runs/crons                     -> create stateless cron
 *   DELETE /runs/crons/:cron_id            -> delete cron
 *   PATCH  /runs/crons/:cron_id            -> update cron
 *   POST   /runs/crons/search              -> search crons
 *   POST   /runs/crons/count               -> count crons
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  CronSchema,
  CreateCronRequestSchema,
  UpdateCronRequestSchema,
  SearchCronsRequestSchema,
  CountCronsRequestSchema,
  CronIdParamSchema,
} from '../../schemas/cron.schema.js';
import { ThreadIdParamSchema } from '../../schemas/thread.schema.js';
import { ErrorResponseSchema } from '../../schemas/common.schema.js';
import { CronsService } from './crons.service.js';
import { getRepositoryRegistry } from '../../repositories/registry.js';
import { setPaginationHeaders } from '../../utils/pagination.util.js';

const cronsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const { crons: repository } = getRepositoryRegistry();
  const service = new CronsService(repository);

  // POST /threads/:thread_id/runs/crons -> create stateful cron
  fastify.post('/threads/:thread_id/runs/crons', {
    schema: {
      tags: ['Crons'],
      summary: 'Create a stateful cron job bound to a thread',
      params: ThreadIdParamSchema,
      body: CreateCronRequestSchema,
      response: {
        201: CronSchema,
        422: ErrorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const { thread_id } = request.params as { thread_id: string };
    const body = request.body as any;

    const cron = await service.createCron(thread_id, body);
    return reply.status(201).send(cron);
  });

  // POST /runs/crons -> create stateless cron
  fastify.post('/runs/crons', {
    schema: {
      tags: ['Crons'],
      summary: 'Create a stateless cron job',
      body: CreateCronRequestSchema,
      response: {
        201: CronSchema,
        422: ErrorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const body = request.body as any;

    const cron = await service.createCron(null, body);
    return reply.status(201).send(cron);
  });

  // DELETE /runs/crons/:cron_id -> delete cron
  fastify.delete('/runs/crons/:cron_id', {
    schema: {
      tags: ['Crons'],
      summary: 'Delete a cron job',
      params: CronIdParamSchema,
      response: {
        204: Type.Null(),
        404: ErrorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const { cron_id } = request.params as { cron_id: string };

    await service.deleteCron(cron_id);
    return reply.status(204).send();
  });

  // PATCH /runs/crons/:cron_id -> update cron
  fastify.patch('/runs/crons/:cron_id', {
    schema: {
      tags: ['Crons'],
      summary: 'Update a cron job',
      params: CronIdParamSchema,
      body: UpdateCronRequestSchema,
      response: {
        200: CronSchema,
        404: ErrorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const { cron_id } = request.params as { cron_id: string };
    const body = request.body as any;

    const cron = await service.updateCron(cron_id, body);
    return reply.status(200).send(cron);
  });

  // POST /runs/crons/search -> search crons
  fastify.post('/runs/crons/search', {
    schema: {
      tags: ['Crons'],
      summary: 'Search cron jobs',
      body: SearchCronsRequestSchema,
      response: {
        200: Type.Array(CronSchema),
      },
    },
  }, async (request, reply) => {
    const body = request.body as any;

    const limit = body.limit ?? 10;
    const offset = body.offset ?? 0;

    const result = await service.searchCrons({
      assistant_id: body.assistant_id,
      thread_id: body.thread_id,
      enabled: body.enabled,
      limit,
      offset,
      sort_by: body.sort_by,
      sort_order: body.sort_order,
      select: body.select,
    });

    setPaginationHeaders(reply, result.total, offset, limit);
    return reply.status(200).send(result.items);
  });

  // POST /runs/crons/count -> count crons
  fastify.post('/runs/crons/count', {
    schema: {
      tags: ['Crons'],
      summary: 'Count cron jobs',
      body: CountCronsRequestSchema,
      response: {
        200: Type.Object({ count: Type.Integer() }),
      },
    },
  }, async (request, reply) => {
    const body = request.body as any;

    const count = await service.countCrons({
      assistant_id: body.assistant_id,
      thread_id: body.thread_id,
    });

    return reply.status(200).send({ count });
  });
};

export default cronsRoutes;
