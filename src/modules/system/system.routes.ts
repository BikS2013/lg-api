/**
 * System Routes
 *
 * Fastify plugin that registers system-level API endpoints.
 *
 * Endpoints:
 *   GET /ok   -> health check
 *   GET /info -> server info and capabilities
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Type } from '@sinclair/typebox';

const systemRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // GET /ok -> health check
  // Note: A basic /ok route exists in app.ts from the foundation.
  // This route is defined here for modular completeness. The registering
  // agent should decide whether to skip the app.ts version or this one.
  fastify.get('/ok', {
    schema: {
      tags: ['System'],
      summary: 'Health check',
      response: {
        200: Type.Object({
          ok: Type.Boolean(),
        }),
      },
    },
  }, async (_request, reply) => {
    return reply.status(200).send({ ok: true });
  });

  // GET /info -> server info
  fastify.get('/info', {
    schema: {
      tags: ['System'],
      summary: 'Server information and capabilities',
      response: {
        200: Type.Object({
          version: Type.String(),
          name: Type.String(),
          description: Type.String(),
          capabilities: Type.Object({
            assistants: Type.Boolean(),
            threads: Type.Boolean(),
            runs: Type.Boolean(),
            crons: Type.Boolean(),
            store: Type.Boolean(),
            streaming: Type.Boolean(),
          }),
        }),
      },
    },
  }, async (_request, reply) => {
    return reply.status(200).send({
      version: '0.1.0',
      name: 'lg-api',
      description: 'LangGraph Server API Drop-in Replacement',
      capabilities: {
        assistants: true,
        threads: true,
        runs: true,
        crons: true,
        store: true,
        streaming: true,
      },
    });
  });
};

export default systemRoutes;
