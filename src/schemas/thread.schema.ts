import { Type } from '@sinclair/typebox';
import {
  CheckpointSchema, InterruptSchema, TTLInfoSchema
} from './common.schema.js';
import {
  ThreadStatusEnum, IfExistsEnum, SortOrderEnum, PruneStrategyEnum, StreamModeEnum
} from './enums.schema.js';

// --- Thread Entity ---
export const ThreadSchema = Type.Object({
  thread_id: Type.String({ format: 'uuid' }),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  status: ThreadStatusEnum,
  values: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  interrupts: Type.Optional(Type.Array(InterruptSchema)),
});

// --- Thread Task ---
export const ThreadTaskSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  interrupts: Type.Optional(Type.Array(InterruptSchema)),
  checkpoint: Type.Optional(CheckpointSchema),
  state: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  result: Type.Optional(Type.Unknown()),
});

// --- Thread State ---
export const ThreadStateSchema = Type.Object({
  values: Type.Record(Type.String(), Type.Unknown()),
  next: Type.Array(Type.String()),
  checkpoint: CheckpointSchema,
  metadata: Type.Record(Type.String(), Type.Unknown()),
  created_at: Type.String({ format: 'date-time' }),
  parent_checkpoint: Type.Optional(Type.Union([CheckpointSchema, Type.Null()])),
  tasks: Type.Array(ThreadTaskSchema),
  interrupts: Type.Optional(Type.Array(InterruptSchema)),
});

// --- Create Thread Request ---
export const CreateThreadRequestSchema = Type.Object({
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  thread_id: Type.Optional(Type.String({ format: 'uuid' })),
  if_exists: Type.Optional(IfExistsEnum),
  supersteps: Type.Optional(Type.Integer()),
  graph_id: Type.Optional(Type.String()),
  ttl: Type.Optional(TTLInfoSchema),
});

// --- Update Thread Request ---
export const UpdateThreadRequestSchema = Type.Object({
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  ttl: Type.Optional(TTLInfoSchema),
});

// --- Search Threads Request ---
export const SearchThreadsRequestSchema = Type.Object({
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  values: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  ids: Type.Optional(Type.Array(Type.String({ format: 'uuid' }))),
  status: Type.Optional(ThreadStatusEnum),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  sort_by: Type.Optional(Type.String()),
  sort_order: Type.Optional(SortOrderEnum),
  select: Type.Optional(Type.Array(Type.String())),
  extract: Type.Optional(Type.Array(Type.String())),
});

// --- Count Threads Request ---
export const CountThreadsRequestSchema = Type.Object({
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  values: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  status: Type.Optional(ThreadStatusEnum),
});

// --- Copy Thread Request ---
export const CopyThreadRequestSchema = Type.Object({});

// --- Prune Threads Request ---
export const PruneThreadsRequestSchema = Type.Object({
  thread_ids: Type.Optional(Type.Array(Type.String({ format: 'uuid' }))),
  strategy: Type.Optional(PruneStrategyEnum),
});

// --- Update Thread State Request ---
export const UpdateThreadStateRequestSchema = Type.Object({
  values: Type.Record(Type.String(), Type.Unknown()),
  as_node: Type.Optional(Type.String()),
  checkpoint: Type.Optional(CheckpointSchema),
  checkpoint_id: Type.Optional(Type.String({ format: 'uuid' })),
});

// --- Thread History Request ---
export const ThreadHistoryRequestSchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  before: Type.Optional(Type.String({ format: 'date-time' })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  checkpoint: Type.Optional(CheckpointSchema),
});

// --- Thread ID Path Param ---
export const ThreadIdParamSchema = Type.Object({
  thread_id: Type.String({ format: 'uuid' }),
});

// --- Get Thread Querystring ---
export const GetThreadQuerySchema = Type.Object({
  include: Type.Optional(Type.Array(Type.String())),
});

// --- Get State Querystring ---
export const GetStateQuerySchema = Type.Object({
  subgraphs: Type.Optional(Type.Boolean()),
});

// --- Get State with Checkpoint Path ---
export const GetStateWithCheckpointParamSchema = Type.Object({
  thread_id: Type.String({ format: 'uuid' }),
  checkpoint_id: Type.String({ format: 'uuid' }),
});

// --- Thread Stream Querystring ---
export const ThreadStreamQuerySchema = Type.Object({
  stream_mode: Type.Optional(Type.Array(StreamModeEnum)),
  last_event_id: Type.Optional(Type.String()),
});
