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
      description: `Creates or updates a key-value item in the cross-thread store. The store provides persistent memory that can be shared across threads, scoped by hierarchical namespace paths. Each item is identified by a **namespace** (array of string segments) and a **key** within that namespace.

If an item with the same namespace and key already exists, it is overwritten; otherwise a new item is created. Namespaces are created implicitly and do not need to be pre-created. Common use cases include storing user preferences, shared knowledge, and cross-session memory.`,
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
      description: `Retrieves a single item from the store by its **namespace** and **key**, passed as query parameters. This is the read counterpart to \`PUT /store/items\`.

The response includes the full namespace, key, and value of the item. If the item does not exist, a 404 error is returned. Use this endpoint to load persisted data such as user preferences, shared knowledge, or per-thread metadata into graph execution context.`,
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
      description: `Permanently deletes a single item from the store by **namespace** and **key**. This operation is irreversible.

The delete operation is idempotent: if the item does not exist, the request still succeeds with a 204 response. Deletion does not support wildcard or recursive removal; items must be deleted individually. Common use cases include user data removal for GDPR/CCPA compliance, cache invalidation, and cleanup of obsolete entries.`,
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
      description: `Searches for store items matching specified filters. Supports **namespace prefix** matching, metadata filtering, and pagination via \`limit\` and \`offset\` parameters.

Namespace prefix matching is hierarchical: a prefix of \`["users"]\` matches items under \`["users", "u123"]\` and \`["users", "u456", "prefs"]\`. An empty prefix matches all items. Use this endpoint to list all items within a namespace, discover stored data, or find items by metadata tags.`,
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
      description: `Lists all unique namespace paths in the store, optionally filtered by a parent prefix. This enables hierarchical navigation and discovery of the store's namespace structure.

The **max_depth** parameter controls how many levels of hierarchy to return. Namespaces are derived from stored items; empty namespaces with no items are not returned. Use this endpoint to discover what namespaces exist, build folder-like navigation UIs, or audit stored data across users and organizations.`,
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
