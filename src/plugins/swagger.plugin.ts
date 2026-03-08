import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';

export default fp(
  async function swaggerPlugin(fastify: FastifyInstance) {
    await fastify.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title: 'LG API',
          description: 'LangGraph Server API Drop-in Replacement',
          version: '1.0.0',
        },
        components: {
          securitySchemes: {
            apiKey: {
              type: 'apiKey',
              name: 'X-Api-Key',
              in: 'header',
            },
          },
        },
      },
    });

    await fastify.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: {
        docExpansion: 'list',
        deepLinking: true,
      },
    });
  },
  {
    name: 'swagger-plugin',
  }
);
