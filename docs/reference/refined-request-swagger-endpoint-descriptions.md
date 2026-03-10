# Refined Request: Swagger Endpoint Descriptions Enhancement

## 1. Objective

Enhance the Swagger/OpenAPI documentation for all 50 lg-api endpoints by adding comprehensive, informative descriptions that explain each endpoint's purpose, usage, and role within the LangGraph Platform context. The goal is to make the Swagger UI (`/docs`) a self-contained reference for any developer consuming the API, aligning with the official LangGraph Platform documentation.

## 2. Background and Motivation

The lg-api project is a drop-in replacement for the LangGraph Platform (Agent Server) API. Currently, the route definitions contain minimal or no Swagger metadata:

- **Assistants routes** (11 endpoints): No `tags`, `summary`, or `description` fields at all.
- **Threads routes** (12 endpoints): No `tags`, `summary`, or `description` fields at all.
- **Runs routes** (14 endpoints): No `tags`, `summary`, or `description` fields at all.
- **Crons routes** (6 endpoints): Have `tags` and `summary` but no `description` fields.
- **Store routes** (5 endpoints): Have `tags` and `summary` but no `description` fields.
- **System routes** (2 endpoints): Have `tags` and `summary` but no `description` fields.

This means the Swagger UI currently provides almost no guidance on what each endpoint does, when to use it, or how it fits into the LangGraph agent orchestration lifecycle.

## 3. Scope

### 3.1 What Changes

All 50 route definitions across 6 modules must be updated with:

1. **`tags`** -- Categorize each endpoint into its API group (Assistants, Threads, Runs, Crons, Store, System). Modules that already have tags (Crons, Store, System) should be verified for consistency.

2. **`summary`** -- A concise one-line description (max ~80 characters) of the endpoint's action. Modules that already have summaries should be reviewed and improved if too terse.

3. **`description`** -- A multi-line, detailed explanation that includes:
   - What the endpoint does and what it returns.
   - The LangGraph Platform concept it maps to (e.g., "In the LangGraph Platform, an Assistant is a configured instance of a graph template with specific model parameters, tools, and system prompts...").
   - Typical usage scenarios and when a client would call this endpoint.
   - Relationship to other endpoints (e.g., "A thread must exist before creating a stateful run. Use POST /threads to create one first.").
   - Key behavioral notes (e.g., "This endpoint uses Server-Sent Events (SSE) for real-time streaming. The client should process the event stream using an EventSource-compatible client.").
   - Any pagination, filtering, or query parameter semantics worth highlighting.

### 3.2 What Does NOT Change

- No functional behavior changes. This is a documentation-only update.
- No schema changes. TypeBox schemas remain untouched.
- No new endpoints or removed endpoints.
- No changes to the Swagger plugin configuration (`src/plugins/swagger.plugin.ts`) beyond optionally adding tag descriptions at the OpenAPI level.

## 4. Affected Files

| File | Endpoints | Current State |
|------|-----------|---------------|
| `src/modules/assistants/assistants.routes.ts` | 11 | No tags, summary, or description |
| `src/modules/threads/threads.routes.ts` | 12 | No tags, summary, or description |
| `src/modules/runs/runs.routes.ts` | 14 | No tags, summary, or description |
| `src/modules/crons/crons.routes.ts` | 6 | Has tags + summary, no description |
| `src/modules/store/store.routes.ts` | 5 | Has tags + summary, no description |
| `src/modules/system/system.routes.ts` | 2 | Has tags + summary, no description |
| `src/plugins/swagger.plugin.ts` | N/A | May need OpenAPI-level tag descriptions |

## 5. Detailed Endpoint Inventory

### 5.1 Assistants (11 endpoints)

| # | Method | Path | Purpose |
|---|--------|------|---------|
| 1 | POST | `/assistants` | Create a new assistant |
| 2 | GET | `/assistants/:assistant_id` | Retrieve an assistant by ID |
| 3 | PATCH | `/assistants/:assistant_id` | Update an existing assistant |
| 4 | DELETE | `/assistants/:assistant_id` | Delete an assistant |
| 5 | POST | `/assistants/search` | Search assistants with filters |
| 6 | POST | `/assistants/count` | Count assistants matching filters |
| 7 | GET | `/assistants/:assistant_id/graph` | Get the graph structure of an assistant |
| 8 | GET | `/assistants/:assistant_id/schemas` | Get input/output schemas of an assistant's graph |
| 9 | GET | `/assistants/:assistant_id/subgraphs` | Get subgraphs of an assistant's graph |
| 10 | POST | `/assistants/:assistant_id/versions` | List version history of an assistant |
| 11 | POST | `/assistants/:assistant_id/latest` | Set a specific version as the latest |

### 5.2 Threads (12 endpoints)

| # | Method | Path | Purpose |
|---|--------|------|---------|
| 1 | POST | `/threads` | Create a new thread |
| 2 | GET | `/threads/:thread_id` | Retrieve a thread by ID |
| 3 | PATCH | `/threads/:thread_id` | Update thread metadata |
| 4 | DELETE | `/threads/:thread_id` | Delete a thread |
| 5 | POST | `/threads/search` | Search threads with filters |
| 6 | POST | `/threads/count` | Count threads matching filters |
| 7 | POST | `/threads/:thread_id/copy` | Copy/clone a thread |
| 8 | POST | `/threads/prune` | Prune old or inactive threads |
| 9 | GET | `/threads/:thread_id/state` | Get the current state of a thread |
| 10 | POST | `/threads/:thread_id/state` | Update/patch the state of a thread |
| 11 | POST | `/threads/:thread_id/history` | Get state history (checkpoints) of a thread |
| 12 | GET | `/threads/:thread_id/stream` | SSE stub (handled by runs module) |

### 5.3 Runs (14 endpoints)

| # | Method | Path | Purpose |
|---|--------|------|---------|
| 1 | POST | `/threads/:thread_id/runs` | Create a stateful run on a thread |
| 2 | POST | `/runs` | Create a stateless run |
| 3 | POST | `/threads/:thread_id/runs/stream` | Stream a stateful run via SSE |
| 4 | POST | `/runs/stream` | Stream a stateless run via SSE |
| 5 | POST | `/threads/:thread_id/runs/wait` | Create and wait for a stateful run to complete |
| 6 | POST | `/runs/wait` | Create and wait for a stateless run to complete |
| 7 | POST | `/runs/batch` | Batch create multiple runs |
| 8 | GET | `/threads/:thread_id/runs` | List runs for a thread |
| 9 | GET | `/threads/:thread_id/runs/:run_id` | Get a specific run |
| 10 | POST | `/threads/:thread_id/runs/:run_id/cancel` | Cancel a running run |
| 11 | POST | `/runs/cancel` | Bulk cancel multiple runs |
| 12 | GET | `/threads/:thread_id/runs/:run_id/join` | Wait for an existing run to complete |
| 13 | GET | `/threads/:thread_id/runs/:run_id/stream` | Join an existing run's SSE stream |
| 14 | DELETE | `/threads/:thread_id/runs/:run_id` | Delete a run |

### 5.4 Crons (6 endpoints)

| # | Method | Path | Purpose |
|---|--------|------|---------|
| 1 | POST | `/threads/:thread_id/runs/crons` | Create a stateful cron job |
| 2 | POST | `/runs/crons` | Create a stateless cron job |
| 3 | DELETE | `/runs/crons/:cron_id` | Delete a cron job |
| 4 | PATCH | `/runs/crons/:cron_id` | Update a cron job |
| 5 | POST | `/runs/crons/search` | Search cron jobs |
| 6 | POST | `/runs/crons/count` | Count cron jobs |

### 5.5 Store (5 endpoints)

| # | Method | Path | Purpose |
|---|--------|------|---------|
| 1 | PUT | `/store/items` | Create or update a store item |
| 2 | GET | `/store/items` | Get a store item by namespace and key |
| 3 | DELETE | `/store/items` | Delete a store item |
| 4 | POST | `/store/items/search` | Search store items |
| 5 | POST | `/store/namespaces` | List store namespaces |

### 5.6 System (2 endpoints)

| # | Method | Path | Purpose |
|---|--------|------|---------|
| 1 | GET | `/ok` | Health check |
| 2 | GET | `/info` | Server info and capabilities |

## 6. Description Content Guidelines

### 6.1 LangGraph Context

Each description should reference official LangGraph Platform concepts. Key concepts to draw from:

- **Assistants**: Configured instances of graph templates. An assistant binds a `graph_id` to specific configuration (model, tools, system prompt). Multiple assistants can share the same graph with different configs. Assistants support versioning.
- **Threads**: Persistent conversation sessions that maintain state across multiple interactions. Threads store the accumulated state (messages, values) and support checkpointing for time-travel debugging and branching.
- **Runs**: Individual invocations of an assistant's graph on a thread. Runs can be stateful (bound to a thread, accumulating state) or stateless (ephemeral, no thread persistence). Runs support streaming (SSE), synchronous wait, and background execution.
- **Crons**: Scheduled recurring runs. A cron job periodically invokes an assistant's graph, optionally on a specific thread. Useful for periodic data processing, monitoring, or automated agent tasks.
- **Store**: A general-purpose key-value store organized by namespaces. Used for cross-thread memory, user profiles, shared configuration, or any persistent data that agents need across conversations.
- **Streaming**: Real-time event delivery via Server-Sent Events (SSE). Stream modes include `values` (full state after each step), `messages` (incremental LLM tokens), `events` (lifecycle events), and `debug` (internal graph events).

### 6.2 Description Format

Descriptions should use plain text (Swagger UI renders markdown in descriptions, so markdown can be used sparingly for emphasis). Each description should follow this general structure:

1. **Purpose statement** (1-2 sentences): What the endpoint does.
2. **LangGraph context** (1-2 sentences): How this maps to LangGraph Platform concepts.
3. **Usage guidance** (1-3 sentences): When and why a client would call this endpoint.
4. **Behavioral notes** (as needed): Pagination, streaming, side effects, prerequisites.

### 6.3 Swagger Plugin Enhancement

The `src/plugins/swagger.plugin.ts` should be updated to include OpenAPI-level tag descriptions, so each tag group has a top-level explanation in the Swagger UI:

```typescript
tags: [
  { name: 'Assistants', description: 'Manage assistants - configured instances of LangGraph agent templates...' },
  { name: 'Threads', description: 'Manage conversation threads - persistent sessions that maintain state...' },
  { name: 'Runs', description: 'Execute agent graphs - create, monitor, stream, and manage run invocations...' },
  { name: 'Crons', description: 'Schedule recurring runs - automated periodic execution of agent graphs...' },
  { name: 'Store', description: 'Key-value storage - persistent cross-thread memory and shared data...' },
  { name: 'System', description: 'System endpoints - health checks and server capability discovery...' },
]
```

## 7. Information Sources

The descriptions should be informed by:

1. **Official LangGraph Platform documentation** (https://langchain-ai.github.io/langgraph/cloud/) -- Concepts, API reference, and tutorials.
2. **LangGraph SDK source code** -- The official Python/JS SDK that clients use to interact with the API.
3. **Existing project reference material** in `docs/reference/`:
   - `langgraph-api-concepts.md` -- LangGraph API concepts documentation.
   - `investigation-langgraph-api-replacement.md` -- Investigation into the API surface.
4. **Current route implementations** -- For behavioral details specific to this lg-api implementation.

## 8. Implementation Approach

### Phase 1: Swagger Plugin Update
- Add OpenAPI-level tag descriptions to `src/plugins/swagger.plugin.ts`.

### Phase 2: Route Files Update (per module)
For each of the 6 route files:
1. Add `tags` array to every route schema that lacks one.
2. Add or improve `summary` for every route.
3. Add `description` for every route with rich, informative content per the guidelines above.

### Phase 3: Verification
- Start the dev server (`npm run dev`) and verify the Swagger UI at `/docs` renders all descriptions correctly.
- Verify no schema validation errors or Fastify startup issues.

## 9. Acceptance Criteria

1. All 50 endpoints display `tags`, `summary`, and `description` in the Swagger UI.
2. Every description references relevant LangGraph Platform concepts.
3. Descriptions explain purpose, usage scenarios, and behavioral notes.
4. The Swagger UI tag groups have top-level descriptions.
5. No functional regressions -- the server starts and all endpoints work as before.
6. The existing test suite passes without modification.

## 10. Constraints

- Documentation-only change. No route logic, schema, or handler modifications.
- Descriptions must be accurate to both the official LangGraph Platform API semantics and this project's specific implementation.
- Use internet research and official LangGraph documentation as primary sources for concept descriptions.
