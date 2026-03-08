import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ApiError } from '../errors/api-error.js';

export default fp(
  async function errorHandlerPlugin(fastify: FastifyInstance) {
    fastify.setErrorHandler(
      (error: Error, _request: FastifyRequest, reply: FastifyReply) => {
        // Handle ApiError
        if (error instanceof ApiError) {
          return reply.status(error.statusCode).send({
            detail: error.detail ?? error.message,
          });
        }

        // Handle Fastify validation errors
        const fastifyError = error as Error & {
          validation?: unknown;
          statusCode?: number;
        };
        if (fastifyError.validation) {
          return reply.status(422).send({
            detail: fastifyError.message,
          });
        }

        // Handle unknown errors
        fastify.log.error(error);
        return reply.status(500).send({
          detail: 'Internal Server Error',
        });
      }
    );
  },
  {
    name: 'error-handler-plugin',
  }
);
