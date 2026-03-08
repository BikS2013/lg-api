/**
 * Store Routes
 *
 * Fastify plugin that registers all store-related API endpoints.
 *
 * Endpoints:
 *   PUT    /store/items         -> put item
 *   GET    /store/items         -> get item (namespace and key from query params)
 *   DELETE /store/items         -> delete item (namespace and key from request body)
 *   POST   /store/items/search  -> search items
 *   POST   /store/namespaces    -> list namespaces
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  ItemSchema,
  SearchItemSchema,
  PutItemRequestSchema,
  GetItemQuerySchema,
  DeleteItemRequestSchema,
  SearchItemsRequestSchema,
  ListNamespacesRequestSchema,
  ListNamespacesResponseSchema,
} from '../../schemas/store.schema.js';
import { ErrorResponseSchema } from '../../schemas/common.schema.js';
import { StoreService } from './store.service.js';
import { getRepositoryRegistry } from '../../repositories/registry.js';
import { setPaginationHeaders } from '../../utils/pagination.util.js';

const storeRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const { store: repository } = getRepositoryRegistry();
  const service = new StoreService(repository);

  // PUT /store/items -> put item
  fastify.put('/store/items', {
    schema: {
      tags: ['Store'],
      summary: 'Put (create or update) an item in the store',
      body: PutItemRequestSchema,
      response: {
        200: ItemSchema,
      },
    },
  }, async (request, reply) => {
    const body = request.body as any;

    const item = await service.putItem(
      body.namespace,
      body.key,
      body.value,
      body.index,
      body.ttl ?? undefined
    );

    return reply.status(200).send(item);
  });

  // GET /store/items -> get item
  // namespace is passed as a JSON-encoded string query param or repeated query params
  fastify.get('/store/items', {
    schema: {
      tags: ['Store'],
      summary: 'Get an item from the store by namespace and key',
      querystring: GetItemQuerySchema,
      response: {
        200: ItemSchema,
        404: ErrorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const query = request.query as { namespace: string; key: string; refresh_ttl?: boolean };

    // Parse namespace: accept JSON-encoded array string or plain string
    let namespace: string[];
    try {
      const parsed = JSON.parse(query.namespace);
      namespace = Array.isArray(parsed) ? parsed : [query.namespace];
    } catch {
      // If not valid JSON, treat as a single namespace component
      namespace = [query.namespace];
    }

    const item = await service.getItem(namespace, query.key, query.refresh_ttl);

    if (!item) {
      return reply.status(404).send({ detail: 'Item not found' });
    }

    return reply.status(200).send(item);
  });

  // DELETE /store/items -> delete item
  fastify.delete('/store/items', {
    schema: {
      tags: ['Store'],
      summary: 'Delete an item from the store',
      body: DeleteItemRequestSchema,
      response: {
        204: Type.Null(),
      },
    },
  }, async (request, reply) => {
    const body = request.body as any;

    await service.deleteItem(body.namespace, body.key);
    return reply.status(204).send();
  });

  // POST /store/items/search -> search items
  fastify.post('/store/items/search', {
    schema: {
      tags: ['Store'],
      summary: 'Search items in the store',
      body: SearchItemsRequestSchema,
      response: {
        200: Type.Array(SearchItemSchema),
      },
    },
  }, async (request, reply) => {
    const body = request.body as any;

    const limit = body.limit ?? 10;
    const offset = body.offset ?? 0;

    const result = await service.searchItems(body.namespace_prefix, {
      filter: body.filter,
      limit,
      offset,
      query: body.query,
    });

    setPaginationHeaders(reply, result.total, offset, limit);
    return reply.status(200).send(result.items);
  });

  // POST /store/namespaces -> list namespaces
  fastify.post('/store/namespaces', {
    schema: {
      tags: ['Store'],
      summary: 'List namespaces in the store',
      body: ListNamespacesRequestSchema,
      response: {
        200: ListNamespacesResponseSchema,
      },
    },
  }, async (request, reply) => {
    const body = request.body as any;

    const namespaces = await service.listNamespaces({
      prefix: body.prefix,
      suffix: body.suffix,
      maxDepth: body.max_depth,
      limit: body.limit,
      offset: body.offset,
    });

    return reply.status(200).send(namespaces);
  });
};

export default storeRoutes;
