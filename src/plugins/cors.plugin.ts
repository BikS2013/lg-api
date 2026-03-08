import fp from 'fastify-plugin';
import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';

export default fp(
  async function corsPlugin(fastify: FastifyInstance) {
    await fastify.register(cors, {
      origin: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
      exposedHeaders: [
        'X-Pagination-Total',
        'X-Pagination-Offset',
        'X-Pagination-Limit',
      ],
      credentials: true,
    });
  },
  {
    name: 'cors-plugin',
  }
);
