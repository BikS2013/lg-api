import { Type } from '@sinclair/typebox';
import { ConfigSchema } from './common.schema.js';
import {
  MultitaskStrategyEnum, StreamModeEnum, OnCompletionEnum,
  DurabilityEnum, SortOrderEnum
} from './enums.schema.js';

// --- Cron Entity ---
export const CronSchema = Type.Object({
  cron_id: Type.String({ format: 'uuid' }),
  assistant_id: Type.String({ format: 'uuid' }),
  thread_id: Type.Optional(Type.Union([
    Type.String({ format: 'uuid' }),
    Type.Null(),
  ])),
  on_run_completed: Type.Optional(OnCompletionEnum),
  end_time: Type.Optional(Type.Union([
    Type.String({ format: 'date-time' }),
    Type.Null(),
  ])),
  schedule: Type.String(),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
  payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  user_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  next_run_date: Type.Optional(Type.Union([
    Type.String({ format: 'date-time' }),
    Type.Null(),
  ])),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  enabled: Type.Boolean(),
});

// --- Create Cron Request ---
export const CreateCronRequestSchema = Type.Object({
  assistant_id: Type.String({ format: 'uuid' }),
  schedule: Type.String(),
  input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  config: Type.Optional(ConfigSchema),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  context: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  checkpoint_during: Type.Optional(Type.Boolean()),
  interrupt_before: Type.Optional(Type.Union([
    Type.Array(Type.String()),
    Type.Literal('*'),
  ])),
  interrupt_after: Type.Optional(Type.Union([
    Type.Array(Type.String()),
    Type.Literal('*'),
  ])),
  webhook: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  multitask_strategy: Type.Optional(MultitaskStrategyEnum),
  end_time: Type.Optional(Type.Union([
    Type.String({ format: 'date-time' }),
    Type.Null(),
  ])),
  enabled: Type.Optional(Type.Boolean()),
  on_run_completed: Type.Optional(OnCompletionEnum),
  stream_mode: Type.Optional(Type.Array(StreamModeEnum)),
  stream_subgraphs: Type.Optional(Type.Boolean()),
  stream_resumable: Type.Optional(Type.Boolean()),
  durability: Type.Optional(DurabilityEnum),
});

// --- Update Cron Request ---
export const UpdateCronRequestSchema = Type.Object({
  schedule: Type.Optional(Type.String()),
  input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  config: Type.Optional(ConfigSchema),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  enabled: Type.Optional(Type.Boolean()),
  end_time: Type.Optional(Type.Union([
    Type.String({ format: 'date-time' }),
    Type.Null(),
  ])),
  on_run_completed: Type.Optional(OnCompletionEnum),
});

// --- Search Crons Request ---
export const SearchCronsRequestSchema = Type.Object({
  assistant_id: Type.Optional(Type.String({ format: 'uuid' })),
  thread_id: Type.Optional(Type.String({ format: 'uuid' })),
  enabled: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  sort_by: Type.Optional(Type.String()),
  sort_order: Type.Optional(SortOrderEnum),
  select: Type.Optional(Type.Array(Type.String())),
});

// --- Count Crons Request ---
export const CountCronsRequestSchema = Type.Object({
  assistant_id: Type.Optional(Type.String({ format: 'uuid' })),
  thread_id: Type.Optional(Type.String({ format: 'uuid' })),
});

// --- Cron ID Path Param ---
export const CronIdParamSchema = Type.Object({
  cron_id: Type.String({ format: 'uuid' }),
});
