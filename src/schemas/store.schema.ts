import { Type } from '@sinclair/typebox';

// --- Item Entity ---
export const ItemSchema = Type.Object({
  namespace: Type.Array(Type.String()),
  key: Type.String(),
  value: Type.Record(Type.String(), Type.Unknown()),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
});

// --- SearchItem Entity (Item + score) ---
export const SearchItemSchema = Type.Object({
  namespace: Type.Array(Type.String()),
  key: Type.String(),
  value: Type.Record(Type.String(), Type.Unknown()),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
  score: Type.Optional(Type.Number()),
});

// --- Put Item Request ---
export const PutItemRequestSchema = Type.Object({
  namespace: Type.Array(Type.String()),
  key: Type.String(),
  value: Type.Record(Type.String(), Type.Unknown()),
  index: Type.Optional(Type.Union([Type.Boolean(), Type.Array(Type.String())])),
  ttl: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});

// --- Get Item Querystring ---
export const GetItemQuerySchema = Type.Object({
  namespace: Type.String(),
  key: Type.String(),
  refresh_ttl: Type.Optional(Type.Boolean()),
});

// --- Delete Item Request ---
export const DeleteItemRequestSchema = Type.Object({
  namespace: Type.Array(Type.String()),
  key: Type.String(),
});

// --- Search Items Request ---
export const SearchItemsRequestSchema = Type.Object({
  namespace_prefix: Type.Array(Type.String()),
  filter: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  query: Type.Optional(Type.String()),
  refresh_ttl: Type.Optional(Type.Boolean()),
});

// --- List Namespaces Request ---
export const ListNamespacesRequestSchema = Type.Object({
  prefix: Type.Optional(Type.Array(Type.String())),
  suffix: Type.Optional(Type.Array(Type.String())),
  max_depth: Type.Optional(Type.Integer({ minimum: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});

// --- List Namespaces Response ---
export const ListNamespacesResponseSchema = Type.Array(
  Type.Array(Type.String())
);
