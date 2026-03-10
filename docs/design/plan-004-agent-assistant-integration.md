# Plan 004: Agent-Assistant Integration

**Project:** lg-api
**Date:** 2026-03-10
**Status:** Draft
**Depends On:** Existing agent system (`src/agents/`), storage layer (`src/storage/`), run execution pipeline (`src/modules/runs/`)

---

## Objective

Wire the existing agent system (AgentRegistry, CliAgentConnector, RequestComposer) into the run execution pipeline so that run creation endpoints invoke real agents instead of returning hardcoded stub responses. Additionally, introduce auto-registration of assistants from the agent registry on startup and add support for API-based agents alongside CLI agents.

---

## Reference Documents

| Document | Location |
|----------|----------|
| Requirements (FR-01 to FR-07) | `docs/reference/refined-request-agent-assistant-integration.md` |
| Investigation & Patterns | `docs/reference/investigation-agent-integration.md` |
| Codebase Scan | `docs/reference/codebase-scan-agent-integration.md` |
| Project Design | `docs/design/project-design.md` |

---

## Summary of Changes

- **9 files modified**, **6 new files created**, **7+ test files created**
- Refactor `AgentConfig` from flat interface to discriminated union
- Introduce `IAgentConnector` interface with Strategy pattern
- Create `ApiAgentConnector` for HTTP-based agents
- Auto-register assistants from `agent-registry.yaml` on startup
- Replace all stub responses in `RunsService` with real agent execution
- Relax `assistant_id` UUID constraint to support graph_id aliasing

---

## Phase 1: Foundation -- Agent Types Refactor

**Goal:** Establish the new type system and update existing consumers.
**Dependencies:** None (can start immediately).
**Estimated effort:** Small.

### Steps

| Step | Description | File | Action |
|------|-------------|------|--------|
| 1.1 | Refactor `AgentConfig` into a discriminated union with `BaseAgentConfig`, `CliAgentConfig`, `ApiAgentConfig` | `src/agents/types.ts` | Modify |
| 1.2 | Add `name` field to `BaseAgentConfig` | `src/agents/types.ts` | Modify |
| 1.3 | Expand `RawAgentEntry` to include `type?`, `name?`, `url?`, `method?`, `headers?` | `src/agents/agent-registry.ts` | Modify |
| 1.4 | Refactor `validateAndRegister()` to branch on `type` field: validate `command` for CLI, `url` for API; default `type` to `'cli'` when absent | `src/agents/agent-registry.ts` | Modify |
| 1.5 | Add environment variable substitution for `headers` values in API agent entries (reuse pattern from `yaml-config-loader.ts`) | `src/agents/agent-registry.ts` | Modify |
| 1.6 | Update `agent-registry.yaml` to include explicit `type: cli` and `name` fields for the passthrough agent | `agent-registry.yaml` | Modify |

### Exact Modification Points

**`src/agents/types.ts` lines 63-69** -- Replace the flat `AgentConfig` interface:

```typescript
// BEFORE (current)
export interface AgentConfig {
  command: string;
  args: string[];
  cwd: string;
  timeout: number;
  description?: string;
}

// AFTER (discriminated union)
export interface BaseAgentConfig {
  type: string;
  name?: string;
  description?: string;
  timeout: number;
}

export interface CliAgentConfig extends BaseAgentConfig {
  type: 'cli';
  command: string;
  args: string[];
  cwd: string;
}

export interface ApiAgentConfig extends BaseAgentConfig {
  type: 'api';
  url: string;
  method: string;
  headers: Record<string, string>;
}

export type AgentConfig = CliAgentConfig | ApiAgentConfig;
```

**`src/agents/agent-registry.ts` lines 17-23** -- Expand `RawAgentEntry`:

```typescript
interface RawAgentEntry {
  type?: 'cli' | 'api';
  name?: string;
  description?: string;
  timeout?: number;
  // CLI fields
  command?: string;
  args?: string[];
  cwd?: string;
  // API fields
  url?: string;
  method?: string;
  headers?: Record<string, string>;
}
```

**`src/agents/agent-registry.ts` lines 130-149** -- Refactor `validateAndRegister()`:

```typescript
private validateAndRegister(graphId: string, entry: RawAgentEntry): void {
  const type = entry.type || 'cli'; // Backward compatibility

  if (type === 'cli') {
    if (!entry.command) {
      throw new Error(`Agent '${graphId}': 'command' is required for CLI agents`);
    }
    const config: CliAgentConfig = {
      type: 'cli',
      name: entry.name,
      description: entry.description,
      command: entry.command,
      args: entry.args || [],
      cwd: entry.cwd || '.',
      timeout: entry.timeout || 60000,
    };
    this.agents.set(graphId, config);
  } else if (type === 'api') {
    if (!entry.url) {
      throw new Error(`Agent '${graphId}': 'url' is required for API agents`);
    }
    const config: ApiAgentConfig = {
      type: 'api',
      name: entry.name,
      description: entry.description,
      url: entry.url,
      method: entry.method || 'POST',
      headers: this.substituteEnvVars(entry.headers || {}),
      timeout: entry.timeout || 60000,
    };
    this.agents.set(graphId, config);
  } else {
    throw new Error(`Agent '${graphId}': unknown type '${type}'`);
  }
}
```

### Acceptance Criteria

- [x] `AgentConfig` is a discriminated union with `type` field
- [x] Existing `agent-registry.yaml` without `type` field still parses correctly (defaults to `cli`)
- [x] `AgentRegistry.getAgentConfig()` returns the union type
- [x] TypeScript compiles with no errors (`npm run build`)
- [x] API agent entries with `${ENV_VAR}` in headers are substituted at load time

---

## Phase 2: Polymorphic Connectors

**Goal:** Create the `IAgentConnector` interface, refactor `CliAgentConnector`, create `ApiAgentConnector`, build `ConnectorFactory` and `AgentExecutor`.
**Dependencies:** Phase 1 (requires the discriminated union types).
**Estimated effort:** Medium.

### Steps

| Step | Description | File | Action |
|------|-------------|------|--------|
| 2.1 | Create `IAgentConnector` interface | `src/agents/interfaces.ts` | **Create** |
| 2.2 | Refactor `CliAgentConnector` to implement `IAgentConnector`; change signatures from `(graphId, request)` to `(config, request)`; remove internal registry lookup | `src/agents/cli-connector.ts` | Modify |
| 2.3 | Create `ApiAgentConnector` implementing `IAgentConnector`; use native `fetch` with `AbortSignal.timeout()` | `src/agents/api-connector.ts` | **Create** |
| 2.4 | Create `ConnectorFactory` with exhaustiveness-checked switch on `config.type` | `src/agents/connector-factory.ts` | **Create** |
| 2.5 | Create `AgentExecutor` orchestrator: registry lookup, connector selection, execution | `src/agents/agent-executor.ts` | **Create** |

### New File: `src/agents/interfaces.ts`

```typescript
import type { AgentConfig, AgentRequest, AgentResponse, AgentStreamEvent } from './types.js';

export interface IAgentConnector {
  executeAgent(config: AgentConfig, request: AgentRequest): Promise<AgentResponse>;
  streamAgent(config: AgentConfig, request: AgentRequest): AsyncGenerator<AgentStreamEvent>;
}
```

### Refactoring: `src/agents/cli-connector.ts`

**Lines 40-41** -- Change method signature:

```typescript
// BEFORE
async executeAgent(graphId: string, request: AgentRequest): Promise<AgentResponse> {
  const config = this.registry.getAgentConfig(graphId);

// AFTER
async executeAgent(config: CliAgentConfig, request: AgentRequest): Promise<AgentResponse> {
  // Config is passed in directly, no registry lookup
```

**Lines 155-156** -- Same for `streamAgent`:

```typescript
// BEFORE
async *streamAgent(graphId: string, request: AgentRequest): AsyncGenerator<AgentStreamEvent> {

// AFTER
async *streamAgent(config: CliAgentConfig, request: AgentRequest): AsyncGenerator<AgentStreamEvent> {
```

**Constructor** -- Remove the `registry` dependency:

```typescript
// BEFORE
constructor(private registry: AgentRegistry) {}

// AFTER (no constructor dependency, or remove constructor entirely)
// The class becomes stateless -- it just executes based on the config passed in
```

### New File: `src/agents/api-connector.ts`

Key implementation details:
- Uses native `fetch` (Node.js 18+, no external dependency)
- `AbortSignal.timeout(config.timeout)` for timeout handling
- Error mapping: HTTP 4xx/5xx -> `ApiError(502, ...)`, timeout -> `ApiError(504, ...)`, network -> `ApiError(502, ...)`
- `streamAgent()` calls `executeAgent()` synchronously, wraps response into `AgentStreamEvent` sequence (metadata -> values -> messages -> end) -- identical pattern to `CliAgentConnector.streamAgent()`

### New File: `src/agents/connector-factory.ts`

```typescript
export class ConnectorFactory {
  constructor(
    private cliConnector: CliAgentConnector,
    private apiConnector: ApiAgentConnector
  ) {}

  getConnector(config: AgentConfig): IAgentConnector {
    switch (config.type) {
      case 'cli': return this.cliConnector;
      case 'api': return this.apiConnector;
      default:
        const _exhaustive: never = config;
        throw new Error(`Unknown agent type: ${(config as any).type}`);
    }
  }
}
```

### New File: `src/agents/agent-executor.ts`

```typescript
export class AgentExecutor {
  constructor(
    private registry: AgentRegistry,
    private connectorFactory: ConnectorFactory
  ) {}

  async execute(graphId: string, request: AgentRequest): Promise<AgentResponse> {
    const config = this.registry.getAgentConfig(graphId);
    if (!config) {
      throw new ApiError(400, `No agent registered for graph_id '${graphId}'. Check agent-registry.yaml.`);
    }
    const connector = this.connectorFactory.getConnector(config);
    return connector.executeAgent(config, request);
  }

  async *stream(graphId: string, request: AgentRequest): AsyncGenerator<AgentStreamEvent> {
    const config = this.registry.getAgentConfig(graphId);
    if (!config) {
      throw new ApiError(400, `No agent registered for graph_id '${graphId}'. Check agent-registry.yaml.`);
    }
    const connector = this.connectorFactory.getConnector(config);
    yield* connector.streamAgent(config, request);
  }
}
```

### Acceptance Criteria

- [x] `IAgentConnector` interface is defined with `executeAgent` and `streamAgent`
- [x] `CliAgentConnector` implements `IAgentConnector`, no longer depends on `AgentRegistry`
- [x] `ApiAgentConnector` implements `IAgentConnector`, handles timeout/network/HTTP errors
- [x] `ConnectorFactory` selects correct connector with exhaustiveness checking
- [x] `AgentExecutor` orchestrates registry lookup + connector selection + execution
- [x] TypeScript compiles with no errors
- [x] No external npm packages added (native `fetch` used)

---

## Phase 3: Auto-Registration

**Goal:** Auto-create default assistants from `agent-registry.yaml` on startup, and create the `AssistantResolver` for graph_id aliasing.
**Dependencies:** Phase 1 (requires updated `AgentRegistry` with `name` field). Independent of Phase 2.
**Estimated effort:** Medium.

### Steps

| Step | Description | File | Action |
|------|-------------|------|--------|
| 3.1 | Create `AssistantResolver` -- resolves `assistant_id` (UUID) or `graph_id` (string) to an `Assistant` entity | `src/agents/assistant-resolver.ts` | **Create** |
| 3.2 | Create `autoRegisterAssistants()` function -- iterates agent registry, creates default assistants idempotently | `src/agents/assistant-auto-register.ts` | **Create** |
| 3.3 | Relax `assistant_id` UUID format constraint in `RunCreateRequestSchema` to `Type.String()` (allow graph_id strings) | `src/schemas/run.schema.ts` | Modify |
| 3.4 | Wire auto-registration into `buildApp()` via Fastify `onReady` hook, after `initializeStorage()` | `src/app.ts` | Modify |

### New File: `src/agents/assistant-resolver.ts`

Resolution logic:
1. Try `assistantStorage.getById(value)` -- UUID lookup
2. If not found, try `assistantStorage.search({limit: 10, offset: 0}, {graph_id: value})` filtering for `metadata.auto_registered === true`
3. If multiple matches: use earliest `created_at` (original default)
4. If no match: throw `ApiError(404, "No assistant found for identifier '<value>'")`

### New File: `src/agents/assistant-auto-register.ts`

Key behaviors:
- Iterates `agentRegistry.getRegisteredGraphIds()`
- For each `graphId`: search assistant storage for existing assistant with matching `graph_id`
- If none found: create a new assistant with `metadata: { auto_registered: true, agent_type: config.type, agent_config: sanitized(config) }`
- Sensitive header values redacted in stored `agent_config` (auth/key headers replaced with `***`)
- Error in one agent does NOT block others (try/catch per agent)
- Logging: INFO for new, DEBUG for existing, ERROR for failures

### Schema Change: `src/schemas/run.schema.ts` line 25

```typescript
// BEFORE
assistant_id: Type.String({ format: 'uuid' }),

// AFTER
assistant_id: Type.String(),
```

This change is in `RunCreateRequestSchema` only. The `RunSchema` entity can keep UUID format since actual run records always store the resolved assistant UUID.

### Wiring in `src/app.ts`

Insert after `initializeStorage()` (current line 34), before route registration:

```typescript
// Auto-register assistants from agent registry
fastify.addHook('onReady', async function () {
  try {
    const agentRegistry = new AgentRegistry();
    const storageProvider = getStorageProvider();
    this.log.info('Auto-registering assistants from agent-registry.yaml...');
    await autoRegisterAssistants(agentRegistry, storageProvider.assistants, this.log);
    this.log.info('Assistant auto-registration complete');
  } catch (error) {
    this.log.error({ error }, 'Assistant auto-registration failed');
    // Do not throw -- server should still start
  }
});
```

### Acceptance Criteria

- [x] On startup with a fresh storage, one assistant per agent is created
- [x] On restart, no duplicate assistants are created (idempotent)
- [x] Auto-registered assistants have `metadata.auto_registered: true` and `metadata.agent_config`
- [x] `AssistantResolver` resolves UUIDs and graph_id strings
- [x] `RunCreateRequestSchema` accepts non-UUID `assistant_id` values
- [x] One agent registration failure does not block others
- [x] TypeScript compiles with no errors

---

## Phase 4: Pipeline Wiring

**Goal:** Replace all stub responses in `RunsService` and `RunStreamEmitter` with real agent execution, thread state updates, and SSE streaming.
**Dependencies:** Phases 1, 2, and 3 (requires all new components).
**Estimated effort:** Large -- this is the core integration phase.

### Steps

| Step | Description | File | Action |
|------|-------------|------|--------|
| 4.1 | Expand `RunsService` constructor to accept `AgentExecutor`, `AssistantResolver`, `RequestComposer`, thread storage | `src/modules/runs/runs.service.ts` | Modify |
| 4.2 | Create private helper `executeAgentForRun()` -- composes request, executes agent, updates thread state | `src/modules/runs/runs.service.ts` | Modify |
| 4.3 | Wire `createStateful()`: resolve assistant, execute agent in background via `setImmediate`, update thread state on completion | `src/modules/runs/runs.service.ts` | Modify |
| 4.4 | Wire `wait()`: resolve assistant, execute agent synchronously, return real result (remove 200ms delay and stub) | `src/modules/runs/runs.service.ts` | Modify |
| 4.5 | Wire `streamRun()`: resolve assistant, compose request, stream real agent events via `AgentExecutor.stream()`, update thread state | `src/modules/runs/runs.service.ts` | Modify |
| 4.6 | Wire `createStateless()`: same as `createStateful` but without thread state retrieval | `src/modules/runs/runs.service.ts` | Modify |
| 4.7 | Update `RunStreamEmitter` to accept real `AgentStreamEvent[]` or integrate the streaming directly in `RunsService.streamRun()` | `src/modules/runs/runs.streaming.ts` | Modify |
| 4.8 | Update `RunsService` construction in `runs.routes.ts` -- inject `AgentExecutor`, `AssistantResolver`, `RequestComposer`, thread storage | `src/modules/runs/runs.routes.ts` | Modify |
| 4.9 | Expose `AgentExecutor`, `AssistantResolver`, and `AgentRegistry` as module-level singletons accessible from route modules | `src/repositories/registry.ts` | Modify |

### Detailed Modifications

#### `src/modules/runs/runs.service.ts` -- Constructor (line 42-48)

```typescript
// BEFORE
constructor(
  private runsRepository: RunsRepository,
  private threadsRepository: ThreadsRepository
)

// AFTER
constructor(
  private runsRepository: RunsRepository,
  private threadsRepository: ThreadsRepository,
  private agentExecutor: AgentExecutor,
  private assistantResolver: AssistantResolver,
  private requestComposer: RequestComposer,
  private threadStorage: IThreadStorage
)
```

#### `src/modules/runs/runs.service.ts` -- New private helper

```typescript
private async executeAgentForRun(
  threadId: string | null,
  runId: string,
  graphId: string,
  input: Record<string, unknown>
): Promise<{ messages: Array<{ type: string; content: string }> }> {
  // 1. Get thread state (if stateful)
  const threadState = threadId
    ? await this.threadStorage.getState(threadId)
    : null;

  // 2. Compose agent request
  const agentRequest = this.requestComposer.composeRequest({
    threadId: threadId || runId,
    runId,
    assistantId: graphId,
    input,
    threadState: threadState?.values || {},
  });

  // 3. Execute agent
  const agentResponse = await this.agentExecutor.execute(graphId, agentRequest);

  // 4. Update thread state (if stateful)
  if (threadId) {
    await this.updateThreadState(threadId, input, agentResponse, threadState);
  }

  // 5. Return result in LangGraph format
  return {
    messages: agentResponse.messages.map(msg => ({
      type: msg.role === 'assistant' ? 'ai' : msg.role === 'user' ? 'human' : 'system',
      content: msg.content,
    })),
  };
}
```

#### `src/modules/runs/runs.service.ts` -- `createStateful()` (lines 96-110)

Replace the `setImmediate` stub block:

```typescript
// BEFORE (stub)
setImmediate(async () => {
  await delay(100);
  await this.runsRepository.update(run.run_id, { status: 'success', updated_at: nowISO() });
  await this.threadsRepository.update(threadId, { status: 'idle', updated_at: nowISO() });
});

// AFTER (real execution)
setImmediate(async () => {
  try {
    await this.runsRepository.update(run.run_id, { status: 'running', updated_at: nowISO() });
    await this.executeAgentForRun(threadId, run.run_id, assistant.graph_id, request.input || {});
    await this.runsRepository.update(run.run_id, { status: 'success', updated_at: nowISO() });
    await this.threadsRepository.update(threadId, { status: 'idle', updated_at: nowISO() });
  } catch (error: any) {
    await this.runsRepository.update(run.run_id, { status: 'error', updated_at: nowISO() });
    await this.threadsRepository.update(threadId, { status: 'error', updated_at: nowISO() });
    // Log error -- fire-and-forget, cannot throw to client
  }
});
```

#### `src/modules/runs/runs.service.ts` -- `wait()` (lines 322-354)

Replace the 200ms delay and stub response:

```typescript
// BEFORE (stub)
await delay(200);
return {
  ...run,
  status: 'success',
  result: { messages: [{ type: 'ai', content: 'STUB RESPONSE' }] },
};

// AFTER (real execution)
const assistant = await this.assistantResolver.resolve(request.assistant_id);
const run = await this.createRunRecord(threadId, assistant.assistant_id, request);
try {
  const result = await this.executeAgentForRun(threadId, run.run_id, assistant.graph_id, request.input || {});
  await this.runsRepository.update(run.run_id, { status: 'success', updated_at: nowISO() });
  if (threadId) {
    await this.threadsRepository.update(threadId, { status: 'idle', updated_at: nowISO() });
  }
  return { ...run, status: 'success', result };
} catch (error: any) {
  await this.runsRepository.update(run.run_id, { status: 'error', updated_at: nowISO() });
  throw error;
}
```

#### `src/modules/runs/runs.service.ts` -- `streamRun()` (lines 359-403)

Replace the stub emitter with real agent streaming:

```typescript
// 1. Resolve assistant
const assistant = await this.assistantResolver.resolve(request.assistant_id);
// 2. Create run record
const run = await this.createRunRecord(threadId, assistant.assistant_id, request);
// 3. Set SSE headers
reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', ... });
// 4. Get thread state and compose request
const threadState = threadId ? await this.threadStorage.getState(threadId) : null;
const agentRequest = this.requestComposer.composeRequest({ ... });
// 5. Stream agent events
for await (const event of this.agentExecutor.stream(assistant.graph_id, agentRequest)) {
  this.writeSSE(reply, event.event, event.data, run.run_id);
}
// 6. Update thread state with final response
// 7. reply.raw.end()
```

#### `src/modules/runs/runs.routes.ts` (lines 43-44)

```typescript
// BEFORE
const { runs: runsRepository, threads: threadsRepository } = getRepositoryRegistry();
const runsService = new RunsService(runsRepository, threadsRepository);

// AFTER
const { runs: runsRepository, threads: threadsRepository } = getRepositoryRegistry();
const storageProvider = getStorageProvider();
const agentRegistry = new AgentRegistry();
const cliConnector = new CliAgentConnector();
const apiConnector = new ApiAgentConnector();
const connectorFactory = new ConnectorFactory(cliConnector, apiConnector);
const agentExecutor = new AgentExecutor(agentRegistry, connectorFactory);
const assistantResolver = new AssistantResolver(storageProvider.assistants);
const requestComposer = new RequestComposer();
const runsService = new RunsService(
  runsRepository, threadsRepository,
  agentExecutor, assistantResolver, requestComposer,
  storageProvider.threads
);
```

**Alternative (cleaner):** Create the `AgentExecutor`, `AssistantResolver`, etc. once in `src/repositories/registry.ts` (or a new `src/agents/index.ts` barrel) as module-level singletons, and export getter functions (`getAgentExecutor()`, `getAssistantResolver()`). This avoids recreating them per route module and keeps the wiring centralized.

#### `src/repositories/registry.ts`

Add new exports for agent system singletons:

```typescript
let agentExecutor: AgentExecutor | null = null;
let assistantResolver: AssistantResolver | null = null;

export function getAgentExecutor(): AgentExecutor { ... }
export function getAssistantResolver(): AssistantResolver { ... }

// Initialize after storage init
export function initializeAgentSystem(): void {
  const agentRegistry = new AgentRegistry();
  const cliConnector = new CliAgentConnector();
  const apiConnector = new ApiAgentConnector();
  const connectorFactory = new ConnectorFactory(cliConnector, apiConnector);
  agentExecutor = new AgentExecutor(agentRegistry, connectorFactory);
  assistantResolver = new AssistantResolver(getStorageProvider().assistants);
}
```

### Thread State Update

After agent execution, the pipeline must:
1. Get current thread state via `threadStorage.getState(threadId)`
2. Extract existing messages from `state.values.messages`
3. Construct user message from `input.messages[0]`
4. Append agent response messages (mapped to LangGraph `ai`/`human` types)
5. Build new `ThreadState` with checkpoint, parent_checkpoint, etc.
6. Call `threadStorage.addState(threadId, newState)`
7. Update thread `values` for quick access: `threadStorage.update(threadId, { values: newState.values })`

### Acceptance Criteria

- [x] `POST /threads/:id/runs` creates a run and executes the agent in the background
- [x] `POST /threads/:id/runs/wait` returns real agent response (not stub)
- [x] `POST /threads/:id/runs/stream` streams real agent events via SSE
- [x] `POST /runs/stream` and `POST /runs/wait` work for stateless runs
- [x] Thread state is updated with conversation history after agent execution
- [x] Run status transitions: `pending` -> `running` -> `success` (or `error`)
- [x] Thread status transitions: `idle` -> `busy` -> `idle` (or `error`)
- [x] `assistant_id` accepts both UUID and graph_id string
- [x] Missing agent for a graph_id returns HTTP 400 with descriptive message
- [x] Missing assistant for an ID returns HTTP 404 with descriptive message
- [x] TypeScript compiles with no errors

---

## Phase 5: Testing

**Goal:** Comprehensive unit and integration tests for all new and modified components.
**Dependencies:** Phases 1-4 (all implementation complete).
**Estimated effort:** Medium.

### Steps

| Step | Description | File | Action |
|------|-------------|------|--------|
| 5.1 | Unit tests for `AgentRegistry` with polymorphic types (CLI, API, backward compat) | `test_scripts/agent-registry.test.ts` | **Create** |
| 5.2 | Unit tests for `ApiAgentConnector` (success, timeout, HTTP error, network error, invalid JSON) | `test_scripts/api-connector.test.ts` | **Create** |
| 5.3 | Unit tests for `ConnectorFactory` (CLI selection, API selection, exhaustiveness) | `test_scripts/connector-factory.test.ts` | **Create** |
| 5.4 | Unit tests for `AgentExecutor` (execute, stream, missing agent error) | `test_scripts/agent-executor.test.ts` | **Create** |
| 5.5 | Unit tests for `autoRegisterAssistants` (new creation, idempotent skip, error isolation) | `test_scripts/auto-register.test.ts` | **Create** |
| 5.6 | Unit tests for `AssistantResolver` (UUID lookup, graph_id lookup, multiple matches, not found) | `test_scripts/assistant-resolver.test.ts` | **Create** |
| 5.7 | Integration test: full run pipeline with passthrough agent (requires agent installed) | `test_scripts/run-pipeline-integration.test.ts` | **Create** |

### Test Strategy

- **Unit tests** (5.1-5.6): Mock dependencies (storage, fetch, child_process). Focus on logic and error handling.
- **Integration test** (5.7): Uses real passthrough agent, requires `agents/passthrough/node_modules` installed and Azure OpenAI env vars set. Can be skipped in CI if env vars not available.
- **Framework:** Vitest (existing project convention)
- **Mocking:** Vitest `vi.mock()` and `vi.fn()` for storage interfaces and external calls

### Verification Criteria (All Phases)

| Check | Command | Expected |
|-------|---------|----------|
| TypeScript compilation | `npm run build` | No errors |
| Test suite | `npm test` | All tests pass |
| Existing tests | `npm test` | No regressions in existing 170 tests |
| Server startup | `npm run dev` | Starts successfully, logs assistant auto-registration |
| Stub elimination | Search for "stub response" | No occurrences in production code |

---

## Dependency Graph

```
Phase 1: Foundation (Types Refactor)
  |
  +---> Phase 2: Polymorphic Connectors
  |       |
  |       +---+
  |           |
  +---> Phase 3: Auto-Registration
  |       |
  |       +---+
  |           |
  |           v
  +---> Phase 4: Pipeline Wiring  (depends on 1 + 2 + 3)
              |
              v
        Phase 5: Testing  (depends on 4)
```

**Parallelization:** Phases 2 and 3 can be developed in parallel after Phase 1 is complete. They have no cross-dependencies. Phase 4 requires all of 1, 2, and 3.

---

## Files Summary

### Files to Create (6)

| File | Phase | Description |
|------|-------|-------------|
| `src/agents/interfaces.ts` | 2 | `IAgentConnector` interface |
| `src/agents/api-connector.ts` | 2 | HTTP-based agent connector |
| `src/agents/connector-factory.ts` | 2 | Agent type -> connector routing |
| `src/agents/agent-executor.ts` | 2 | Central orchestrator |
| `src/agents/assistant-auto-register.ts` | 3 | Startup auto-registration |
| `src/agents/assistant-resolver.ts` | 3 | UUID/graph_id resolution |

### Files to Modify (9)

| File | Phase | Description |
|------|-------|-------------|
| `src/agents/types.ts` | 1 | Discriminated union for `AgentConfig` |
| `src/agents/agent-registry.ts` | 1 | Polymorphic parsing, backward compat |
| `src/agents/cli-connector.ts` | 2 | Implement `IAgentConnector`, accept config directly |
| `src/modules/runs/runs.service.ts` | 4 | Replace all stubs with real execution |
| `src/modules/runs/runs.streaming.ts` | 4 | Accept real agent stream events |
| `src/modules/runs/runs.routes.ts` | 4 | Inject new dependencies |
| `src/app.ts` | 3 | Add `onReady` hook for auto-registration |
| `src/schemas/run.schema.ts` | 3 | Relax `assistant_id` UUID constraint |
| `src/repositories/registry.ts` | 4 | Expose agent system singletons |
| `agent-registry.yaml` | 1 | Add `type` and `name` fields |

### Test Files to Create (7)

| File | Phase | Scope |
|------|-------|-------|
| `test_scripts/agent-registry.test.ts` | 5 | AgentRegistry polymorphic types |
| `test_scripts/api-connector.test.ts` | 5 | ApiAgentConnector |
| `test_scripts/connector-factory.test.ts` | 5 | ConnectorFactory |
| `test_scripts/agent-executor.test.ts` | 5 | AgentExecutor |
| `test_scripts/auto-register.test.ts` | 5 | autoRegisterAssistants |
| `test_scripts/assistant-resolver.test.ts` | 5 | AssistantResolver |
| `test_scripts/run-pipeline-integration.test.ts` | 5 | End-to-end pipeline |

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `CliAgentConnector` refactor breaks existing code | Compilation errors | Phase 2 updates all consumers; the only caller is `CliAgentConnector` itself (internal registry lookup) |
| `RunCreateRequestSchema` format relaxation allows invalid data | Bad `assistant_id` values pass validation | `AssistantResolver` validates at runtime; TypeBox still validates it is a string |
| Nested `metadata.auto_registered` filter not supported by all storage providers | Auto-registration search returns wrong results | In-memory provider does shallow equality; may need to add top-level `auto_registered` field or filter client-side |
| Thread state update race condition on concurrent runs | Interleaved messages | Document as known limitation; out of scope for this plan (requires optimistic locking) |
| Agent timeout blocks `wait` endpoint | Client timeout | Agent timeout is configurable; default 60s; document that `wait` can take as long as the agent's timeout |

---

## Open Decisions

| # | Question | Recommendation |
|---|----------|----------------|
| 1 | Where to instantiate agent system singletons? | Option A: Extend `registry.ts` with `initializeAgentSystem()`. Option B: New `src/agents/index.ts` barrel with singletons. **Recommend Option A** for consistency with existing pattern. |
| 2 | Should `RunStreamEmitter` be kept or bypassed? | The `streamRun()` method in `RunsService` can write SSE events directly, bypassing `RunStreamEmitter` entirely. The emitter class can remain for backward compatibility but its `emitModeEvent()` stub methods become dead code. **Recommend bypassing** and documenting the emitter as deprecated. |
| 3 | Should `metadata.auto_registered` filter be stored as top-level field? | If nested metadata filtering proves problematic across storage providers, add `auto_registered: boolean` as a top-level field on the `Assistant` entity. **Defer** until testing reveals an issue. |

---

## Revision History

| Date | Version | Description |
|------|---------|-------------|
| 2026-03-10 | 1.0 | Initial plan created from refined requirements and investigation |
