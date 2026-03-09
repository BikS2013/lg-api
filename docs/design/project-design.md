# Technical Design: LangGraph Server API Drop-in Replacement

**Project:** lg-api
**Version:** 1.0
**Date:** 2026-03-08
**Status:** Draft

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [Project Structure](#2-project-structure)
3. [Data Models (TypeBox Schemas)](#3-data-models-typebox-schemas)
4. [Repository Layer Design](#4-repository-layer-design)
5. [Route Handler Design](#5-route-handler-design)
6. [SSE Streaming Design](#6-sse-streaming-design)
7. [Middleware Stack](#7-middleware-stack)
8. [Configuration Design](#8-configuration-design)
9. [API Contract Summary](#9-api-contract-summary)
10. [Implementation Units for Parallel Execution](#10-implementation-units-for-parallel-execution)

---

## 1. System Architecture

### 1.1 High-Level Component Diagram

```
+------------------------------------------------------------------+
|                        LangGraph SDK Client                       |
|              (Python langgraph-sdk / JS @langchain/langgraph-sdk) |
+------------------------------+-----------------------------------+
                               |
                          HTTP / SSE
                               |
+------------------------------v-----------------------------------+
|                         Fastify Server                            |
|  +------------------------------------------------------------+  |
|  |                     Plugin Layer                            |  |
|  |  +----------+  +-----------+  +--------+  +-------------+  |  |
|  |  | CORS     |  | Swagger   |  | Auth   |  | Error       |  |  |
|  |  | Plugin   |  | Plugin    |  | Plugin |  | Handler     |  |  |
|  |  +----------+  +-----------+  +--------+  +-------------+  |  |
|  +------------------------------------------------------------+  |
|                                                                   |
|  +------------------------------------------------------------+  |
|  |                     Route Layer                             |  |
|  |  +-----------+ +--------+ +------+ +------+ +------+ +--+ |  |
|  |  | Assistants| |Threads | | Runs | |Crons | |Store | |Sys|| |
|  |  | Routes    | |Routes  | |Routes| |Routes| |Routes| |   || |
|  |  +-----------+ +--------+ +------+ +------+ +------+ +--+ |  |
|  +------------------------------------------------------------+  |
|                               |                                   |
|  +------------------------------------------------------------+  |
|  |                    Service Layer                            |  |
|  |  +-----------+ +--------+ +------+ +------+ +------+      |  |
|  |  | Assistants| |Threads | | Runs | |Crons | |Store |      |  |
|  |  | Service   | |Service | |Service| |Service| |Service|    |  |
|  |  +-----------+ +--------+ +------+ +------+ +------+      |  |
|  +------------------------------------------------------------+  |
|                               |                                   |
|  +------------------------------------------------------------+  |
|  |                  Repository Layer                           |  |
|  |  +-----------+ +--------+ +------+ +------+ +------+      |  |
|  |  | Assistants| |Threads | | Runs | |Crons | |Store |      |  |
|  |  | Repo      | |Repo    | | Repo | | Repo | | Repo |      |  |
|  |  +-----------+ +--------+ +------+ +------+ +------+      |  |
|  |                        |                                    |  |
|  |              +--------------------+                         |  |
|  |              | InMemoryRepository |                         |  |
|  |              |   (Map<string,T>)  |                         |  |
|  |              +--------------------+                         |  |
|  +------------------------------------------------------------+  |
|                                                                   |
|  +------------------------------------------------------------+  |
|  |                  Streaming Layer                            |  |
|  |  +------------------+  +-------------------+                |  |
|  |  | StreamManager    |  | SSE Event Emitter |                |  |
|  |  | (active streams) |  | (better-sse)      |                |  |
|  |  +------------------+  +-------------------+                |  |
|  +------------------------------------------------------------+  |
+------------------------------------------------------------------+
```

### 1.2 Request Flow

```
Client Request
      |
      v
+-- Fastify Server ------------------------------------------------+
|     |                                                             |
|     v                                                             |
|  CORS Plugin (adds headers)                                       |
|     |                                                             |
|     v                                                             |
|  Auth Plugin (preHandler)                                         |
|  - Skip for /ok, /docs                                           |
|  - Validate X-Api-Key if LG_API_AUTH_ENABLED=true                |
|  - 401 if missing/invalid                                        |
|     |                                                             |
|     v                                                             |
|  Route Schema Validation (Ajv via TypeBox)                        |
|  - Validate params, querystring, body against TypeBox schemas     |
|  - 422 if validation fails                                       |
|     |                                                             |
|     v                                                             |
|  Route Handler                                                    |
|  - Extracts typed params/body/query                               |
|  - Calls Service method                                           |
|  - Sets pagination headers via util                               |
|  - Returns typed response                                         |
|     |                                                             |
|     v                                                             |
|  Service Layer                                                    |
|  - Business logic (if_exists, status transitions, version mgmt)   |
|  - Calls Repository methods                                       |
|  - Throws ApiError on business rule violations                    |
|     |                                                             |
|     v                                                             |
|  Repository Layer                                                 |
|  - CRUD operations on Map<string, T>                              |
|  - Filtering, sorting, pagination                                 |
|  - Returns data or null                                           |
|     |                                                             |
|     v                                                             |
|  Response Serialization (Fastify)                                 |
|  - Serializes to JSON via schema                                  |
|  - Sets status code                                               |
|     |                                                             |
+-------------------------------------------------------------------+
      |
      v
Client Response (JSON or SSE stream)
```

### 1.3 SSE Streaming Request Flow

```
Client POST /threads/:id/runs/stream
      |
      v
Auth + Validation (same as above)
      |
      v
Run Route Handler
  - Creates Run in repository (status: pending)
  - Transitions Run to running
  - Transitions Thread to busy
  - Creates SSE session via StreamManager
      |
      v
StreamManager.createStream(req, reply)
  - Sets Content-Type: text/event-stream
  - Sets Cache-Control: no-cache
  - Sets Connection: keep-alive
      |
      v
Event Emission Loop
  - emit metadata event: {run_id, thread_id}
  - for each stream_mode in request:
      - emit mode-specific stub events
  - emit end event
  - Transition Run to success
  - Transition Thread to idle
      |
      v
Close SSE connection
```

### 1.4 Module Dependency Graph

```
index.ts
  |
  v
server.ts ----> config/env.config.ts
  |
  v
app.ts
  |
  +---> plugins/cors.plugin.ts
  +---> plugins/swagger.plugin.ts
  +---> plugins/auth.plugin.ts ---------> config/env.config.ts
  +---> plugins/error-handler.plugin.ts -> errors/api-error.ts
  |
  +---> modules/assistants/assistants.routes.ts
  |       +---> assistants.service.ts
  |               +---> assistants.repository.ts --> repositories/in-memory.repository.ts
  |
  +---> modules/threads/threads.routes.ts
  |       +---> threads.service.ts
  |               +---> threads.repository.ts ----> repositories/in-memory.repository.ts
  |
  +---> modules/runs/runs.routes.ts
  |       +---> runs.service.ts
  |       |       +---> runs.repository.ts -------> repositories/in-memory.repository.ts
  |       |       +---> threads.service.ts (ref)
  |       +---> runs.streaming.ts ----------------> streaming/stream-manager.ts
  |
  +---> modules/crons/crons.routes.ts
  |       +---> crons.service.ts
  |               +---> crons.repository.ts ------> repositories/in-memory.repository.ts
  |
  +---> modules/store/store.routes.ts
  |       +---> store.service.ts
  |               +---> store.repository.ts ------> repositories/in-memory.repository.ts
  |
  +---> modules/system/system.routes.ts

All routes depend on:
  - schemas/*.schema.ts (TypeBox schemas for validation + OpenAPI)
  - types/index.ts (Static<> type exports)
  - utils/pagination.util.ts
  - utils/uuid.util.ts
  - utils/date.util.ts
  - errors/api-error.ts
```

---

## 2. Project Structure

```
lg-api/
├── docs/
│   ├── design/
│   │   ├── plan-001-langgraph-api-replacement.md
│   │   ├── project-design.md                    # This document
│   │   └── project-functions.md
│   └── reference/
│       ├── refined-request-langgraph-api-replacement.md
│       └── investigation-langgraph-api-replacement.md
├── src/
│   ├── index.ts                                 # Entry point
│   ├── server.ts                                # Fastify server bootstrap
│   ├── app.ts                                   # Fastify app factory
│   ├── config/
│   │   └── env.config.ts                        # Env var loader (strict, no fallbacks)
│   ├── schemas/
│   │   ├── index.ts                             # Barrel export
│   │   ├── enums.schema.ts                      # All enum definitions
│   │   ├── common.schema.ts                     # Config, Metadata, Checkpoint, Pagination, Error
│   │   ├── assistant.schema.ts                  # Assistant entity + request/response schemas
│   │   ├── thread.schema.ts                     # Thread entity + request/response schemas
│   │   ├── run.schema.ts                        # Run entity + request/response schemas
│   │   ├── cron.schema.ts                       # Cron entity + request/response schemas
│   │   └── store.schema.ts                      # Store entity + request/response schemas
│   ├── types/
│   │   └── index.ts                             # Static<> type exports from all schemas
│   ├── errors/
│   │   ├── api-error.ts                         # ApiError class
│   │   └── error-codes.ts                       # Error code enum
│   ├── plugins/
│   │   ├── auth.plugin.ts                       # X-Api-Key authentication
│   │   ├── cors.plugin.ts                       # CORS configuration
│   │   ├── swagger.plugin.ts                    # OpenAPI + Swagger UI
│   │   └── error-handler.plugin.ts              # Global error handler
│   ├── repositories/
│   │   ├── interfaces.ts                        # IRepository<T>, SearchOptions, SearchResult
│   │   └── in-memory.repository.ts              # InMemoryRepository<T>
│   ├── modules/
│   │   ├── assistants/
│   │   │   ├── assistants.routes.ts             # Route registration (11 endpoints)
│   │   │   ├── assistants.service.ts            # Business logic
│   │   │   └── assistants.repository.ts         # Data access
│   │   ├── threads/
│   │   │   ├── threads.routes.ts                # Route registration (12 endpoints)
│   │   │   ├── threads.service.ts               # Business logic + state mgmt
│   │   │   └── threads.repository.ts            # Data access
│   │   ├── runs/
│   │   │   ├── runs.routes.ts                   # Route registration (14 endpoints)
│   │   │   ├── runs.service.ts                  # Business logic + lifecycle
│   │   │   ├── runs.repository.ts               # Data access
│   │   │   └── runs.streaming.ts                # SSE event generation
│   │   ├── crons/
│   │   │   ├── crons.routes.ts                  # Route registration (6 endpoints)
│   │   │   ├── crons.service.ts                 # Business logic
│   │   │   └── crons.repository.ts              # Data access
│   │   ├── store/
│   │   │   ├── store.routes.ts                  # Route registration (5 endpoints)
│   │   │   ├── store.service.ts                 # Business logic
│   │   │   └── store.repository.ts              # Data access (composite keys)
│   │   └── system/
│   │       └── system.routes.ts                 # /ok, /info endpoints
│   ├── streaming/
│   │   └── stream-manager.ts                    # SSE session management
│   └── utils/
│       ├── uuid.util.ts                         # UUID v4 generation
│       ├── date.util.ts                         # ISO 8601 datetime
│       └── pagination.util.ts                   # X-Pagination-* header helper
├── test_scripts/
│   ├── assistants.test.ts
│   ├── threads.test.ts
│   ├── runs.test.ts
│   ├── runs-streaming.test.ts
│   ├── crons.test.ts
│   ├── store.test.ts
│   ├── system.test.ts
│   ├── sdk-compat-python.py
│   ├── sdk-compat-js.test.ts
│   └── sdk-compat-streaming.test.ts
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .env.example
├── Issues - Pending Items.md
└── CLAUDE.md
```

---

## 3. Data Models (TypeBox Schemas)

### 3.1 Enum Definitions

**File:** `src/schemas/enums.schema.ts`

```typescript
import { Type } from '@sinclair/typebox';

// --- Thread Status ---
export const ThreadStatusEnum = Type.Union([
  Type.Literal('idle'),
  Type.Literal('busy'),
  Type.Literal('interrupted'),
  Type.Literal('error'),
], { $id: 'ThreadStatus' });

// --- Run Status ---
export const RunStatusEnum = Type.Union([
  Type.Literal('pending'),
  Type.Literal('running'),
  Type.Literal('error'),
  Type.Literal('success'),
  Type.Literal('timeout'),
  Type.Literal('interrupted'),
], { $id: 'RunStatus' });

// --- Multitask Strategy ---
export const MultitaskStrategyEnum = Type.Union([
  Type.Literal('reject'),
  Type.Literal('interrupt'),
  Type.Literal('rollback'),
  Type.Literal('enqueue'),
], { $id: 'MultitaskStrategy' });

// --- Stream Mode ---
export const StreamModeEnum = Type.Union([
  Type.Literal('values'),
  Type.Literal('updates'),
  Type.Literal('messages'),
  Type.Literal('messages-tuple'),
  Type.Literal('events'),
  Type.Literal('debug'),
  Type.Literal('custom'),
  Type.Literal('tasks'),
  Type.Literal('checkpoints'),
], { $id: 'StreamMode' });

// --- IfExists ---
export const IfExistsEnum = Type.Union([
  Type.Literal('raise'),
  Type.Literal('do_nothing'),
  Type.Literal('update'),
], { $id: 'IfExists' });

// --- OnCompletion ---
export const OnCompletionEnum = Type.Union([
  Type.Literal('delete'),
  Type.Literal('keep'),
], { $id: 'OnCompletion' });

// --- OnDisconnect ---
export const OnDisconnectEnum = Type.Union([
  Type.Literal('cancel'),
  Type.Literal('continue'),
], { $id: 'OnDisconnect' });

// --- Sort Order ---
export const SortOrderEnum = Type.Union([
  Type.Literal('asc'),
  Type.Literal('desc'),
], { $id: 'SortOrder' });

// --- Durability ---
export const DurabilityEnum = Type.Union([
  Type.Literal('durable'),
  Type.Literal('ephemeral'),
], { $id: 'Durability' });

// --- Prune Strategy ---
export const PruneStrategyEnum = Type.Union([
  Type.Literal('delete'),
  Type.Literal('archive'),
], { $id: 'PruneStrategy' });

// --- Cancel Action ---
export const CancelActionEnum = Type.Union([
  Type.Literal('interrupt'),
  Type.Literal('rollback'),
], { $id: 'CancelAction' });
```

### 3.2 Common Schemas

**File:** `src/schemas/common.schema.ts`

```typescript
import { Type, Static } from '@sinclair/typebox';

// --- Metadata (arbitrary key-value object) ---
export const MetadataSchema = Type.Record(
  Type.String(),
  Type.Unknown(),
  { $id: 'Metadata' }
);

// --- Config ---
export const ConfigSchema = Type.Object({
  tags: Type.Optional(Type.Array(Type.String())),
  recursion_limit: Type.Optional(Type.Integer()),
  configurable: Type.Optional(
    Type.Record(Type.String(), Type.Unknown())
  ),
}, { $id: 'Config' });

// --- Checkpoint ---
export const CheckpointSchema = Type.Object({
  thread_id: Type.String({ format: 'uuid' }),
  checkpoint_ns: Type.String(),
  checkpoint_id: Type.String({ format: 'uuid' }),
  checkpoint_map: Type.Optional(
    Type.Record(Type.String(), Type.String())
  ),
}, { $id: 'Checkpoint' });

// --- Interrupt ---
export const InterruptSchema = Type.Object({
  value: Type.Unknown(),
  id: Type.String({ format: 'uuid' }),
}, { $id: 'Interrupt' });

// --- Command ---
export const CommandSchema = Type.Object({
  goto: Type.Optional(Type.Union([
    Type.String(),
    Type.Array(Type.String()),
  ])),
  update: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  resume: Type.Optional(Type.Unknown()),
}, { $id: 'Command' });

// --- Graph Schema (response for /schemas endpoint) ---
export const GraphSchemaSchema = Type.Object({
  graph_id: Type.String(),
  input_schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  output_schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  state_schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  config_schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  context_schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { $id: 'GraphSchema' });

// --- StreamPart ---
export const StreamPartSchema = Type.Object({
  event: Type.String(),
  data: Type.Unknown(),
  id: Type.Optional(Type.String()),
}, { $id: 'StreamPart' });

// --- Error Response ---
export const ErrorResponseSchema = Type.Object({
  detail: Type.String(),
}, { $id: 'ErrorResponse' });

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
```

### 3.3 Assistant Schemas

**File:** `src/schemas/assistant.schema.ts`

```typescript
import { Type, Static } from '@sinclair/typebox';
import { ConfigSchema, MetadataSchema, GraphSchemaSchema, ErrorResponseSchema }
  from './common.schema';
import { IfExistsEnum, SortOrderEnum } from './enums.schema';

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
}, { $id: 'Assistant' });

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
}, { $id: 'AssistantVersion' });

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
```

### 3.4 Thread Schemas

**File:** `src/schemas/thread.schema.ts`

```typescript
import { Type, Static } from '@sinclair/typebox';
import {
  ConfigSchema, MetadataSchema, CheckpointSchema, InterruptSchema, TTLInfoSchema
} from './common.schema';
import {
  ThreadStatusEnum, IfExistsEnum, SortOrderEnum, PruneStrategyEnum, StreamModeEnum
} from './enums.schema';

// --- Thread Entity ---
export const ThreadSchema = Type.Object({
  thread_id: Type.String({ format: 'uuid' }),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  status: ThreadStatusEnum,
  values: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  interrupts: Type.Optional(Type.Array(InterruptSchema)),
}, { $id: 'Thread' });

// --- Thread Task ---
export const ThreadTaskSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  interrupts: Type.Optional(Type.Array(InterruptSchema)),
  checkpoint: Type.Optional(CheckpointSchema),
  state: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  result: Type.Optional(Type.Unknown()),
}, { $id: 'ThreadTask' });

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
}, { $id: 'ThreadState' });

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
```

### 3.5 Run Schemas

**File:** `src/schemas/run.schema.ts`

```typescript
import { Type, Static } from '@sinclair/typebox';
import {
  ConfigSchema, CheckpointSchema, CommandSchema
} from './common.schema';
import {
  RunStatusEnum, MultitaskStrategyEnum, StreamModeEnum,
  OnCompletionEnum, OnDisconnectEnum, DurabilityEnum, CancelActionEnum
} from './enums.schema';

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
}, { $id: 'Run' });

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
```

### 3.6 Cron Schemas

**File:** `src/schemas/cron.schema.ts`

```typescript
import { Type, Static } from '@sinclair/typebox';
import {
  ConfigSchema, CheckpointSchema
} from './common.schema';
import {
  MultitaskStrategyEnum, StreamModeEnum, OnCompletionEnum,
  DurabilityEnum, SortOrderEnum
} from './enums.schema';

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
}, { $id: 'Cron' });

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
```

### 3.7 Store Schemas

**File:** `src/schemas/store.schema.ts`

```typescript
import { Type, Static } from '@sinclair/typebox';

// --- Item Entity ---
export const ItemSchema = Type.Object({
  namespace: Type.Array(Type.String()),
  key: Type.String(),
  value: Type.Record(Type.String(), Type.Unknown()),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
}, { $id: 'Item' });

// --- SearchItem Entity (Item + score) ---
export const SearchItemSchema = Type.Object({
  namespace: Type.Array(Type.String()),
  key: Type.String(),
  value: Type.Record(Type.String(), Type.Unknown()),
  created_at: Type.String({ format: 'date-time' }),
  updated_at: Type.String({ format: 'date-time' }),
  score: Type.Number(),
}, { $id: 'SearchItem' });

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
```

### 3.8 Type Exports

**File:** `src/types/index.ts`

```typescript
import { Static } from '@sinclair/typebox';

// Enums
import {
  ThreadStatusEnum, RunStatusEnum, MultitaskStrategyEnum, StreamModeEnum,
  IfExistsEnum, OnCompletionEnum, OnDisconnectEnum, SortOrderEnum,
  DurabilityEnum, PruneStrategyEnum, CancelActionEnum
} from '../schemas/enums.schema';

// Common
import {
  ConfigSchema, CheckpointSchema, InterruptSchema, CommandSchema,
  GraphSchemaSchema, StreamPartSchema, ErrorResponseSchema, TTLInfoSchema
} from '../schemas/common.schema';

// Assistants
import { AssistantSchema, AssistantVersionSchema } from '../schemas/assistant.schema';

// Threads
import { ThreadSchema, ThreadStateSchema, ThreadTaskSchema } from '../schemas/thread.schema';

// Runs
import { RunSchema } from '../schemas/run.schema';

// Crons
import { CronSchema } from '../schemas/cron.schema';

// Store
import { ItemSchema, SearchItemSchema } from '../schemas/store.schema';

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
```

---

## 4. Repository Layer Design

### 4.1 Repository Interfaces

**File:** `src/repositories/interfaces.ts`

```typescript
export interface SearchOptions {
  filter?: (item: any) => boolean;
  limit: number;
  offset: number;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
}

export interface SearchResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface IRepository<T> {
  findById(id: string): Promise<T | null>;
  findMany(filter: (item: T) => boolean): Promise<T[]>;
  findAll(): Promise<T[]>;
  save(item: T): Promise<T>;
  update(id: string, updates: Partial<T>): Promise<T | null>;
  delete(id: string): Promise<boolean>;
  count(filter?: (item: T) => boolean): Promise<number>;
  search(options: SearchOptions): Promise<SearchResult<T>>;
  clear(): Promise<void>;
}
```

### 4.2 InMemoryRepository Implementation

**File:** `src/repositories/in-memory.repository.ts`

```typescript
import { IRepository, SearchOptions, SearchResult } from './interfaces';

export class InMemoryRepository<T extends Record<string, any>>
  implements IRepository<T>
{
  protected store: Map<string, T> = new Map();
  protected readonly idField: string;

  constructor(idField: string) {
    this.idField = idField;
  }

  async findById(id: string): Promise<T | null> {
    return this.store.get(id) ?? null;
  }

  async findMany(filter: (item: T) => boolean): Promise<T[]> {
    return Array.from(this.store.values()).filter(filter);
  }

  async findAll(): Promise<T[]> {
    return Array.from(this.store.values());
  }

  async save(item: T): Promise<T> {
    const id = item[this.idField] as string;
    if (!id) {
      throw new Error(`Item missing required field: ${this.idField}`);
    }
    this.store.set(id, { ...item });
    return item;
  }

  async update(id: string, updates: Partial<T>): Promise<T | null> {
    const existing = this.store.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...updates } as T;
    this.store.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  async count(filter?: (item: T) => boolean): Promise<number> {
    if (!filter) return this.store.size;
    return Array.from(this.store.values()).filter(filter).length;
  }

  async search(options: SearchOptions): Promise<SearchResult<T>> {
    let items = Array.from(this.store.values());

    if (options.filter) {
      items = items.filter(options.filter);
    }

    if (options.sort_by) {
      const key = options.sort_by;
      const dir = options.sort_order === 'desc' ? -1 : 1;
      items.sort((a, b) => {
        const aVal = a[key];
        const bVal = b[key];
        if (aVal > bVal) return dir;
        if (aVal < bVal) return -dir;
        return 0;
      });
    }

    const total = items.length;
    const offset = options.offset;
    const limit = options.limit;
    items = items.slice(offset, offset + limit);

    return { items, total, offset, limit };
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}
```

### 4.3 Domain Repositories

Each domain repository extends `InMemoryRepository` with entity-specific query methods.

**AssistantsRepository** (`src/modules/assistants/assistants.repository.ts`):

```typescript
import { InMemoryRepository } from '../../repositories/in-memory.repository';
import { Assistant, AssistantVersion } from '../../types';

export class AssistantsRepository extends InMemoryRepository<Assistant> {
  private versions: Map<string, AssistantVersion[]> = new Map();

  constructor() {
    super('assistant_id');
  }

  async findByGraphId(graphId: string): Promise<Assistant[]> {
    return this.findMany((a) => a.graph_id === graphId);
  }

  async findByName(name: string): Promise<Assistant[]> {
    return this.findMany((a) =>
      a.name.toLowerCase().includes(name.toLowerCase())
    );
  }

  async saveVersion(version: AssistantVersion): Promise<void> {
    const existing = this.versions.get(version.assistant_id) ?? [];
    existing.push(version);
    this.versions.set(version.assistant_id, existing);
  }

  async getVersions(assistantId: string): Promise<AssistantVersion[]> {
    return this.versions.get(assistantId) ?? [];
  }

  async getVersion(
    assistantId: string,
    versionNum: number
  ): Promise<AssistantVersion | null> {
    const versions = this.versions.get(assistantId) ?? [];
    return versions.find((v) => v.version === versionNum) ?? null;
  }

  async deleteVersions(assistantId: string): Promise<void> {
    this.versions.delete(assistantId);
  }
}
```

**ThreadsRepository** (`src/modules/threads/threads.repository.ts`):

```typescript
import { InMemoryRepository } from '../../repositories/in-memory.repository';
import { Thread, ThreadState } from '../../types';

export class ThreadsRepository extends InMemoryRepository<Thread> {
  private states: Map<string, ThreadState[]> = new Map();

  constructor() {
    super('thread_id');
  }

  async findByStatus(status: string): Promise<Thread[]> {
    return this.findMany((t) => t.status === status);
  }

  async saveState(threadId: string, state: ThreadState): Promise<void> {
    const history = this.states.get(threadId) ?? [];
    history.push(state);
    this.states.set(threadId, history);
  }

  async getLatestState(threadId: string): Promise<ThreadState | null> {
    const history = this.states.get(threadId);
    if (!history || history.length === 0) return null;
    return history[history.length - 1];
  }

  async getStateHistory(threadId: string): Promise<ThreadState[]> {
    return (this.states.get(threadId) ?? []).slice().reverse();
  }

  async deleteStates(threadId: string): Promise<void> {
    this.states.delete(threadId);
  }

  async cloneStates(
    fromThreadId: string,
    toThreadId: string
  ): Promise<void> {
    const history = this.states.get(fromThreadId);
    if (history) {
      this.states.set(toThreadId, [...history]);
    }
  }
}
```

**RunsRepository** (`src/modules/runs/runs.repository.ts`):

```typescript
import { InMemoryRepository } from '../../repositories/in-memory.repository';
import { Run } from '../../types';

export class RunsRepository extends InMemoryRepository<Run> {
  constructor() {
    super('run_id');
  }

  async findByThreadId(threadId: string): Promise<Run[]> {
    return this.findMany((r) => r.thread_id === threadId);
  }

  async findByStatus(status: string): Promise<Run[]> {
    return this.findMany((r) => r.status === status);
  }

  async findByThreadIdAndStatus(
    threadId: string,
    status: string
  ): Promise<Run[]> {
    return this.findMany(
      (r) => r.thread_id === threadId && r.status === status
    );
  }

  async deleteByThreadId(threadId: string): Promise<number> {
    const runs = await this.findByThreadId(threadId);
    let count = 0;
    for (const run of runs) {
      if (await this.delete(run.run_id)) count++;
    }
    return count;
  }
}
```

**CronsRepository** (`src/modules/crons/crons.repository.ts`):

```typescript
import { InMemoryRepository } from '../../repositories/in-memory.repository';
import { Cron } from '../../types';

export class CronsRepository extends InMemoryRepository<Cron> {
  constructor() {
    super('cron_id');
  }

  async findByAssistantId(assistantId: string): Promise<Cron[]> {
    return this.findMany((c) => c.assistant_id === assistantId);
  }

  async findByThreadId(threadId: string): Promise<Cron[]> {
    return this.findMany((c) => c.thread_id === threadId);
  }

  async findEnabled(): Promise<Cron[]> {
    return this.findMany((c) => c.enabled === true);
  }
}
```

**StoreRepository** (`src/modules/store/store.repository.ts`):

```typescript
import { Item, SearchItem } from '../../types';

export class StoreRepository {
  // Composite key: "namespace_json::key"
  private store: Map<string, Item> = new Map();

  private makeCompositeKey(namespace: string[], key: string): string {
    return `${JSON.stringify(namespace)}::${key}`;
  }

  async put(item: Item): Promise<Item> {
    const compositeKey = this.makeCompositeKey(item.namespace, item.key);
    this.store.set(compositeKey, { ...item });
    return item;
  }

  async get(namespace: string[], key: string): Promise<Item | null> {
    const compositeKey = this.makeCompositeKey(namespace, key);
    return this.store.get(compositeKey) ?? null;
  }

  async delete(namespace: string[], key: string): Promise<boolean> {
    const compositeKey = this.makeCompositeKey(namespace, key);
    return this.store.delete(compositeKey);
  }

  async searchByPrefix(
    namespacePrefix: string[],
    filter?: Record<string, unknown>,
    limit: number = 100,
    offset: number = 0
  ): Promise<{ items: SearchItem[]; total: number }> {
    const allItems = Array.from(this.store.values());

    let filtered = allItems.filter((item) => {
      // Check namespace prefix match
      if (namespacePrefix.length > item.namespace.length) return false;
      return namespacePrefix.every((seg, i) => item.namespace[i] === seg);
    });

    // Apply value filter (shallow key match)
    if (filter) {
      filtered = filtered.filter((item) =>
        Object.entries(filter).every(
          ([k, v]) => item.value[k] === v
        )
      );
    }

    const total = filtered.length;
    const paged = filtered.slice(offset, offset + limit);

    const searchItems: SearchItem[] = paged.map((item) => ({
      ...item,
      score: 1.0, // stub score
    }));

    return { items: searchItems, total };
  }

  async listNamespaces(options: {
    prefix?: string[];
    suffix?: string[];
    max_depth?: number;
    limit?: number;
    offset?: number;
  }): Promise<string[][]> {
    const allItems = Array.from(this.store.values());
    const namespacesSet = new Set<string>();

    for (const item of allItems) {
      let ns = item.namespace;

      // Apply max_depth truncation
      if (options.max_depth && ns.length > options.max_depth) {
        ns = ns.slice(0, options.max_depth);
      }

      namespacesSet.add(JSON.stringify(ns));
    }

    let namespaces: string[][] = Array.from(namespacesSet).map(
      (s) => JSON.parse(s) as string[]
    );

    // Apply prefix filter
    if (options.prefix) {
      const pfx = options.prefix;
      namespaces = namespaces.filter((ns) =>
        pfx.every((seg, i) => ns[i] === seg)
      );
    }

    // Apply suffix filter
    if (options.suffix) {
      const sfx = options.suffix;
      namespaces = namespaces.filter((ns) => {
        const startIdx = ns.length - sfx.length;
        if (startIdx < 0) return false;
        return sfx.every((seg, i) => ns[startIdx + i] === seg);
      });
    }

    const total = namespaces.length;
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 100;

    return namespaces.slice(offset, offset + limit);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}
```

---

## 5. Route Handler Design

### 5.1 Route Registration Pattern

Each module exports an `async function` that receives a `FastifyInstance` and registers all routes with typed schemas.

```typescript
// Signature for all route registration functions
import { FastifyInstance } from 'fastify';

export async function registerAssistantRoutes(
  fastify: FastifyInstance
): Promise<void>;

export async function registerThreadRoutes(
  fastify: FastifyInstance
): Promise<void>;

export async function registerRunRoutes(
  fastify: FastifyInstance
): Promise<void>;

export async function registerCronRoutes(
  fastify: FastifyInstance
): Promise<void>;

export async function registerStoreRoutes(
  fastify: FastifyInstance
): Promise<void>;

export async function registerSystemRoutes(
  fastify: FastifyInstance
): Promise<void>;
```

### 5.2 Service Interfaces

**AssistantsService:**

```typescript
import { Assistant, AssistantVersion, GraphSchema } from '../../types';
import { Static } from '@sinclair/typebox';
import {
  CreateAssistantRequestSchema,
  UpdateAssistantRequestSchema,
  SearchAssistantsRequestSchema,
  CountAssistantsRequestSchema,
  ListVersionsRequestSchema,
} from '../../schemas/assistant.schema';

type CreateAssistantRequest = Static<typeof CreateAssistantRequestSchema>;
type UpdateAssistantRequest = Static<typeof UpdateAssistantRequestSchema>;
type SearchAssistantsRequest = Static<typeof SearchAssistantsRequestSchema>;
type CountAssistantsRequest = Static<typeof CountAssistantsRequestSchema>;
type ListVersionsRequest = Static<typeof ListVersionsRequestSchema>;

export interface IAssistantsService {
  create(request: CreateAssistantRequest): Promise<Assistant>;
  get(assistantId: string): Promise<Assistant>;
  update(assistantId: string, request: UpdateAssistantRequest): Promise<Assistant>;
  delete(assistantId: string): Promise<void>;
  search(request: SearchAssistantsRequest): Promise<{
    items: Assistant[];
    total: number;
    offset: number;
    limit: number;
  }>;
  count(request: CountAssistantsRequest): Promise<number>;
  getGraph(assistantId: string, xray?: boolean | number): Promise<Record<string, unknown>>;
  getSchemas(assistantId: string): Promise<GraphSchema>;
  getSubgraphs(
    assistantId: string,
    namespace?: string,
    recurse?: boolean
  ): Promise<Record<string, unknown>>;
  listVersions(
    assistantId: string,
    request: ListVersionsRequest
  ): Promise<{ items: AssistantVersion[]; total: number; offset: number; limit: number }>;
  setLatestVersion(assistantId: string, version: number): Promise<Assistant>;
}
```

**ThreadsService:**

```typescript
import { Thread, ThreadState } from '../../types';
import { Static } from '@sinclair/typebox';
import {
  CreateThreadRequestSchema,
  UpdateThreadRequestSchema,
  SearchThreadsRequestSchema,
  CountThreadsRequestSchema,
  UpdateThreadStateRequestSchema,
  ThreadHistoryRequestSchema,
  PruneThreadsRequestSchema,
} from '../../schemas/thread.schema';

type CreateThreadRequest = Static<typeof CreateThreadRequestSchema>;
type UpdateThreadRequest = Static<typeof UpdateThreadRequestSchema>;
type SearchThreadsRequest = Static<typeof SearchThreadsRequestSchema>;
type CountThreadsRequest = Static<typeof CountThreadsRequestSchema>;
type UpdateThreadStateRequest = Static<typeof UpdateThreadStateRequestSchema>;
type ThreadHistoryRequest = Static<typeof ThreadHistoryRequestSchema>;
type PruneThreadsRequest = Static<typeof PruneThreadsRequestSchema>;

export interface IThreadsService {
  create(request: CreateThreadRequest): Promise<Thread>;
  get(threadId: string): Promise<Thread>;
  update(threadId: string, request: UpdateThreadRequest): Promise<Thread>;
  delete(threadId: string): Promise<void>;
  search(request: SearchThreadsRequest): Promise<{
    items: Thread[];
    total: number;
    offset: number;
    limit: number;
  }>;
  count(request: CountThreadsRequest): Promise<number>;
  copy(threadId: string): Promise<Thread>;
  prune(request: PruneThreadsRequest): Promise<{ pruned_count: number }>;
  getState(threadId: string, checkpointId?: string): Promise<ThreadState>;
  updateState(
    threadId: string,
    request: UpdateThreadStateRequest
  ): Promise<{ checkpoint: Checkpoint }>;
  getHistory(
    threadId: string,
    request: ThreadHistoryRequest
  ): Promise<ThreadState[]>;
  setStatus(threadId: string, status: ThreadStatus): Promise<void>;
}
```

**RunsService:**

```typescript
import { Run, RunStatus } from '../../types';
import { Static } from '@sinclair/typebox';
import {
  RunCreateRequestSchema,
  ListRunsQuerySchema,
  CancelRunRequestSchema,
  BulkCancelRunsRequestSchema,
} from '../../schemas/run.schema';

type RunCreateRequest = Static<typeof RunCreateRequestSchema>;
type ListRunsQuery = Static<typeof ListRunsQuerySchema>;
type CancelRunRequest = Static<typeof CancelRunRequestSchema>;
type BulkCancelRunsRequest = Static<typeof BulkCancelRunsRequestSchema>;

export interface IRunsService {
  createStateful(
    threadId: string,
    request: RunCreateRequest
  ): Promise<Run>;
  createStateless(request: RunCreateRequest): Promise<Run>;
  createBatch(requests: RunCreateRequest[]): Promise<Run[]>;
  get(threadId: string, runId: string): Promise<Run>;
  list(threadId: string, query: ListRunsQuery): Promise<{
    items: Run[];
    total: number;
    offset: number;
    limit: number;
  }>;
  cancel(
    threadId: string,
    runId: string,
    request: CancelRunRequest
  ): Promise<void>;
  bulkCancel(request: BulkCancelRunsRequest): Promise<void>;
  join(threadId: string, runId: string): Promise<Run>;
  delete(threadId: string, runId: string): Promise<void>;
  wait(
    threadId: string | null,
    request: RunCreateRequest
  ): Promise<{ run_id: string; status: RunStatus; result: Record<string, unknown> }>;
}
```

**CronsService:**

```typescript
import { Cron } from '../../types';
import { Static } from '@sinclair/typebox';
import {
  CreateCronRequestSchema,
  UpdateCronRequestSchema,
  SearchCronsRequestSchema,
  CountCronsRequestSchema,
} from '../../schemas/cron.schema';

type CreateCronRequest = Static<typeof CreateCronRequestSchema>;
type UpdateCronRequest = Static<typeof UpdateCronRequestSchema>;
type SearchCronsRequest = Static<typeof SearchCronsRequestSchema>;
type CountCronsRequest = Static<typeof CountCronsRequestSchema>;

export interface ICronsService {
  createStateful(threadId: string, request: CreateCronRequest): Promise<Cron>;
  createStateless(request: CreateCronRequest): Promise<Cron>;
  update(cronId: string, request: UpdateCronRequest): Promise<Cron>;
  delete(cronId: string): Promise<void>;
  search(request: SearchCronsRequest): Promise<{
    items: Cron[];
    total: number;
    offset: number;
    limit: number;
  }>;
  count(request: CountCronsRequest): Promise<number>;
}
```

**StoreService:**

```typescript
import { Item, SearchItem } from '../../types';
import { Static } from '@sinclair/typebox';
import {
  PutItemRequestSchema,
  SearchItemsRequestSchema,
  ListNamespacesRequestSchema,
} from '../../schemas/store.schema';

type PutItemRequest = Static<typeof PutItemRequestSchema>;
type SearchItemsRequest = Static<typeof SearchItemsRequestSchema>;
type ListNamespacesRequest = Static<typeof ListNamespacesRequestSchema>;

export interface IStoreService {
  putItem(request: PutItemRequest): Promise<void>;
  getItem(namespace: string[], key: string): Promise<Item>;
  deleteItem(namespace: string[], key: string): Promise<void>;
  searchItems(request: SearchItemsRequest): Promise<{
    items: SearchItem[];
    total: number;
  }>;
  listNamespaces(request: ListNamespacesRequest): Promise<string[][]>;
}
```

### 5.3 Route Handler Patterns

Each route follows this pattern within the route registration function:

```typescript
// Example: POST /assistants
fastify.post('/assistants', {
  schema: {
    description: 'Create a new assistant',
    tags: ['Assistants'],
    body: CreateAssistantRequestSchema,
    response: {
      200: AssistantSchema,
      409: ErrorResponseSchema,
      422: ErrorResponseSchema,
    },
  },
}, async (request, reply) => {
  const assistant = await assistantsService.create(request.body);
  return reply.code(200).send(assistant);
});
```

For endpoints returning pagination:

```typescript
// Example: POST /assistants/search
fastify.post('/assistants/search', {
  schema: {
    description: 'Search assistants',
    tags: ['Assistants'],
    body: SearchAssistantsRequestSchema,
    response: {
      200: Type.Array(AssistantSchema),
    },
  },
}, async (request, reply) => {
  const result = await assistantsService.search(request.body);
  setPaginationHeaders(reply, result.total, result.offset, result.limit);
  return reply.code(200).send(result.items);
});
```

---

## 6. SSE Streaming Design

### 6.1 StreamManager Class

**File:** `src/streaming/stream-manager.ts`

```typescript
import { FastifyRequest, FastifyReply } from 'fastify';
import { StreamMode } from '../types';

export interface StreamSession {
  id: string;
  runId: string;
  threadId: string | null;
  streamModes: StreamMode[];
  eventBuffer: StreamEvent[];
  lastEventId: number;
  closed: boolean;
}

export interface StreamEvent {
  event: string;
  data: string;      // JSON-serialized
  id: string;        // sequential numeric string
}

export class StreamManager {
  private sessions: Map<string, StreamSession> = new Map();

  createSession(
    runId: string,
    threadId: string | null,
    streamModes: StreamMode[]
  ): StreamSession {
    const session: StreamSession = {
      id: runId,
      runId,
      threadId,
      streamModes,
      eventBuffer: [],
      lastEventId: 0,
      closed: false,
    };
    this.sessions.set(runId, session);
    return session;
  }

  getSession(runId: string): StreamSession | null {
    return this.sessions.get(runId) ?? null;
  }

  closeSession(runId: string): void {
    const session = this.sessions.get(runId);
    if (session) {
      session.closed = true;
      // Keep for replay, auto-cleanup after timeout
      setTimeout(() => this.sessions.delete(runId), 60_000);
    }
  }

  getEventsAfter(runId: string, lastEventId: string): StreamEvent[] {
    const session = this.sessions.get(runId);
    if (!session) return [];
    const afterId = parseInt(lastEventId, 10);
    return session.eventBuffer.filter(
      (e) => parseInt(e.id, 10) > afterId
    );
  }
}
```

### 6.2 SSE Event Emission

**File:** `src/modules/runs/runs.streaming.ts`

```typescript
import { FastifyReply } from 'fastify';
import { StreamManager, StreamEvent, StreamSession } from '../../streaming/stream-manager';
import { StreamMode, Run } from '../../types';
import { generateUUID } from '../../utils/uuid.util';
import { nowISO } from '../../utils/date.util';

export class RunStreamEmitter {
  constructor(private streamManager: StreamManager) {}

  async streamRun(
    reply: FastifyReply,
    run: Run,
    streamModes: StreamMode[],
    lastEventId?: string
  ): Promise<void> {
    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const session = this.streamManager.createSession(
      run.run_id,
      run.thread_id,
      streamModes
    );

    // Handle reconnection
    if (lastEventId) {
      const missed = this.streamManager.getEventsAfter(
        run.run_id,
        lastEventId
      );
      for (const event of missed) {
        this.writeEvent(reply, event);
      }
      return;
    }

    try {
      // 1. Emit metadata event
      await this.emit(reply, session, 'metadata', {
        run_id: run.run_id,
        thread_id: run.thread_id,
      });

      // 2. Emit mode-specific stub events
      for (const mode of streamModes) {
        await this.emitModeEvent(reply, session, mode, run);
      }

      // 3. Emit end event
      await this.emit(reply, session, 'end', null);
    } catch (error: unknown) {
      const message = error instanceof Error
        ? error.message
        : 'Unknown streaming error';
      await this.emit(reply, session, 'error', { message });
    } finally {
      this.streamManager.closeSession(run.run_id);
      reply.raw.end();
    }
  }

  private async emitModeEvent(
    reply: FastifyReply,
    session: StreamSession,
    mode: StreamMode,
    run: Run
  ): Promise<void> {
    switch (mode) {
      case 'values':
        await this.emit(reply, session, 'values', {
          messages: [
            {
              type: 'ai',
              content: 'This is a stub response from the LG-API server.',
              id: generateUUID(),
            },
          ],
        });
        break;

      case 'updates':
        await this.emit(reply, session, 'updates', {
          agent: {
            messages: [
              {
                type: 'ai',
                content: 'Stub update from agent node.',
                id: generateUUID(),
              },
            ],
          },
        });
        break;

      case 'messages':
        await this.emit(reply, session, 'messages', [
          {
            type: 'AIMessageChunk',
            content: 'Stub message chunk.',
            id: generateUUID(),
          },
        ]);
        break;

      case 'messages-tuple':
        await this.emit(reply, session, 'messages/partial', [
          ['ai', { content: 'Stub tuple message.', id: generateUUID() }],
        ]);
        break;

      case 'events':
        await this.emit(reply, session, 'events', {
          event: 'on_chain_end',
          name: 'agent',
          run_id: run.run_id,
          data: { output: {} },
        });
        break;

      case 'debug':
        await this.emit(reply, session, 'debug', {
          type: 'task_result',
          timestamp: nowISO(),
          step: 1,
          payload: {},
        });
        break;

      case 'custom':
        await this.emit(reply, session, 'custom', {
          type: 'stub_custom_event',
          data: {},
        });
        break;

      case 'tasks':
        await this.emit(reply, session, 'tasks', {
          task_id: generateUUID(),
          name: 'agent',
          status: 'completed',
          result: {},
        });
        break;

      case 'checkpoints':
        await this.emit(reply, session, 'checkpoints', {
          thread_id: run.thread_id,
          checkpoint_ns: '',
          checkpoint_id: generateUUID(),
        });
        break;
    }
  }

  private async emit(
    reply: FastifyReply,
    session: StreamSession,
    event: string,
    data: unknown
  ): Promise<void> {
    session.lastEventId++;
    const streamEvent: StreamEvent = {
      event,
      data: JSON.stringify(data),
      id: String(session.lastEventId),
    };
    session.eventBuffer.push(streamEvent);
    this.writeEvent(reply, streamEvent);
  }

  private writeEvent(reply: FastifyReply, event: StreamEvent): void {
    reply.raw.write(`event: ${event.event}\n`);
    reply.raw.write(`data: ${event.data}\n`);
    reply.raw.write(`id: ${event.id}\n`);
    reply.raw.write('\n');
  }
}
```

### 6.3 SSE Connection Lifecycle

```
1. Client sends POST /threads/:id/runs/stream
   Headers: Accept: text/event-stream

2. Server validates request body (RunCreateRequestSchema)

3. Server creates Run (status: pending -> running)

4. Server sets response headers:
   Content-Type: text/event-stream
   Cache-Control: no-cache
   Connection: keep-alive

5. Server emits events:
   event: metadata
   data: {"run_id":"...","thread_id":"..."}
   id: 1

   event: values
   data: {"messages":[...]}
   id: 2

   event: end
   data: null
   id: 3

6. Server transitions Run to success, Thread to idle

7. Server closes connection (reply.raw.end())

8. If client disconnects early:
   - Detect via reply.raw 'close' event
   - If on_disconnect == 'cancel': cancel the run
   - If on_disconnect == 'continue': let stub complete
```

### 6.4 Reconnection via Last-Event-ID

```
1. Client reconnects with header:
   Last-Event-ID: 2

2. Server looks up session by run_id
3. Server replays events with id > 2 from eventBuffer
4. If session closed/expired, returns empty stream with end event
```

---

## 7. Middleware Stack

### 7.1 Plugin Registration Order

**File:** `src/app.ts`

```typescript
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { loadConfig } from './config/env.config';

export async function buildApp() {
  const config = loadConfig();

  const fastify = Fastify({
    logger: true,
  }).withTypeProvider<TypeBoxTypeProvider>();

  // 1. CORS (first - adds headers to all responses)
  await fastify.register(import('./plugins/cors.plugin'));

  // 2. Swagger (before routes - collects schemas)
  await fastify.register(import('./plugins/swagger.plugin'));

  // 3. Error Handler (global)
  await fastify.register(import('./plugins/error-handler.plugin'));

  // 4. Auth Plugin (decorates fastify.authenticate)
  await fastify.register(import('./plugins/auth.plugin'));

  // 5. System routes (no auth required for /ok)
  await fastify.register(import('./modules/system/system.routes'));

  // 6. Protected routes (auth applied per-route or per-group)
  await fastify.register(async (instance) => {
    if (config.LG_API_AUTH_ENABLED) {
      instance.addHook('preHandler', instance.authenticate);
    }

    await instance.register(import('./modules/assistants/assistants.routes'));
    await instance.register(import('./modules/threads/threads.routes'));
    await instance.register(import('./modules/runs/runs.routes'));
    await instance.register(import('./modules/crons/crons.routes'));
    await instance.register(import('./modules/store/store.routes'));
  });

  return fastify;
}
```

### 7.2 Authentication Plugin

**File:** `src/plugins/auth.plugin.ts`

```typescript
import fp from 'fastify-plugin';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadConfig } from '../config/env.config';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
  }
}

export default fp(async (fastify: FastifyInstance) => {
  const config = loadConfig();

  fastify.decorate(
    'authenticate',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!config.LG_API_AUTH_ENABLED) return;

      const apiKey = request.headers['x-api-key'];

      if (!apiKey) {
        reply.code(401).send({ detail: 'Missing X-Api-Key header' });
        return;
      }

      if (apiKey !== config.LG_API_KEY) {
        reply.code(401).send({ detail: 'Invalid API key' });
        return;
      }
    }
  );
});
```

### 7.3 Error Handler Plugin

**File:** `src/plugins/error-handler.plugin.ts`

```typescript
import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { ApiError } from '../errors/api-error';

export default fp(async (fastify: FastifyInstance) => {
  fastify.setErrorHandler((error, request, reply) => {
    // ApiError (custom business errors)
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        detail: error.detail,
      });
    }

    // Fastify validation errors (Ajv)
    if (error.validation) {
      const messages = error.validation.map(
        (v) => `${v.instancePath || 'body'} ${v.message}`
      );
      return reply.code(422).send({
        detail: `Validation error: ${messages.join('; ')}`,
      });
    }

    // Generic errors
    request.log.error(error);
    return reply.code(500).send({
      detail: 'Internal server error',
    });
  });
});
```

### 7.4 ApiError Class

**File:** `src/errors/api-error.ts`

```typescript
export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly detail: string;

  constructor(statusCode: number, detail: string) {
    super(detail);
    this.statusCode = statusCode;
    this.detail = detail;
    this.name = 'ApiError';
  }

  static notFound(resource: string): ApiError {
    return new ApiError(404, `${resource} not found`);
  }

  static conflict(detail: string): ApiError {
    return new ApiError(409, detail);
  }

  static validationError(detail: string): ApiError {
    return new ApiError(422, detail);
  }
}
```

### 7.5 Pagination Utility

**File:** `src/utils/pagination.util.ts`

```typescript
import { FastifyReply } from 'fastify';

export function setPaginationHeaders(
  reply: FastifyReply,
  total: number,
  offset: number,
  limit: number
): void {
  reply.header('X-Pagination-Total', String(total));
  reply.header('X-Pagination-Offset', String(offset));
  reply.header('X-Pagination-Limit', String(limit));
}
```

### 7.6 CORS Plugin

**File:** `src/plugins/cors.plugin.ts`

```typescript
import fp from 'fastify-plugin';
import cors from '@fastify/cors';
import { FastifyInstance } from 'fastify';

export default fp(async (fastify: FastifyInstance) => {
  await fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'X-Api-Key',
      'Accept',
      'Last-Event-ID',
    ],
    exposedHeaders: [
      'X-Pagination-Total',
      'X-Pagination-Offset',
      'X-Pagination-Limit',
    ],
    credentials: true,
  });
});
```

### 7.7 Swagger Plugin

**File:** `src/plugins/swagger.plugin.ts`

```typescript
import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { FastifyInstance } from 'fastify';

export default fp(async (fastify: FastifyInstance) => {
  await fastify.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'LangGraph API Replacement',
        description: 'Drop-in replacement for LangGraph Platform Server API',
        version: '1.0.0',
      },
      tags: [
        { name: 'Assistants', description: 'Assistant management' },
        { name: 'Threads', description: 'Thread management' },
        { name: 'Runs', description: 'Run execution' },
        { name: 'Crons', description: 'Scheduled runs' },
        { name: 'Store', description: 'Key-value store' },
        { name: 'System', description: 'Health and info' },
      ],
      components: {
        securitySchemes: {
          ApiKeyAuth: {
            type: 'apiKey',
            name: 'X-Api-Key',
            in: 'header',
          },
        },
      },
      security: [{ ApiKeyAuth: [] }],
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });
});
```

---

## 8. Configuration Design

### 8.1 Configuration Interface

**File:** `src/config/env.config.ts`

```typescript
export interface AppConfig {
  LG_API_PORT: number;
  LG_API_HOST: string;
  LG_API_AUTH_ENABLED: boolean;
  LG_API_KEY: string | undefined;
  NODE_ENV: 'development' | 'production' | 'test';
}

let _config: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (_config) return _config;

  // --- LG_API_PORT ---
  const portStr = process.env.LG_API_PORT;
  if (portStr === undefined || portStr === '') {
    throw new Error(
      'Missing required environment variable: LG_API_PORT. ' +
      'Set it to the port number the server should listen on (1-65535).'
    );
  }
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid LG_API_PORT value "${portStr}". Must be an integer between 1 and 65535.`
    );
  }

  // --- LG_API_HOST ---
  const host = process.env.LG_API_HOST;
  if (host === undefined || host === '') {
    throw new Error(
      'Missing required environment variable: LG_API_HOST. ' +
      'Set it to the network interface to bind (e.g., "0.0.0.0" or "127.0.0.1").'
    );
  }

  // --- LG_API_AUTH_ENABLED ---
  const authEnabledStr = process.env.LG_API_AUTH_ENABLED;
  if (authEnabledStr === undefined || authEnabledStr === '') {
    throw new Error(
      'Missing required environment variable: LG_API_AUTH_ENABLED. ' +
      'Set it to "true" or "false".'
    );
  }
  if (authEnabledStr !== 'true' && authEnabledStr !== 'false') {
    throw new Error(
      `Invalid LG_API_AUTH_ENABLED value "${authEnabledStr}". Must be "true" or "false".`
    );
  }
  const authEnabled = authEnabledStr === 'true';

  // --- LG_API_KEY ---
  const apiKey = process.env.LG_API_KEY;
  if (authEnabled && (!apiKey || apiKey === '')) {
    throw new Error(
      'Missing required environment variable: LG_API_KEY. ' +
      'Required when LG_API_AUTH_ENABLED is true.'
    );
  }

  // --- NODE_ENV ---
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv === undefined || nodeEnv === '') {
    throw new Error(
      'Missing required environment variable: NODE_ENV. ' +
      'Set it to "development", "production", or "test".'
    );
  }
  if (!['development', 'production', 'test'].includes(nodeEnv)) {
    throw new Error(
      `Invalid NODE_ENV value "${nodeEnv}". Must be "development", "production", or "test".`
    );
  }

  _config = {
    LG_API_PORT: port,
    LG_API_HOST: host,
    LG_API_AUTH_ENABLED: authEnabled,
    LG_API_KEY: apiKey,
    NODE_ENV: nodeEnv as 'development' | 'production' | 'test',
  };

  return _config;
}

// Reset for testing
export function resetConfig(): void {
  _config = null;
}
```

### 8.2 Configuration Variable Reference

| Variable | Type | Required | Description |
|----------|------|----------|-------------|
| `LG_API_PORT` | number (1-65535) | Always | TCP port the server listens on |
| `LG_API_HOST` | string | Always | Network interface to bind (e.g., `0.0.0.0`) |
| `LG_API_AUTH_ENABLED` | `"true"` or `"false"` | Always | Whether X-Api-Key authentication is enforced |
| `LG_API_KEY` | string | When auth enabled | The expected API key value for X-Api-Key header |
| `NODE_ENV` | `"development"`, `"production"`, `"test"` | Always | Runtime environment |

**Strict enforcement:** Every variable listed above throws a descriptive exception if missing or invalid. There are no fallback or default values.

### 8.3 .env.example

```bash
# LG-API Configuration
# All variables are REQUIRED - server will not start without them

# Server port (1-65535)
LG_API_PORT=8124

# Server bind address
LG_API_HOST=0.0.0.0

# Enable X-Api-Key authentication (true/false)
LG_API_AUTH_ENABLED=false

# API key (required when LG_API_AUTH_ENABLED=true)
LG_API_KEY=your-api-key-here

# Runtime environment (development/production/test)
NODE_ENV=development
```

---

## 9. API Contract Summary

### 9.1 Assistants Endpoints (11)

| # | Method | Path | Request Body Schema | Response Schema | Status Codes | Tag |
|---|--------|------|---------------------|-----------------|-------------|-----|
| 1 | POST | `/assistants` | `CreateAssistantRequestSchema` | `AssistantSchema` | 200, 409, 422 | Assistants |
| 2 | GET | `/assistants/:assistant_id` | -- | `AssistantSchema` | 200, 404 | Assistants |
| 3 | PATCH | `/assistants/:assistant_id` | `UpdateAssistantRequestSchema` | `AssistantSchema` | 200, 404, 422 | Assistants |
| 4 | DELETE | `/assistants/:assistant_id` | -- | -- (204) | 204, 404 | Assistants |
| 5 | POST | `/assistants/search` | `SearchAssistantsRequestSchema` | `Array<AssistantSchema>` | 200 | Assistants |
| 6 | POST | `/assistants/count` | `CountAssistantsRequestSchema` | `Type.Integer()` | 200 | Assistants |
| 7 | GET | `/assistants/:assistant_id/graph` | -- (query: `xray`) | `Type.Record(...)` | 200, 404 | Assistants |
| 8 | GET | `/assistants/:assistant_id/schemas` | -- | `GraphSchemaSchema` | 200, 404 | Assistants |
| 9 | GET | `/assistants/:assistant_id/subgraphs` | -- (query: `namespace`, `recurse`) | `Type.Record(...)` | 200, 404 | Assistants |
| 10 | POST | `/assistants/:assistant_id/versions` | `ListVersionsRequestSchema` | `Array<AssistantVersionSchema>` | 200, 404 | Assistants |
| 11 | POST | `/assistants/:assistant_id/latest` | `SetLatestVersionRequestSchema` | `AssistantSchema` | 200, 404 | Assistants |

### 9.2 Threads Endpoints (12)

| # | Method | Path | Request Body Schema | Response Schema | Status Codes | Tag |
|---|--------|------|---------------------|-----------------|-------------|-----|
| 1 | POST | `/threads` | `CreateThreadRequestSchema` | `ThreadSchema` | 200, 409, 422 | Threads |
| 2 | GET | `/threads/:thread_id` | -- (query: `include`) | `ThreadSchema` | 200, 404 | Threads |
| 3 | PATCH | `/threads/:thread_id` | `UpdateThreadRequestSchema` | `ThreadSchema` | 200, 404, 422 | Threads |
| 4 | DELETE | `/threads/:thread_id` | -- | -- (204) | 204, 404 | Threads |
| 5 | POST | `/threads/search` | `SearchThreadsRequestSchema` | `Array<ThreadSchema>` | 200 | Threads |
| 6 | POST | `/threads/count` | `CountThreadsRequestSchema` | `Type.Integer()` | 200 | Threads |
| 7 | POST | `/threads/:thread_id/copy` | `CopyThreadRequestSchema` | `ThreadSchema` | 200, 404 | Threads |
| 8 | POST | `/threads/prune` | `PruneThreadsRequestSchema` | `{pruned_count: number}` | 200 | Threads |
| 9 | GET | `/threads/:thread_id/state` | -- (query: `subgraphs`) | `ThreadStateSchema` | 200, 404 | Threads |
| 10 | POST | `/threads/:thread_id/state` | `UpdateThreadStateRequestSchema` | `{checkpoint: Checkpoint}` | 200, 404 | Threads |
| 11 | POST | `/threads/:thread_id/history` | `ThreadHistoryRequestSchema` | `Array<ThreadStateSchema>` | 200, 404 | Threads |
| 12 | GET | `/threads/:thread_id/stream` | -- (query: `stream_mode`, `last_event_id`) | SSE stream | 200, 404 | Threads |

### 9.3 Runs Endpoints (14)

| # | Method | Path | Request Body Schema | Response Schema | Status Codes | Tag |
|---|--------|------|---------------------|-----------------|-------------|-----|
| 1 | POST | `/threads/:thread_id/runs` | `RunCreateRequestSchema` | `RunSchema` | 200, 404, 422 | Runs |
| 2 | POST | `/runs` | `RunCreateRequestSchema` | `RunSchema` | 200, 422 | Runs |
| 3 | POST | `/threads/:thread_id/runs/stream` | `RunCreateRequestSchema` | SSE stream | 200, 404, 422 | Runs |
| 4 | POST | `/runs/stream` | `RunCreateRequestSchema` | SSE stream | 200, 422 | Runs |
| 5 | POST | `/threads/:thread_id/runs/wait` | `RunCreateRequestSchema` | `RunWaitResponseSchema` | 200, 404, 422 | Runs |
| 6 | POST | `/runs/wait` | `RunCreateRequestSchema` | `RunWaitResponseSchema` | 200, 422 | Runs |
| 7 | POST | `/runs/batch` | `RunBatchRequestSchema` | `Array<RunSchema>` | 200, 422 | Runs |
| 8 | GET | `/threads/:thread_id/runs` | -- (query: `ListRunsQuerySchema`) | `Array<RunSchema>` | 200, 404 | Runs |
| 9 | GET | `/threads/:thread_id/runs/:run_id` | -- | `RunSchema` | 200, 404 | Runs |
| 10 | POST | `/threads/:thread_id/runs/:run_id/cancel` | `CancelRunRequestSchema` | -- (200) | 200, 404 | Runs |
| 11 | POST | `/runs/cancel` | `BulkCancelRunsRequestSchema` | -- (200) | 200 | Runs |
| 12 | GET | `/threads/:thread_id/runs/:run_id/join` | -- | `RunSchema` | 200, 404 | Runs |
| 13 | GET | `/threads/:thread_id/runs/:run_id/stream` | -- (query: `JoinStreamQuerySchema`) | SSE stream | 200, 404 | Runs |
| 14 | DELETE | `/threads/:thread_id/runs/:run_id` | -- | -- (204) | 204, 404 | Runs |

### 9.4 Crons Endpoints (6)

| # | Method | Path | Request Body Schema | Response Schema | Status Codes | Tag |
|---|--------|------|---------------------|-----------------|-------------|-----|
| 1 | POST | `/threads/:thread_id/runs/crons` | `CreateCronRequestSchema` | `CronSchema` | 200, 404, 422 | Crons |
| 2 | POST | `/runs/crons` | `CreateCronRequestSchema` | `CronSchema` | 200, 422 | Crons |
| 3 | DELETE | `/runs/crons/:cron_id` | -- | -- (204) | 204, 404 | Crons |
| 4 | PATCH | `/runs/crons/:cron_id` | `UpdateCronRequestSchema` | `CronSchema` | 200, 404, 422 | Crons |
| 5 | POST | `/runs/crons/search` | `SearchCronsRequestSchema` | `Array<CronSchema>` | 200 | Crons |
| 6 | POST | `/runs/crons/count` | `CountCronsRequestSchema` | `Type.Integer()` | 200 | Crons |

### 9.5 Store Endpoints (5)

| # | Method | Path | Request Body Schema | Response Schema | Status Codes | Tag |
|---|--------|------|---------------------|-----------------|-------------|-----|
| 1 | PUT | `/store/items` | `PutItemRequestSchema` | -- (200) | 200, 422 | Store |
| 2 | GET | `/store/items` | -- (query: `GetItemQuerySchema`) | `ItemSchema` | 200, 404 | Store |
| 3 | DELETE | `/store/items` | `DeleteItemRequestSchema` | -- (204) | 204, 422 | Store |
| 4 | POST | `/store/items/search` | `SearchItemsRequestSchema` | `Array<SearchItemSchema>` | 200 | Store |
| 5 | POST | `/store/namespaces` | `ListNamespacesRequestSchema` | `ListNamespacesResponseSchema` | 200 | Store |

### 9.6 System Endpoints (2)

| # | Method | Path | Request Body Schema | Response Schema | Status Codes | Auth Required | Tag |
|---|--------|------|---------------------|-----------------|-------------|---------------|-----|
| 1 | GET | `/ok` | -- | `{ok: boolean}` | 200 | No | System |
| 2 | GET | `/info` | -- | `{version, name, description, capabilities}` | 200 | Yes | System |

**Total: 50 endpoints**

---

## 10. Implementation Units for Parallel Execution

### 10.1 Unit Dependency Graph

```
Unit A (Foundation)
  |
  +---> Unit B (Type Definitions)     [can start after A]
  |       |
  |       +---> Unit C (Repositories) [can start after B]
  |       |
  |       +---> Unit D (Middleware)    [can start after B]
  |               |
  |               +---> Unit E (Assistants + Threads)  [after C + D]
  |               |
  |               +---> Unit F (Runs + SSE Streaming)  [after C + D + E(Threads)]
  |               |
  |               +---> Unit G (Crons + Store + System) [after C + D, parallel with E/F]
```

### 10.2 Unit A: Project Foundation

**Scope:** Project skeleton, build pipeline, configuration loader, Fastify bootstrap.

**Files:**
- `package.json`
- `tsconfig.json`
- `vitest.config.ts`
- `.env.example`
- `src/index.ts`
- `src/server.ts`
- `src/app.ts`
- `src/config/env.config.ts`

**Interface Contract (exports consumed by other units):**

```typescript
// src/config/env.config.ts
export interface AppConfig {
  LG_API_PORT: number;
  LG_API_HOST: string;
  LG_API_AUTH_ENABLED: boolean;
  LG_API_KEY: string | undefined;
  NODE_ENV: 'development' | 'production' | 'test';
}
export function loadConfig(): AppConfig;
export function resetConfig(): void;

// src/app.ts
import { FastifyInstance } from 'fastify';
export async function buildApp(): Promise<FastifyInstance>;

// src/server.ts
// Entry point - calls buildApp() and starts listening
```

**Dependencies on other units:** None.

**Estimated effort:** 4 hours.

### 10.3 Unit B: Type Definitions (All TypeBox Schemas)

**Scope:** All TypeBox schemas for entities, request bodies, response bodies, enums.

**Files:**
- `src/schemas/enums.schema.ts`
- `src/schemas/common.schema.ts`
- `src/schemas/assistant.schema.ts`
- `src/schemas/thread.schema.ts`
- `src/schemas/run.schema.ts`
- `src/schemas/cron.schema.ts`
- `src/schemas/store.schema.ts`
- `src/schemas/index.ts`
- `src/types/index.ts`

**Interface Contract (exports consumed by other units):**

```typescript
// All schema files export TypeBox TSchema objects
// src/types/index.ts exports Static<> types:
export type Assistant = Static<typeof AssistantSchema>;
export type Thread = Static<typeof ThreadSchema>;
export type Run = Static<typeof RunSchema>;
export type Cron = Static<typeof CronSchema>;
export type Item = Static<typeof ItemSchema>;
// ... (all types listed in Section 3.8)
```

**Dependencies on other units:** Unit A (needs `@sinclair/typebox` installed).

**Estimated effort:** 6 hours.

### 10.4 Unit C: Repository Layer

**Scope:** IRepository interface, InMemoryRepository, all 5 domain repositories.

**Files:**
- `src/repositories/interfaces.ts`
- `src/repositories/in-memory.repository.ts`
- `src/modules/assistants/assistants.repository.ts`
- `src/modules/threads/threads.repository.ts`
- `src/modules/runs/runs.repository.ts`
- `src/modules/crons/crons.repository.ts`
- `src/modules/store/store.repository.ts`

**Interface Contract (exports consumed by other units):**

```typescript
// src/repositories/interfaces.ts
export interface IRepository<T> { ... }
export interface SearchOptions { ... }
export interface SearchResult<T> { ... }

// Each domain repository exports a class:
export class AssistantsRepository extends InMemoryRepository<Assistant> {
  findByGraphId(graphId: string): Promise<Assistant[]>;
  findByName(name: string): Promise<Assistant[]>;
  saveVersion(version: AssistantVersion): Promise<void>;
  getVersions(assistantId: string): Promise<AssistantVersion[]>;
  getVersion(assistantId: string, versionNum: number): Promise<AssistantVersion | null>;
  deleteVersions(assistantId: string): Promise<void>;
}

export class ThreadsRepository extends InMemoryRepository<Thread> {
  findByStatus(status: string): Promise<Thread[]>;
  saveState(threadId: string, state: ThreadState): Promise<void>;
  getLatestState(threadId: string): Promise<ThreadState | null>;
  getStateHistory(threadId: string): Promise<ThreadState[]>;
  deleteStates(threadId: string): Promise<void>;
  cloneStates(fromId: string, toId: string): Promise<void>;
}

export class RunsRepository extends InMemoryRepository<Run> {
  findByThreadId(threadId: string): Promise<Run[]>;
  findByStatus(status: string): Promise<Run[]>;
  findByThreadIdAndStatus(threadId: string, status: string): Promise<Run[]>;
  deleteByThreadId(threadId: string): Promise<number>;
}

export class CronsRepository extends InMemoryRepository<Cron> {
  findByAssistantId(assistantId: string): Promise<Cron[]>;
  findByThreadId(threadId: string): Promise<Cron[]>;
  findEnabled(): Promise<Cron[]>;
}

export class StoreRepository {
  put(item: Item): Promise<Item>;
  get(namespace: string[], key: string): Promise<Item | null>;
  delete(namespace: string[], key: string): Promise<boolean>;
  searchByPrefix(...): Promise<{ items: SearchItem[]; total: number }>;
  listNamespaces(...): Promise<string[][]>;
  clear(): Promise<void>;
}
```

**Dependencies on other units:** Unit B (type definitions).

**Estimated effort:** 4 hours.

### 10.5 Unit D: Middleware Stack

**Scope:** All Fastify plugins (auth, CORS, swagger, error handler), ApiError class, utilities.

**Files:**
- `src/plugins/auth.plugin.ts`
- `src/plugins/cors.plugin.ts`
- `src/plugins/swagger.plugin.ts`
- `src/plugins/error-handler.plugin.ts`
- `src/errors/api-error.ts`
- `src/errors/error-codes.ts`
- `src/utils/uuid.util.ts`
- `src/utils/date.util.ts`
- `src/utils/pagination.util.ts`

**Interface Contract (exports consumed by other units):**

```typescript
// src/errors/api-error.ts
export class ApiError extends Error {
  statusCode: number;
  detail: string;
  static notFound(resource: string): ApiError;
  static conflict(detail: string): ApiError;
  static validationError(detail: string): ApiError;
}

// src/utils/uuid.util.ts
export function generateUUID(): string;

// src/utils/date.util.ts
export function nowISO(): string;

// src/utils/pagination.util.ts
export function setPaginationHeaders(
  reply: FastifyReply, total: number, offset: number, limit: number
): void;

// Fastify declaration augmentation
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
```

**Dependencies on other units:** Unit A (Fastify instance), Unit B (ErrorResponseSchema).

**Estimated effort:** 4 hours.

### 10.6 Unit E: Assistants + Threads Routes

**Scope:** All 11 Assistants endpoints + all 12 Threads endpoints with services.

**Files:**
- `src/modules/assistants/assistants.routes.ts`
- `src/modules/assistants/assistants.service.ts`
- `src/modules/threads/threads.routes.ts`
- `src/modules/threads/threads.service.ts`

**Can be split between two developers:**
- Developer 1: Assistants (11 endpoints)
- Developer 2: Threads (12 endpoints)

**Interface Contract (Threads service is consumed by Runs unit):**

```typescript
// Threads service must be accessible by Runs service
// Use singleton pattern or dependency injection via Fastify decorations

export class ThreadsService implements IThreadsService {
  // All methods from IThreadsService interface (Section 5.2)
  // Critical for Runs: setStatus(threadId, status) must be callable
}
```

**Dependencies on other units:** Unit B, Unit C, Unit D.

**Estimated effort:** 14 hours (6 Assistants + 8 Threads).

### 10.7 Unit F: Runs Routes + SSE Streaming

**Scope:** All 14 Runs endpoints, SSE streaming infrastructure, StreamManager.

**Files:**
- `src/modules/runs/runs.routes.ts`
- `src/modules/runs/runs.service.ts`
- `src/modules/runs/runs.streaming.ts`
- `src/streaming/stream-manager.ts`

**Dependencies on other units:** Unit B, Unit C, Unit D, and **Unit E (ThreadsService)** -- runs must transition thread status.

**Interface Contract (consumed by Crons if needed):**

```typescript
export class RunsService implements IRunsService {
  // All methods from IRunsService interface (Section 5.2)
}

export class RunStreamEmitter {
  streamRun(
    reply: FastifyReply,
    run: Run,
    streamModes: StreamMode[],
    lastEventId?: string
  ): Promise<void>;
}

export class StreamManager {
  createSession(runId: string, threadId: string | null, modes: StreamMode[]): StreamSession;
  getSession(runId: string): StreamSession | null;
  closeSession(runId: string): void;
  getEventsAfter(runId: string, lastEventId: string): StreamEvent[];
}
```

**Estimated effort:** 12 hours.

### 10.8 Unit G: Crons + Store + System Routes

**Scope:** 6 Crons endpoints, 5 Store endpoints, 2 System endpoints.

**Can be split between three developers:**
- Developer 1: Crons (6 endpoints)
- Developer 2: Store (5 endpoints)
- Developer 3: System (2 endpoints)

**Files:**
- `src/modules/crons/crons.routes.ts`
- `src/modules/crons/crons.service.ts`
- `src/modules/store/store.routes.ts`
- `src/modules/store/store.service.ts`
- `src/modules/system/system.routes.ts`

**Dependencies on other units:** Unit B, Unit C, Unit D. Does NOT depend on Unit E or F.

**Estimated effort:** 9 hours (4 Crons + 4 Store + 1 System).

### 10.9 Parallel Execution Timeline

```
Week 1:
  [Unit A: Foundation]-------->|
                                [Unit B: Schemas]------------>|
                                                               [Unit D: Middleware]---->|

Week 2:
                                [Unit C: Repositories]-------->|
                                                                  [Unit E: Assistants]--->|
                                                                  [Unit E: Threads]------>|
                                                                  [Unit G: Crons]-------->|
                                                                  [Unit G: Store]-------->|
                                                                  [Unit G: System]->|

Week 3:
                                                                  [Unit F: Runs + SSE]---------->|

Week 4:
  [Integration Testing with LangGraph SDKs]-------------------------------------------->|
```

### 10.10 Inter-Unit Interface Contracts Summary

| Producing Unit | Consuming Unit | Interface |
|---------------|---------------|-----------|
| A | B, D | `AppConfig`, `buildApp()` |
| B | C, D, E, F, G | All TypeBox schemas + Static types |
| C | E, F, G | Repository classes with CRUD + domain methods |
| D | E, F, G | `ApiError`, `generateUUID()`, `nowISO()`, `setPaginationHeaders()`, `fastify.authenticate` |
| E (Threads) | F (Runs) | `ThreadsService.setStatus()`, `ThreadsService.get()` |
| F (StreamManager) | F (Runs routes) | `StreamManager`, `RunStreamEmitter` |

---

## Appendix A: Utility Functions

### uuid.util.ts

```typescript
import { v4 as uuidv4 } from 'uuid';

export function generateUUID(): string {
  return uuidv4();
}
```

### date.util.ts

```typescript
export function nowISO(): string {
  return new Date().toISOString();
}
```

### error-codes.ts

```typescript
export enum ErrorCode {
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNAUTHORIZED = 'UNAUTHORIZED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}
```

---

## Appendix B: Server Entry Points

### index.ts

```typescript
import { startServer } from './server';

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
```

### server.ts

```typescript
import { buildApp } from './app';
import { loadConfig } from './config/env.config';

export async function startServer(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp();

  await app.listen({
    port: config.LG_API_PORT,
    host: config.LG_API_HOST,
  });

  console.log(
    `LG-API server listening on ${config.LG_API_HOST}:${config.LG_API_PORT}`
  );
}
```

---

## Appendix C: Singleton Repository Pattern

Services and repositories use singletons to ensure shared state across routes within a single process.

```typescript
// Example: assistants.service.ts
import { AssistantsRepository } from './assistants.repository';

let _repository: AssistantsRepository | null = null;

function getRepository(): AssistantsRepository {
  if (!_repository) {
    _repository = new AssistantsRepository();
  }
  return _repository;
}

export class AssistantsService {
  private repository: AssistantsRepository;

  constructor() {
    this.repository = getRepository();
  }

  // ... methods
}
```

Alternatively, use Fastify's `decorate` to register repository singletons:

```typescript
// In app.ts or a dedicated plugin
fastify.decorate('assistantsRepo', new AssistantsRepository());
fastify.decorate('threadsRepo', new ThreadsRepository());
fastify.decorate('runsRepo', new RunsRepository());
fastify.decorate('cronsRepo', new CronsRepository());
fastify.decorate('storeRepo', new StoreRepository());
```

---

---

## 11. Custom Agent Integration Architecture

### 11.1 Overview

Custom agents are integrated as isolated CLI tools that communicate via stdin/stdout JSON. This decouples agent implementations from the API server, allowing agents to be written in any language.

```
+-------------------------------------------------------------------+
|                          lg-api Server                             |
|                                                                    |
|  Run Request                                                       |
|      |                                                             |
|      v                                                             |
|  RequestComposer                                                   |
|  - Extracts messages from thread state (history)                   |
|  - Extracts new message from run input                             |
|  - Extracts documents from run input                               |
|  - Produces AgentRequest JSON                                      |
|      |                                                             |
|      v                                                             |
|  CliAgentConnector                                                 |
|  - Looks up agent command from AgentRegistry (by graph_id)         |
|  - Spawns child_process with agent command                         |
|  - Writes AgentRequest JSON to stdin                               |
|  - Reads AgentResponse JSON from stdout                            |
|  - Handles timeouts, errors, stderr                                |
|      |                                                             |
+------+------------------------------------------------------------+
       |                          ^
       v (stdin)                  | (stdout)
+------+--------------------------+----------------------------------+
|                     CLI Agent Process                               |
|  (any language: TypeScript, Python, Go, etc.)                      |
|                                                                    |
|  Reads AgentRequest JSON from stdin                                |
|  Processes request (calls LLM, runs tools, etc.)                   |
|  Writes AgentResponse JSON to stdout                               |
|  Errors to stderr (never stdout)                                   |
+-------------------------------------------------------------------+
```

### 11.2 Agent Protocol (stdin/stdout JSON)

**AgentRequest** (stdin):
```typescript
{
  thread_id: string;        // conversation thread ID
  run_id: string;           // execution run ID
  assistant_id: string;     // assistant/agent configuration ID
  messages: AgentMessage[];  // conversation history + new message
  documents?: AgentDocument[];  // attached documents
  state?: Record<string, unknown>;  // arbitrary state exchanged between lg-api and agent
  metadata?: Record<string, unknown>;
}
```

**AgentResponse** (stdout):
```typescript
{
  thread_id: string;
  run_id: string;
  messages: AgentMessage[];  // agent response messages
  state?: Record<string, unknown>;  // agent can return modified state
  metadata?: Record<string, unknown>;
}
```

**State object ownership**: The `state` field is owned exclusively by the agent. The lg-api **never modifies** the state object - it only passes it through untouched. On input, the lg-api sends the state as-is from the previous agent response (stored in thread state) or from an explicit `input.state` override. On output, the agent returns its updated state which the lg-api stores without modification. This ensures the agent has full control over its working memory (counters, preferences, context, etc.).

### 11.3 Agent Registry (`agent-registry.yaml`)

Maps assistant `graph_id` values to CLI agent configurations:

```yaml
agents:
  passthrough:
    command: npx
    args: ["tsx", "agents/passthrough/src/index.ts"]
    cwd: "."
    description: "Pass-through test agent"
    timeout: 60000
```

### 11.4 Pass-through Test Agent (`agents/passthrough/`)

Isolated TypeScript project using LangChain to forward requests to configurable LLMs.

**File Structure:**
```
agents/passthrough/
  package.json          - Separate dependencies (LangChain providers)
  tsconfig.json         - Isolated TypeScript config
  llm-config.yaml       - LLM provider config with named profiles
  src/
    index.ts            - CLI entry point (stdin -> agent -> stdout)
    config.ts           - YAML config loader with ${ENV_VAR} substitution
    llm-factory.ts      - Creates LangChain chat model from config
    agent.ts            - Core logic: converts messages, calls LLM
    types.ts            - AgentRequest/Response type definitions
```

**Supported Providers:** Azure OpenAI, OpenAI, Anthropic, Google Gemini

### 11.5 Adding a New Agent

1. Create a CLI tool that reads `AgentRequest` JSON from stdin and writes `AgentResponse` JSON to stdout
2. Add an entry to `agent-registry.yaml` with its `graph_id` and command
3. Create an assistant via `POST /assistants` with that `graph_id`
4. Create a thread and run -- the connector will invoke the agent

---

## Revision History

| Date | Version | Description |
|------|---------|-------------|
| 2026-03-10 | 1.2 | Added Section 11: Custom Agent Integration Architecture |
| 2026-03-08 | 1.0 | Initial technical design created |
