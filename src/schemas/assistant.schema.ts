import { Type } from '@sinclair/typebox';
import { ConfigSchema } from './common.schema.js';
import { IfExistsEnum, SortOrderEnum } from './enums.schema.js';

// --- Assistant Entity ---
export const AssistantSchema = Type.Object({
  assistant_id: Type.String({ format: 'uuid' }),
  graph_id: Type.String(),
  config: ConfigSchema,
  context: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  version: Type.Integer(),
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
});

// --- AssistantVersion Entity ---
export const AssistantVersionSchema = Type.Object({
  assistant_id: Type.String({ format: 'uuid' }),
  graph_id: Type.String(),
  config: ConfigSchema,
  context: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  version: Type.Integer(),
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
});

// --- Create Assistant Request ---
export const CreateAssistantRequestSchema = Type.Object({
  graph_id: Type.String(),
  assistant_id: Type.Optional(Type.String({ format: 'uuid' })),
  config: Type.Optional(ConfigSchema),
  context: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  if_exists: Type.Optional(IfExistsEnum),
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

// --- Update Assistant Request ---
export const UpdateAssistantRequestSchema = Type.Object({
  graph_id: Type.Optional(Type.String()),
  config: Type.Optional(ConfigSchema),
  context: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

// --- Search Assistants Request ---
export const SearchAssistantsRequestSchema = Type.Object({
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  graph_id: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  sort_by: Type.Optional(Type.String()),
  sort_order: Type.Optional(SortOrderEnum),
  select: Type.Optional(Type.Array(Type.String())),
});

// --- Count Assistants Request ---
export const CountAssistantsRequestSchema = Type.Object({
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  graph_id: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
});

// --- Get Graph Querystring ---
export const GetGraphQuerySchema = Type.Object({
  xray: Type.Optional(Type.Union([Type.Boolean(), Type.Integer()])),
});

// --- Get Subgraphs Querystring ---
export const GetSubgraphsQuerySchema = Type.Object({
  namespace: Type.Optional(Type.String()),
  recurse: Type.Optional(Type.Boolean()),
});

// --- List Versions Request ---
export const ListVersionsRequestSchema = Type.Object({
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});

// --- Set Latest Version Request ---
export const SetLatestVersionRequestSchema = Type.Object({
  version: Type.Integer(),
});

// --- Assistant ID Path Param ---
export const AssistantIdParamSchema = Type.Object({
  assistant_id: Type.String({ format: 'uuid' }),
});

// --- Delete Assistant Querystring ---
export const DeleteAssistantQuerySchema = Type.Object({
  delete_threads: Type.Optional(Type.Boolean()),
});
