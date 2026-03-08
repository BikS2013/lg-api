import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ApiError } from '../errors/api-error.js';
import { ErrorCodes } from '../errors/error-codes.js';
import type { AppConfig } from '../config/env.config.js';

const SKIP_PATHS = ['/ok', '/docs'];

function shouldSkip(url: string): boolean {
  return SKIP_PATHS.some((path) => url === path || url.startsWith(path + '/'));
}

export default fp(
  async function authPlugin(fastify: FastifyInstance) {
    const config = fastify.config;

    fastify.addHook(
      'preHandler',
      async (request: FastifyRequest, _reply: FastifyReply) => {
        if (!config.authEnabled) {
          return;
        }

        if (shouldSkip(request.url)) {
          return;
        }

        const apiKey = request.headers['x-api-key'];

        if (!apiKey) {
          throw new ApiError(
            ErrorCodes.MISSING_API_KEY.statusCode,
            ErrorCodes.MISSING_API_KEY.message,
            'Provide a valid API key via the X-Api-Key header'
          );
        }

        if (apiKey !== config.apiKey) {
          throw new ApiError(
            ErrorCodes.INVALID_API_KEY.statusCode,
            ErrorCodes.INVALID_API_KEY.message,
            'The provided API key is not valid'
          );
        }
      }
    );
  },
  {
    name: 'auth-plugin',
  }
);
