# Technical Design: Swagger Endpoint Descriptions Enhancement

**Date:** 2026-03-10
**Plan Reference:** `docs/design/plan-003-swagger-endpoint-descriptions.md`
**Requirements:** `docs/reference/refined-request-swagger-endpoint-descriptions.md`
**Content Source:** `docs/reference/investigation-swagger-endpoint-descriptions.md`
**Codebase Analysis:** `docs/reference/codebase-scan-swagger-endpoints.md`
**Type:** Documentation-only change -- no business logic modifications

---

## 1. Swagger Plugin Update Pattern

### File: `src/plugins/swagger.plugin.ts`

The swagger plugin currently defines `openapi.info` and `openapi.components` but has no `tags` array. A `tags` property must be added at the same level as `info` and `components` inside the `openapi` configuration object.

### Current State (lines 9-25)

```typescript
await fastify.register(swagger, {
  openapi: {
    openapi: '3.1.0',
    info: {
      title: 'LG API',
      description: 'LangGraph Server API Drop-in Replacement',
      version: '1.0.0',
    },
    components: {
      securitySchemes: {
        apiKey: {
          type: 'apiKey',
          name: 'X-Api-Key',
          in: 'header',
        },
      },
    },
  },
});
```

### Target State

```typescript
await fastify.register(swagger, {
  openapi: {
    openapi: '3.1.0',
    info: {
      title: 'LG API',
      description: 'LangGraph Server API Drop-in Replacement',
      version: '1.0.0',
    },
    tags: [
      {
        name: 'Assistants',
        description: 'Manage assistants - versioned configurations of deployed graphs. Each assistant references a specific graph and binds it to particular configuration including model parameters, system prompts, tools, and runtime context. Multiple assistants can reference the same graph with different configurations. Assistants are immutable; updates create new versions with rollback support.',
      },
      {
        name: 'Threads',
        description: 'Manage conversation threads - persistent containers that maintain state across multiple run invocations. Threads store accumulated state (messages, intermediate values, checkpoint history) from all runs, enabling multi-turn conversations, long-running workflows, and stateful agent interactions.',
      },
      {
        name: 'Runs',
        description: 'Execute agent graphs - create, monitor, stream, and manage run invocations. Runs can be stateful (bound to a thread, accumulating state) or stateless (ephemeral). Supports synchronous wait, asynchronous background execution, real-time SSE streaming, and batch processing.',
      },
      {
        name: 'Crons',
        description: 'Schedule recurring runs - automated periodic execution of agent graphs using cron expressions (UTC). Cron jobs can be stateful (bound to a thread) or stateless. Important: delete cron jobs when no longer needed to avoid unwanted LLM API charges.',
      },
      {
        name: 'Store',
        description: 'Key-value storage - persistent cross-thread memory organized by hierarchical namespaces. Enables long-term memory shared across conversations, users, or agents. Unlike thread state (scoped to a single conversation), store items persist indefinitely and are accessible from any thread.',
      },
      {
        name: 'System',
        description: 'System endpoints - health checks and server capability discovery. Used by infrastructure (load balancers, monitoring), client applications (feature detection), and operators (deployment verification).',
      },
    ],
    components: {
      securitySchemes: {
        apiKey: {
          type: 'apiKey',
          name: 'X-Api-Key',
          in: 'header',
        },
      },
    },
  },
});
```

### Key Points

- The `tags` array is placed **between** `info` and `components` for readability, but position within the object is irrelevant to functionality.
- Each tag object has exactly two properties: `name` (string) and `description` (string).
- The `name` values must **exactly match** the tag strings used in route schemas (e.g., `tags: ['Assistants']` in route files must match `name: 'Assistants'` here).
- Tag descriptions are single-line strings (no template literals needed at this level) kept to 1-3 sentences for Swagger UI sidebar readability.

---

## 2. Route Schema Patterns

Two distinct route registration patterns exist in the codebase. Both place swagger metadata (`tags`, `summary`, `description`) as **top-level keys inside the `schema` object**.

### Pattern A: `fastify.route({...})` -- Used by Assistants, Threads

In this pattern, the route is defined as a single options object passed to `fastify.route()`. The `schema` key sits alongside `method`, `url`, and `handler`.

#### Before (Assistants - POST /assistants, line ~33)

```typescript
fastify.route({
  method: 'POST',
  url: '/assistants',
  schema: {
    body: CreateAssistantRequestSchema,
    response: {
      200: AssistantSchema,
      409: ErrorResponseSchema,
    },
  },
  handler: async (request, reply) => {
    const body = request.body as any;
    const assistant = await service.create(body);
    return reply.status(200).send(assistant);
  },
});
```

#### After (Assistants - POST /assistants)

```typescript
fastify.route({
  method: 'POST',
  url: '/assistants',
  schema: {
    tags: ['Assistants'],
    summary: 'Create a new assistant',
    description: `Creates a new assistant with a specified graph configuration. An assistant is a versioned instance of a graph template bound to specific configuration settings such as model parameters, tools, prompts, and runtime context. Multiple assistants can reference the same graph_id but with different configurations, enabling reuse of graph logic across different use cases.

In the LangGraph Platform, assistants are the primary deployment artifact. This endpoint creates both the assistant entity and its initial version simultaneously. The if_exists parameter controls duplicate handling: "raise" returns an error if an assistant with the same ID exists, while "do_nothing" returns the existing assistant without modification.

Key parameters include graph_id (required, references the graph blueprint), assistant_id (optional UUID, auto-generated if not provided), config (graph-specific configuration), metadata (arbitrary key-value pairs for filtering), and name/description (human-readable labels). After creation, the assistant is immediately available for run execution.`,
    body: CreateAssistantRequestSchema,
    response: {
      200: AssistantSchema,
      409: ErrorResponseSchema,
    },
  },
  handler: async (request, reply) => {
    const body = request.body as any;
    const assistant = await service.create(body);
    return reply.status(200).send(assistant);
  },
});
```

#### Insertion Rule for Pattern A

Add `tags`, `summary`, and `description` as the **first three keys** inside the `schema` object, before `params`, `querystring`, `body`, and `response`. This ordering is a convention for readability; Fastify does not enforce key order.

---

### Pattern B: `fastify.<method>(url, {schema}, handler)` -- Used by Runs, Crons, Store, System

In this pattern, the HTTP method is called directly on the fastify instance. The schema is inside the second argument (options object), and the handler is the third argument.

#### Before (Crons - POST /threads/:thread_id/runs/crons, line ~36)

```typescript
fastify.post('/threads/:thread_id/runs/crons', {
  schema: {
    tags: ['Crons'],
    summary: 'Create a stateful cron job bound to a thread',
    params: ThreadIdParamSchema,
    body: CreateCronRequestSchema,
    response: {
      201: CronSchema,
      422: ErrorResponseSchema,
    },
  },
}, async (request, reply) => {
  const { thread_id } = request.params as { thread_id: string };
  const body = request.body as any;
  const cron = await service.createCron(thread_id, body);
  return reply.status(201).send(cron);
});
```

#### After (Crons - POST /threads/:thread_id/runs/crons)

```typescript
fastify.post('/threads/:thread_id/runs/crons', {
  schema: {
    tags: ['Crons'],
    summary: 'Create a stateful cron job bound to a thread',
    description: `Creates a scheduled cron job that periodically executes an assistant's graph on a specific thread. The cron job accumulates state across executions, enabling recurring workflows that build on previous results (e.g., daily summaries that reference prior summaries).

In the LangGraph Platform, stateful crons bind a schedule to a thread-assistant pair. Each scheduled execution creates a new run on the specified thread, loading the thread's current state as input. The schedule uses standard 5-field cron expression syntax interpreted in UTC.

Key parameters include assistant_id (required), schedule (required, cron expression), input (optional graph input), and end_time (optional expiration). Important: delete cron jobs when no longer needed to avoid unwanted LLM API charges from recurring executions.`,
    params: ThreadIdParamSchema,
    body: CreateCronRequestSchema,
    response: {
      201: CronSchema,
      422: ErrorResponseSchema,
    },
  },
}, async (request, reply) => {
  const { thread_id } = request.params as { thread_id: string };
  const body = request.body as any;
  const cron = await service.createCron(thread_id, body);
  return reply.status(201).send(cron);
});
```

#### Insertion Rule for Pattern B

- For modules that **already have** `tags` and `summary` (Crons, Store, System): insert `description` immediately **after** `summary` and **before** `params`/`body`/`querystring`/`response`.
- For modules that have **no** swagger metadata (Runs): insert `tags`, `summary`, and `description` as the first three keys inside `schema`, before `params`/`body`/`querystring`/`response`.

---

## 3. Implementation Units (7 Parallel Units)

All 7 units are independent with no cross-dependencies. They can be implemented and verified in any order or in parallel.

### Unit 1: Swagger Plugin -- OpenAPI Tag Descriptions

| Attribute | Value |
|-----------|-------|
| **File** | `src/plugins/swagger.plugin.ts` |
| **Pattern** | N/A (plugin config, not a route) |
| **Endpoints** | N/A |
| **What to add** | `tags` array with 6 tag objects (`name` + `description`) inside the `openapi` config, between `info` and `components` |
| **Source section** | Investigation doc, "Tag Descriptions" (lines 2150-2277) |
| **Estimated lines changed** | ~30 lines added |

---

### Unit 2: Assistants Routes (11 endpoints)

| Attribute | Value |
|-----------|-------|
| **File** | `src/modules/assistants/assistants.routes.ts` |
| **Pattern** | A (`fastify.route({...})`) |
| **What to add** | `tags: ['Assistants']` + `summary` + `description` to all 11 routes |
| **Source section** | Investigation doc, "Assistants" (lines 30-388) |

**Endpoints in scope:**

| # | Method | URL | Summary | Line |
|---|--------|-----|---------|------|
| 1 | POST | `/assistants` | Create a new assistant | ~33 |
| 2 | GET | `/assistants/:assistant_id` | Retrieve an assistant by ID | ~51 |
| 3 | PATCH | `/assistants/:assistant_id` | Update an assistant | ~69 |
| 4 | DELETE | `/assistants/:assistant_id` | Delete an assistant | ~89 |
| 5 | POST | `/assistants/search` | Search and filter assistants | ~109 |
| 6 | POST | `/assistants/count` | Count assistants matching filters | ~129 |
| 7 | GET | `/assistants/:assistant_id/graph` | Get assistant graph structure | ~146 |
| 8 | GET | `/assistants/:assistant_id/schemas` | Get input/output schemas for the assistant's graph | ~165 |
| 9 | GET | `/assistants/:assistant_id/subgraphs` | Get nested subgraphs of the assistant's graph | ~184 |
| 10 | POST | `/assistants/:assistant_id/versions` | List version history of an assistant | ~204 |
| 11 | POST | `/assistants/:assistant_id/latest` | Set a specific version as the latest | ~227 |

---

### Unit 3: Threads Routes (12 endpoints)

| Attribute | Value |
|-----------|-------|
| **File** | `src/modules/threads/threads.routes.ts` |
| **Pattern** | A (`fastify.route({...})`) |
| **What to add** | `tags: ['Threads']` + `summary` + `description` to all 12 routes |
| **Source section** | Investigation doc, "Threads" (lines 393-910) |

**Endpoints in scope:**

| # | Method | URL | Summary | Line |
|---|--------|-----|---------|------|
| 1 | POST | `/threads` | Create a new conversation thread | ~33 |
| 2 | GET | `/threads/:thread_id` | Retrieve a thread by ID | ~51 |
| 3 | PATCH | `/threads/:thread_id` | Update thread metadata | ~69 |
| 4 | DELETE | `/threads/:thread_id` | Permanently delete a thread | ~89 |
| 5 | POST | `/threads/search` | Search and filter threads | ~108 |
| 6 | POST | `/threads/count` | Count threads matching filters | ~128 |
| 7 | POST | `/threads/:thread_id/copy` | Clone a thread with its state history | ~145 |
| 8 | POST | `/threads/prune` | Delete old or inactive threads in bulk | ~164 |
| 9 | GET | `/threads/:thread_id/state` | Get the current state of a thread | ~181 |
| 10 | POST | `/threads/:thread_id/state` | Manually update thread state | ~200 |
| 11 | POST | `/threads/:thread_id/history` | Get state history (checkpoints) of a thread | ~221 |
| 12 | GET | `/threads/:thread_id/stream` | Stream thread events via SSE (not implemented) | ~243 |

---

### Unit 4: Runs Routes (14 endpoints)

| Attribute | Value |
|-----------|-------|
| **File** | `src/modules/runs/runs.routes.ts` |
| **Pattern** | B (`fastify.post()`, `fastify.get()`, `fastify.delete()`) |
| **What to add** | `tags: ['Runs']` + `summary` + `description` to all 14 routes |
| **Source section** | Investigation doc, "Runs" (lines 915-1555) |

**Endpoints in scope:**

| # | Method | URL | Summary | Line |
|---|--------|-----|---------|------|
| 1 | POST | `/threads/:thread_id/runs` | Create and execute a run on a thread | ~49 |
| 2 | POST | `/runs` | Create and execute a stateless run | ~67 |
| 3 | POST | `/threads/:thread_id/runs/stream` | Create and stream a stateful run via SSE | ~82 |
| 4 | POST | `/runs/stream` | Create and stream a stateless run via SSE | ~99 |
| 5 | POST | `/threads/:thread_id/runs/wait` | Create a stateful run and wait for completion | ~113 |
| 6 | POST | `/runs/wait` | Create a stateless run and wait for completion | ~131 |
| 7 | POST | `/runs/batch` | Create multiple stateless runs in a single request | ~146 |
| 8 | GET | `/threads/:thread_id/runs` | List all runs for a thread | ~161 |
| 9 | GET | `/threads/:thread_id/runs/:run_id` | Retrieve a specific run | ~180 |
| 10 | POST | `/threads/:thread_id/runs/:run_id/cancel` | Cancel an in-progress run | ~196 |
| 11 | POST | `/runs/cancel` | Cancel multiple runs by filter | ~213 |
| 12 | GET | `/threads/:thread_id/runs/:run_id/join` | Wait for an existing run to complete | ~227 |
| 13 | GET | `/threads/:thread_id/runs/:run_id/stream` | Join an existing run's SSE stream | ~243 |
| 14 | DELETE | `/threads/:thread_id/runs/:run_id` | Delete a run record | ~270 |

---

### Unit 5: Crons Routes (6 endpoints -- description only)

| Attribute | Value |
|-----------|-------|
| **File** | `src/modules/crons/crons.routes.ts` |
| **Pattern** | B (`fastify.post()`, `fastify.delete()`, `fastify.patch()`) |
| **What to add** | `description` only (tags and summary already present) |
| **Source section** | Investigation doc, "Crons" (lines 1558-1828) |

**Endpoints in scope:**

| # | Method | URL | Existing Summary | Line |
|---|--------|-----|-----------------|------|
| 1 | POST | `/threads/:thread_id/runs/crons` | Create a stateful cron job bound to a thread | ~36 |
| 2 | POST | `/runs/crons` | Create a stateless cron job | ~56 |
| 3 | DELETE | `/runs/crons/:cron_id` | Delete a cron job | ~74 |
| 4 | PATCH | `/runs/crons/:cron_id` | Update a cron job | ~92 |
| 5 | POST | `/runs/crons/search` | Search cron jobs | ~112 |
| 6 | POST | `/runs/crons/count` | Count cron jobs | ~143 |

---

### Unit 6: Store Routes (5 endpoints -- description only)

| Attribute | Value |
|-----------|-------|
| **File** | `src/modules/store/store.routes.ts` |
| **Pattern** | B (`fastify.put()`, `fastify.get()`, `fastify.delete()`, `fastify.post()`) |
| **What to add** | `description` only (tags and summary already present) |
| **Source section** | Investigation doc, "Store" (lines 1831-2073) |

**Endpoints in scope:**

| # | Method | URL | Existing Summary | Line |
|---|--------|-----|-----------------|------|
| 1 | PUT | `/store/items` | Put (create or update) an item in the store | ~36 |
| 2 | GET | `/store/items` | Get an item from the store by namespace and key | ~61 |
| 3 | DELETE | `/store/items` | Delete an item from the store | ~94 |
| 4 | POST | `/store/items/search` | Search items in the store | ~111 |
| 5 | POST | `/store/namespaces` | List namespaces in the store | ~138 |

---

### Unit 7: System Routes (2 endpoints -- description only)

| Attribute | Value |
|-----------|-------|
| **File** | `src/modules/system/system.routes.ts` |
| **Pattern** | B (`fastify.get()`) |
| **What to add** | `description` only (tags and summary already present) |
| **Source section** | Investigation doc, "System" (lines 2074-2148) |

**Endpoints in scope:**

| # | Method | URL | Existing Summary | Line |
|---|--------|-----|-----------------|------|
| 1 | GET | `/ok` | Health check | ~19 |
| 2 | GET | `/info` | Server information and capabilities | ~34 |

---

## 4. Description Format Guidelines

### 4.1 Multi-line Descriptions: Template Literals

All description values **must** use ES6 template literals (backtick strings) for multi-line content. This is the recommended approach for the following reasons:

- **Readability**: Template literals preserve line breaks in source code without escape sequences.
- **No escaping needed**: Single quotes, double quotes, and most special characters can be used directly inside template literals.
- **Consistency**: All descriptions across all 50 endpoints should use the same string format.

**Correct:**
```typescript
description: `Creates a new assistant with a specified graph configuration. An assistant is
a versioned instance of a graph template bound to specific configuration settings.

In the LangGraph Platform, assistants are the primary deployment artifact.`,
```

**Incorrect (avoid):**
```typescript
description: 'Creates a new assistant with a specified graph configuration.\n\nIn the LangGraph Platform...',
description: "Creates a new assistant with a specified graph configuration.\n\nIn the LangGraph Platform...",
```

### 4.2 Markdown Formatting in Descriptions

Swagger UI (swagger-ui v5.x, used by `@fastify/swagger-ui`) renders **Markdown** in description fields. The following Markdown features can be used:

| Feature | Syntax | Rendering Support | Recommendation |
|---------|--------|-------------------|----------------|
| Bold | `**text**` | Yes | Use sparingly for key terms |
| Italic | `*text*` | Yes | Use for parameter names |
| Line breaks | Blank line between paragraphs | Yes | Use to separate sections |
| Bullet lists | `- item` or `* item` | Yes | Use for parameter lists and use cases |
| Inline code | `` `code` `` | Yes | Use for parameter names, values, field names |
| Code blocks | Triple backticks | Partial (may not render in all views) | **Avoid** in descriptions |
| Tables | Pipe-delimited | **No** (does not render properly) | **Do not use** |
| Headers | `#`, `##` | **No** (conflicts with Swagger UI layout) | **Do not use** |
| Links | `[text](url)` | Yes | Use sparingly for cross-references |

**Recommended approach**: Use plain text as the primary format. Use bold for emphasis on key concepts (e.g., `**stateful**`, `**stateless**`). Use inline code for field names (e.g., `` `assistant_id` ``, `` `graph_id` ``). Use bullet lists for enumerating parameters, use cases, or behavioral notes.

### 4.3 Character Escaping Requirements

When using template literals, the only character that needs escaping is the backtick itself and the `${` sequence:

| Character | Needs Escaping? | How to Escape |
|-----------|----------------|---------------|
| Single quote `'` | No | Use directly |
| Double quote `"` | No | Use directly |
| Backtick `` ` `` | **Yes** | Use `\`` |
| `${` | **Yes** (interpreted as interpolation) | Use `\${` |
| Backslash `\` | Only before `` ` `` or `${` | Use `\\` if needed |
| Newline | No | Template literals preserve literal newlines |

**Practical note**: The investigation document descriptions do not contain backticks or `${` sequences, so no escaping should be needed in practice. However, implementers should be aware of this if adding inline code examples with backticks.

### 4.4 Description Length Guidelines

| Metric | Guideline |
|--------|-----------|
| **Summary** | Max 80 characters, one line, action-oriented (e.g., "Create a new assistant") |
| **Description** | 3-8 sentences (approximately 150-600 characters) |
| **Paragraphs** | 2-3 paragraphs separated by blank lines |
| **Structure** | Paragraph 1: Purpose + what it does. Paragraph 2: LangGraph context. Paragraph 3: Usage notes / behavioral notes. |

Descriptions that are too long will overwhelm the Swagger UI endpoint detail view. Descriptions that are too short fail to provide adequate context. The investigation document provides full-length descriptions that should be **adapted** (potentially condensed) following these rules:

1. **Remove code examples with markdown code blocks** -- they render poorly in some Swagger UI configurations.
2. **Remove comparison tables** -- markdown tables do not render in Swagger UI.
3. **Remove JSON examples** -- they add visual noise; the schema section already shows structure.
4. **Retain LangGraph Platform context references** -- this is the primary differentiator of our descriptions.
5. **Convert bullet lists to prose** where the list has 3 or fewer items, to keep descriptions compact.

---

## 5. Verification Checklist

### Per-Unit Verification (after each unit is implemented)

- [ ] **TypeScript compilation**: Run `npm run build` -- must succeed with zero errors and zero warnings related to the changed files.
- [ ] **Server startup**: Run `npm run dev` -- server must start without errors. Watch the console for Fastify route registration messages.
- [ ] **Swagger UI rendering**: Navigate to `http://localhost:<LG_API_PORT>/docs` and verify:
  - Tag groups appear in the sidebar (after Unit 1).
  - Endpoints appear under the correct tag group.
  - Summary text is visible in the collapsed endpoint row.
  - Description text is visible when expanding an endpoint.
  - No rendering artifacts (broken markdown, escaped characters visible to user).

### Final Verification (after all 7 units are complete)

- [ ] **Full test suite**: Run `npm test` -- all existing tests must pass without modification. No test should reference swagger metadata, so no test changes are expected.
- [ ] **Endpoint count**: Verify all 50 endpoints are visible and documented in Swagger UI. Count endpoints per tag group:
  - Assistants: 11
  - Threads: 12
  - Runs: 14
  - Crons: 6
  - Store: 5
  - System: 2
- [ ] **Tag group descriptions**: Verify all 6 tag groups in the Swagger UI sidebar display their descriptions when expanded.
- [ ] **Spot-check descriptions**: Manually review at least 2 descriptions per module (12 total) for:
  - Accuracy: Does the description match what the endpoint actually does?
  - LangGraph context: Does it reference LangGraph Platform concepts?
  - Readability: Is the description clear and well-structured?
- [ ] **No functional regressions**: Execute at least these API calls to confirm behavior is unchanged:
  - `GET /ok` -- health check returns `{"ok": true}`
  - `POST /assistants` -- creates an assistant successfully
  - `POST /threads/search` -- returns empty array or existing threads
  - `GET /info` -- returns server capabilities
- [ ] **OpenAPI spec validation**: Access `http://localhost:<LG_API_PORT>/docs/json` and verify the raw OpenAPI JSON includes `tags`, `summary`, and `description` for all operations.

---

## 6. Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Template literal with unescaped backtick causes TypeScript syntax error | LOW | Build failure (caught immediately) | Review descriptions for backtick characters before committing; use `npm run build` after each unit |
| Long description string causes Fastify schema compilation issue | VERY LOW | Server fails to start | `@fastify/swagger` treats `description` as passthrough metadata, not validated by Ajv; test startup after each unit |
| Swagger UI truncates very long descriptions | LOW | Visual issue only | Keep descriptions under 600 characters; test rendering in `/docs` |
| Tag name mismatch between plugin and route | MEDIUM | Endpoints appear in "default" group instead of named group | Use exact string matching: `'Assistants'`, `'Threads'`, `'Runs'`, `'Crons'`, `'Store'`, `'System'` |
| Markdown rendering inconsistency across Swagger UI versions | LOW | Minor visual issues | Use conservative markdown (bold, inline code, bullet lists only); avoid tables and code blocks |
| Description content references features not implemented in lg-api | MEDIUM | Misleading documentation | Review each description against actual handler implementation; add qualifiers like "In this implementation..." where behavior differs from official LangGraph Platform |

---

## 7. Implementation Notes

### 7.1 No Schema Changes

This is strictly a metadata change. The `tags`, `summary`, and `description` fields are **OpenAPI operation metadata** that `@fastify/swagger` extracts from the `schema` object but does **not** pass to Ajv for validation. They have no effect on:
- Request validation
- Response serialization
- Handler execution
- TypeBox schema definitions

### 7.2 Fastify Schema Object Structure

Fastify's `@fastify/swagger` plugin reads the following keys from the `schema` object for OpenAPI generation:

| Key | Purpose | Passed to Ajv? |
|-----|---------|---------------|
| `tags` | OpenAPI operation tags | No |
| `summary` | OpenAPI operation summary | No |
| `description` | OpenAPI operation description | No |
| `operationId` | OpenAPI operation ID | No |
| `deprecated` | OpenAPI deprecated flag | No |
| `params` | Path parameter validation | Yes |
| `querystring` | Query parameter validation | Yes |
| `body` | Request body validation | Yes |
| `response` | Response schema for serialization | Yes |
| `headers` | Header validation | Yes |

This confirms that adding `tags`, `summary`, and `description` cannot cause validation or serialization side effects.

### 7.3 File Change Summary

| # | File | Lines Added (est.) | Change Type |
|---|------|-------------------|-------------|
| 1 | `src/plugins/swagger.plugin.ts` | ~30 | Add `tags` array |
| 2 | `src/modules/assistants/assistants.routes.ts` | ~110 | Add tags + summary + description to 11 routes |
| 3 | `src/modules/threads/threads.routes.ts` | ~120 | Add tags + summary + description to 12 routes |
| 4 | `src/modules/runs/runs.routes.ts` | ~140 | Add tags + summary + description to 14 routes |
| 5 | `src/modules/crons/crons.routes.ts` | ~60 | Add description to 6 routes |
| 6 | `src/modules/store/store.routes.ts` | ~50 | Add description to 5 routes |
| 7 | `src/modules/system/system.routes.ts` | ~20 | Add description to 2 routes |
| | **Total** | **~530** | |
