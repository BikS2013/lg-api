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
        tags: [
          {
            name: 'Assistants',
            description: 'Manage assistants - versioned configurations of deployed graphs. Each assistant references a specific graph and binds it to particular configuration including model parameters, system prompts, tools, and runtime context. Multiple assistants can reference the same graph with different configurations. Assistants are immutable; updates create new versions with rollback support.',
          },
          {
            name: 'Threads',
            description: 'Manage conversation threads - persistent containers that maintain state across multiple run invocations. Threads store accumulated state (messages, intermediate values, checkpoint history) from all runs, enabling multi-turn conversations, long-running workflows, and stateful agent interactions.',
          },
          {
            name: 'Runs',
            description: 'Execute agent graphs - create, monitor, stream, and manage run invocations. Runs can be stateful (bound to a thread, accumulating state) or stateless (ephemeral). Supports synchronous wait, asynchronous background execution, real-time SSE streaming, and batch processing.',
          },
          {
            name: 'Crons',
            description: 'Schedule recurring runs - automated periodic execution of agent graphs using cron expressions (UTC). Cron jobs can be stateful (bound to a thread) or stateless. Important: delete cron jobs when no longer needed to avoid unwanted LLM API charges.',
          },
          {
            name: 'Store',
            description: 'Key-value storage - persistent cross-thread memory organized by hierarchical namespaces. Enables long-term memory shared across conversations, users, or agents. Unlike thread state (scoped to a single conversation), store items persist indefinitely and are accessible from any thread.',
          },
          {
            name: 'System',
            description: 'System endpoints - health checks and server capability discovery. Used by infrastructure (load balancers, monitoring), client applications (feature detection), and operators (deployment verification).',
          },
        ],
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
