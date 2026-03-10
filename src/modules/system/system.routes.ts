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
      description: `Returns a simple success response indicating the server is running and able to handle requests. This endpoint is used for load balancer health checks, uptime monitoring, and deployment verification.

In the LangGraph Platform, the health check endpoint does not verify connectivity to dependent services (database, Redis, etc.). It only confirms the HTTP server process is responsive. No authentication is required and processing is minimal, returning immediately with a JSON object containing an **ok** status.`,
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
      description: `Returns metadata about the server including version, name, and supported feature capabilities. This endpoint enables clients to discover what the server supports and adjust behavior accordingly.

In the LangGraph Platform, the /info endpoint is used for version negotiation, feature detection, and debugging. Clients can check if specific capabilities like **streaming**, **crons**, or **store** are supported before attempting to use them. The response includes a \`capabilities\` object with boolean flags for each supported feature area (assistants, threads, runs, crons, store, streaming).`,
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
