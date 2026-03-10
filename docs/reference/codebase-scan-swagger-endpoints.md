# Codebase Scan: Swagger Endpoint Descriptions

Produced for the task defined in `docs/reference/refined-request-swagger-endpoint-descriptions.md`.

---

## 1. Project Overview

- **Framework**: Fastify v5 with `@fastify/type-provider-typebox`
- **Schema Validation**: `@sinclair/typebox` (TypeBox)
- **OpenAPI Generation**: `@fastify/swagger` (v3.1.0) + `@fastify/swagger-ui` (served at `/docs`)
- **Language**: TypeScript (strict mode, ESM)
- **Route Registration**: Each module exports a `FastifyPluginAsync` registered in `src/app.ts` via `app.register()`

## 2. Module Map

| Module | Route File | Endpoints | Current Swagger State |
|--------|-----------|-----------|----------------------|
| Assistants | `src/modules/assistants/assistants.routes.ts` | 11 | **No** `tags`, `summary`, or `description` on any route |
| Threads | `src/modules/threads/threads.routes.ts` | 12 | **No** `tags`, `summary`, or `description` on any route |
| Runs | `src/modules/runs/runs.routes.ts` | 14 | **No** `tags`, `summary`, or `description` on any route |
| Crons | `src/modules/crons/crons.routes.ts` | 6 | Has `tags: ['Crons']` and `summary` on all routes; **no** `description` |
| Store | `src/modules/store/store.routes.ts` | 5 | Has `tags: ['Store']` and `summary` on all routes; **no** `description` |
| System | `src/modules/system/system.routes.ts` | 2 | Has `tags: ['System']` and `summary` on all routes; **no** `description` |

**Total: 50 endpoints**

## 3. Swagger Plugin Configuration

**File**: `src/plugins/swagger.plugin.ts`

Current state:
- Registers `@fastify/swagger` with OpenAPI 3.1.0 spec
- Sets `info.title`, `info.description`, `info.version`
- Defines `apiKey` security scheme (header `X-Api-Key`)
- Registers `@fastify/swagger-ui` at `/docs`
- **No `tags` array** at the OpenAPI level (no tag descriptions for the Swagger UI sidebar)

What needs to be added:
- A `tags` array inside the `openapi` config object with `name` + `description` for each of the 6 groups (Assistants, Threads, Runs, Crons, Store, System).

## 4. Route Definition Conventions

Two route registration patterns are used across the codebase:

### Pattern A: `fastify.route()` (used by Assistants, Threads)

```typescript
fastify.route({
  method: 'POST',
  url: '/assistants',
  schema: {
    // --- Swagger metadata goes here ---
    // tags: ['Assistants'],        <-- MISSING
    // summary: 'Create assistant', <-- MISSING
    // description: '...',          <-- MISSING
    body: CreateAssistantRequestSchema,
    response: {
      200: AssistantSchema,
      409: ErrorResponseSchema,
    },
  },
  handler: async (request, reply) => { ... },
});
```

### Pattern B: `fastify.<method>()` shorthand (used by Runs, Crons, Store, System)

```typescript
fastify.post('/threads/:thread_id/runs', {
  schema: {
    // --- Swagger metadata goes here ---
    // tags: ['Runs'],              <-- MISSING
    // summary: 'Create run',       <-- MISSING
    // description: '...',          <-- MISSING
    params: ThreadIdOnlyParamSchema,
    body: RunCreateRequestSchema,
    response: { 200: RunSchema },
  },
}, async (request, reply) => { ... });
```

Both patterns place the swagger metadata (`tags`, `summary`, `description`) as top-level keys inside the `schema` object. Fastify's swagger integration reads these fields from `schema` to generate OpenAPI operation metadata.

### Schema Usage

- All request/response schemas are TypeBox objects imported from `src/schemas/*.schema.ts`
- Schemas do **not** carry `$id` fields (removed to avoid Fastify serializer conflicts)
- `params`, `body`, `querystring`, and `response` are standard Fastify schema keys
- `response` maps HTTP status codes to TypeBox schemas

## 5. Detailed Integration Points Per Module

### 5.1 Assistants (`src/modules/assistants/assistants.routes.ts`)

Uses Pattern A (`fastify.route()`). All 11 routes need `tags`, `summary`, and `description` added to their `schema` objects.

| # | Line | Method | URL | Action |
|---|------|--------|-----|--------|
| 1 | 33 | POST | `/assistants` | create |
| 2 | 51 | GET | `/assistants/:assistant_id` | get |
| 3 | 69 | PATCH | `/assistants/:assistant_id` | update |
| 4 | 89 | DELETE | `/assistants/:assistant_id` | delete |
| 5 | 109 | POST | `/assistants/search` | search |
| 6 | 129 | POST | `/assistants/count` | count |
| 7 | 146 | GET | `/assistants/:assistant_id/graph` | getGraph |
| 8 | 165 | GET | `/assistants/:assistant_id/schemas` | getSchemas |
| 9 | 184 | GET | `/assistants/:assistant_id/subgraphs` | getSubgraphs |
| 10 | 204 | POST | `/assistants/:assistant_id/versions` | listVersions |
| 11 | 227 | POST | `/assistants/:assistant_id/latest` | setLatestVersion |

### 5.2 Threads (`src/modules/threads/threads.routes.ts`)

Uses Pattern A (`fastify.route()`). All 12 routes need `tags`, `summary`, and `description` added.

| # | Line | Method | URL | Action |
|---|------|--------|-----|--------|
| 1 | 33 | POST | `/threads` | create |
| 2 | 51 | GET | `/threads/:thread_id` | get |
| 3 | 69 | PATCH | `/threads/:thread_id` | update |
| 4 | 89 | DELETE | `/threads/:thread_id` | delete |
| 5 | 108 | POST | `/threads/search` | search |
| 6 | 128 | POST | `/threads/count` | count |
| 7 | 145 | POST | `/threads/:thread_id/copy` | copy |
| 8 | 164 | POST | `/threads/prune` | prune |
| 9 | 181 | GET | `/threads/:thread_id/state` | getState |
| 10 | 200 | POST | `/threads/:thread_id/state` | updateState |
| 11 | 221 | POST | `/threads/:thread_id/history` | getHistory |
| 12 | 243 | GET | `/threads/:thread_id/stream` | stream stub (501) |

### 5.3 Runs (`src/modules/runs/runs.routes.ts`)

Uses Pattern B (`fastify.post()`, `fastify.get()`, `fastify.delete()`). All 14 routes need `tags`, `summary`, and `description` added.

| # | Line | Method | URL | Action |
|---|------|--------|-----|--------|
| 1 | 49 | POST | `/threads/:thread_id/runs` | createStateful |
| 2 | 67 | POST | `/runs` | createStateless |
| 3 | 82 | POST | `/threads/:thread_id/runs/stream` | streamStateful (SSE) |
| 4 | 99 | POST | `/runs/stream` | streamStateless (SSE) |
| 5 | 113 | POST | `/threads/:thread_id/runs/wait` | waitStateful |
| 6 | 131 | POST | `/runs/wait` | waitStateless |
| 7 | 146 | POST | `/runs/batch` | batch |
| 8 | 161 | GET | `/threads/:thread_id/runs` | list |
| 9 | 180 | GET | `/threads/:thread_id/runs/:run_id` | get |
| 10 | 196 | POST | `/threads/:thread_id/runs/:run_id/cancel` | cancel |
| 11 | 213 | POST | `/runs/cancel` | bulkCancel |
| 12 | 227 | GET | `/threads/:thread_id/runs/:run_id/join` | join |
| 13 | 243 | GET | `/threads/:thread_id/runs/:run_id/stream` | joinStream (SSE) |
| 14 | 270 | DELETE | `/threads/:thread_id/runs/:run_id` | delete |

### 5.4 Crons (`src/modules/crons/crons.routes.ts`)

Uses Pattern B. Already has `tags` and `summary`. Only `description` needs to be added to each route's `schema`.

| # | Line | Method | URL | Summary (existing) |
|---|------|--------|-----|-------------------|
| 1 | 36 | POST | `/threads/:thread_id/runs/crons` | "Create a stateful cron job bound to a thread" |
| 2 | 56 | POST | `/runs/crons` | "Create a stateless cron job" |
| 3 | 74 | DELETE | `/runs/crons/:cron_id` | "Delete a cron job" |
| 4 | 92 | PATCH | `/runs/crons/:cron_id` | "Update a cron job" |
| 5 | 112 | POST | `/runs/crons/search` | "Search cron jobs" |
| 6 | 143 | POST | `/runs/crons/count` | "Count cron jobs" |

### 5.5 Store (`src/modules/store/store.routes.ts`)

Uses Pattern B. Already has `tags` and `summary`. Only `description` needs to be added.

| # | Line | Method | URL | Summary (existing) |
|---|------|--------|-----|-------------------|
| 1 | 36 | PUT | `/store/items` | "Put (create or update) an item in the store" |
| 2 | 61 | GET | `/store/items` | "Get an item from the store by namespace and key" |
| 3 | 94 | DELETE | `/store/items` | "Delete an item from the store" |
| 4 | 111 | POST | `/store/items/search` | "Search items in the store" |
| 5 | 138 | POST | `/store/namespaces` | "List namespaces in the store" |

### 5.6 System (`src/modules/system/system.routes.ts`)

Uses Pattern B. Already has `tags` and `summary`. Only `description` needs to be added.

| # | Line | Method | URL | Summary (existing) |
|---|------|--------|-----|-------------------|
| 1 | 19 | GET | `/ok` | "Health check" |
| 2 | 34 | GET | `/info` | "Server information and capabilities" |

## 6. Implementation Checklist

1. **`src/plugins/swagger.plugin.ts`** -- Add `tags` array with 6 tag objects (name + description) inside the `openapi` config, at the same level as `info` and `components`.

2. **`src/modules/assistants/assistants.routes.ts`** -- Add `tags: ['Assistants']`, `summary`, and `description` to all 11 route `schema` objects.

3. **`src/modules/threads/threads.routes.ts`** -- Add `tags: ['Threads']`, `summary`, and `description` to all 12 route `schema` objects.

4. **`src/modules/runs/runs.routes.ts`** -- Add `tags: ['Runs']`, `summary`, and `description` to all 14 route `schema` objects.

5. **`src/modules/crons/crons.routes.ts`** -- Add `description` to all 6 route `schema` objects (tags and summary already present).

6. **`src/modules/store/store.routes.ts`** -- Add `description` to all 5 route `schema` objects (tags and summary already present).

7. **`src/modules/system/system.routes.ts`** -- Add `description` to all 2 route `schema` objects (tags and summary already present).

**Total edits: 7 files, 50 endpoints.**
