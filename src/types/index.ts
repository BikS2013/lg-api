import { Static } from '@sinclair/typebox';

// Enums
import {
  ThreadStatusEnum, RunStatusEnum, MultitaskStrategyEnum, StreamModeEnum,
  IfExistsEnum, OnCompletionEnum, OnDisconnectEnum, SortOrderEnum,
  DurabilityEnum, PruneStrategyEnum, CancelActionEnum
} from '../schemas/enums.schema.js';

// Common
import {
  ConfigSchema, CheckpointSchema, InterruptSchema, CommandSchema,
  GraphSchemaSchema, StreamPartSchema, ErrorResponseSchema, TTLInfoSchema
} from '../schemas/common.schema.js';

// Assistants
import { AssistantSchema, AssistantVersionSchema } from '../schemas/assistant.schema.js';

// Threads
import { ThreadSchema, ThreadStateSchema, ThreadTaskSchema } from '../schemas/thread.schema.js';

// Runs
import { RunSchema } from '../schemas/run.schema.js';

// Crons
import { CronSchema } from '../schemas/cron.schema.js';

// Store
import { ItemSchema, SearchItemSchema } from '../schemas/store.schema.js';

// --- Entity Types ---
export type Assistant = Static<typeof AssistantSchema>;
export type AssistantVersion = Static<typeof AssistantVersionSchema>;
export type Thread = Static<typeof ThreadSchema>;
export type ThreadState = Static<typeof ThreadStateSchema>;
export type ThreadTask = Static<typeof ThreadTaskSchema>;
export type Run = Static<typeof RunSchema>;
export type Cron = Static<typeof CronSchema>;
export type Item = Static<typeof ItemSchema>;
export type SearchItem = Static<typeof SearchItemSchema>;

// --- Value Types ---
export type Config = Static<typeof ConfigSchema>;
export type Checkpoint = Static<typeof CheckpointSchema>;
export type Interrupt = Static<typeof InterruptSchema>;
export type Command = Static<typeof CommandSchema>;
export type GraphSchema = Static<typeof GraphSchemaSchema>;
export type StreamPart = Static<typeof StreamPartSchema>;
export type ErrorResponse = Static<typeof ErrorResponseSchema>;
export type TTLInfo = Static<typeof TTLInfoSchema>;

// --- Enum Types ---
export type ThreadStatus = Static<typeof ThreadStatusEnum>;
export type RunStatus = Static<typeof RunStatusEnum>;
export type MultitaskStrategy = Static<typeof MultitaskStrategyEnum>;
export type StreamMode = Static<typeof StreamModeEnum>;
export type IfExists = Static<typeof IfExistsEnum>;
export type OnCompletion = Static<typeof OnCompletionEnum>;
export type OnDisconnect = Static<typeof OnDisconnectEnum>;
export type SortOrder = Static<typeof SortOrderEnum>;
export type Durability = Static<typeof DurabilityEnum>;
export type PruneStrategy = Static<typeof PruneStrategyEnum>;
export type CancelAction = Static<typeof CancelActionEnum>;
