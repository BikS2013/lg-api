/**
 * Assistants Route Plugin
 *
 * Registers all assistant-related HTTP endpoints as a Fastify plugin.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  AssistantSchema,
  AssistantVersionSchema,
  CreateAssistantRequestSchema,
  UpdateAssistantRequestSchema,
  SearchAssistantsRequestSchema,
  CountAssistantsRequestSchema,
  GetGraphQuerySchema,
  GetSubgraphsQuerySchema,
  ListVersionsRequestSchema,
  SetLatestVersionRequestSchema,
  AssistantIdParamSchema,
  DeleteAssistantQuerySchema,
} from '../../schemas/assistant.schema.js';
import { ErrorResponseSchema } from '../../schemas/common.schema.js';
import { AssistantsService } from './assistants.service.js';
import { getRepositoryRegistry } from '../../repositories/registry.js';
import { setPaginationHeaders } from '../../utils/pagination.util.js';

const assistantsRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const { assistants: repository } = getRepositoryRegistry();
  const service = new AssistantsService(repository);

  // POST /assistants -> create
  fastify.route({
    method: 'POST',
    url: '/assistants',
    schema: {
      body: CreateAssistantRequestSchema,
      response: {
        200: AssistantSchema,
        409: ErrorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const body = request.body as any;
      const assistant = await service.create(body);
      return reply.status(200).send(assistant);
    },
  });

  // GET /assistants/:assistant_id -> get
  fastify.route({
    method: 'GET',
    url: '/assistants/:assistant_id',
    schema: {
      params: AssistantIdParamSchema,
      response: {
        200: AssistantSchema,
        404: ErrorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const { assistant_id } = request.params as { assistant_id: string };
      const assistant = await service.get(assistant_id);
      return reply.status(200).send(assistant);
    },
  });

  // PATCH /assistants/:assistant_id -> update
  fastify.route({
    method: 'PATCH',
    url: '/assistants/:assistant_id',
    schema: {
      params: AssistantIdParamSchema,
      body: UpdateAssistantRequestSchema,
      response: {
        200: AssistantSchema,
        404: ErrorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const { assistant_id } = request.params as { assistant_id: string };
      const body = request.body as any;
      const assistant = await service.update(assistant_id, body);
      return reply.status(200).send(assistant);
    },
  });

  // DELETE /assistants/:assistant_id -> delete
  fastify.route({
    method: 'DELETE',
    url: '/assistants/:assistant_id',
    schema: {
      params: AssistantIdParamSchema,
      querystring: DeleteAssistantQuerySchema,
      response: {
        204: Type.Null(),
        404: ErrorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const { assistant_id } = request.params as { assistant_id: string };
      const { delete_threads } = (request.query as { delete_threads?: boolean }) ?? {};
      await service.delete(assistant_id, delete_threads);
      return reply.status(204).send();
    },
  });

  // POST /assistants/search -> search
  fastify.route({
    method: 'POST',
    url: '/assistants/search',
    schema: {
      body: SearchAssistantsRequestSchema,
      response: {
        200: Type.Array(AssistantSchema),
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

  // POST /assistants/count -> count
  fastify.route({
    method: 'POST',
    url: '/assistants/count',
    schema: {
      body: CountAssistantsRequestSchema,
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

  // GET /assistants/:assistant_id/graph -> getGraph
  fastify.route({
    method: 'GET',
    url: '/assistants/:assistant_id/graph',
    schema: {
      params: AssistantIdParamSchema,
      querystring: GetGraphQuerySchema,
      response: {
        200: Type.Record(Type.String(), Type.Unknown()),
        404: ErrorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const { assistant_id } = request.params as { assistant_id: string };
      const { xray } = (request.query as { xray?: boolean | number }) ?? {};
      const graph = await service.getGraph(assistant_id, xray);
      return reply.status(200).send(graph);
    },
  });

  // GET /assistants/:assistant_id/schemas -> getSchemas
  fastify.route({
    method: 'GET',
    url: '/assistants/:assistant_id/schemas',
    schema: {
      params: AssistantIdParamSchema,
      response: {
        200: Type.Record(Type.String(), Type.Unknown()),
        404: ErrorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const { assistant_id } = request.params as { assistant_id: string };
      const schemas = await service.getSchemas(assistant_id);
      return reply.status(200).send(schemas);
    },
  });

  // GET /assistants/:assistant_id/subgraphs -> getSubgraphs
  fastify.route({
    method: 'GET',
    url: '/assistants/:assistant_id/subgraphs',
    schema: {
      params: AssistantIdParamSchema,
      querystring: GetSubgraphsQuerySchema,
      response: {
        200: Type.Record(Type.String(), Type.Unknown()),
        404: ErrorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const { assistant_id } = request.params as { assistant_id: string };
      const { namespace, recurse } = (request.query as { namespace?: string; recurse?: boolean }) ?? {};
      const subgraphs = await service.getSubgraphs(assistant_id, namespace, recurse);
      return reply.status(200).send(subgraphs);
    },
  });

  // POST /assistants/:assistant_id/versions -> listVersions
  fastify.route({
    method: 'POST',
    url: '/assistants/:assistant_id/versions',
    schema: {
      params: AssistantIdParamSchema,
      body: ListVersionsRequestSchema,
      response: {
        200: Type.Array(AssistantVersionSchema),
        404: ErrorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const { assistant_id } = request.params as { assistant_id: string };
      const body = request.body as any;
      const result = await service.listVersions(assistant_id, body);
      const limit = body.limit ?? 10;
      const offset = body.offset ?? 0;
      setPaginationHeaders(reply, result.total, offset, limit);
      return reply.status(200).send(result.items);
    },
  });

  // POST /assistants/:assistant_id/latest -> setLatestVersion
  fastify.route({
    method: 'POST',
    url: '/assistants/:assistant_id/latest',
    schema: {
      params: AssistantIdParamSchema,
      body: SetLatestVersionRequestSchema,
      response: {
        200: AssistantSchema,
        404: ErrorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const { assistant_id } = request.params as { assistant_id: string };
      const { version } = request.body as { version: number };
      const assistant = await service.setLatestVersion(assistant_id, version);
      return reply.status(200).send(assistant);
    },
  });
};

export default assistantsRoutes;
