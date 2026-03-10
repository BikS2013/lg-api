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
      tags: ['Assistants'],
      summary: 'Create a new assistant',
      description: `Creates a new assistant with a specified graph configuration. An assistant is a versioned instance of a graph template bound to specific settings such as model parameters, tools, prompts, and runtime context. Multiple assistants can reference the same \`graph_id\` with different configurations.

This endpoint creates both the assistant entity and its initial version simultaneously. The \`if_exists\` parameter controls duplicate handling: **"raise"** returns an error if the ID exists, **"do_nothing"** returns the existing one unmodified.

Key parameters: \`graph_id\` (required), \`assistant_id\` (optional UUID, auto-generated if omitted), \`config\`, \`metadata\`, and \`name\`. After creation, the assistant is immediately available for run execution.`,
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
      tags: ['Assistants'],
      summary: 'Retrieve an assistant by ID',
      description: `Retrieves the complete configuration and metadata for a specific assistant. The response includes the assistant's current (latest) version with all configuration settings, graph references, timestamps, and metadata.

In the LangGraph Platform, assistants are versioned entities. The GET operation always returns the assistant at its currently active version. To inspect historical versions, use the versions endpoint.

Commonly used to verify assistant configuration before creating runs, retrieve metadata for client UIs, or confirm an assistant exists before stateless run execution.`,
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
      tags: ['Assistants'],
      summary: 'Update an assistant',
      description: `Updates an existing assistant by creating a new version with modified configuration. Unlike typical PATCH semantics, this creates a complete new version -- all fields you want to retain must be included, as prior version data is **not** merged.

In the LangGraph Platform, assistants are immutable once created. Updates always produce a new version and the "latest" pointer is updated automatically. This versioning model enables safe rollback, audit trails, and A/B testing between configurations.

The \`graph_id\` can be changed to reassign the assistant to a different graph. The \`version\` counter increments automatically. Use POST /assistants/:assistant_id/versions to view history, or POST /assistants/:assistant_id/latest to roll back.`,
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
      tags: ['Assistants'],
      summary: 'Delete an assistant',
      description: `Permanently deletes an assistant and all its associated versions. This operation is **irreversible** and should be used with caution in production environments.

Deleting an assistant does not delete threads or runs that were previously executed with it. Threads remain accessible and their state history is preserved, but future runs cannot be created with the deleted \`assistant_id\`. Active cron jobs referencing the assistant will fail on their next scheduled execution.

Before deletion, consider cancelling associated cron jobs and migrating client references to a replacement assistant. Returns 204 on success or 404 if the assistant does not exist.`,
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
      tags: ['Assistants'],
      summary: 'Search and filter assistants',
      description: `Searches for assistants matching specified filters and returns a paginated list. When called with no filters, returns all assistants. Supports filtering by \`metadata\` (exact key-value match), \`graph_id\`, and \`name\` (case-insensitive substring match).

Pagination is controlled via \`limit\` (1-1000, default 10) and \`offset\`. Results can be sorted by \`assistant_id\`, \`created_at\`, \`updated_at\`, \`name\`, or \`graph_id\` in ascending or descending order. Use the optional \`select\` array to return only specific fields, reducing payload size.

Returns an array of assistant objects. Use POST /assistants/count with the same filters to obtain the total count for pagination UIs.`,
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
      tags: ['Assistants'],
      summary: 'Count assistants matching filters',
      description: `Returns the total count of assistants matching the specified filters. Accepts the same filter parameters as POST /assistants/search (\`metadata\`, \`graph_id\`, \`name\`) but returns only an integer count instead of full assistant objects.

Useful for pagination UIs (e.g., "Page 1 of 5"), quota enforcement, and dashboard metrics. The count is computed at query time and reflects the current assistant set. If no filters are provided, returns the total count of all assistants.`,
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
      tags: ['Assistants'],
      summary: 'Get assistant graph structure',
      description: `Returns a JSON representation of the assistant's graph structure, including nodes, edges, conditional branches, and entry/exit points. This provides introspection into the graph topology that the assistant executes.

In the LangGraph Platform, graphs are state machines with nodes (functions/tools), edges (transitions), and conditional routing. The structure returned is the compiled, resolved graph after configuration has been applied. For graphs with dynamic node selection, the response shows all possible nodes and edges.

Useful for visualization (rendering graph diagrams), debugging execution flow, and validation. The graph structure is static metadata -- it does not include runtime state. For input/output schemas, use GET /assistants/:assistant_id/schemas instead.`,
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
      tags: ['Assistants'],
      summary: 'Get input/output schemas for the assistant graph',
      description: `Returns JSON schemas for the assistant's graph input, output, and state structures. These schemas define the expected format for run inputs, the structure of returned outputs, and the shape of thread state.

In the LangGraph Platform, graphs are strongly typed. Each graph defines an **input_schema**, **output_schema**, and **state_schema**. These are derived from the graph's type annotations and are tied to the assistant's current version.

Useful for client-side input validation, code generation (TypeScript/Python types), documentation, and dynamic UI form generation. If the graph does not define explicit schemas, the endpoint may return generic or empty objects.`,
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
      tags: ['Assistants'],
      summary: 'Get nested subgraphs of the assistant graph',
      description: `Returns metadata about nested subgraphs (child graphs) embedded within the assistant's main graph. Subgraphs are reusable graph components invoked as nodes within a parent graph, enabling modular agent design.

In the LangGraph Platform, complex agents are often composed of multiple subgraphs (e.g., intent classification, knowledge retrieval, response generation). Each subgraph is a full graph with its own nodes, edges, and state. The optional \`namespace\` query parameter filters by subgraph namespace, and \`recurse\` controls whether nested subgraphs are returned recursively.

If the graph has no subgraphs, the response is an empty object. Subgraphs are fully isolated with their own state and checkpoint history.`,
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
      tags: ['Assistants'],
      summary: 'List version history of an assistant',
      description: `Returns the version history for an assistant, showing all past configurations and when each version was created. Enables audit trails, rollback workflows, and A/B testing between assistant versions.

In the LangGraph Platform, every PATCH operation creates a new version with an auto-incremented version number. The "latest" pointer determines which version is used for new runs. Versions are returned in descending order (newest first).

Pagination is controlled via \`limit\` (default 10) and \`offset\`. To roll back to a previous version, identify the target version here and then use POST /assistants/:assistant_id/latest to activate it. Deleting an assistant removes all its versions permanently.`,
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
      tags: ['Assistants'],
      summary: 'Set a specific version as the latest',
      description: `Updates the assistant's "latest" pointer to reference a specific version number. This enables rollback to previous configurations without deleting or recreating assistants.

In the LangGraph Platform, the "latest" version determines which configuration is used when creating new runs. By default it is the most recently created version. This endpoint allows you to override that and designate any historical version as "latest". The operation is idempotent.

All future runs will use the newly designated version. Active (in-progress) runs are not affected. Cron jobs will pick up the new version on their next scheduled execution. Returns the updated assistant object, or 404 if the assistant or version does not exist.`,
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
