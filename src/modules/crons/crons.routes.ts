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
      description: `Creates a scheduled cron job that periodically executes a run on a specific thread. The cron job accumulates state across executions, enabling recurring workflows that build on previous results (e.g., daily summaries that reference prior summaries).

Each scheduled execution creates a new run on the specified thread, loading the thread's current state as input. The schedule uses standard 5-field cron expression syntax interpreted in UTC. Key parameters include \`assistant_id\` (required), \`schedule\` (required, cron expression), \`input\` (optional graph input), and \`end_time\` (optional expiration).

**Important:** Delete cron jobs when no longer needed to avoid unwanted LLM API charges from recurring executions.`,
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
      description: `Creates a cron job that periodically executes a **stateless** run. Each scheduled execution creates a new temporary thread, executes the run, and discards the thread. Unlike stateful crons, there is no state accumulation between executions.

Stateless crons are ideal for recurring tasks that don't need history, such as scheduled batch processing, periodic notifications, or independent health checks. The schedule uses standard 5-field cron expression syntax in UTC.

Key parameters include \`assistant_id\` (required), \`schedule\` (required, cron expression), \`input\` (optional), and \`end_time\` (optional expiration). **Important:** Delete cron jobs when done to avoid unwanted LLM API charges.`,
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
      description: `Permanently deletes a cron job, stopping all future scheduled runs. This operation does not affect runs that have already executed -- completed runs remain in the thread (if stateful) or in storage.

Deleting cron jobs is critical for cost management. Forgotten cron jobs can accumulate significant LLM API charges over time. If a run is currently executing when the cron is deleted, that run completes normally. Returns 204 No Content on success or 404 if the cron does not exist.`,
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
      description: `Updates an existing cron job's schedule, input, metadata, or end time. This enables dynamic cron management without deleting and recreating jobs. Only specified fields are updated; others remain unchanged.

If the \`schedule\` field is updated, the \`next_run_date\` is recalculated accordingly. Changes apply to the next scheduled run -- already-queued runs are not affected. Common use cases include adjusting schedules (e.g., changing from daily to weekly), updating input for future runs, and extending or shortening expiration via \`end_time\`.`,
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
      description: `Searches for cron jobs matching specified filters and returns a paginated list. This endpoint supports filtering by \`assistant_id\`, \`thread_id\`, and \`enabled\` status, with configurable pagination and sorting.

Common use cases include listing a user's scheduled tasks, building admin dashboards showing all active crons, and finding crons to delete or update. The response is an array of cron job objects. Pagination headers are included in the response for total count, offset, and limit.`,
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
      description: `Returns the total count of cron jobs matching specified filters. This endpoint accepts the same filter parameters as POST /runs/crons/search (\`assistant_id\`, \`thread_id\`) but returns only an integer count instead of the full cron objects.

Useful for pagination UI (displaying "Page 1 of N"), quota enforcement (checking if a user has hit their cron limit), and dashboard metrics. The response is a JSON object with a \`count\` field.`,
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
