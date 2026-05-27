# Issues - Pending Items

## Pending Items

### P1 - Repositories use local inline types instead of shared types from types/index.ts
- **Files**: `src/modules/assistants/assistants.repository.ts`, `src/modules/threads/threads.repository.ts`, `src/modules/runs/runs.repository.ts`, `src/modules/crons/crons.repository.ts`, `src/modules/store/store.repository.ts`
- **Description**: Each repository defines its own inline interface (e.g., `Assistant`, `Thread`, `Run`, `Cron`, `Item`) with comments saying "will be replaced with the shared type from types/index.ts". The shared types exist in `src/types/index.ts` but are not used by repositories or services. This creates a risk of type drift between the schema-derived types and the inline types.
- **Severity**: Medium
- **Recommendation**: Replace inline interfaces with imports from `src/types/index.ts`.

### P2 - Thread stream endpoint returns 501 instead of proper SSE
- **File**: `src/modules/threads/threads.routes.ts`, line 246
- **Description**: The `GET /threads/:thread_id/stream` endpoint returns a 501 (Not Implemented) with a message that "SSE streaming is handled by the runs module". While the runs module does handle run-based streaming, the LangGraph SDK's `client.threads.stream()` method expects this endpoint to work and return SSE events for the active thread.
- **Severity**: Medium
- **Recommendation**: Implement this endpoint to delegate to the stream manager to join the active run stream for the thread.

### P3 - Crons count endpoint returns `{ count: N }` instead of a plain integer
- **File**: `src/modules/crons/crons.routes.ts`, line 160
- **Description**: The assistants and threads count endpoints return a plain integer, but the crons count endpoint wraps it in `{ count: N }`. This is inconsistent and may cause SDK compatibility issues if the SDK expects a plain integer.
- **Severity**: Low-Medium
- **Recommendation**: Verify the LangGraph SDK expectation and make consistent across all count endpoints.

### P5 - Unused dependency: `better-sse`
- **File**: `package.json`
- **Description**: The `better-sse` package is listed as a dependency but is never imported in any source file. SSE streaming is implemented manually via `reply.raw`.
- **Severity**: Low
- **Recommendation**: Remove from dependencies.

### P6 - `enabled` and `on_run_completed` fields are missing from crons repository's Cron interface
- **File**: `src/modules/crons/crons.repository.ts`
- **Description**: The inline `Cron` type uses `[key: string]: any` as a catch-all which masks this, but `enabled` and `on_run_completed` should be explicitly declared for type safety.
- **Severity**: Low
- **Recommendation**: Add `enabled: boolean` and `on_run_completed?: string` to the inline Cron interface.

### P7 - Run `kwargs` field allows `any` via index signature in repository type
- **File**: `src/modules/runs/runs.repository.ts`
- **Description**: The `Run` interface has `[key: string]: any` which defeats type safety. This allows any property to be set without type checking.
- **Severity**: Low
- **Recommendation**: Remove the index signature and explicitly declare needed fields.

### P8 - `GET /threads/:thread_id/state/:checkpoint_id` endpoint not implemented
- **File**: Refined request FR-02 endpoint #9 mentions this variant
- **Description**: The refined request mentions `GET /threads/{thread_id}/state/{checkpoint_id}` as a variant of the state endpoint. The `GetStateWithCheckpointParamSchema` exists in `thread.schema.ts` but no route uses it.
- **Severity**: Low
- **Recommendation**: Add the route when needed for SDK compatibility testing.

### P11 - `POST /state` message append lacks `add_messages` id-dedup / RemoveMessages fidelity
- **Files**: `src/modules/threads/threads.service.ts` (`updateState`), `src/agents/state-reducer.ts` (`append`)
- **Description**: `POST /threads/:id/state` now appends `messages` via the `append` channel reducer (`DEFAULT_CHANNEL_REDUCERS`), matching LangGraph `update_state`'s reducer routing (state channels still `LastValue`, siblings retained). But `append` is a plain array concat — it does not dedupe/merge by message `id`, nor honor `RemoveMessages`, the way LangGraph's `add_messages` reducer does. A caller that re-sends a message with an existing `id` double-adds it instead of replacing in place. The run path's hand-rolled 3-way concat (`runs.service.updateThreadState`) has the same limitation.
- **Severity**: Low
- **Recommendation**: Only if clients edit/replay messages through `POST /state` or runs — upgrade `append` (or add a dedicated `add_messages`-style reducer) to merge-by-`id` and process `RemoveMessages`, and apply the same reducer to both the manual and run paths. Until then, append + sibling-retention is the documented, intentional behavior.

### P9 - Configuration exception: STORAGE_CONFIG_PATH defaults to file-existence detection
- **File**: `src/storage/yaml-config-loader.ts`
- **Description**: Per project rules, no fallback values are permitted for configuration. However, the storage system needs a way to work without a config file (defaulting to in-memory provider). The approach is: if `STORAGE_CONFIG_PATH` env var is not set, the loader checks if `storage-config.yaml` exists at the project root. If the file exists, it is loaded. If neither the env var nor the file exist, the system defaults to the in-memory provider. This is file-existence detection, not a config fallback -- documented as a deliberate exception per the storage infrastructure design.
- **Severity**: Info (deliberate design decision)

### LG-RUNCREATE-LANGSMITH-TRACING — `langsmith_tracing` field missing from `RunCreateRequestSchema`
- **File**: `src/schemas/run.schema.ts`
- **Description**: The official LangGraph `RunCreate` body accepts a `langsmith_tracing` object that routes traces to a specific project / associates with a dataset example. lg-api's strict TypeBox validator rejects any request that includes it, so SDK clients with tracing enabled get a 400.
- **Severity**: High (breaks any SDK client with tracing)
- **Recommendation**: Add `langsmith_tracing: Type.Optional(Type.Object({...}))` (or `Type.Record(Type.String(), Type.Unknown())` for forward compat) to `RunCreateRequestSchema`.

### LG-HISTORY-BODY-OPTIONAL — `POST /threads/:id/history` requires a request body
- **File**: `src/modules/threads/threads.routes.ts` (route handler), `src/schemas/thread.schema.ts` (`ThreadHistoryRequestSchema`)
- **Description**: The official LangGraph SDK calls `client.threads.get_history(thread_id)` with no filter args; the server defaults `limit=10` and returns. lg-api declares the body as required, so an empty POST without `Content-Type`/body returns 400.
- **Severity**: High (breaks the SDK's most common no-args usage)
- **Recommendation**: Make the body optional. Either wrap the schema in `Type.Optional(...)` at the route, or default `request.body` to `{}` in the handler before passing it to the service. Apply default `limit = 10` server-side.

### LG-THREADID-FORMAT — `format: 'uuid'` enforced on all `/threads/:id/*` routes
- **Files**: `src/schemas/thread.schema.ts` (`ThreadIdParamSchema`), all routes that consume it
- **Description**: lg-api restricts `thread_id` path params to UUIDs; the official LangGraph Platform accepts any string (the SDK's own example uses `"my_thread_id"`). A client passing a non-UUID thread id gets a 400 from lg-api but a 200 from the real server.
- **Severity**: High (breaks SDK example code and any consumer using semantic thread ids)
- **Recommendation**: Drop `format: 'uuid'` from `ThreadIdParamSchema`. Sweep the codebase for any other path-param schemas with the same UUID constraint (`run_id`, `assistant_id` may have the same issue).

### LG-RUNCREATE-CHECKPOINT-ID — top-level `checkpoint_id` is an lg-api extension
- **File**: `src/schemas/run.schema.ts`
- **Description**: `RunCreateRequestSchema` declares a top-level `checkpoint_id: uuid` field. The official `RunCreate` body has only the `checkpoint` object; `checkpoint_id` is a path/query parameter elsewhere (`/threads/:id/history`, `/threads/:id/state/{checkpoint_id}`) but never on `RunCreate`. Harmless for SDK clients (they don't send it), but documenting it as part of the run body misleads consumers.
- **Severity**: Low (no client breaks today)
- **Recommendation**: Remove `checkpoint_id` from the run body schema. If lg-api needs to honor it as a back-compat alias, keep the field but mark it deprecated and accept `checkpoint: { checkpoint_id }` as the canonical form.

### LG-RUNS-KWARGS-GAPS — `kwargs` field on `Run` is loose and missing canonical sub-fields
- **File**: `src/schemas/run.schema.ts` (`RunSchema`), `src/modules/runs/runs.service.ts` (object builders at line 76 area)
- **Description**: `RunSchema.kwargs` is declared `Type.Optional(Type.Record(String, Unknown))` and the service populates only `{input, config, stream_mode, interrupt_before, interrupt_after, webhook}`. Official LangGraph always returns `kwargs` (not optional) and includes `context`, `feedback_keys`, `temporary` alongside the fields above. No SDK client breaks today, but the response is leaner than the spec.
- **Severity**: Low (P3)
- **Recommendation**: Tighten `kwargs` to required, declare its sub-fields explicitly, and populate `context`, `temporary`, `feedback_keys` from the run create request in `createStateful` / `createStateless` / `wait` / `streamRun`.

### LG-WAIT-INTERRUPT-STATUS — `/runs/wait` throws on agent error instead of returning the values
- **File**: `src/modules/runs/runs.service.ts` (`wait()` catch block)
- **Description**: Official `/runs/wait` returns the graph's state values regardless of terminal status (`success`, `error`, `interrupted`); the run record carries the status, the response carries the values. lg-api currently throws on `agentExecutor.execute` failure, sending a 5xx, so clients lose any partial state. After the LG-WAIT-FLATTEN fix this is no longer hidden by the wrapper — it's now visible to callers.
- **Severity**: Medium (chat UIs that want to render error state can't)
- **Recommendation**: On error, still write the run as `status: error`, but return the current `thread.values` (with an appended assistant message describing the error) at the response root, matching the official contract. Stateless runs return whatever partial state the agent produced before failing.

### LG-STREAM-MODE-HONOR — `/runs/stream` ignores the `stream_mode` request field
- **File**: `src/modules/runs/runs.service.ts` (`streamRun()`)
- **Description**: The official LangGraph stream emits events according to `stream_mode` (`values`, `updates`, `messages`, `debug`, `tasks`, `checkpoints`, `events` — any subset). lg-api currently emits `metadata` → `values` → `end` regardless. Clients asking for `updates` or token-by-token `messages` get the wrong events.
- **Severity**: Medium (chat UIs work; SDK clients using non-default modes break)
- **Recommendation**: Read `request.stream_mode` (already in `RunCreateRequestSchema`) and emit only the requested event types. For `messages` mode, the agent's CLI contract must expose token streaming too — track separately as LG-STREAM-LIVE-EXECUTION.

### LG-STREAM-LIVE-EXECUTION — stream is faked: agent runs to completion before any SSE event is emitted
- **File**: `src/modules/runs/runs.service.ts` (`streamRun()` lines 605–650 area), `src/agents/cli-connector.ts`, `src/agents/types.ts` (`AgentStreamEvent`)
- **Description**: `streamRun` currently calls `agentExecutor.execute` (synchronous, returns the full response), then yields one `metadata` + one `values` + one `end` event from the resulting state. The official LangGraph server emits events progressively as the graph executes — one `values` per graph step, one `messages/partial` per LLM token, etc. lg-api's behavior breaks token-by-token chat UIs and any debugger that watches step-by-step state evolution.
- **Severity**: Medium (only matters once a UI/debugger needs live streaming)
- **Recommendation**: Define a streaming agent contract (CLI agent emits one JSON event per stdout line — `{event, data}` records — instead of one final blob). Update `CliAgentConnector.streamAgent` to forward each chunk as it arrives. Update `streamRun` to forward agent events directly to the SSE channel, including `messages/partial` for token chunks. Non-trivial design change; deferred.

### LG-STREAM-END-EVENT — `end: null` terminator is non-canonical
- **File**: `src/modules/runs/runs.service.ts` (`streamRun()` final `yield`)
- **Description**: lg-api emits an explicit `event: end\ndata: null\n\n` event before closing the SSE stream. The official LangGraph server just closes the connection (SSE EOF). Kept deliberately for back-compat with current consumers (e.g. agent-chat-ui) that listen for the `end` marker. Documenting here so it's not lost.
- **Severity**: Low (intentional divergence pending consumer migration)
- **Recommendation**: When consumers no longer rely on `event: end`, drop the terminator and rely on SSE EOF.

---

---

## Completed Items

### LG-WAIT-FLATTEN, LG-WAIT-FULL-STATE, LG-MESSAGE-SCHEMA, LG-STREAM-FLATTEN-VALUES, LG-STREAM-METADATA-PAYLOAD — `/runs/wait` and `/runs/stream` aligned with official LangGraph contract
- **Date**: 2026-05-27
- **Files**: `src/modules/runs/runs.service.ts` (`wait()`, `streamRun()`, `updateThreadState()`, new `toLangChainMessage()` helper), `src/schemas/run.schema.ts` (`RunWaitResponseSchema`), `test_scripts/runs.test.ts`
- **Issue**: `POST /runs/wait` and `POST /threads/:id/runs/wait` returned a non-canonical `{run_id, thread_id, status, result: {messages}}` envelope; the official LangGraph Platform returns the graph's final state values at the response root (e.g. `{messages: [...], <other_state_keys>}`). On the wait response, the wrapper hid `messages` one level deep so the NBG .NET orchestrator (`AgentCommunicationService.SendChatMessageAsync` → `chatResponse.Messages.LastOrDefault(m => m.Type == "ai")`) couldn't find any AI message and fell back to the synthetic `"Error processing request with conversation history"` on every handoff call. The `values` SSE event in `/runs/stream` carried only `{messages: [...]}`, dropping every other state channel (e.g. `organization_name`, `payment_code`, `memory`). Messages were also missing the LangChain shape fields (`additional_kwargs`, `name`, `example`, plus AI-specific `tool_calls`, `invalid_tool_calls`, `usage_metadata`) that the SDK deserializer expects.
- **Fix**: `wait()` return type changed to `Promise<Record<string, unknown>>`; returns the post-run thread `values` at root for stateful runs (read freshly after `updateThreadState`) or a synthesized state for stateless runs. `RunWaitResponseSchema` simplified to `Type.Record(Type.String(), Type.Unknown())`. `streamRun()` `values` event now carries the full state values at root, not just `{messages}`; `metadata` event payload now `{run_id, attempt: 1, thread_id}` per spec (kept `thread_id` for back-compat with agent-chat-ui). New `toLangChainMessage(m)` helper produces the full LangChain message shape and is used by both `wait()`, `streamRun()`, and `updateThreadState()` so every persisted/returned message matches the SDK. Updated the two `runs.test.ts` cases that asserted the old envelope (`result.run_id`, `result.status`, `result.result.messages`) to verify the new flat shape (`body.messages` at root, no `result`/`run_id`). `npx tsc --noEmit` clean; full lg-api suite green (196/196 across 12 files); pre-existing unrelated `skill-agent.test.ts` failures left untouched. agent-chat-ui compatibility preserved (it reads `messages` from each `values` SSE event, which is still present). Production impact: the NBG .NET orchestrator's `/runs/wait` deserialization now finds AI messages, eliminating the `"Error processing request with conversation history"` fallback on handoff calls.



### P10 — Manual `POST /state` flattened to match the canonical convention (divergence closed)
- **Date**: 2026-05-27
- **Files**: `src/modules/threads/threads.service.ts` (`updateState`), `test_scripts/threads.test.ts`, `docs/design/project-design.md`
- **Issue**: After `LG-STATE-CANONICAL` flattened the run path, `threads.service.updateState` still special-cased a **nested** `values.state` blob (spread `params.values`, then per-channel merge an incoming `values.state` over the stored one). A legacy nested `POST /state` (`{ values: { state: {…} } }`) therefore wrote a literal `state` channel that the run composer surfaced to the agent as `{ state: {…} }` (double-nested) — inconsistent with the flat model. It also wiped sibling channels for flat top-level keys (it spread only `params.values`, not the stored values).
- **Fix**: `updateState` now does `reduceChannels(currentValues, params.values)` — a per-channel `LastValue` merge at the **top level** of `values`, matching `runs.service.updateThreadState`. A partial `POST /state` replaces only the channels it names and retains every sibling (including `messages`); the nested `values.state` special-case is gone. Rewrote the two `threads.test.ts` cases that asserted `body.values.state` to the flat shape (assert `body.values` via `toMatchObject` + `not.toHaveProperty('state')`). `npx tsc --noEmit` clean; full suite green except the pre-existing unrelated `skill-agent.test.ts` failures (missing `agents/skill-agent/node_modules`). Every write path (run input → agent, agent → storage, manual `POST /state`) is now consistent and flat. (ADR-0001 is left as the append-only historical record of the original nested per-channel decision; this flatten supersedes it and is recorded here + in `project-design.md`.)

### LG-STATE-CANONICAL — Aligned run state passing with LangGraph "input keys = graph state" convention
- **Date**: 2026-05-27
- **Files**: `src/agents/request-composer.ts`, `src/modules/runs/runs.service.ts`, `test_scripts/agent-connector.test.ts`, `test_scripts/request-composer.test.ts`, `test_scripts/runs.test.ts`, `docs/design/project-design.md`
- **Issue**: lg-api carried a proprietary `input.state` extension. `RequestComposer.extractState` unwrapped an explicit `input.state` (per-channel merging it over the nested `threadState.values.state` blob) and `extractMetadata` spilled every other `input` key into `metadata`; `runs.service.updateThreadState` persisted the agent's returned state nested under `values.state`. This diverged from the canonical LangGraph contract where the run **input itself is the graph state** (every key other than `messages`/`documents`), which broke drop-in parity for SDK clients that send state as flat top-level input keys.
- **Fix (hard cut)**: Removed the `input.state` special-case and `extractMetadata`. `extractState` now inherits the top-level keys of `threadState.values` (minus `messages`/`documents`), folds the input's top-level state keys on top per-channel via the shared `reduceChannels` engine (input wins, omitted siblings retained), and returns `undefined` when empty. `composeRequest` takes a `metadata` param forwarded as-is; all four call sites in `runs.service.ts` pass `metadata: request.metadata ?? {}`. `updateThreadState` now folds `agentResponse.state` into the **top level** of `values` (per-channel), so it round-trips as inherited state next run; `messages` stay a separate manual append. A literal `state` input key is now just a channel — legacy `input.state` callers break loudly, by design. Rewrote the state tests in `agent-connector.test.ts`, `request-composer.test.ts`, and `runs.test.ts` to the flat convention (input keys → state, inherited values → state, input override, top-level `metadata` forwarded). Updated the "Graph state" section of `project-design.md`. `npx tsc --noEmit` clean; full suite green except the pre-existing `skill-agent.test.ts` failures (missing `agents/skill-agent/node_modules`, unrelated). Follow-up divergence on the manual `POST /state` path tracked as P10.

### C7 - Run creation ignored `if_not_exists` and always 404'd on missing thread
- **Files**: `src/modules/runs/runs.service.ts`, `test_scripts/runs.test.ts`
- **Issue**: The `RunCreateRequestSchema` declared `if_not_exists: "create" | "reject"` (`src/schemas/run.schema.ts:54`) and the project docs cited the real LangGraph semantics (`docs/reference/langgraph-api-concepts.md:848`), but `RunsService` never read the field. `createStateful` (line 61), `wait` (line 439), and `streamRun` (line 570) each contained an inline `getById` + `throw new ApiError(404, ...)` block that unconditionally rejected missing threads. Real LangGraph honors `if_not_exists: "create"` and auto-creates the thread, which is why the NBG `agent-proxy` (`Nbg.NetCore.AI.Agents.Common/Models/LangGraph/ChatModels.cs:30-33`, default `"create"`) works against cloud LangGraph but got `{"detail":"Thread <id> not found"}` against lg-api.
- **Fix**: Added a private `RunsService.ensureThread(threadId, ifNotExists)` helper that returns the existing thread, auto-creates it when `ifNotExists === "create"`, or throws 404 otherwise (default — matches real LangGraph). Replaced all three inline 404 sites with calls to the helper threading `request.if_not_exists` through. Added six vitest cases in `test_scripts/runs.test.ts` covering both branches for `createStateful`, `wait`, and `streamRun`.

### C6 - SQLite schema uses unquoted `values` column name (reserved keyword)
- **Files**: `src/storage/providers/sqlite/sqlite-schema.ts`, `src/storage/providers/sqlite/sqlite-thread-storage.ts`
- **Description**: The Thread and ThreadState table DDL and INSERT/UPDATE queries used `values` as a column name without quoting. `VALUES` is a reserved keyword in SQLite, causing "near values: syntax error" on table creation and all queries referencing this column.
- **Fix**: Quoted the column name as `"values"` in the schema DDL (`sqlite-schema.ts`) and in all SQL statements in `sqlite-thread-storage.ts` (INSERT INTO Thread, UPDATE Thread, INSERT INTO ThreadState).

### C4 - TypeBox `$id` fields causing Fastify serializer conflicts
- **Files**: All files in `src/schemas/`
- **Description**: TypeBox schemas with `$id` fields (especially `CheckpointSchema`, `InterruptSchema`, and enum schemas) caused Fastify's `fast-json-stringify` to throw "resolves to more than one schema" when the same schema was embedded inline in multiple response schemas.
- **Fix**: Removed all `$id` fields from TypeBox schemas. They are not needed since schemas are used inline (not via `$ref`).

### C5 - Repository singletons not shared across route modules
- **Files**: All `*.routes.ts` files
- **Description**: Each route module created its own repository instances as module-level singletons. This meant threads created via `POST /threads` were invisible to the runs module which had its own `ThreadsRepository`.
- **Fix**: Created `src/repositories/registry.ts` with a centralized `RepositoryRegistry` singleton. All route modules now use `getRepositoryRegistry()` to get shared instances.



### C1 - Stateless runs used empty string for thread_id instead of null
- **Files**: `src/modules/runs/runs.service.ts`, `src/modules/runs/runs.repository.ts`
- **Description**: The `RunSchema` defines `thread_id` as `string | null`, but the service was setting `thread_id: ''` for stateless runs. The repository's `Run` interface had `thread_id: string` (not nullable).
- **Fix**: Changed repository interface to `thread_id: string | null` and service to use `null`.

### C2 - Store SearchItem schema `score` field changed from required to optional
- **File**: `src/schemas/store.schema.ts`
- **Description**: The `SearchItemSchema` defined `score: Type.Number()` (required), but the repository only assigns `score` when a text query is provided. This would cause runtime serialization failures.
- **Fix**: Changed to `score: Type.Optional(Type.Number())`.

### C3 - Unused imports cleaned up across multiple files
- **Files**: `src/schemas/common.schema.ts`, `src/schemas/assistant.schema.ts`, `src/schemas/thread.schema.ts`, `src/schemas/run.schema.ts`, `src/schemas/cron.schema.ts`, `src/schemas/store.schema.ts`, `src/modules/runs/runs.routes.ts`
- **Description**: Removed unused `Static` imports from all schema files, unused `MetadataSchema`, `GraphSchemaSchema`, `ErrorResponseSchema` from assistant schema, unused `ConfigSchema`, `MetadataSchema` from thread schema, unused `CheckpointSchema` from cron schema, and unused `FastifyRequest`/`FastifyReply` from runs routes.
