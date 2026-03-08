# Implementation Plan: LangGraph Server API Drop-in Replacement

**Plan ID:** plan-001
**Date:** 2026-03-08
**Status:** Draft
**Project:** lg-api

---

## Overview

This plan details the phased implementation of a TypeScript-based REST API server that replicates the LangGraph Platform (Agent Server) API interface as a drop-in replacement. The server will expose 45+ endpoints across 6 endpoint groups with dummy/stub backend logic, prioritizing API surface accuracy and SDK compatibility.

### Tech Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Runtime | Node.js | v18+ |
| Language | TypeScript | strict mode |
| HTTP Framework | Fastify | v5.x |
| Schema/Validation | TypeBox + @fastify/type-provider-typebox | latest |
| SSE Streaming | better-sse | latest |
| OpenAPI Docs | @fastify/swagger + @fastify/swagger-ui | latest |
| CORS | @fastify/cors | latest |
| Data Layer | In-memory Map-based repositories | N/A |
| Package Manager | npm | latest |
| Test Runner | vitest | latest |

---

## Phase Dependency Graph

```
Phase 1 (Foundation)
  |
  v
Phase 2 (Type Definitions)
  |
  +---> Phase 3 (In-Memory Repositories)
  |       |
  |       +---> Phase 4 (Core Middleware)
  |               |
  |               +---> Phase 5 (Assistants API)
  |               |       |
  |               +---> Phase 6 (Threads API)    [can parallel with Phase 5]
  |               |       |
  |               |       v
  |               +---> Phase 7 (Runs API)       [depends on Threads]
  |               |       |
  |               +---> Phase 8 (Crons API)      [can parallel with Phase 7]
  |               |
  |               +---> Phase 9 (Store API)      [can parallel with Phase 7/8]
  |               |
  |               +---> Phase 10 (System)        [can parallel with any after Phase 4]
  |
  v
Phase 11 (Integration Testing with LangGraph SDK) [depends on all above]
```

### Parallelization Opportunities

- **Phase 5 + Phase 6**: Assistants and Threads APIs are independent; can be built simultaneously.
- **Phase 8 + Phase 9 + Phase 10**: Crons, Store, and System endpoints have no inter-dependencies and can be built in parallel after Phase 4 is complete.
- **Phase 7** depends on Phase 6 (Threads) because runs are created on threads.

---

## Phase 1: Project Foundation

### Objective
Set up the project skeleton: package.json, tsconfig, configuration loader, Fastify server bootstrap, and build pipeline.

### Files to Create

| File | Description |
|------|-------------|
| `package.json` | Project metadata, scripts, dependencies |
| `tsconfig.json` | TypeScript strict mode configuration |
| `.env.example` | Example environment variables |
| `src/server.ts` | Server entry point -- loads config, creates app, starts listening |
| `src/app.ts` | Fastify app factory -- registers plugins, routes, error handlers |
| `src/config/env.config.ts` | Environment variable loader; throws on missing required vars (NO fallbacks) |

### Dependencies to Install

**Production:**
- `fastify` (v5.x)
- `@fastify/cors`
- `@fastify/swagger`
- `@fastify/swagger-ui`
- `@fastify/type-provider-typebox`
- `@sinclair/typebox`
- `better-sse`
- `fastify-plugin`
- `uuid`

**Development:**
- `typescript`
- `@types/node`
- `@types/uuid`
- `vitest`
- `tsx` (for development runner)
- `rimraf` (for clean builds)

### Configuration Variables

All required at startup -- no fallback/default values allowed:

| Variable | Type | Description |
|----------|------|-------------|
| `LG_API_PORT` | number | Server port (1-65535) |
| `LG_API_HOST` | string | Server bind address (e.g., `0.0.0.0`) |
| `LG_API_AUTH_ENABLED` | boolean | Enable/disable X-Api-Key authentication |
| `LG_API_KEY` | string | Expected API key (required when auth enabled) |
| `NODE_ENV` | enum | `development`, `production`, or `test` |

### Acceptance Criteria

1. `npm run build` compiles TypeScript without errors.
2. `npm run dev` starts the Fastify server and binds to the configured host/port.
3. Server refuses to start if `LG_API_PORT` or `LG_API_HOST` is missing, throwing a descriptive error.
4. Server refuses to start if `LG_API_AUTH_ENABLED=true` but `LG_API_KEY` is not set.
5. `GET /docs` returns Swagger UI (empty spec at this stage).

### Verification Commands

```bash
# Build
npm run build

# Start with missing config (should fail with descriptive error)
NODE_ENV=development npx tsx src/server.ts

# Start with valid config
LG_API_PORT=8124 LG_API_HOST=0.0.0.0 LG_API_AUTH_ENABLED=false NODE_ENV=development npx tsx src/server.ts

# Verify Swagger UI
curl -s http://localhost:8124/docs | head -20
```

### Dependencies on Other Phases
None -- this is the foundation.

---

## Phase 2: Type Definitions (TypeBox Schemas)

### Objective
Define all LangGraph data models as TypeBox schemas. These schemas drive request validation, response serialization, OpenAPI generation, and TypeScript type inference simultaneously.

### Files to Create

| File | Description |
|------|-------------|
| `src/schemas/common.schema.ts` | Shared schemas: `ConfigSchema`, `MetadataSchema`, `CheckpointSchema`, `PaginationQuerySchema`, `ErrorResponseSchema`, `InterruptSchema`, `CommandSchema` |
| `src/schemas/assistant.schema.ts` | `AssistantSchema`, `AssistantVersionSchema`, `CreateAssistantRequestSchema`, `UpdateAssistantRequestSchema`, `SearchAssistantsRequestSchema`, `CountAssistantsRequestSchema`, `GraphSchemaResponse`, `SchemasResponse`, `SetLatestVersionRequestSchema` |
| `src/schemas/thread.schema.ts` | `ThreadSchema`, `ThreadStateSchema`, `ThreadTaskSchema`, `CreateThreadRequestSchema`, `UpdateThreadRequestSchema`, `SearchThreadsRequestSchema`, `CountThreadsRequestSchema`, `UpdateThreadStateRequestSchema`, `ThreadHistoryRequestSchema`, `CopyThreadRequestSchema`, `PruneThreadsRequestSchema` |
| `src/schemas/run.schema.ts` | `RunSchema`, `RunCreateRequestSchema`, `RunStreamRequestSchema`, `RunWaitRequestSchema`, `RunBatchRequestSchema`, `CancelRunRequestSchema`, `CancelRunsRequestSchema`, `ListRunsQuerySchema`, `StreamPartSchema` |
| `src/schemas/cron.schema.ts` | `CronSchema`, `CreateCronRequestSchema`, `UpdateCronRequestSchema`, `SearchCronsRequestSchema`, `CountCronsRequestSchema` |
| `src/schemas/store.schema.ts` | `ItemSchema`, `SearchItemSchema`, `PutItemRequestSchema`, `GetItemQuerySchema`, `DeleteItemRequestSchema`, `SearchItemsRequestSchema`, `ListNamespacesRequestSchema` |
| `src/schemas/index.ts` | Barrel export for all schemas |
| `src/types/index.ts` | TypeScript type exports derived from schemas via `Static<typeof Schema>` |

### Key Data Model Summary

**Enums to define:**
- `ThreadStatus`: `idle`, `busy`, `interrupted`, `error`
- `RunStatus`: `pending`, `running`, `error`, `success`, `timeout`, `interrupted`
- `MultitaskStrategy`: `reject`, `interrupt`, `rollback`, `enqueue`
- `StreamMode`: `values`, `updates`, `messages`, `messages-tuple`, `events`, `debug`, `custom`, `tasks`, `checkpoints`
- `IfExists`: `raise`, `do_nothing`, `update`
- `OnCompletion`: `delete`, `keep`
- `SortOrder`: `asc`, `desc`

### Acceptance Criteria

1. All schemas compile without TypeScript errors.
2. `Static<typeof AssistantSchema>` produces the correct TypeScript type matching the LangGraph SDK `Assistant` interface.
3. All required fields are non-optional; optional fields use `Type.Optional(...)`.
4. UUID fields use `Type.String({ format: 'uuid' })`.
5. DateTime fields use `Type.String({ format: 'date-time' })`.
6. Enum fields use `Type.Union([Type.Literal(...), ...])`.
7. A unit test validates that schema compilation produces valid JSON Schema.

### Verification Commands

```bash
# Build (validates all type errors)
npm run build

# Run schema unit tests
npm run test -- --filter schemas
```

### Dependencies on Other Phases
- Phase 1 (project foundation must exist)

---

## Phase 3: In-Memory Repositories

### Objective
Implement the repository pattern with an in-memory Map-based storage backend. The repository interface is designed to be swappable with a database-backed implementation in the future.

### Files to Create

| File | Description |
|------|-------------|
| `src/repositories/interfaces.ts` | `IRepository<T>` interface, `SearchOptions<T>`, `SearchResult<T>` types |
| `src/repositories/in-memory.repository.ts` | `InMemoryRepository<T>` implementing `IRepository<T>` with Map storage |
| `src/modules/assistants/assistants.repository.ts` | `AssistantsRepository` extending InMemoryRepository with assistant-specific queries (findByGraphId, searchWithMetadata, version management) |
| `src/modules/threads/threads.repository.ts` | `ThreadsRepository` with thread-specific queries (findByStatus, state management) |
| `src/modules/runs/runs.repository.ts` | `RunsRepository` with run-specific queries (findByThreadId, findByStatus) |
| `src/modules/crons/crons.repository.ts` | `CronsRepository` with cron-specific queries (findByAssistantId, findByThreadId) |
| `src/modules/store/store.repository.ts` | `StoreRepository` with namespace-aware key-value operations (getByNamespaceAndKey, searchByPrefix, listNamespaces) |

### IRepository Interface

```typescript
interface IRepository<T> {
  findById(id: string): Promise<T | null>;
  findMany(filter: (item: T) => boolean): Promise<T[]>;
  save(item: T): Promise<T>;
  update(id: string, updates: Partial<T>): Promise<T | null>;
  delete(id: string): Promise<boolean>;
  count(filter?: (item: T) => boolean): Promise<number>;
  search(options: SearchOptions<T>): Promise<SearchResult<T>>;
}
```

### Acceptance Criteria

1. `InMemoryRepository` passes CRUD unit tests (create, read, update, delete).
2. `search()` correctly applies filter, sort, offset, and limit.
3. `count()` correctly counts with and without filters.
4. Each domain repository has its entity-specific query methods.
5. `StoreRepository` supports composite key lookups (namespace + key).
6. All repositories are stateless singletons (shared across requests within a single server process).

### Verification Commands

```bash
npm run test -- --filter repositories
```

### Dependencies on Other Phases
- Phase 2 (type definitions must exist for repository generics)

---

## Phase 4: Core Middleware and Plugins

### Objective
Implement cross-cutting concerns: authentication, error handling, CORS, pagination header injection, and OpenAPI documentation.

### Files to Create

| File | Description |
|------|-------------|
| `src/plugins/auth.plugin.ts` | Fastify plugin that decorates `fastify.authenticate` as a preHandler; validates `X-Api-Key` header against `LG_API_KEY` config; returns 401 on failure |
| `src/plugins/cors.plugin.ts` | Fastify plugin wrapping `@fastify/cors` with permissive CORS for development |
| `src/plugins/swagger.plugin.ts` | Fastify plugin configuring `@fastify/swagger` (OpenAPI 3.1) and `@fastify/swagger-ui` at `/docs`; defines security scheme for `X-Api-Key` |
| `src/plugins/error-handler.plugin.ts` | Global error handler returning `{ detail: string }` JSON with appropriate HTTP status codes (400, 401, 404, 409, 422, 500) |
| `src/errors/api-error.ts` | Custom `ApiError` class with `statusCode`, `detail`, and optional `message` fields |
| `src/errors/error-codes.ts` | Enum of error codes used across the application |
| `src/utils/uuid.util.ts` | UUID v4 generation utility |
| `src/utils/date.util.ts` | ISO 8601 date-time utility |
| `src/utils/pagination.util.ts` | Helper to set `X-Pagination-Total`, `X-Pagination-Offset`, `X-Pagination-Limit` response headers |

### Auth Plugin Behavior

- When `LG_API_AUTH_ENABLED=true`: all API routes (except `/ok`, `/docs`) require `X-Api-Key` header matching `LG_API_KEY`.
- When `LG_API_AUTH_ENABLED=false`: no authentication check is performed.
- Missing header returns `401 { detail: "Missing X-Api-Key header" }`.
- Invalid key returns `401 { detail: "Invalid API key" }`.

### Error Handler Behavior

- Fastify validation errors (Ajv) are caught and returned as `422 { detail: "Validation error: ..." }`.
- `ApiError` instances are returned with their own `statusCode` and `detail`.
- Unhandled errors return `500 { detail: "Internal server error" }`.

### Acceptance Criteria

1. Requests to protected routes without `X-Api-Key` return 401 when auth is enabled.
2. Requests with wrong `X-Api-Key` return 401.
3. Requests with correct `X-Api-Key` pass through to handler.
4. Invalid request bodies return 422 with descriptive validation errors.
5. `ApiError(404, "Not found")` thrown in a handler returns `{ "detail": "Not found" }` with status 404.
6. CORS headers are present on responses.
7. Swagger UI loads at `/docs` and displays security scheme.
8. Pagination helper correctly sets all three `X-Pagination-*` headers.

### Verification Commands

```bash
# Unit tests for middleware
npm run test -- --filter plugins

# Manual auth test
curl -s -o /dev/null -w "%{http_code}" http://localhost:8124/assistants/search -X POST -H "Content-Type: application/json" -d '{}'
# Should return 401 when auth enabled, or proceed when disabled

# CORS test
curl -s -D - -o /dev/null http://localhost:8124/ok -H "Origin: http://example.com" | grep -i access-control
```

### Dependencies on Other Phases
- Phase 1 (app.ts must exist to register plugins)
- Phase 2 (ErrorResponseSchema needed for error handler)

---

## Phase 5: Assistants API Routes

### Objective
Implement all 11 Assistants endpoints with full request validation, stub responses, and in-memory persistence.

### Files to Create

| File | Description |
|------|-------------|
| `src/modules/assistants/assistants.routes.ts` | Route registration with TypeBox schemas for all 11 endpoints |
| `src/modules/assistants/assistants.service.ts` | Business logic: create, get, update, delete, search, count, graph, schemas, subgraphs, versions, set-latest |
| `test_scripts/assistants.test.ts` | Unit/integration tests for all assistants endpoints |

### Endpoints

| # | Method | Path | Status Codes |
|---|--------|------|-------------|
| 1 | POST | `/assistants` | 200, 409, 422 |
| 2 | GET | `/assistants/:assistant_id` | 200, 404 |
| 3 | PATCH | `/assistants/:assistant_id` | 200, 404, 422 |
| 4 | DELETE | `/assistants/:assistant_id` | 204, 404 |
| 5 | POST | `/assistants/search` | 200 |
| 6 | POST | `/assistants/count` | 200 |
| 7 | GET | `/assistants/:assistant_id/graph` | 200, 404 |
| 8 | GET | `/assistants/:assistant_id/schemas` | 200, 404 |
| 9 | GET | `/assistants/:assistant_id/subgraphs` | 200, 404 |
| 10 | POST | `/assistants/:assistant_id/versions` | 200, 404 |
| 11 | POST | `/assistants/:assistant_id/latest` | 200, 404 |

### Stub Behavior Details

- **Create**: Generates UUID, stores in memory. Supports `if_exists` behavior (`raise` returns 409 if exists, `do_nothing` returns existing, `update` updates existing).
- **Update**: Increments `version`, updates `updated_at` timestamp.
- **Graph**: Returns a static graph definition JSON with nodes and edges.
- **Schemas**: Returns static JSON schemas for input/output/state/config.
- **Subgraphs**: Returns empty array (no real subgraphs in stub).
- **Versions**: Returns list of all stored versions for the assistant.
- **Set Latest**: Updates the assistant to point to the specified version number.
- **Search/Count**: Support `metadata` filter (shallow key match), `graph_id`, `name`, `limit`, `offset`, `sort_by`, `sort_order`. Search returns pagination headers.

### Acceptance Criteria

1. All 11 endpoints are registered and respond with correct HTTP status codes.
2. `POST /assistants` with valid body returns a well-formed `Assistant` object with UUID and timestamps.
3. `POST /assistants` with `if_exists: "raise"` and an existing `assistant_id` returns 409.
4. `GET /assistants/:id` for a non-existent ID returns 404.
5. `PATCH /assistants/:id` increments the version number.
6. `DELETE /assistants/:id` returns 204 and the assistant is no longer retrievable.
7. `POST /assistants/search` returns an array with `X-Pagination-*` headers.
8. Invalid request bodies return 422.
9. All endpoints appear in Swagger UI under the "Assistants" tag.

### Verification Commands

```bash
npm run test -- --filter assistants

# Manual smoke tests
curl -s http://localhost:8124/assistants -X POST -H "Content-Type: application/json" -d '{"graph_id": "agent"}' | jq .
curl -s http://localhost:8124/assistants/search -X POST -H "Content-Type: application/json" -d '{"limit": 10}' | jq .
```

### Dependencies on Other Phases
- Phase 2 (schemas)
- Phase 3 (AssistantsRepository)
- Phase 4 (auth, error handling, pagination)

---

## Phase 6: Threads API Routes

### Objective
Implement all 12 Threads endpoints with full request validation, stub responses, and in-memory persistence including thread state management.

### Files to Create

| File | Description |
|------|-------------|
| `src/modules/threads/threads.routes.ts` | Route registration for all 12 endpoints |
| `src/modules/threads/threads.service.ts` | Business logic including state/history management |
| `test_scripts/threads.test.ts` | Tests for all threads endpoints |

### Endpoints

| # | Method | Path | Status Codes |
|---|--------|------|-------------|
| 1 | POST | `/threads` | 200, 409, 422 |
| 2 | GET | `/threads/:thread_id` | 200, 404 |
| 3 | PATCH | `/threads/:thread_id` | 200, 404, 422 |
| 4 | DELETE | `/threads/:thread_id` | 204, 404 |
| 5 | POST | `/threads/search` | 200 |
| 6 | POST | `/threads/count` | 200 |
| 7 | POST | `/threads/:thread_id/copy` | 200, 404 |
| 8 | POST | `/threads/prune` | 200 |
| 9 | GET | `/threads/:thread_id/state` | 200, 404 |
| 10 | POST | `/threads/:thread_id/state` | 200, 404 |
| 11 | POST | `/threads/:thread_id/history` | 200, 404 |
| 12 | GET | `/threads/:thread_id/stream` | 200 (SSE), 404 |

### Stub Behavior Details

- **Create**: Generates UUID, initial status `idle`, empty values/interrupts. Supports `if_exists` semantics.
- **State (GET)**: Returns a stub `ThreadState` with `values: {}`, `next: []`, empty `tasks`, a generated checkpoint.
- **State (POST)**: Accepts `values` and `as_node`, stores them as the latest state, generates a new checkpoint.
- **History**: Returns an array of state snapshots (initially just the current state).
- **Copy**: Duplicates the thread with a new UUID, preserving metadata and state.
- **Prune**: Accepts `thread_ids` array, deletes matching threads, returns count.
- **Stream (GET)**: SSE endpoint for joining an active thread's stream. For stubs, immediately sends `end` event.

### Acceptance Criteria

1. All 12 endpoints are registered and respond with correct status codes.
2. Thread status is `idle` on creation.
3. `GET /threads/:id/state` returns a valid `ThreadState` with checkpoint.
4. `POST /threads/:id/state` updates values and creates a new checkpoint.
5. `POST /threads/:id/history` returns an array of previous states.
6. `POST /threads/:id/copy` returns a new thread with a different `thread_id` but same metadata.
7. `GET /threads/:id/stream` returns SSE with `text/event-stream` content type.
8. Search supports filtering by `status`, `metadata`, and returns pagination headers.

### Verification Commands

```bash
npm run test -- --filter threads

# Manual smoke tests
curl -s http://localhost:8124/threads -X POST -H "Content-Type: application/json" -d '{}' | jq .
curl -s http://localhost:8124/threads/search -X POST -H "Content-Type: application/json" -d '{"status": "idle"}' | jq .
```

### Dependencies on Other Phases
- Phase 2 (schemas)
- Phase 3 (ThreadsRepository)
- Phase 4 (auth, error handling, pagination)

---

## Phase 7: Runs API Routes (Including SSE Streaming)

### Objective
Implement all 14 Runs endpoints including SSE streaming. This is the most complex phase due to streaming requirements.

### Files to Create

| File | Description |
|------|-------------|
| `src/modules/runs/runs.routes.ts` | Route registration for all 14 endpoints |
| `src/modules/runs/runs.service.ts` | Business logic: create, list, cancel, join, delete |
| `src/modules/runs/runs.streaming.ts` | SSE streaming logic using `better-sse`: session creation, event emission for all stream modes, reconnection handling |
| `test_scripts/runs.test.ts` | Tests for all runs endpoints |
| `test_scripts/runs-streaming.test.ts` | Dedicated streaming tests |

### Endpoints

| # | Method | Path | Status Codes | Notes |
|---|--------|------|-------------|-------|
| 1 | POST | `/threads/:thread_id/runs` | 200, 404, 422 | Stateful run |
| 2 | POST | `/runs` | 200, 422 | Stateless run |
| 3 | POST | `/threads/:thread_id/runs/stream` | 200 (SSE), 404, 422 | Stateful stream |
| 4 | POST | `/runs/stream` | 200 (SSE), 422 | Stateless stream |
| 5 | POST | `/threads/:thread_id/runs/wait` | 200, 404, 422 | Stateful wait |
| 6 | POST | `/runs/wait` | 200, 422 | Stateless wait |
| 7 | POST | `/runs/batch` | 200, 422 | Batch create |
| 8 | GET | `/threads/:thread_id/runs` | 200, 404 | List runs |
| 9 | GET | `/threads/:thread_id/runs/:run_id` | 200, 404 | Get run |
| 10 | POST | `/threads/:thread_id/runs/:run_id/cancel` | 200, 404 | Cancel run |
| 11 | POST | `/runs/cancel` | 200 | Bulk cancel |
| 12 | GET | `/threads/:thread_id/runs/:run_id/join` | 200, 404 | Join run |
| 13 | GET | `/threads/:thread_id/runs/:run_id/stream` | 200 (SSE), 404 | Join stream |
| 14 | DELETE | `/threads/:thread_id/runs/:run_id` | 204, 404 | Delete run |

### SSE Streaming Implementation

The streaming module (`runs.streaming.ts`) must:

1. **Create SSE session** using `better-sse`'s `createSession()`.
2. **Emit metadata event** first: `event: metadata\ndata: {"run_id": "...", "thread_id": "..."}\nid: 1\n\n`
3. **Emit mode-specific events** for each requested `stream_mode`:
   - `values`: Complete stub state after each simulated step
   - `updates`: Delta updates from each simulated step
   - `messages`: Message objects (role + content)
   - `messages-tuple`: Messages as `[type, content]` tuples
   - `events`: Simulated execution events
   - `debug`: Debug trace information
   - `custom`: Custom event payload
   - `tasks`: Task-level execution events
   - `checkpoints`: Checkpoint snapshots
4. **Emit `end` event**: `event: end\ndata: null\nid: N\n\n`
5. **Handle errors** by emitting `event: error\ndata: {"message": "..."}\nid: N\n\n`
6. **Support `Last-Event-ID`** for reconnection (replay from buffered events).
7. **Support multiple concurrent stream modes** in a single request.

### Stub Run Lifecycle

When a run is created (via create, stream, or wait):
1. Run is stored with status `pending`.
2. Status transitions to `running` (immediate for stubs).
3. Status transitions to `success` (after a brief simulated delay for `/wait`).
4. Thread status transitions: `idle` -> `busy` -> `idle`.

### Run Creation Shared Parameters

All run creation endpoints accept: `input`, `command`, `stream_mode`, `stream_subgraphs`, `stream_resumable`, `metadata`, `config`, `context`, `checkpoint`, `checkpoint_id`, `checkpoint_during`, `interrupt_before`, `interrupt_after`, `feedback_keys`, `webhook`, `multitask_strategy`, `if_not_exists`, `on_disconnect`, `on_completion`, `after_seconds`, `durability`.

### Acceptance Criteria

1. All 14 endpoints are registered and respond with correct status codes.
2. `POST /threads/:id/runs` creates a run and returns a valid `Run` object with status `success`.
3. `POST /threads/:id/runs/stream` returns SSE with `text/event-stream` content type.
4. SSE stream includes `metadata` event, at least one mode-specific event, and `end` event.
5. `POST /threads/:id/runs/wait` returns the run result synchronously (simulated delay optional).
6. `POST /runs/batch` accepts an array of run payloads and returns an array of results.
7. `GET /threads/:id/runs` lists runs with pagination.
8. `POST /threads/:id/runs/:id/cancel` changes run status to `interrupted`.
9. `DELETE /threads/:id/runs/:id` returns 204.
10. Stream events are parseable by the LangGraph SDK's SSE decoder.

### Verification Commands

```bash
npm run test -- --filter runs

# Manual SSE test
curl -N -H "Accept: text/event-stream" http://localhost:8124/threads/THREAD_ID/runs/stream -X POST -H "Content-Type: application/json" -d '{"assistant_id": "ASSISTANT_ID", "stream_mode": ["values"]}'
```

### Dependencies on Other Phases
- Phase 2 (schemas)
- Phase 3 (RunsRepository)
- Phase 4 (auth, error handling)
- Phase 6 (Threads -- runs reference threads)

---

## Phase 8: Crons API Routes

### Objective
Implement all 6 Crons endpoints. Cron jobs are accepted and stored but not actually scheduled.

### Files to Create

| File | Description |
|------|-------------|
| `src/modules/crons/crons.routes.ts` | Route registration for all 6 endpoints |
| `src/modules/crons/crons.service.ts` | Business logic: create, update, delete, search, count |
| `test_scripts/crons.test.ts` | Tests for all crons endpoints |

### Endpoints

| # | Method | Path | Status Codes |
|---|--------|------|-------------|
| 1 | POST | `/threads/:thread_id/runs/crons` | 200, 404, 422 |
| 2 | POST | `/runs/crons` | 200, 422 |
| 3 | DELETE | `/runs/crons/:cron_id` | 204, 404 |
| 4 | PATCH | `/runs/crons/:cron_id` | 200, 404, 422 |
| 5 | POST | `/runs/crons/search` | 200 |
| 6 | POST | `/runs/crons/count` | 200 |

### Stub Behavior

- **Create**: Stores cron config with a generated `cron_id`, `next_run_date` (calculated from schedule, or a static future date), `enabled: true`.
- **Update**: Modifies schedule, payload, or enabled status.
- **Search/Count**: Filter by `assistant_id`, `thread_id`, `enabled`.
- No actual scheduling or execution occurs.

### Acceptance Criteria

1. All 6 endpoints are registered and respond with correct status codes.
2. Created crons have a valid `cron_id`, `schedule`, `next_run_date`, and `enabled` field.
3. `PATCH` correctly updates fields and `updated_at`.
4. `DELETE` returns 204.
5. Search supports filtering by `assistant_id`, `thread_id`, `enabled`.

### Verification Commands

```bash
npm run test -- --filter crons
```

### Dependencies on Other Phases
- Phase 2 (schemas)
- Phase 3 (CronsRepository)
- Phase 4 (auth, error handling, pagination)

---

## Phase 9: Store API Routes

### Objective
Implement all 5 Store endpoints for a namespace-aware key-value store with in-memory backing.

### Files to Create

| File | Description |
|------|-------------|
| `src/modules/store/store.routes.ts` | Route registration for all 5 endpoints |
| `src/modules/store/store.service.ts` | Business logic: put, get, delete, search, list namespaces |
| `test_scripts/store.test.ts` | Tests for all store endpoints |

### Endpoints

| # | Method | Path | Status Codes |
|---|--------|------|-------------|
| 1 | PUT | `/store/items` | 200, 422 |
| 2 | GET | `/store/items` | 200, 404 |
| 3 | DELETE | `/store/items` | 204, 422 |
| 4 | POST | `/store/items/search` | 200 |
| 5 | POST | `/store/namespaces` | 200 |

### Stub Behavior

- **PUT**: Upserts an item by composite key `(namespace, key)`. `namespace` is an array of strings (e.g., `["users", "123"]`).
- **GET**: Retrieves by `namespace` and `key` query params.
- **DELETE**: Removes by `namespace` and `key` in request body.
- **Search**: Filters by `namespace_prefix` (array prefix match), optional `filter` object (shallow key match on item value), `query` (ignored in stub -- would be semantic search). Returns items with `score: 1.0` (stub).
- **List Namespaces**: Returns distinct namespaces matching `prefix`/`suffix`/`max_depth`.

### Acceptance Criteria

1. All 5 endpoints are registered and respond with correct status codes.
2. `PUT /store/items` creates and updates items correctly.
3. `GET /store/items?namespace=["a","b"]&key=mykey` retrieves the correct item.
4. `DELETE /store/items` removes the item and subsequent GET returns 404.
5. Search returns items with `score` field.
6. Namespace listing respects `prefix`, `suffix`, and `max_depth`.

### Verification Commands

```bash
npm run test -- --filter store
```

### Dependencies on Other Phases
- Phase 2 (schemas)
- Phase 3 (StoreRepository)
- Phase 4 (auth, error handling)

---

## Phase 10: System Endpoints

### Objective
Implement health check (`/ok`) and server info (`/info`) endpoints.

### Files to Create

| File | Description |
|------|-------------|
| `src/modules/system/system.routes.ts` | Route registration for `/ok` and `/info` |
| `test_scripts/system.test.ts` | Tests for system endpoints |

### Endpoints

| # | Method | Path | Status Codes | Auth Required |
|---|--------|------|-------------|---------------|
| 1 | GET | `/ok` | 200 | No |
| 2 | GET | `/info` | 200 | Yes |

### Response Structures

**GET /ok:**
```json
{ "ok": true }
```

**GET /info:**
```json
{
  "version": "1.0.0",
  "name": "lg-api",
  "description": "LangGraph API Replacement",
  "capabilities": {
    "streaming": true,
    "store": true,
    "crons": true,
    "assistants": true,
    "threads": true,
    "runs": true
  }
}
```

### Acceptance Criteria

1. `GET /ok` returns 200 without requiring authentication.
2. `GET /info` returns server metadata with capabilities listing.
3. Both endpoints appear in Swagger UI under "System" tag.

### Verification Commands

```bash
npm run test -- --filter system

curl -s http://localhost:8124/ok | jq .
curl -s http://localhost:8124/info | jq .
```

### Dependencies on Other Phases
- Phase 1 (server must be running)
- Phase 4 (auth plugin -- `/ok` must bypass auth)

---

## Phase 11: Integration Testing with LangGraph SDK

### Objective
Verify that the official LangGraph Python SDK (`langgraph-sdk`) and JavaScript SDK (`@langchain/langgraph-sdk`) can connect to the server and successfully perform all documented operations without modification.

### Files to Create

| File | Description |
|------|-------------|
| `test_scripts/sdk-compat-python.py` | Python integration tests using `langgraph-sdk` |
| `test_scripts/sdk-compat-js.test.ts` | JavaScript integration tests using `@langchain/langgraph-sdk` |
| `test_scripts/sdk-compat-streaming.test.ts` | Dedicated streaming compatibility tests |
| `test_scripts/sdk-compat-run.sh` | Shell script to run all SDK compatibility tests |

### Test Scenarios

**Assistants (Python + JS):**
1. `client.assistants.create(graph_id="agent")` -- returns valid assistant
2. `client.assistants.get(assistant_id)` -- returns the created assistant
3. `client.assistants.search(metadata={}, limit=10)` -- returns array
4. `client.assistants.update(assistant_id, name="Updated")` -- returns updated assistant
5. `client.assistants.delete(assistant_id)` -- succeeds
6. `client.assistants.get_graph(assistant_id)` -- returns graph JSON
7. `client.assistants.get_schemas(assistant_id)` -- returns schemas

**Threads (Python + JS):**
1. `client.threads.create()` -- returns valid thread
2. `client.threads.get(thread_id)` -- returns the thread
3. `client.threads.search(status="idle")` -- returns array
4. `client.threads.get_state(thread_id)` -- returns state with checkpoint
5. `client.threads.update_state(thread_id, values={"key": "value"})` -- succeeds
6. `client.threads.get_history(thread_id)` -- returns history array

**Runs (Python + JS):**
1. `client.runs.create(thread_id, assistant_id, input={})` -- returns run
2. `client.runs.stream(thread_id, assistant_id, stream_mode=["values"])` -- receives SSE events
3. `client.runs.wait(thread_id, assistant_id, input={})` -- returns result
4. `client.runs.list(thread_id)` -- returns array
5. `client.runs.cancel(thread_id, run_id)` -- succeeds

**Crons (Python + JS):**
1. `client.crons.create(assistant_id, schedule="0 * * * *")` -- returns cron
2. `client.crons.search()` -- returns array
3. `client.crons.delete(cron_id)` -- succeeds

**Store (Python + JS):**
1. `client.store.put_item(["ns"], "key", {"data": 1})` -- succeeds
2. `client.store.get_item(["ns"], "key")` -- returns item
3. `client.store.search_items(namespace_prefix=["ns"])` -- returns results
4. `client.store.list_namespaces()` -- returns namespace list
5. `client.store.delete_item(["ns"], "key")` -- succeeds

### Acceptance Criteria

1. All Python SDK test scenarios pass without SDK modification.
2. All JavaScript SDK test scenarios pass without SDK modification.
3. SSE streaming is correctly parsed by both SDK stream decoders.
4. Error responses (404, 422) are correctly interpreted by both SDKs.
5. Pagination headers are correctly interpreted.

### Verification Commands

```bash
# Install Python SDK (using UV per project conventions)
cd /Users/giorgosmarinos/aiwork/agent-platform/lg-api && source .venv/bin/activate && uv add langgraph-sdk

# Run Python SDK tests
source .venv/bin/activate && python test_scripts/sdk-compat-python.py

# Install JS SDK
npm install --save-dev @langchain/langgraph-sdk

# Run JS SDK tests
npm run test -- --filter sdk-compat

# Run all SDK tests
bash test_scripts/sdk-compat-run.sh
```

### Dependencies on Other Phases
- All previous phases (1-10) must be complete.

---

## Project File Structure (Complete)

```
lg-api/
├── docs/
│   ├── design/
│   │   ├── plan-001-langgraph-api-replacement.md    # This plan
│   │   ├── project-design.md                        # Project design document
│   │   └── project-functions.md                     # Functional requirements
│   └── reference/
│       ├── refined-request-langgraph-api-replacement.md
│       └── investigation-langgraph-api-replacement.md
├── src/
│   ├── server.ts
│   ├── app.ts
│   ├── config/
│   │   └── env.config.ts
│   ├── schemas/
│   │   ├── index.ts
│   │   ├── common.schema.ts
│   │   ├── assistant.schema.ts
│   │   ├── thread.schema.ts
│   │   ├── run.schema.ts
│   │   ├── cron.schema.ts
│   │   └── store.schema.ts
│   ├── types/
│   │   └── index.ts
│   ├── plugins/
│   │   ├── auth.plugin.ts
│   │   ├── cors.plugin.ts
│   │   ├── swagger.plugin.ts
│   │   └── error-handler.plugin.ts
│   ├── errors/
│   │   ├── api-error.ts
│   │   └── error-codes.ts
│   ├── repositories/
│   │   └── interfaces.ts
│   │   └── in-memory.repository.ts
│   ├── modules/
│   │   ├── assistants/
│   │   │   ├── assistants.routes.ts
│   │   │   ├── assistants.service.ts
│   │   │   └── assistants.repository.ts
│   │   ├── threads/
│   │   │   ├── threads.routes.ts
│   │   │   ├── threads.service.ts
│   │   │   └── threads.repository.ts
│   │   ├── runs/
│   │   │   ├── runs.routes.ts
│   │   │   ├── runs.service.ts
│   │   │   ├── runs.repository.ts
│   │   │   └── runs.streaming.ts
│   │   ├── crons/
│   │   │   ├── crons.routes.ts
│   │   │   ├── crons.service.ts
│   │   │   └── crons.repository.ts
│   │   ├── store/
│   │   │   ├── store.routes.ts
│   │   │   ├── store.service.ts
│   │   │   └── store.repository.ts
│   │   └── system/
│   │       └── system.routes.ts
│   └── utils/
│       ├── uuid.util.ts
│       ├── date.util.ts
│       └── pagination.util.ts
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
│   ├── sdk-compat-streaming.test.ts
│   └── sdk-compat-run.sh
├── package.json
├── tsconfig.json
├── .env.example
├── vitest.config.ts
├── Issues - Pending Items.md
└── CLAUDE.md
```

**Total files to create: ~45 files**

---

## Risks and Mitigation Strategies

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|-----------|
| R1 | SSE event format mismatch with SDK decoder | MEDIUM | HIGH | Study SDK source code for exact expected format; test with real SDK early in Phase 7; keep streaming module isolated for easy iteration |
| R2 | TypeBox schema limitations for complex LangGraph types (unions, recursive types) | LOW | MEDIUM | TypeBox supports `Type.Union`, `Type.Recursive`, and `Type.Ref`; fall back to `Type.Any()` for deeply nested dynamic objects if needed |
| R3 | better-sse library incompatibility with Fastify v5 | LOW | HIGH | Verify compatibility during Phase 1 setup; have fallback plan to implement raw SSE using Node.js `res.write()` with Fastify's raw response mode |
| R4 | LangGraph SDK version drift -- newer SDK versions add/change endpoints | MEDIUM | MEDIUM | Pin SDK version for testing; document target SDK version; design routes to be easily extensible |
| R5 | Error response format differs from SDK expectations | MEDIUM | MEDIUM | Study SDK error handling code (`langgraph_sdk/client.py` error parsing); test with real SDK in Phase 11 |
| R6 | Checkpoint data structure complexity -- SDK may validate checkpoint contents | MEDIUM | MEDIUM | Start with minimal valid checkpoint structure; iterate based on SDK test failures |
| R7 | Store namespace handling -- array encoding in query params | LOW | LOW | Test with real SDK; arrays may be JSON-encoded or comma-separated in query params |
| R8 | Pagination header format mismatch | LOW | LOW | Verify exact header names by testing with SDK; headers are well-documented |
| R9 | Missing undocumented endpoints or behaviors | MEDIUM | MEDIUM | Monitor SDK network traffic during integration tests; add missing endpoints as discovered |
| R10 | Fastify route ordering conflicts (e.g., `/assistants/search` vs `/assistants/:assistant_id`) | LOW | LOW | Register specific routes before parameterized routes; Fastify handles this well with radix-tree routing |

---

## Estimated Effort

| Phase | Estimated Effort | Can Parallel With |
|-------|-----------------|-------------------|
| Phase 1: Foundation | 4 hours | -- |
| Phase 2: Type Definitions | 6 hours | -- |
| Phase 3: Repositories | 4 hours | -- |
| Phase 4: Middleware | 4 hours | -- |
| Phase 5: Assistants API | 6 hours | Phase 6 |
| Phase 6: Threads API | 8 hours | Phase 5 |
| Phase 7: Runs API | 12 hours | -- |
| Phase 8: Crons API | 4 hours | Phase 7, Phase 9, Phase 10 |
| Phase 9: Store API | 4 hours | Phase 7, Phase 8, Phase 10 |
| Phase 10: System Endpoints | 1 hour | Phase 7, Phase 8, Phase 9 |
| Phase 11: SDK Integration | 8 hours | -- |
| **Total** | **~61 hours** | |

---

## Open Decisions (To Be Resolved Before or During Implementation)

1. **Error response format**: Use `{ detail: string }` as primary format. Adjust during Phase 11 based on SDK error parsing behavior.
2. **Webhook handling**: Accept and store webhook URLs; do not deliver. Log a warning.
3. **Multitask strategy**: Accept the parameter, store it on the run, but do not enforce behavioral semantics in the stub.
4. **Thread status transitions**: Implement `idle` -> `busy` -> `idle` during run creation for realism.
5. **Streaming payload realism**: Start with minimal valid payloads; iterate based on SDK parsing results.
6. **Target SDK versions**: `langgraph-sdk >= 0.3.9` (Python), `@langchain/langgraph-sdk >= 0.0.36` (JavaScript).
7. **`if_exists` enforcement**: Implement `raise`, `do_nothing`, and `update` semantics against in-memory storage.

---

## Revision History

| Date | Version | Description |
|------|---------|-------------|
| 2026-03-08 | 1.0 | Initial plan created |
