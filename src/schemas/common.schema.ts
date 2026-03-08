import { Type } from '@sinclair/typebox';

// --- Metadata (arbitrary key-value object) ---
export const MetadataSchema = Type.Record(
  Type.String(),
  Type.Unknown(),
);

// --- Config ---
export const ConfigSchema = Type.Object({
  tags: Type.Optional(Type.Array(Type.String())),
  recursion_limit: Type.Optional(Type.Integer()),
  configurable: Type.Optional(
    Type.Record(Type.String(), Type.Unknown())
  ),
});

// --- Checkpoint ---
export const CheckpointSchema = Type.Object({
  thread_id: Type.String({ format: 'uuid' }),
  checkpoint_ns: Type.String(),
  checkpoint_id: Type.String({ format: 'uuid' }),
  checkpoint_map: Type.Optional(
    Type.Record(Type.String(), Type.String())
  ),
});

// --- Interrupt ---
export const InterruptSchema = Type.Object({
  value: Type.Unknown(),
  id: Type.String({ format: 'uuid' }),
});

// --- Command ---
export const CommandSchema = Type.Object({
  goto: Type.Optional(Type.Union([
    Type.String(),
    Type.Array(Type.String()),
  ])),
  update: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  resume: Type.Optional(Type.Unknown()),
});

// --- Graph Schema (response for /schemas endpoint) ---
export const GraphSchemaSchema = Type.Object({
  graph_id: Type.String(),
  input_schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  output_schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  state_schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  config_schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  context_schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

// --- StreamPart ---
export const StreamPartSchema = Type.Object({
  event: Type.String(),
  data: Type.Unknown(),
  id: Type.Optional(Type.String()),
});

// --- Error Response ---
export const ErrorResponseSchema = Type.Object({
  detail: Type.String(),
});

// --- Pagination Query Parameters (shared) ---
export const PaginationQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
});

// --- TTL Info ---
export const TTLInfoSchema = Type.Object({
  strategy: Type.Optional(Type.String()),
  seconds: Type.Optional(Type.Number()),
  at: Type.Optional(Type.String({ format: 'date-time' })),
});
