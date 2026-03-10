# Plan 003: Swagger Endpoint Descriptions Enhancement

**Date:** 2026-03-10
**Type:** Documentation-only change (no logic, schema, or handler modifications)
**Scope:** 7 files, 50 endpoints
**Source of content:** `docs/reference/investigation-swagger-endpoint-descriptions.md`

---

## 1. Objective

Add comprehensive, informative Swagger/OpenAPI descriptions to all 50 lg-api endpoints so that the Swagger UI (`/docs`) becomes a self-contained developer reference, aligned with official LangGraph Platform documentation.

---

## 2. Implementation Units

The work is divided into 7 independent implementation units. Unit 1 (Swagger plugin) and Units 2-7 (route files) have **no dependencies on each other** and can all be executed in parallel.

### Unit 1: Swagger Plugin -- OpenAPI Tag Descriptions

**File:** `src/plugins/swagger.plugin.ts`
**What to do:** Add a `tags` array inside the `openapi` configuration object, at the same level as `info` and `components`. Each tag object has `name` and `description`.

**Tags to add (6):**

| Tag Name | Description Source |
|----------|-------------------|
| Assistants | Investigation doc, "Tag Descriptions > Assistants" (line ~2154) |
| Threads | Investigation doc, "Tag Descriptions > Threads" (line ~2171) |
| Runs | Investigation doc, "Tag Descriptions > Runs" (line ~2190) |
| Crons | Investigation doc, "Tag Descriptions > Crons" (line ~2213) |
| Store | Investigation doc, "Tag Descriptions > Store" (line ~2239) |
| System | Investigation doc, "Tag Descriptions > System" (line ~2265) |

**Pattern:**
```typescript
// Inside the @fastify/swagger register options, within the openapi object:
tags: [
  { name: 'Assistants', description: '...' },
  { name: 'Threads', description: '...' },
  { name: 'Runs', description: '...' },
  { name: 'Crons', description: '...' },
  { name: 'Store', description: '...' },
  { name: 'System', description: '...' },
],
```

**Verification:** Server starts without errors; Swagger UI sidebar shows tag group descriptions.

---

### Unit 2: Assistants Routes (11 endpoints -- add tags, summary, description)

**File:** `src/modules/assistants/assistants.routes.ts`
**Route pattern:** `fastify.route()` (Pattern A)
**Current state:** No `tags`, `summary`, or `description` on any route.
**What to add:** For each of the 11 routes, add `tags: ['Assistants']`, `summary`, and `description` as top-level keys inside the `schema` object.

| # | Line | Method | URL | Summary | Description Source (investigation doc section) |
|---|------|--------|-----|---------|----------------------------------------------|
| 1 | ~33 | POST | `/assistants` | Create a new assistant | Assistants #1 (line ~30) |
| 2 | ~51 | GET | `/assistants/:assistant_id` | Retrieve an assistant by ID | Assistants #2 (line ~53) |
| 3 | ~69 | PATCH | `/assistants/:assistant_id` | Update an assistant | Assistants #3 (line ~83) |
| 4 | ~89 | DELETE | `/assistants/:assistant_id` | Delete an assistant | Assistants #4 (line ~114) |
| 5 | ~109 | POST | `/assistants/search` | Search and filter assistants | Assistants #5 (line ~144) |
| 6 | ~129 | POST | `/assistants/count` | Count assistants matching filters | Assistants #6 (line ~180) |
| 7 | ~146 | GET | `/assistants/:assistant_id/graph` | Get assistant graph structure | Assistants #7 (line ~216) |
| 8 | ~165 | GET | `/assistants/:assistant_id/schemas` | Get input/output schemas for the assistant's graph | Assistants #8 (line ~250) |
| 9 | ~184 | GET | `/assistants/:assistant_id/subgraphs` | Get nested subgraphs of the assistant's graph | Assistants #9 (line ~282) |
| 10 | ~204 | POST | `/assistants/:assistant_id/versions` | List version history of an assistant | Assistants #10 (line ~316) |
| 11 | ~227 | POST | `/assistants/:assistant_id/latest` | Set a specific version as the latest | Assistants #11 (line ~356) |

**Insertion pattern (Pattern A):**
```typescript
fastify.route({
  method: 'POST',
  url: '/assistants',
  schema: {
    tags: ['Assistants'],
    summary: 'Create a new assistant',
    description: '...multi-line description from investigation doc...',
    body: CreateAssistantRequestSchema,
    response: { ... },
  },
  handler: async (request, reply) => { ... },
});
```

---

### Unit 3: Threads Routes (12 endpoints -- add tags, summary, description)

**File:** `src/modules/threads/threads.routes.ts`
**Route pattern:** `fastify.route()` (Pattern A)
**Current state:** No `tags`, `summary`, or `description` on any route.
**What to add:** For each of the 12 routes, add `tags: ['Threads']`, `summary`, and `description`.

| # | Line | Method | URL | Summary | Description Source |
|---|------|--------|-----|---------|-------------------|
| 1 | ~33 | POST | `/threads` | Create a new conversation thread | Threads #1 (line ~393) |
| 2 | ~51 | GET | `/threads/:thread_id` | Retrieve a thread by ID | Threads #2 (line ~442) |
| 3 | ~69 | PATCH | `/threads/:thread_id` | Update thread metadata | Threads #3 (line ~482) |
| 4 | ~89 | DELETE | `/threads/:thread_id` | Permanently delete a thread | Threads #4 (line ~529) |
| 5 | ~108 | POST | `/threads/search` | Search and filter threads | Threads #5 (line ~565) |
| 6 | ~128 | POST | `/threads/count` | Count threads matching filters | Threads #6 (line ~606) |
| 7 | ~145 | POST | `/threads/:thread_id/copy` | Clone a thread with its state history | Threads #7 (line ~650) |
| 8 | ~164 | POST | `/threads/prune` | Delete old or inactive threads in bulk | Threads #8 (line ~690) |
| 9 | ~181 | GET | `/threads/:thread_id/state` | Get the current state of a thread | Threads #9 (line ~736) |
| 10 | ~200 | POST | `/threads/:thread_id/state` | Manually update thread state | Threads #10 (line ~781) |
| 11 | ~221 | POST | `/threads/:thread_id/history` | Get state history (checkpoints) of a thread | Threads #11 (line ~831) |
| 12 | ~243 | GET | `/threads/:thread_id/stream` | Stream thread events via Server-Sent Events (not implemented) | Threads #12 (line ~883) |

---

### Unit 4: Runs Routes (14 endpoints -- add tags, summary, description)

**File:** `src/modules/runs/runs.routes.ts`
**Route pattern:** `fastify.post()`, `fastify.get()`, `fastify.delete()` (Pattern B)
**Current state:** No `tags`, `summary`, or `description` on any route.
**What to add:** For each of the 14 routes, add `tags: ['Runs']`, `summary`, and `description`.

| # | Line | Method | URL | Summary | Description Source |
|---|------|--------|-----|---------|-------------------|
| 1 | ~49 | POST | `/threads/:thread_id/runs` | Create and execute a run on a thread | Runs #1 (line ~915) |
| 2 | ~67 | POST | `/runs` | Create and execute a stateless run | Runs #2 (line ~960) |
| 3 | ~82 | POST | `/threads/:thread_id/runs/stream` | Create and stream a stateful run via SSE | Runs #3 (line ~1008) |
| 4 | ~99 | POST | `/runs/stream` | Create and stream a stateless run via SSE | Runs #4 (line ~1073) |
| 5 | ~113 | POST | `/threads/:thread_id/runs/wait` | Create a stateful run and wait for completion | Runs #5 (line ~1131) |
| 6 | ~131 | POST | `/runs/wait` | Create a stateless run and wait for completion | Runs #6 (line ~1180) |
| 7 | ~146 | POST | `/runs/batch` | Create multiple stateless runs in a single request | Runs #7 (line ~1225) |
| 8 | ~161 | GET | `/threads/:thread_id/runs` | List all runs for a thread | Runs #8 (line ~1278) |
| 9 | ~180 | GET | `/threads/:thread_id/runs/:run_id` | Retrieve a specific run | Runs #9 (line ~1325) |
| 10 | ~196 | POST | `/threads/:thread_id/runs/:run_id/cancel` | Cancel an in-progress run | Runs #10 (line ~1368) |
| 11 | ~213 | POST | `/runs/cancel` | Cancel multiple runs by filter | Runs #11 (line ~1405) |
| 12 | ~227 | GET | `/threads/:thread_id/runs/:run_id/join` | Wait for an existing run to complete | Runs #12 (line ~1453) |
| 13 | ~243 | GET | `/threads/:thread_id/runs/:run_id/stream` | Join an existing run's SSE stream | Runs #13 (line ~1484) |
| 14 | ~270 | DELETE | `/threads/:thread_id/runs/:run_id` | Delete a run record | Runs #14 (line ~1521) |

**Insertion pattern (Pattern B):**
```typescript
fastify.post('/threads/:thread_id/runs', {
  schema: {
    tags: ['Runs'],
    summary: 'Create and execute a run on a thread',
    description: '...multi-line description from investigation doc...',
    params: ThreadIdOnlyParamSchema,
    body: RunCreateRequestSchema,
    response: { 200: RunSchema },
  },
}, async (request, reply) => { ... });
```

---

### Unit 5: Crons Routes (6 endpoints -- add description only)

**File:** `src/modules/crons/crons.routes.ts`
**Route pattern:** Pattern B
**Current state:** Already has `tags: ['Crons']` and `summary` on all 6 routes. Only `description` is missing.
**What to add:** Add `description` field to each route's `schema` object, below the existing `summary`.

| # | Line | Method | URL | Existing Summary | Description Source |
|---|------|--------|-----|-----------------|-------------------|
| 1 | ~36 | POST | `/threads/:thread_id/runs/crons` | Create a stateful cron job bound to a thread | Crons #1 (line ~1558) |
| 2 | ~56 | POST | `/runs/crons` | Create a stateless cron job | Crons #2 (line ~1614) |
| 3 | ~74 | DELETE | `/runs/crons/:cron_id` | Delete a cron job | Crons #3 (line ~1673) |
| 4 | ~92 | PATCH | `/runs/crons/:cron_id` | Update a cron job | Crons #4 (line ~1705) |
| 5 | ~112 | POST | `/runs/crons/search` | Search cron jobs | Crons #5 (line ~1745) |
| 6 | ~143 | POST | `/runs/crons/count` | Count cron jobs | Crons #6 (line ~1799) |

---

### Unit 6: Store Routes (5 endpoints -- add description only)

**File:** `src/modules/store/store.routes.ts`
**Route pattern:** Pattern B
**Current state:** Already has `tags: ['Store']` and `summary` on all 5 routes. Only `description` is missing.
**What to add:** Add `description` field to each route's `schema` object.

| # | Line | Method | URL | Existing Summary | Description Source |
|---|------|--------|-----|-----------------|-------------------|
| 1 | ~36 | PUT | `/store/items` | Put (create or update) an item in the store | Store #1 (line ~1831) |
| 2 | ~61 | GET | `/store/items` | Get an item from the store by namespace and key | Store #2 (line ~1880) |
| 3 | ~94 | DELETE | `/store/items` | Delete an item from the store | Store #3 (line ~1927) |
| 4 | ~111 | POST | `/store/items/search` | Search items in the store | Store #4 (line ~1968) |
| 5 | ~138 | POST | `/store/namespaces` | List namespaces in the store | Store #5 (line ~2020) |

---

### Unit 7: System Routes (2 endpoints -- add description only)

**File:** `src/modules/system/system.routes.ts`
**Route pattern:** Pattern B
**Current state:** Already has `tags: ['System']` and `summary` on both routes. Only `description` is missing.
**What to add:** Add `description` field to each route's `schema` object.

| # | Line | Method | URL | Existing Summary | Description Source |
|---|------|--------|-----|-----------------|-------------------|
| 1 | ~19 | GET | `/ok` | Health check | System #1 (line ~2074) |
| 2 | ~34 | GET | `/info` | Server information and capabilities | System #2 (line ~2107) |

---

## 3. Implementation Order

All 7 units are independent and can be implemented in any order or in parallel. A recommended sequence for a single developer:

1. **Unit 1** (Swagger plugin) -- smallest change, quick win, establishes tag groups in UI
2. **Unit 7** (System) -- 2 endpoints, simplest, good for validating the pattern
3. **Unit 6** (Store) -- 5 endpoints, description-only additions
4. **Unit 5** (Crons) -- 6 endpoints, description-only additions
5. **Unit 2** (Assistants) -- 11 endpoints, full additions (tags + summary + description)
6. **Unit 3** (Threads) -- 12 endpoints, full additions
7. **Unit 4** (Runs) -- 14 endpoints, full additions, largest unit

---

## 4. Description Content Guidelines

### Format
- Descriptions are plain text strings in TypeScript template literals or regular strings.
- Swagger UI renders markdown in descriptions, so markdown can be used sparingly (bold, lists, code blocks).
- Use `\n` for line breaks within string literals, or use template literals (backtick strings) for readability.

### Content Structure (per endpoint)
1. **Purpose statement** (1-2 sentences): What the endpoint does.
2. **LangGraph context** (1-2 sentences): How this maps to LangGraph Platform concepts.
3. **Usage guidance** (1-3 sentences): When and why a client would call this endpoint.
4. **Behavioral notes** (as needed): Pagination, streaming, side effects, prerequisites.

### Content Source
All description text comes from `docs/reference/investigation-swagger-endpoint-descriptions.md`. The investigation doc provides full-length descriptions that should be adapted (potentially shortened) for Swagger. The key adaptation rules:
- Remove code examples with markdown code blocks (they render poorly in some Swagger UI versions).
- Remove comparison tables (markdown tables do not render in all Swagger UIs).
- Keep the content informative but concise -- aim for 3-8 sentences per endpoint.
- Retain LangGraph Platform context references.

---

## 5. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Long description strings break Fastify schema compilation | LOW | Server fails to start | Test after each unit: `npm run dev` and check `/docs` |
| Markdown in descriptions renders incorrectly in Swagger UI | LOW | Visual issues only, no functional impact | Use plain text primarily; test rendering in `/docs` |
| Special characters in descriptions (backticks, quotes, backslashes) cause TypeScript syntax errors | MEDIUM | Build failure | Use template literals (backtick strings) to avoid escaping issues; run `npm run build` after each unit |
| Adding `tags` to routes that previously had none changes Swagger UI grouping | LOW | Endpoints move to new groups in UI (expected behavior) | This is the desired outcome; verify all 50 endpoints appear under correct groups |
| Descriptions reference features that lg-api does not implement | MEDIUM | Misleading documentation | Review descriptions against actual route handlers; add "(implementation-dependent)" qualifiers where needed |

---

## 6. Verification Plan

### After each unit:
1. **TypeScript compilation:** `npm run build` -- must succeed with no errors
2. **Server startup:** `npm run dev` -- server must start without errors
3. **Swagger UI check:** Navigate to `http://localhost:<port>/docs` and verify:
   - Tag groups appear in the sidebar with descriptions (after Unit 1)
   - Endpoints appear under the correct tag group
   - Summary is visible in the endpoint list
   - Description is visible when expanding an endpoint

### After all units complete:
4. **Full test suite:** `npm test` -- all existing tests must pass without modification
5. **Endpoint count:** Verify all 50 endpoints are documented in Swagger UI
6. **Spot-check descriptions:** Manually review 5-10 descriptions for accuracy and readability
7. **No functional regressions:** Execute a few API calls (e.g., health check, create assistant, search threads) to confirm behavior is unchanged

---

## 7. Acceptance Criteria

1. All 50 endpoints display `tags`, `summary`, and `description` in the Swagger UI.
2. Every description references relevant LangGraph Platform concepts.
3. Descriptions explain purpose, usage scenarios, and behavioral notes.
4. The Swagger UI tag groups (sidebar) have top-level descriptions for all 6 groups.
5. No functional regressions -- the server starts and all endpoints work as before.
6. The existing test suite passes without modification.
7. `npm run build` succeeds with no TypeScript errors.

---

## 8. Estimated Effort

| Unit | Endpoints | Complexity | Estimated Time |
|------|-----------|-----------|---------------|
| Unit 1 (Swagger plugin) | N/A | Low | 15 min |
| Unit 2 (Assistants) | 11 | Medium (full additions) | 30 min |
| Unit 3 (Threads) | 12 | Medium (full additions) | 30 min |
| Unit 4 (Runs) | 14 | Medium (full additions) | 35 min |
| Unit 5 (Crons) | 6 | Low (description only) | 15 min |
| Unit 6 (Store) | 5 | Low (description only) | 15 min |
| Unit 7 (System) | 2 | Low (description only) | 10 min |
| Verification | -- | -- | 20 min |
| **Total** | **50** | -- | **~2.5 hours** |

---

## 9. Files Summary

| # | File | Change Type |
|---|------|------------|
| 1 | `src/plugins/swagger.plugin.ts` | Add `tags` array with 6 tag descriptions |
| 2 | `src/modules/assistants/assistants.routes.ts` | Add `tags`, `summary`, `description` to 11 routes |
| 3 | `src/modules/threads/threads.routes.ts` | Add `tags`, `summary`, `description` to 12 routes |
| 4 | `src/modules/runs/runs.routes.ts` | Add `tags`, `summary`, `description` to 14 routes |
| 5 | `src/modules/crons/crons.routes.ts` | Add `description` to 6 routes |
| 6 | `src/modules/store/store.routes.ts` | Add `description` to 5 routes |
| 7 | `src/modules/system/system.routes.ts` | Add `description` to 2 routes |
