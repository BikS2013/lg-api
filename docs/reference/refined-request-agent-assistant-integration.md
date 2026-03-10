# Refined Request: Agent-Assistant Integration

**Date:** 2026-03-10
**Status:** Draft
**Scope:** Auto-registration of assistants from agent-registry.yaml, polymorphic agent connector (CLI + API), and wiring the run execution pipeline end-to-end.

---

## 1. Context and Motivation

### 1.1 Current State

The lg-api currently has two independent subsystems that are **not wired together**:

1. **Assistants API** (fully functional): 11 CRUD endpoints, storage-backed, versioned -- but assistants must be created manually via `POST /assistants`.
2. **Agent System** (built but unused): `AgentRegistry` loads `agent-registry.yaml`, `CliAgentConnector` can spawn agents, `RequestComposer` can build requests -- but nothing in the run execution pipeline calls them.

The run execution pipeline (`RunsService`) currently:
- Creates run records and transitions their status (`pending` -> `running` -> `success`)
- Returns **hardcoded stub responses** ("This is a stub response from the LG-API server.")
- Never looks up the assistant's `graph_id`
- Never invokes any agent

### 1.2 Gap Analysis

| Capability | Official LangGraph | lg-api Current | Gap |
|---|---|---|---|
| Auto-create default assistants on startup | Yes (from `langgraph.json`) | No | **Missing** |
| Resolve `graph_id` to agent backend | Yes (in-process graph) | No (agent registry exists but unused) | **Not wired** |
| Execute agent on run creation | Yes | No (stub response) | **Not wired** |
| Multiple agent transport types | N/A (in-process only) | CLI only (built but unused) | **Needs API transport** |
| Stream agent output via SSE | Yes | Stub SSE events only | **Not wired** |
| Store agent config in assistant | Yes (config/context fields) | Fields exist but unused | **Not wired** |

### 1.3 Official LangGraph Behavior (from investigation)

Per the investigation in `docs/reference/investigation-assistant-registration.md`:

- **Graphs are declared** in `langgraph.json` (analogous to our `agent-registry.yaml`)
- **Default assistants are auto-created** on deployment, one per graph
- **Assistants persist** across restarts with persistent storage; with in-memory storage they are recreated
- **graph_id can be used as assistant_id** in run creation (the server resolves it to the default assistant)
- `if_exists: "do_nothing"` enables idempotent creation (safe to call on every startup)

---

## 2. Requirements

### FR-01: Auto-Registration of Default Assistants on Startup

**On server startup**, the system must:

1. Load `agent-registry.yaml` via the existing `AgentRegistry`
2. For each registered agent entry (keyed by `graph_id`):
   a. Search the assistant storage for an existing assistant with `graph_id` matching the agent key
   b. If no assistant exists with that `graph_id`:
      - Create a new assistant with:
        - `assistant_id`: new UUID
        - `graph_id`: the agent key from the registry
        - `name`: derived from the agent's `name` field (or the agent key if no name)
        - `description`: from the agent's `description` field
        - `metadata`: `{ "auto_registered": true, "agent_type": "<cli|api>" }`
        - `config`: `{}` (empty, default configuration)
      - Log the creation at INFO level
   c. If an assistant already exists with that `graph_id`:
      - Do nothing (idempotent)
      - Log at DEBUG level that the assistant already exists
3. This must happen **after** storage initialization and **before** the HTTP server starts accepting requests
4. Errors during auto-registration of one agent must not prevent the remaining agents from being registered, but must be logged at ERROR level

**Rationale:** Mirrors the official LangGraph Platform behavior where each graph declared in `langgraph.json` gets a default assistant automatically created on deployment. Uses `graph_id` matching (not `assistant_id`) because default assistant IDs are random UUIDs, consistent with official behavior.

### FR-02: Polymorphic Agent Type Support in agent-registry.yaml

The `agent-registry.yaml` must support **multiple agent transport types** via a `type` discriminator field:

**Type: `cli`** (current behavior, formalized):
```yaml
agents:
  passthrough:
    type: cli
    name: "Passthrough Agent"
    description: "Pass-through test agent - forwards requests directly to an LLM"
    command: npx
    args: ["tsx", "agents/passthrough/src/index.ts"]
    cwd: "."
    timeout: 60000
```

**Type: `api`** (new):
```yaml
agents:
  external-rag:
    type: api
    name: "External RAG Agent"
    description: "RAG agent accessible via REST API"
    url: "https://rag-agent.example.com/invoke"
    method: POST
    headers:
      Authorization: "Bearer ${RAG_AGENT_API_KEY}"
      Content-Type: "application/json"
    timeout: 30000
```

**Field definitions:**

| Field | Type | Required | Applies To | Description |
|---|---|---|---|---|
| `type` | `"cli" \| "api"` | Yes | all | Transport type discriminator |
| `name` | string | No | all | Human-readable name (defaults to agent key) |
| `description` | string | No | all | Human-readable description |
| `timeout` | number | No | all | Max execution time in ms (default: 60000) |
| `command` | string | Yes (cli) | cli | Executable to run |
| `args` | string[] | No | cli | Command arguments |
| `cwd` | string | No | cli | Working directory (default: ".") |
| `url` | string | Yes (api) | api | Agent API endpoint URL |
| `method` | string | No | api | HTTP method (default: "POST") |
| `headers` | Record<string, string> | No | api | HTTP headers (supports `${ENV_VAR}` substitution) |

**Backward Compatibility:** If `type` is omitted, it defaults to `"cli"` for backward compatibility with the current `agent-registry.yaml`.

**Future Extensibility:** The design anticipates a future `type: "in-process"` for drop-in agents loaded directly into the Node.js process. The discriminated union pattern makes this a non-breaking addition.

### FR-03: Agent Configuration Stored in Assistant Metadata

When a default assistant is auto-registered (FR-01), the agent configuration from the registry must be stored in the assistant's `metadata` field under the key `agent_config`. This enables:

1. Any component with access to the assistant can discover how to invoke the agent without loading the agent registry
2. The information is available to clients querying `GET /assistants/:id`
3. Runtime overrides could be applied by updating the assistant's metadata

**Stored structure:**
```json
{
  "metadata": {
    "auto_registered": true,
    "agent_type": "cli",
    "agent_config": {
      "type": "cli",
      "command": "npx",
      "args": ["tsx", "agents/passthrough/src/index.ts"],
      "cwd": ".",
      "timeout": 60000
    }
  }
}
```

For API agents:
```json
{
  "metadata": {
    "auto_registered": true,
    "agent_type": "api",
    "agent_config": {
      "type": "api",
      "url": "https://rag-agent.example.com/invoke",
      "method": "POST",
      "headers": { "Authorization": "Bearer ***" },
      "timeout": 30000
    }
  }
}
```

**Note:** Sensitive values in headers (tokens, keys) should be redacted when stored (replaced with `***`). The actual values are resolved at runtime from the agent registry, which reads them fresh from environment variables.

### FR-04: Graph ID Aliasing in Run Creation

When a run is created (via any of the run creation endpoints), the `assistant_id` field must support **both**:

1. **Standard UUID** -- looked up directly in assistant storage (current behavior)
2. **graph_id string** -- resolved to the default assistant for that graph

**Resolution logic:**
1. Try to find an assistant by `assistant_id` (UUID lookup)
2. If not found, search for an assistant with `graph_id` equal to the provided value and `metadata.auto_registered === true`
3. If exactly one match: use it
4. If multiple matches: use the one with the earliest `created_at` (the original default)
5. If no match: return 404 with message "No assistant found for identifier '<value>'"

This aligns with official LangGraph SDK behavior where `assistant_id` can be either a UUID or a graph_id string.

**Affected endpoints:**
- `POST /threads/:thread_id/runs`
- `POST /runs`
- `POST /threads/:thread_id/runs/stream`
- `POST /runs/stream`
- `POST /threads/:thread_id/runs/wait`
- `POST /runs/wait`
- `POST /runs/batch`

### FR-05: Run Execution Pipeline Wiring

The run execution pipeline must be wired end-to-end:

**Step 1 -- Assistant Lookup:**
When a run is created, resolve `assistant_id` to an assistant entity (using FR-04 aliasing logic).

**Step 2 -- Agent Resolution:**
From the assistant's `graph_id`, look up the agent configuration in the `AgentRegistry`.

**Step 3 -- Agent Connector Selection:**
Based on the agent's `type` field:
- `"cli"` -> Use `CliAgentConnector` (existing)
- `"api"` -> Use `ApiAgentConnector` (new, FR-06)

This requires a **polymorphic connector** (Strategy pattern):

```
interface IAgentConnector {
  executeAgent(config: AgentConfig, request: AgentRequest): Promise<AgentResponse>;
  streamAgent(config: AgentConfig, request: AgentRequest): AsyncGenerator<AgentStreamEvent>;
}
```

A `ConnectorFactory` or `AgentExecutor` selects the right connector based on `agent.type`.

**Step 4 -- Request Composition:**
Use the existing `RequestComposer` to build an `AgentRequest` from:
- Thread state (conversation history from `threadStorage.getState()`)
- Run input (new user message)
- Assistant config/context (optional, passed as metadata)

**Step 5 -- Agent Execution:**
Invoke the connector:
- For `wait` endpoints: `executeAgent()` -> return result synchronously
- For `stream` endpoints: `streamAgent()` -> pipe events as SSE
- For `fire-and-forget` endpoints: `executeAgent()` in background via `setImmediate`

**Step 6 -- Response Handling:**
After agent execution:
1. Append the agent's response messages to the thread state (via `threadStorage.addState()`)
2. If the agent returned `state`, store it in the thread state for the next run
3. Update the run status to `success` (or `error` if the agent failed)
4. Set the thread status back to `idle`

### FR-06: API Agent Connector

A new `ApiAgentConnector` class that implements the same interface as `CliAgentConnector` but communicates via HTTP:

1. Sends an HTTP request to the agent's `url` with the `AgentRequest` as JSON body
2. Uses the configured `method` and `headers`
3. Implements timeout via `AbortController`
4. Parses the response body as `AgentResponse` JSON
5. For streaming: the API agent is expected to return a complete response (no SSE from agent); the connector wraps it into `AgentStreamEvent`s (same as `CliAgentConnector.streamAgent()` does)

**Error handling:**
- HTTP 4xx/5xx: throw with status code and response body
- Timeout: throw with timeout message
- Network error: throw with connection error message
- Invalid JSON response: throw with parse error message

### FR-07: Updated AgentConfig Type System

The `AgentConfig` interface must be refactored into a discriminated union:

```typescript
interface BaseAgentConfig {
  type: string;
  name?: string;
  description?: string;
  timeout: number;
}

interface CliAgentConfig extends BaseAgentConfig {
  type: 'cli';
  command: string;
  args: string[];
  cwd: string;
}

interface ApiAgentConfig extends BaseAgentConfig {
  type: 'api';
  url: string;
  method: string;
  headers: Record<string, string>;
}

type AgentConfig = CliAgentConfig | ApiAgentConfig;
```

This is a **breaking change** to the `AgentConfig` type in `src/agents/types.ts`. The `CliAgentConnector` must be updated to accept `CliAgentConfig` specifically (type narrowing).

---

## 3. Non-Functional Requirements

### NFR-01: Startup Performance
Auto-registration must complete within 2 seconds for up to 50 agents. Registration is sequential (one assistant creation at a time) to avoid overwhelming the storage backend.

### NFR-02: Idempotency
Multiple server restarts must not create duplicate assistants. The `graph_id` search ensures only one default assistant per graph exists.

### NFR-03: Logging
- Agent registration: INFO for new, DEBUG for existing
- Agent execution: INFO for start/end, ERROR for failures
- Agent connector selection: DEBUG

### NFR-04: Error Isolation
A single agent registration failure must not block the server from starting. The failed agent is logged and skipped; remaining agents are registered normally.

### NFR-05: Backward Compatibility
- Existing `agent-registry.yaml` without `type` field must continue working (defaults to `cli`)
- Existing API endpoints must not change signatures
- Manually created assistants (without `auto_registered` metadata) must not be affected

---

## 4. Technical Design Decisions

### D-01: Where to Place Auto-Registration

**Decision:** In `src/app.ts`, after `await initializeStorage()` and before route registration.

**Implementation:** Create a new module `src/agents/assistant-auto-register.ts` with a function:
```typescript
export async function autoRegisterAssistants(
  agentRegistry: AgentRegistry,
  assistantStorage: IAssistantStorage
): Promise<void>
```

Called from `buildApp()`:
```typescript
await initializeStorage();
await autoRegisterAssistants(agentRegistry, getStorageProvider().assistants);
// ... register routes
```

**Rationale:** This is the natural point where both storage and agent registry are available. It mirrors the official LangGraph deployment flow where assistants are created during the deployment (build) phase, not at request time.

### D-02: Polymorphic Connector via Strategy Pattern

**Decision:** Introduce an `IAgentConnector` interface and a `ConnectorFactory`.

**Files:**
- `src/agents/interfaces.ts` -- `IAgentConnector` interface
- `src/agents/cli-connector.ts` -- Updated to implement `IAgentConnector`
- `src/agents/api-connector.ts` -- New, implements `IAgentConnector`
- `src/agents/connector-factory.ts` -- Returns the right connector for a given `AgentConfig`
- `src/agents/agent-executor.ts` -- Orchestrates: registry lookup -> connector selection -> execution

**Rationale:** The Strategy pattern cleanly separates transport concerns from orchestration logic. Adding future agent types (e.g., `in-process`) requires only a new connector class and a factory case.

### D-03: Agent Executor as Central Orchestrator

**Decision:** Create `AgentExecutor` class that combines registry lookup, connector selection, and execution.

```typescript
class AgentExecutor {
  constructor(
    private registry: AgentRegistry,
    private connectorFactory: ConnectorFactory
  ) {}

  async execute(graphId: string, request: AgentRequest): Promise<AgentResponse>;
  async *stream(graphId: string, request: AgentRequest): AsyncGenerator<AgentStreamEvent>;
}
```

The `RunsService` will depend on `AgentExecutor` instead of knowing about individual connectors.

### D-04: Thread State Update After Agent Execution

**Decision:** After agent execution completes:

1. Build a new `ThreadState` from the agent response:
   - `values.messages`: all messages (history + new user message + agent response)
   - `state`: the agent's returned `state` (if any), stored for the next run
2. Call `threadStorage.addState(threadId, newState)` to append to history
3. This enables conversation continuity across runs

### D-05: graph_id Validation on Assistant Lookup in Runs

**Decision:** The `assistant_id` field in run creation is first attempted as a UUID lookup. If that fails, it is treated as a `graph_id` lookup. This is implemented as a helper method on a new `AssistantResolver` utility.

**File:** `src/agents/assistant-resolver.ts`

```typescript
class AssistantResolver {
  constructor(private assistantStorage: IAssistantStorage) {}

  async resolve(assistantIdOrGraphId: string): Promise<Assistant>;
}
```

---

## 5. Implementation Plan

### Phase 1: Foundation (Types + Registry)

| Step | Description | Files |
|------|-------------|-------|
| 1.1 | Refactor `AgentConfig` into discriminated union | `src/agents/types.ts` |
| 1.2 | Update `AgentRegistry` to parse new YAML format (with backward compat) | `src/agents/agent-registry.ts` |
| 1.3 | Update `agent-registry.yaml` to include `type` and `name` fields | `agent-registry.yaml` |
| 1.4 | Update `CliAgentConnector` to accept `CliAgentConfig` | `src/agents/cli-connector.ts` |

### Phase 2: Polymorphic Connectors

| Step | Description | Files |
|------|-------------|-------|
| 2.1 | Create `IAgentConnector` interface | `src/agents/interfaces.ts` |
| 2.2 | Create `ApiAgentConnector` | `src/agents/api-connector.ts` |
| 2.3 | Create `ConnectorFactory` | `src/agents/connector-factory.ts` |
| 2.4 | Create `AgentExecutor` orchestrator | `src/agents/agent-executor.ts` |

### Phase 3: Auto-Registration

| Step | Description | Files |
|------|-------------|-------|
| 3.1 | Create `AssistantResolver` | `src/agents/assistant-resolver.ts` |
| 3.2 | Create `autoRegisterAssistants()` function | `src/agents/assistant-auto-register.ts` |
| 3.3 | Wire into `buildApp()` startup | `src/app.ts` |

### Phase 4: Run Pipeline Wiring

| Step | Description | Files |
|------|-------------|-------|
| 4.1 | Inject `AgentExecutor` and `AssistantResolver` into `RunsService` | `src/modules/runs/runs.service.ts` |
| 4.2 | Wire `createStateful()`: assistant lookup -> agent execution -> state update | `src/modules/runs/runs.service.ts` |
| 4.3 | Wire `streamRun()`: replace stub emitter with real agent streaming | `src/modules/runs/runs.service.ts`, `src/modules/runs/runs.streaming.ts` |
| 4.4 | Wire `wait()`: synchronous agent execution | `src/modules/runs/runs.service.ts` |
| 4.5 | Wire `createStateless()`: agent execution without thread state | `src/modules/runs/runs.service.ts` |
| 4.6 | Wire `RunsService` construction in routes (inject dependencies) | `src/modules/runs/runs.routes.ts` |

### Phase 5: Testing

| Step | Description | Files |
|------|-------------|-------|
| 5.1 | Unit tests for `AgentRegistry` with new type format | `test_scripts/` |
| 5.2 | Unit tests for `ApiAgentConnector` | `test_scripts/` |
| 5.3 | Unit tests for `ConnectorFactory` | `test_scripts/` |
| 5.4 | Unit tests for `autoRegisterAssistants` | `test_scripts/` |
| 5.5 | Unit tests for `AssistantResolver` | `test_scripts/` |
| 5.6 | Integration test: full run pipeline with passthrough agent | `test_scripts/` |
| 5.7 | Integration test: auto-registration on startup | `test_scripts/` |

---

## 6. Impact Analysis

### Files Modified

| File | Change Type | Description |
|------|-------------|-------------|
| `src/agents/types.ts` | **Modified** | Refactor `AgentConfig` to discriminated union, add `name` field |
| `src/agents/agent-registry.ts` | **Modified** | Parse `type`, `name`, `url`, `method`, `headers` fields; backward compat |
| `src/agents/cli-connector.ts` | **Modified** | Accept `CliAgentConfig`, implement `IAgentConnector` |
| `src/modules/runs/runs.service.ts` | **Modified** | Replace stubs with real agent execution pipeline |
| `src/modules/runs/runs.streaming.ts` | **Modified** | Replace stub events with real agent stream events |
| `src/modules/runs/runs.routes.ts` | **Modified** | Inject new dependencies into `RunsService` |
| `src/app.ts` | **Modified** | Add auto-registration step on startup |
| `agent-registry.yaml` | **Modified** | Add `type` and `name` fields |
| `src/repositories/registry.ts` | **Modified** | Expose agent executor / registry for route modules |

### Files Created

| File | Description |
|------|-------------|
| `src/agents/interfaces.ts` | `IAgentConnector` interface definition |
| `src/agents/api-connector.ts` | HTTP-based agent connector |
| `src/agents/connector-factory.ts` | Selects connector by agent type |
| `src/agents/agent-executor.ts` | Central orchestrator: registry + connector + execution |
| `src/agents/assistant-auto-register.ts` | Startup auto-registration logic |
| `src/agents/assistant-resolver.ts` | Resolves `assistant_id` or `graph_id` to an `Assistant` |

### Files NOT Modified (no changes needed)

| File | Reason |
|------|--------|
| `src/agents/request-composer.ts` | Already complete, used as-is |
| `src/storage/interfaces.ts` | No schema changes needed |
| `src/schemas/assistant.schema.ts` | No schema changes (metadata is a free-form object) |
| `src/schemas/run.schema.ts` | No schema changes (`assistant_id` is already `Type.String()`) |

---

## 7. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Auto-registration creates duplicates on concurrent startups | Duplicate default assistants | Use `graph_id` search + single creation; in-memory provider is single-process anyway; persistent providers can use unique constraint on (graph_id, auto_registered) |
| API agent endpoint unavailable at startup | Registration succeeds but runtime fails | Agent health is not checked at registration; runtime errors are handled per-run |
| Breaking change to AgentConfig type | Existing code using old interface breaks | Phase 1 includes updating all consumers (only CliAgentConnector) |
| Large agent timeout blocks HTTP response | Client timeout before agent responds | Document timeout configuration; streaming endpoints show progress |
| Thread state grows unboundedly with message history | Memory/storage pressure | Out of scope for this request; noted as future work (message window/truncation) |

---

## 8. Open Questions

| # | Question | Proposed Answer |
|---|----------|-----------------|
| Q1 | Should auto-registered assistants be deletable via the API? | Yes -- no special protection. If deleted, the server will re-create it on next restart. |
| Q2 | Should the `config` and `context` fields of auto-registered assistants carry agent-specific configuration? | The `metadata.agent_config` carries the transport config. The `config` and `context` fields remain empty for defaults, but can be updated via `PATCH /assistants/:id` for per-assistant customization. |
| Q3 | Should the API connector support streaming from the agent (SSE/WebSocket)? | Not in this phase. The API connector calls the agent synchronously and wraps the response in stream events. Future enhancement for true streaming from API agents. |
| Q4 | Should we validate that the agent is reachable during auto-registration? | No. Registration is a metadata operation. Runtime health is checked at execution time. This avoids startup failures due to temporarily unavailable agents. |
| Q5 | How should run execution handle an assistant that has no agent in the registry? | Return HTTP 400 with message "No agent registered for graph_id '<graph_id>'. Check agent-registry.yaml." This covers manually created assistants that reference a non-existent graph. |

---

## 9. Relationship to Existing Issues

The following items from `Issues - Pending Items.md` are **related** but not directly resolved by this work:

- **P1** (Repository inline types): The new code will import from `src/types/index.ts`, not inline types. P1 remains for existing code.
- **P2** (Thread stream endpoint): The thread stream endpoint could be wired to join the active run's SSE stream after this work, but is out of scope here.

---

## 10. Updated Component Diagram

After implementation, the run execution flow becomes:

```
Client POST /threads/:id/runs/stream
  |
  v
RunsRoutes
  |
  v
RunsService.streamRun()
  |
  v
AssistantResolver.resolve(assistant_id)  -->  IAssistantStorage
  |
  v
AgentExecutor.stream(graph_id, agentRequest)
  |
  +---> AgentRegistry.getAgentConfig(graph_id)
  |       |
  |       v
  |     AgentConfig (CliAgentConfig | ApiAgentConfig)
  |       |
  |       v
  +---> ConnectorFactory.getConnector(config.type)
          |
          +---> CliAgentConnector.streamAgent()   [type: cli]
          |       |
          |       v
          |     child_process.spawn -> stdin JSON -> stdout JSON
          |
          +---> ApiAgentConnector.streamAgent()   [type: api]
                  |
                  v
                HTTP POST -> JSON response
  |
  v
RequestComposer.composeRequest()
  |
  v
AgentStreamEvents --> SSE to client
  |
  v
ThreadStorage.addState()  (persist conversation)
  |
  v
Run status -> success, Thread status -> idle
```

---

**End of Refined Request**
