# Codebase Scan: Agent-Assistant Integration

**Date:** 2026-03-10
**Purpose:** Map existing code relevant to the agent-assistant integration change defined in `docs/reference/refined-request-agent-assistant-integration.md`.

---

## 1. Module Map

### 1.1 Agent System (`src/agents/`)

#### `src/agents/types.ts` (lines 1-69)

**Key symbols:**

| Symbol | Line | Kind | Description |
|--------|------|------|-------------|
| `AgentMessage` | 12-15 | interface | `{ role: 'user' \| 'assistant' \| 'system'; content: string }` |
| `AgentDocument` | 20-25 | interface | `{ id, title?, content, metadata? }` |
| `AgentRequest` | 30-38 | interface | Stdin payload: `{ thread_id, run_id, assistant_id, messages, documents?, state?, metadata? }` |
| `AgentResponse` | 43-49 | interface | Stdout payload: `{ thread_id, run_id, messages, state?, metadata? }` |
| `AgentStreamEvent` | 55-58 | interface | `{ event: 'metadata'\|'values'\|'messages'\|'end'\|'error', data: unknown }` |
| `AgentConfig` | 63-69 | interface | **Current (flat, CLI-only):** `{ command, args, cwd, timeout, description? }` |

**Integration impact:** `AgentConfig` must be refactored into a discriminated union (`CliAgentConfig | ApiAgentConfig`) with a `type` field and a `name` field added. This is the central type change.

---

#### `src/agents/agent-registry.ts` (lines 1-151)

**Key symbols:**

| Symbol | Line | Kind | Description |
|--------|------|------|-------------|
| `RawAgentEntry` | 17-23 | interface | Raw YAML shape: `{ command, args?, cwd?, timeout?, description? }` |
| `RawRegistryFile` | 28-30 | interface | `{ agents: Record<string, RawAgentEntry> }` |
| `AgentRegistry` | 42-151 | class | Singleton-style, loads on construction |
| `AgentRegistry.agents` | 43 | field | `Map<string, AgentConfig>` -- the in-memory map |
| `AgentRegistry.constructor()` | 49-51 | method | Calls `this.load()` synchronously |
| `AgentRegistry.getAgentConfig(graphId)` | 57-59 | method | Returns `AgentConfig \| null` |
| `AgentRegistry.getRegisteredGraphIds()` | 64-66 | method | Returns `string[]` of all keys |
| `AgentRegistry.load()` | 77-97 | private | Reads YAML, iterates entries, calls `validateAndRegister` |
| `AgentRegistry.resolveConfigPath()` | 103-125 | private | Env var `AGENT_REGISTRY_PATH` or auto-detect `agent-registry.yaml` |
| `AgentRegistry.validateAndRegister()` | 130-149 | private | Validates `command` field, builds `AgentConfig`, sets in map |

**Integration impact:**
- `RawAgentEntry` must expand to include `type?`, `name?`, `url?`, `method?`, `headers?`.
- `validateAndRegister()` must handle polymorphic validation (cli vs api).
- Backward compat: if `type` is absent, default to `'cli'`.
- `getAgentConfig()` return type changes from `AgentConfig` to the new union type.

---

#### `src/agents/cli-connector.ts` (lines 1-210)

**Key symbols:**

| Symbol | Line | Kind | Description |
|--------|------|------|-------------|
| `CliAgentConnector` | 26-210 | class | Spawns CLI child processes |
| `CliAgentConnector.registry` | 28 | field | `AgentRegistry` -- used for config lookup |
| `CliAgentConnector.executeAgent(graphId, request)` | 40-146 | method | Looks up config from registry, spawns child process, reads stdout JSON |
| `CliAgentConnector.streamAgent(graphId, request)` | 155-209 | async generator | Calls `executeAgent()`, wraps response into `AgentStreamEvent` sequence: metadata -> values -> messages -> end |

**Current coupling:** Both methods take `graphId: string` and do internal registry lookup (line 41: `this.registry.getAgentConfig(graphId)`). The connector **owns** the registry lookup.

**Integration impact:**
- Must implement an `IAgentConnector` interface.
- Signature changes: should accept `CliAgentConfig` directly (config is resolved externally by `AgentExecutor`), rather than doing its own registry lookup.
- The `spawn` logic (lines 51-145) stays unchanged but references `config.command`, `config.args`, `config.cwd`, `config.timeout` -- these fields remain in `CliAgentConfig`.

**SSE event mapping in `streamAgent()` (lines 180-208):**
```typescript
// values event: maps role to LangGraph type
messages: response.messages.map((msg) => ({
  type: msg.role === 'assistant' ? 'ai' : msg.role === 'user' ? 'human' : 'system',
  content: msg.content,
}))

// messages event: maps to chunk types
type: msg.role === 'assistant' ? 'AIMessageChunk' : 'HumanMessageChunk'
```

---

#### `src/agents/request-composer.ts` (lines 1-247)

**Key symbols:**

| Symbol | Line | Kind | Description |
|--------|------|------|-------------|
| `ComposeRequestParams` | 14-20 | interface | `{ threadId, runId, assistantId, input: Record<string,unknown>, threadState?: Record<string,unknown> }` |
| `RequestComposer` | 22-247 | class | Stateless, builds `AgentRequest` from run context |
| `RequestComposer.composeRequest(params)` | 32-76 | method | Main entry: extracts messages from state + input, documents, state, metadata |
| `extractMessagesFromState()` | 85-99 | private | Reads `threadState.values.messages` array, normalizes each |
| `extractMessagesFromInput()` | 106-115 | private | Reads `input.messages` array |
| `normalizeMessage()` | 123-150 | private | Handles both `role`-based and LangGraph `type`-based message formats |
| `extractState()` | 214-233 | private | Priority: `input.state` > `threadState.state` (pass-through, no merging) |

**Integration impact:** None -- used as-is per the refined request. Called by the new `AgentExecutor` with `threadState` from `threadStorage.getState()`.

---

### 1.2 Run Execution (`src/modules/runs/`)

#### `src/modules/runs/runs.service.ts` (lines 1-449)

**Key symbols:**

| Symbol | Line | Kind | Description |
|--------|------|------|-------------|
| `RunsService` | 38-449 | class | Business logic for all run operations |
| `RunsService.constructor(runsRepository, threadsRepository)` | 42-48 | constructor | Takes `RunsRepository` and `ThreadsRepository` |
| `RunsService.streamManager` | 39 | field | `StreamManager` instance (private) |
| `RunsService.streamEmitter` | 40 | field | `RunStreamEmitter` instance (private) |
| `createStateful(threadId, request)` | 54-113 | method | Creates run, sets thread busy, **stub**: `setImmediate` with 100ms delay -> success |
| `createStateless(request)` | 118-159 | method | Creates run without thread, **stub**: `setImmediate` -> success |
| `wait(threadId, request)` | 322-354 | method | Creates run, **stub**: 200ms delay, returns hardcoded `"This is a stub response from the LG-API server."` |
| `streamRun(threadId, request, reply)` | 359-403 | method | Creates run, transitions to running, calls `streamEmitter.streamRun()` (stub events), transitions to success |
| `createBatch(requests)` | 164-171 | method | Calls `createStateless()` for each |

**Stub response location (line 345-352):**
```typescript
result: {
  messages: [
    {
      type: 'ai',
      content: 'This is a stub response from the LG-API server.',
      id: generateId(),
    },
  ],
},
```

**Integration impact -- this is the primary modification target:**
- Constructor must accept `AgentExecutor`, `AssistantResolver`, and the thread storage (for state retrieval).
- `createStateful()`: must resolve assistant, compose request, execute agent, update thread state.
- `createStateless()`: same but without thread state retrieval.
- `wait()`: must execute agent synchronously, return real response instead of stub.
- `streamRun()`: must stream real agent events instead of stub emitter.
- The `setImmediate` pattern in `createStateful`/`createStateless` (for fire-and-forget) must be replaced with real agent execution.

---

#### `src/modules/runs/runs.routes.ts` (lines 1-380)

**Key symbols:**

| Symbol | Line | Kind | Description |
|--------|------|------|-------------|
| `registerRunRoutes(fastify)` | 42-379 | function | Registers all 14 run endpoints |
| Service instantiation | 43-44 | code | `const { runs, threads } = getRepositoryRegistry(); const runsService = new RunsService(runs, threads);` |

**Critical code at lines 43-44:**
```typescript
const { runs: runsRepository, threads: threadsRepository } = getRepositoryRegistry();
const runsService = new RunsService(runsRepository, threadsRepository);
```

**Integration impact:** Must inject `AgentExecutor` and `AssistantResolver` into `RunsService`. These dependencies need to be obtained from somewhere accessible at route registration time. Options:
1. Pass them through Fastify's `decorate()` mechanism.
2. Export them from a shared module (like the registry pattern).
3. Create them inline (requires access to `AgentRegistry` and `IAssistantStorage`).

---

#### `src/modules/runs/runs.streaming.ts` (lines 1-216)

**Key symbols:**

| Symbol | Line | Kind | Description |
|--------|------|------|-------------|
| `RunStreamEmitter` | 22-216 | class | Generates and writes SSE events |
| `RunStreamEmitter.constructor(streamManager)` | 23 | constructor | Takes `StreamManager` |
| `streamRun(reply, run, streamModes, lastEventId?)` | 31-90 | method | Sets SSE headers, emits metadata -> mode events -> end |
| `emitModeEvent(reply, session, mode, run)` | 95-186 | private | Switch on mode: `values`, `updates`, `messages`, etc. -- all return **hardcoded stub data** |
| `emit(reply, session, event, data)` | 191-205 | private | Buffers event in session, writes to `reply.raw` |
| `writeEvent(reply, event)` | 210-215 | private | Writes SSE format: `event: ...\ndata: ...\nid: ...\n\n` |

**Stub data example (lines 103-111):**
```typescript
case 'values':
  await this.emit(reply, session, 'values', {
    messages: [
      {
        type: 'ai',
        content: 'This is a stub response from the LG-API server.',
        id: generateId(),
      },
    ],
  });
```

**Integration impact:** The `emitModeEvent` method must be replaced or the entire `streamRun` method must accept real `AgentStreamEvent`s from the connector instead of generating stubs. Two approaches:
1. Replace `RunStreamEmitter.streamRun()` to accept an `AsyncGenerator<AgentStreamEvent>` and map those events to SSE writes.
2. Keep the emitter but pass real data into it.

---

### 1.3 Assistant System (`src/modules/assistants/`)

#### `src/modules/assistants/assistants.service.ts` (lines 1-325)

**Key symbols:**

| Symbol | Line | Kind | Description |
|--------|------|------|-------------|
| `CreateAssistantParams` | 14-23 | interface | `{ graph_id, assistant_id?, config?, context?, metadata?, if_exists?, name?, description? }` |
| `AssistantsService` | 57-325 | class | CRUD + version management |
| `AssistantsService.create(params)` | 66-129 | method | Handles `if_exists` logic (`raise`/`do_nothing`/`update`), creates with `generateId()`, sets default name `assistant-${id.substring(0,8)}` |
| `AssistantsService.search(params)` | 189-206 | method | Supports `graph_id` filter via `filters.graph_id` |

**Integration impact:** The auto-registration function will call the assistant storage's `search()` with `graph_id` filter to check for existing assistants, then `create()` to add new ones. It does NOT need to go through `AssistantsService` -- it can use `IAssistantStorage` directly to avoid circular dependencies.

---

#### `src/modules/assistants/assistants.repository.ts` (lines 1-96)

**Key symbols:**

| Symbol | Line | Kind | Description |
|--------|------|------|-------------|
| `Assistant` | 12-23 | interface (inline) | `{ assistant_id, graph_id, config, context?, created_at, updated_at, metadata, version, name, description }` |
| `AssistantsRepository` | 25-96 | class | Extends `InMemoryRepository<Assistant>` |
| `searchByGraphId(graphId, options)` | 32-34 | method | `this.search(options, { graph_id: graphId })` -- **directly usable for FR-04 graph_id lookup** |

**Integration impact:** The `searchByGraphId` method is available and directly usable for the `AssistantResolver` to find assistants by `graph_id`. However, note the storage interface (`IAssistantStorage`) does NOT expose `searchByGraphId` -- it only has `search(options, filters)`. The resolver must use the generic `search()` with `{ graph_id: value }` filter.

---

### 1.4 Storage & Initialization

#### `src/app.ts` (lines 1-56)

**Key symbols:**

| Symbol | Line | Kind | Description |
|--------|------|------|-------------|
| `buildApp(config)` | 24-56 | function | Creates Fastify instance, initializes storage, registers plugins and routes |

**Current startup sequence (lines 33-53):**
```
1. await initializeStorage()            // line 34
2. addHook('onClose', closeStorage)     // line 37-39
3. register(corsPlugin)                 // line 42
4. register(swaggerPlugin)              // line 43
5. register(errorHandlerPlugin)         // line 44
6. register(authPlugin)                 // line 45
7. register(assistantsRoutes)           // line 48
8. register(threadsRoutes)              // line 49
9. register(runsRoutes)                 // line 50
10. register(cronsRoutes)               // line 51
11. register(storeRoutes)               // line 52
12. register(systemRoutes)              // line 53
```

**Integration impact:** Auto-registration must be inserted between step 1 and step 2 (or between 1 and 7). The refined request specifies: after `initializeStorage()`, before route registration. The new call will be:
```typescript
await initializeStorage();
const agentRegistry = new AgentRegistry();
await autoRegisterAssistants(agentRegistry, getStorageProvider().assistants);
// ... register routes
```

---

#### `src/repositories/registry.ts` (lines 1-130)

**Key symbols:**

| Symbol | Line | Kind | Description |
|--------|------|------|-------------|
| `initializeStorage()` | 38-43 | function | Loads YAML config, creates provider, stores in module-level `storageProvider` |
| `getStorageProvider()` | 49-54 | function | Returns `IStorageProvider`, throws if not initialized |
| `closeStorage()` | 60-66 | function | Closes provider, nullifies references |
| `RepositoryRegistry` | 72-78 | interface | `{ assistants, threads, runs, crons, store }` |
| `getRepositoryRegistry()` | 94-120 | function | Bridges `storageProvider` interfaces to old repository types via `as unknown as` casts |

**Integration impact:** The `AgentExecutor`, `AssistantResolver`, and `AgentRegistry` instances need to be accessible at route registration time. Options:
1. Extend `RepositoryRegistry` to include them.
2. Create a parallel singleton (e.g., `getAgentExecutor()`).
3. Pass them through Fastify decoration from `buildApp()`.

The cleanest approach per existing patterns: extend the registry or create dedicated module-level singletons in `src/agents/`.

---

#### `src/storage/interfaces.ts` -- `IAssistantStorage` (lines 51-63)

```typescript
export interface IAssistantStorage {
  create(assistant: Assistant): Promise<Assistant>;
  getById(assistantId: string): Promise<Assistant | null>;
  update(assistantId: string, updates: Partial<Assistant>): Promise<Assistant | null>;
  delete(assistantId: string): Promise<boolean>;
  search(options: SearchOptions, filters?: Record<string, unknown>): Promise<SearchResult<Assistant>>;
  count(filters?: Record<string, unknown>): Promise<number>;
  getVersions(assistantId: string, limit?: number, offset?: number): Promise<SearchResult<Assistant>>;
  addVersion(assistantId: string, version: Assistant): Promise<void>;
  setLatestVersion(assistantId: string, version: number): Promise<Assistant | null>;
}
```

**Key observation:** The `search()` method accepts `filters?: Record<string, unknown>`. The in-memory implementation (`filterByFields`) does shallow equality matching on top-level fields. This means `search({ limit: 10, offset: 0 }, { graph_id: 'passthrough' })` will correctly find assistants by `graph_id`.

**Important:** The `create()` method signature takes `(assistant: Assistant)` (single arg), while the old `InMemoryRepository.create()` takes `(id, item)`. The `compat.ts` bridge (mentioned in CLAUDE.md memory) resolves this. The auto-registration must use the storage interface signature: `create(assistant)`.

---

### 1.5 Thread State (`src/modules/threads/`)

#### `src/modules/threads/threads.service.ts` (lines 1-344)

**Key symbols:**

| Symbol | Line | Kind | Description |
|--------|------|------|-------------|
| `ThreadsService.getState(threadId)` | 251-277 | method | Returns `ThreadState` from repository, or generates a dummy initial state if none exists |
| `ThreadsService.updateState(threadId, params)` | 282-323 | method | Creates new `ThreadState` entry with checkpoint, calls `repository.addState()`, updates thread `values` |

**Thread state structure (`ThreadState` from `threads.repository.ts` lines 23-42):**
```typescript
interface ThreadState {
  values: Record<string, unknown>;     // <-- messages live here as values.messages
  next: string[];
  checkpoint: { thread_id, checkpoint_ns, checkpoint_id, checkpoint_map? };
  metadata: Record<string, unknown>;
  created_at: string;
  parent_checkpoint: { ... } | null;
  tasks: Array<Record<string, any>>;
}
```

**Integration impact for post-agent-execution state update:**
After agent execution, the run pipeline must:
1. Get current state: `threadStorage.getState(threadId)`
2. Build new state with combined messages (history + user input + agent response)
3. Call `threadStorage.addState(threadId, newState)` with a proper `ThreadState` object including checkpoint, metadata, etc.
4. Update thread: `threadStorage.update(threadId, { values: newState.values, updated_at: nowISO() })`

The `RequestComposer.extractMessagesFromState()` reads from `threadState.values.messages`, so the messages must be stored at that path.

---

## 2. Current Data Flow

### 2.1 Run Creation (Stateful) -- Current Stub Flow

```
Client: POST /threads/:thread_id/runs  { assistant_id, input, ... }
  |
  v
runs.routes.ts:67 --> runsService.createStateful(thread_id, request.body)
  |
  v
runs.service.ts:54-113  createStateful():
  1. threadsRepository.getById(threadId) -- verify thread exists
  2. Build Run object { run_id: uuid, status: 'pending', ... }
  3. runsRepository.create(run_id, run)
  4. threadsRepository.update(threadId, { status: 'busy' })
  5. runsRepository.update(run_id, { status: 'running' })
  6. setImmediate(() => {
       delay(100ms)
       runsRepository.update(run_id, { status: 'success' })    // NO AGENT CALL
       threadsRepository.update(threadId, { status: 'idle' })
     })
  7. Return created run (status: 'pending')
```

**No assistant lookup. No agent invocation. No state update.**

### 2.2 Stream Run -- Current Stub Flow

```
Client: POST /threads/:thread_id/runs/stream  { assistant_id, input, stream_mode }
  |
  v
runs.routes.ts:111-114 --> runsService.streamRun(thread_id, request.body, reply)
  |
  v
runs.service.ts:359-403  streamRun():
  1. createStateful() or createStateless() -- creates run record
  2. runsRepository.update(run_id, { status: 'running' })
  3. streamEmitter.streamRun(reply, run, streamModes)
     |
     v  runs.streaming.ts:31-90  streamRun():
     |  1. reply.raw.writeHead(200, SSE headers)
     |  2. streamManager.createSession(run_id, thread_id, streamModes)
     |  3. emit('metadata', { run_id, thread_id })
     |  4. For each mode: emitModeEvent() -- HARDCODED STUB DATA
     |  5. emit('end', null)
     |  6. reply.raw.end()
  4. runsRepository.update(run_id, { status: 'success' })
  5. threadsRepository.update(threadId, { status: 'idle' })
```

### 2.3 Wait Run -- Current Stub Flow

```
Client: POST /threads/:thread_id/runs/wait  { assistant_id, input }
  |
  v
runs.routes.ts:157-160 --> runsService.wait(thread_id, request.body)
  |
  v
runs.service.ts:322-354  wait():
  1. createStateful() or createStateless()
  2. delay(200ms)
  3. Return { run_id, thread_id, status: 'success',
       result: { messages: [{ type: 'ai', content: 'STUB RESPONSE' }] }
     }
```

---

## 3. Integration Points

### 3.1 Files to Modify

| File | What Changes | Key Symbols Affected |
|------|-------------|---------------------|
| `src/agents/types.ts` | Refactor `AgentConfig` to discriminated union, add `name` field | `AgentConfig` (line 63) |
| `src/agents/agent-registry.ts` | Parse `type`, `name`, `url`, `method`, `headers`; backward compat | `RawAgentEntry` (line 17), `validateAndRegister()` (line 130) |
| `src/agents/cli-connector.ts` | Implement `IAgentConnector`, accept `CliAgentConfig` instead of `graphId` | `CliAgentConnector.executeAgent()` (line 40), `.streamAgent()` (line 155) |
| `src/modules/runs/runs.service.ts` | Replace stubs with real agent execution | `createStateful()` (line 54), `createStateless()` (line 118), `wait()` (line 322), `streamRun()` (line 359), constructor (line 42) |
| `src/modules/runs/runs.streaming.ts` | Replace stub events with real agent stream data | `emitModeEvent()` (line 95), possibly `streamRun()` (line 31) |
| `src/modules/runs/runs.routes.ts` | Inject new dependencies into RunsService | Line 43-44 (service construction) |
| `src/app.ts` | Add auto-registration step after storage init | After line 34 (`initializeStorage()`) |
| `agent-registry.yaml` | Add `type` and `name` fields | Lines 8-13 |
| `src/repositories/registry.ts` | Expose agent executor/registry for route modules | `getRepositoryRegistry()` or new exports |

### 3.2 Files to Create

| File | Purpose |
|------|---------|
| `src/agents/interfaces.ts` | `IAgentConnector` interface |
| `src/agents/api-connector.ts` | HTTP-based agent connector |
| `src/agents/connector-factory.ts` | Selects connector by `AgentConfig.type` |
| `src/agents/agent-executor.ts` | Central orchestrator: registry lookup -> connector -> execution |
| `src/agents/assistant-auto-register.ts` | Startup auto-registration logic |
| `src/agents/assistant-resolver.ts` | Resolves `assistant_id` or `graph_id` to `Assistant` entity |

### 3.3 Exact Modification Points

**`src/agents/types.ts` line 63-69** -- Replace:
```typescript
export interface AgentConfig {
  command: string;
  args: string[];
  cwd: string;
  timeout: number;
  description?: string;
}
```
With the discriminated union (BaseAgentConfig, CliAgentConfig, ApiAgentConfig).

**`src/agents/agent-registry.ts` line 17-23** -- Expand `RawAgentEntry`:
```typescript
interface RawAgentEntry {
  command: string;  // currently required -- must become conditional
  // Add: type?, name?, url?, method?, headers?
}
```

**`src/agents/agent-registry.ts` line 130-149** -- `validateAndRegister()` must branch on `type`:
- `'cli'` (or absent): validate `command` required
- `'api'`: validate `url` required

**`src/agents/cli-connector.ts` line 40-41** -- Change signature from:
```typescript
async executeAgent(graphId: string, request: AgentRequest): Promise<AgentResponse>
```
To accept config directly:
```typescript
async executeAgent(config: CliAgentConfig, request: AgentRequest): Promise<AgentResponse>
```
And remove the internal registry lookup at line 41-47.

**`src/modules/runs/runs.service.ts` line 42-48** -- Expand constructor:
```typescript
constructor(
  private runsRepository: RunsRepository,
  private threadsRepository: ThreadsRepository,
  // Add: private agentExecutor: AgentExecutor,
  // Add: private assistantResolver: AssistantResolver,
  // Add: private requestComposer: RequestComposer,
  // Add: private threadStorage: IThreadStorage,  (for getState/addState)
)
```

**`src/modules/runs/runs.service.ts` line 96-110** -- Replace the `setImmediate` stub block in `createStateful()` with real agent execution.

**`src/modules/runs/runs.service.ts` line 345-352** -- Replace the hardcoded stub response in `wait()`.

**`src/modules/runs/runs.routes.ts` line 43-44** -- Expand service construction to include new dependencies.

**`src/app.ts` after line 34** -- Insert auto-registration:
```typescript
await initializeStorage();
// INSERT HERE:
// const agentRegistry = new AgentRegistry();
// await autoRegisterAssistants(agentRegistry, getStorageProvider().assistants);
```

**`src/schemas/run.schema.ts` line 25** -- Note: `assistant_id` is currently `Type.String({ format: 'uuid' })`. For FR-04 (graph_id aliasing), this format constraint must be relaxed to `Type.String()` to allow non-UUID graph_id strings.

---

## 4. Patterns and Conventions

### 4.1 Coding Conventions

- **Module structure:** Each domain module has `*.routes.ts` (Fastify plugin), `*.service.ts` (business logic class), `*.repository.ts` (data access class).
- **Service construction:** Services are instantiated in route files, not globally. Dependencies are obtained via `getRepositoryRegistry()`.
- **Error handling:** Throws `ApiError(statusCode, message)` from `src/errors/api-error.ts`. The `error-handler.plugin.ts` catches these.
- **ID generation:** `generateId()` from `src/utils/uuid.util.ts`.
- **Timestamps:** `nowISO()` from `src/utils/date.util.ts`.
- **Cloning:** `structuredClone()` used extensively in repositories.
- **Imports:** All use `.js` extensions in import paths (ESM requirement).
- **Type exports:** Entity types defined in `src/types/index.ts` via `Static<typeof Schema>`, but repositories also define inline types (legacy, noted as issue P1).

### 4.2 Error Handling Pattern

```typescript
// Throw ApiError for client errors
throw new ApiError(404, `Thread ${threadId} not found`);
throw new ApiError(409, `Assistant ${id} already exists`);

// Agent errors should become ApiError(500, ...) or ApiError(400, ...) at the service level
```

### 4.3 Import Patterns

```typescript
// Storage interfaces
import type { IAssistantStorage } from '../../storage/interfaces.js';

// Repository registry (deprecated but still used)
import { getRepositoryRegistry } from '../../repositories/registry.js';

// Storage provider
import { getStorageProvider } from '../../repositories/registry.js';

// Agent types
import type { AgentRequest, AgentResponse, AgentStreamEvent } from './types.js';

// Utils
import { generateId } from '../../utils/uuid.util.js';
import { nowISO } from '../../utils/date.util.js';
import { ApiError } from '../../errors/api-error.js';
```

### 4.4 SSE Streaming Pattern

```typescript
// Set headers
reply.raw.writeHead(200, {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
});

// Write events
reply.raw.write(`event: ${event}\n`);
reply.raw.write(`data: ${JSON.stringify(data)}\n`);
reply.raw.write(`id: ${id}\n`);
reply.raw.write('\n');

// End
reply.raw.end();
```

### 4.5 Async Generator Pattern (from `cli-connector.ts`)

```typescript
async *streamAgent(graphId: string, request: AgentRequest): AsyncGenerator<AgentStreamEvent> {
  yield { event: 'metadata', data: { ... } };
  const response = await this.executeAgent(graphId, request);
  yield { event: 'values', data: { ... } };
  yield { event: 'end', data: null };
}
```

---

## 5. Dependencies

### 5.1 Internal Dependency Graph

```
runs.routes.ts
  imports: RunsService, getRepositoryRegistry, schemas

RunsService
  imports: RunsRepository, ThreadsRepository, RunStreamEmitter, StreamManager
  imports: ApiError, generateId, nowISO

RunStreamEmitter
  imports: StreamManager, StreamMode, Run, generateId, nowISO

CliAgentConnector
  imports: AgentRegistry, AgentRequest, AgentResponse, AgentStreamEvent
  imports: child_process.spawn, path.resolve

AgentRegistry
  imports: AgentConfig (from types.ts)
  imports: fs.readFileSync, fs.existsSync, path.resolve, yaml.parse

RequestComposer
  imports: AgentRequest, AgentMessage, AgentDocument (from types.ts)

app.ts
  imports: initializeStorage, closeStorage (from repositories/registry.ts)
  imports: all route modules, all plugins
```

### 5.2 New Dependencies After Integration

```
app.ts
  NEW: imports AgentRegistry, autoRegisterAssistants
  NEW: imports getStorageProvider (already available)

runs.routes.ts
  NEW: imports AgentExecutor, AssistantResolver, RequestComposer
  NEW: imports getStorageProvider (for threadStorage)

RunsService
  NEW: imports AgentExecutor, AssistantResolver, RequestComposer, IThreadStorage

AgentExecutor (NEW)
  imports: AgentRegistry, ConnectorFactory, AgentRequest, AgentResponse

ConnectorFactory (NEW)
  imports: IAgentConnector, CliAgentConnector, ApiAgentConnector, AgentConfig

ApiAgentConnector (NEW)
  imports: IAgentConnector, AgentRequest, AgentResponse, AgentStreamEvent, ApiAgentConfig

AssistantResolver (NEW)
  imports: IAssistantStorage, Assistant, ApiError
```

### 5.3 External Package Dependencies

| Package | Used By | Status |
|---------|---------|--------|
| `node:child_process` | `CliAgentConnector` | Existing |
| `yaml` | `AgentRegistry` | Existing |
| `node:fs`, `node:path` | `AgentRegistry` | Existing |
| Native `fetch` (Node 18+) | `ApiAgentConnector` (new) | **New** -- no npm package needed |

---

## 6. Schema Constraint Issue

**`src/schemas/run.schema.ts` line 25:**
```typescript
assistant_id: Type.String({ format: 'uuid' }),
```

This enforces UUID format validation on the `assistant_id` field in `RunCreateRequestSchema`. FR-04 requires `assistant_id` to accept **both** UUIDs and `graph_id` strings (e.g., `"passthrough"`). This format constraint must be relaxed to `Type.String()` for the request schema only (the `RunSchema` entity can keep UUID format since actual runs always store a real assistant UUID).

---

**End of Codebase Scan**
