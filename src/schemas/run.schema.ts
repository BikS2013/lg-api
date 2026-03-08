import { Type } from '@sinclair/typebox';
import {
  ConfigSchema, CheckpointSchema, CommandSchema
} from './common.schema.js';
import {
  RunStatusEnum, MultitaskStrategyEnum, StreamModeEnum,
  OnCompletionEnum, OnDisconnectEnum, DurabilityEnum, CancelActionEnum
} from './enums.schema.js';

// --- Run Entity ---
export const RunSchema = Type.Object({
  run_id: Type.String({ format: 'uuid' }),
  thread_id: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  assistant_id: Type.String({ format: 'uuid' }),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
  status: RunStatusEnum,
  metadata: Type.Record(Type.String(), Type.Unknown()),
  multitask_strategy: Type.Optional(MultitaskStrategyEnum),
  kwargs: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

// --- Run Create Request (shared body for stateful + stateless runs) ---
export const RunCreateRequestSchema = Type.Object({
  assistant_id: Type.String({ format: 'uuid' }),
  input: Type.Optional(Type.Union([
    Type.Record(Type.String(), Type.Unknown()),
    Type.Null(),
  ])),
  command: Type.Optional(CommandSchema),
  stream_mode: Type.Optional(Type.Union([
    Type.Array(StreamModeEnum),
    StreamModeEnum,
  ])),
  stream_subgraphs: Type.Optional(Type.Boolean()),
  stream_resumable: Type.Optional(Type.Boolean()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  config: Type.Optional(ConfigSchema),
  context: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  checkpoint: Type.Optional(CheckpointSchema),
  checkpoint_id: Type.Optional(Type.String({ format: 'uuid' })),
  checkpoint_during: Type.Optional(Type.Boolean()),
  interrupt_before: Type.Optional(Type.Union([
    Type.Array(Type.String()),
    Type.Literal('*'),
  ])),
  interrupt_after: Type.Optional(Type.Union([
    Type.Array(Type.String()),
    Type.Literal('*'),
  ])),
  feedback_keys: Type.Optional(Type.Array(Type.String())),
  webhook: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  multitask_strategy: Type.Optional(MultitaskStrategyEnum),
  if_not_exists: Type.Optional(Type.Union([
    Type.Literal('create'),
    Type.Literal('reject'),
  ])),
  on_disconnect: Type.Optional(OnDisconnectEnum),
  on_completion: Type.Optional(OnCompletionEnum),
  after_seconds: Type.Optional(Type.Number()),
  durability: Type.Optional(DurabilityEnum),
});

// --- Run Batch Request ---
export const RunBatchRequestSchema = Type.Array(RunCreateRequestSchema);

// --- List Runs Querystring ---
export const ListRunsQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  status: Type.Optional(RunStatusEnum),
  select: Type.Optional(Type.Array(Type.String())),
});

// --- Cancel Run Request ---
export const CancelRunRequestSchema = Type.Object({
  wait: Type.Optional(Type.Boolean()),
  action: Type.Optional(CancelActionEnum),
});

// --- Bulk Cancel Runs Request ---
export const BulkCancelRunsRequestSchema = Type.Object({
  thread_id: Type.Optional(Type.String({ format: 'uuid' })),
  run_ids: Type.Optional(Type.Array(Type.String({ format: 'uuid' }))),
  status: Type.Optional(RunStatusEnum),
  action: Type.Optional(CancelActionEnum),
});

// --- Run ID + Thread ID Path Params ---
export const RunIdParamSchema = Type.Object({
  thread_id: Type.String({ format: 'uuid' }),
  run_id: Type.String({ format: 'uuid' }),
});

// --- Join Stream Querystring ---
export const JoinStreamQuerySchema = Type.Object({
  cancel_on_disconnect: Type.Optional(Type.Boolean()),
  stream_mode: Type.Optional(Type.Array(StreamModeEnum)),
  last_event_id: Type.Optional(Type.String()),
});

// --- Run Wait Response ---
export const RunWaitResponseSchema = Type.Object({
  run_id: Type.String({ format: 'uuid' }),
  thread_id: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  status: RunStatusEnum,
  result: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
