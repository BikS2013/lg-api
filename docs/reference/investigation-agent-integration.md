# Agent-Assistant Integration Investigation

**Date:** 2026-03-10
**Purpose:** Research patterns and approaches for implementing agent-assistant integration in the lg-api project
**Context:** This investigation supports the requirements defined in `refined-request-agent-assistant-integration.md`

---

## Executive Summary

This document presents research findings and recommendations for implementing the five key aspects of the agent-assistant integration:

1. **Polymorphic Agent Connector Pattern**: Strategy pattern with discriminated unions for CLI and API agent types
2. **HTTP Agent Connector**: Native fetch with AbortController for timeout handling, SSE forwarding via async generators
3. **Auto-Registration Pattern**: Fastify onReady hook for idempotent assistant creation from agent registry
4. **Run Execution Pipeline**: Assistant resolution → agent execution → thread state update flow
5. **Agent Registry YAML Schema**: Discriminated union with type field, environment variable substitution

**Key Recommendations:**
- Use TypeScript discriminated unions with exhaustiveness checking for type-safe agent handling
- Implement connector interface with factory pattern for runtime connector selection
- Leverage Fastify's `onReady` lifecycle hook for startup auto-registration
- Use native Node.js fetch with `AbortSignal.timeout()` for HTTP agent requests
- Design YAML schema with `type` discriminator and optional fields per type

---

## 1. Polymorphic Agent Connector Pattern

### 1.1 Strategy Pattern in TypeScript

**Core Concept**: The Strategy pattern turns behaviors into objects and makes them interchangeable within a context object. TypeScript's discriminated unions provide type-safe variant handling with compile-time exhaustiveness checking.

**Modern Approach (2026)**: Contemporary TypeScript implementations emphasize discriminated unions over traditional class-based patterns, reducing ceremony by 60-70% through functional approaches.

### 1.2 Recommended Implementation

#### Interface Definition

```typescript
// src/agents/interfaces.ts
export interface IAgentConnector {
  executeAgent(config: AgentConfig, request: AgentRequest): Promise<AgentResponse>;
  streamAgent(config: AgentConfig, request: AgentRequest): AsyncGenerator<AgentStreamEvent>;
}
```

#### Discriminated Union for AgentConfig

```typescript
// src/agents/types.ts
interface BaseAgentConfig {
  type: string;
  name?: string;
  description?: string;
  timeout: number; // milliseconds, default 60000
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
  method: string; // default 'POST'
  headers: Record<string, string>;
}

// Discriminated union - TypeScript will narrow types based on 'type' field
export type AgentConfig = CliAgentConfig | ApiAgentConfig;
```

**Key Pattern**: The `type` field is the discriminator. TypeScript's control flow analysis automatically narrows the type in switch statements and if blocks.

#### Type Narrowing with Exhaustiveness Checking

```typescript
// src/agents/connector-factory.ts
export class ConnectorFactory {
  constructor(
    private cliConnector: CliAgentConnector,
    private apiConnector: ApiAgentConnector
  ) {}

  getConnector(config: AgentConfig): IAgentConnector {
    switch (config.type) {
      case 'cli':
        return this.cliConnector;
      case 'api':
        return this.apiConnector;
      default:
        // Exhaustiveness check: if a new type is added, TypeScript will error here
        const _exhaustive: never = config;
        throw new Error(`Unknown agent type: ${(config as any).type}`);
    }
  }
}
```

**Benefits:**
- **Compile-time safety**: Adding a new agent type without handling it causes a TypeScript error
- **Type narrowing**: Inside each case, TypeScript knows the exact type (e.g., `config` is `CliAgentConfig` in the `'cli'` case)
- **No runtime overhead**: The discriminated union compiles to plain JavaScript

### 1.3 Factory Pattern for Connector Selection

```typescript
// src/agents/agent-executor.ts
export class AgentExecutor {
  constructor(
    private registry: AgentRegistry,
    private connectorFactory: ConnectorFactory
  ) {}

  async execute(graphId: string, request: AgentRequest): Promise<AgentResponse> {
    const config = this.registry.getAgentConfig(graphId);
    if (!config) {
      throw new ApiError(400, `No agent registered for graph_id '${graphId}'`);
    }

    const connector = this.connectorFactory.getConnector(config);
    return await connector.executeAgent(config, request);
  }

  async *stream(graphId: string, request: AgentRequest): AsyncGenerator<AgentStreamEvent> {
    const config = this.registry.getAgentConfig(graphId);
    if (!config) {
      throw new ApiError(400, `No agent registered for graph_id '${graphId}'`);
    }

    const connector = this.connectorFactory.getConnector(config);
    yield* connector.streamAgent(config, request);
  }
}
```

**Design Rationale:**
- **Separation of concerns**: `AgentExecutor` orchestrates, `ConnectorFactory` selects, `IAgentConnector` executes
- **Single Responsibility**: Each connector implementation only handles its transport type
- **Open/Closed Principle**: Adding a new agent type requires:
  1. Adding a new interface to the union
  2. Creating a new connector class
  3. Adding a case to the factory switch
  - No changes to existing connectors or executor logic

### 1.4 Integration with Existing CliAgentConnector

**Current State**: `CliAgentConnector` takes `graphId: string` and does internal registry lookup.

**Refactor Required**:
```typescript
// Before (current)
async executeAgent(graphId: string, request: AgentRequest): Promise<AgentResponse>

// After (implements IAgentConnector)
async executeAgent(config: CliAgentConfig, request: AgentRequest): Promise<AgentResponse>
```

**Change Summary:**
- Remove internal `this.registry.getAgentConfig()` call
- Accept `CliAgentConfig` directly (already has `command`, `args`, `cwd`, `timeout`)
- Implement `IAgentConnector` interface
- Update spawn logic to use `config.command`, `config.args`, etc.

---

## 2. HTTP Agent Connector (API-based agents)

### 2.1 Native Fetch with AbortController

**Node.js 18+**: Native fetch is available, no external dependencies required. Default timeout is 300 seconds (Chromium default), which is unsuitable for production.

**Best Practice (2026)**: Always set timeouts for outgoing HTTP requests using `AbortSignal.timeout()`.

### 2.2 Recommended Implementation

```typescript
// src/agents/api-connector.ts
import type { IAgentConnector } from './interfaces.js';
import type { ApiAgentConfig, AgentRequest, AgentResponse, AgentStreamEvent } from './types.js';
import { ApiError } from '../errors/api-error.js';

export class ApiAgentConnector implements IAgentConnector {
  async executeAgent(config: ApiAgentConfig, request: AgentRequest): Promise<AgentResponse> {
    const timeoutMs = config.timeout || 60000;

    try {
      const response = await fetch(config.url, {
        method: config.method || 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...config.headers,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new ApiError(
          502,
          `Agent API returned ${response.status}: ${body.substring(0, 200)}`
        );
      }

      const agentResponse: AgentResponse = await response.json();
      return agentResponse;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw new ApiError(504, `Agent API timed out after ${timeoutMs}ms`);
      }
      if (error.name === 'TypeError' && error.message.includes('fetch failed')) {
        throw new ApiError(502, `Failed to connect to agent API: ${error.message}`);
      }
      throw error; // Re-throw ApiError or other unexpected errors
    }
  }

  async *streamAgent(
    config: ApiAgentConfig,
    request: AgentRequest
  ): AsyncGenerator<AgentStreamEvent> {
    // Execute synchronously (API agents don't stream back in this phase)
    yield { event: 'metadata', data: { run_id: request.run_id, thread_id: request.thread_id } };

    const response = await this.executeAgent(config, request);

    // Emit values event with messages
    yield {
      event: 'values',
      data: {
        messages: response.messages.map((msg) => ({
          type: msg.role === 'assistant' ? 'ai' : msg.role === 'user' ? 'human' : 'system',
          content: msg.content,
        })),
      },
    };

    // Emit messages event (for compatibility with LangGraph SDK expectations)
    for (const msg of response.messages) {
      yield {
        event: 'messages',
        data: {
          type: msg.role === 'assistant' ? 'AIMessageChunk' : 'HumanMessageChunk',
          content: msg.content,
        },
      };
    }

    yield { event: 'end', data: null };
  }
}
```

### 2.3 Timeout Handling Patterns

**AbortSignal.timeout() (Node.js 18+)**:
```typescript
// Simple timeout
const response = await fetch(url, {
  signal: AbortSignal.timeout(3000), // 3 seconds
});

// Combining multiple abort conditions
const controller = new AbortController();
const timeoutSignal = AbortSignal.timeout(5000);

// Abort on either timeout OR manual abort
const combinedSignal = AbortSignal.any([controller.signal, timeoutSignal]);

const response = await fetch(url, { signal: combinedSignal });

// Manual abort
controller.abort();
```

**Error Handling**:
- `AbortError` (name === 'AbortError'): Timeout or manual abort
- `TypeError` with 'fetch failed': Network/connection error
- `HeadersTimeoutError` (from undici): Default 300s timeout exceeded

**Best Practices (Better Stack 2026 Guide)**:
1. Always set timeouts (networks are unpredictable)
2. Use 99.9th percentile response times × 3-4 as baseline
3. For user-facing requests, tie timeout to UX tolerance
4. Consider dynamic adjustment based on real-time metrics

### 2.4 SSE Forwarding (Future Enhancement)

**Current Scope**: API agents return complete JSON responses (not streaming).

**Future Pattern**: Use `fetch-event-stream` library for SSE forwarding.

```typescript
// Future implementation (not in current scope)
import { events } from 'fetch-event-stream';

async *streamAgentSSE(config: ApiAgentConfig, request: AgentRequest): AsyncGenerator<AgentStreamEvent> {
  const response = await fetch(config.url, {
    method: config.method || 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...config.headers,
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(config.timeout || 60000),
  });

  if (!response.ok) {
    throw new ApiError(502, `Agent API returned ${response.status}`);
  }

  // Parse SSE stream
  const stream = events(response);
  for await (const event of stream) {
    // Transform upstream SSE event to AgentStreamEvent
    yield JSON.parse(event.data);
  }
}
```

**Libraries for SSE Consumption**:
- **fetch-event-stream** (741 bytes): Converts SSE response to async iterator, supports POST with headers
- **@umijs/fetch-sse**: Full fetch API features, supports Node.js 18+
- **better-sse**: TypeScript-native, spec-compliant (but for servers, not clients)

**Key Insight**: `EventSource` only supports GET requests and no custom headers, making it unsuitable for most agent APIs (which require POST + Authorization).

---

## 3. Auto-Registration Pattern (Bootstrap on startup)

### 3.1 Fastify Lifecycle Hooks

**Fastify Lifecycle Sequence**:
1. `onRoute` - Triggered when a route is registered
2. `onRegister` - Triggered when a plugin encapsulation context is created
3. **`onReady`** - Triggered before server starts listening, after all plugins loaded
4. `onListen` - Triggered when server starts listening
5. `preClose` - Triggered when fastify.close() is invoked
6. `onClose` - Triggered after server has stopped

**Recommended Hook**: `onReady`

**Why onReady over onListen**:
- `onReady`: Essential data must be available before the application starts (blocking startup)
- `onListen`: Non-mandatory data can be loaded asynchronously without blocking startup

Auto-registering assistants is essential for the application to function correctly, making `onReady` the appropriate choice.

### 3.2 Fastify onReady Hook Usage

```typescript
// Async/await style (recommended)
fastify.addHook('onReady', async function () {
  await loadCacheFromDatabase();
  this.log.info('Application ready');
});

// Callback style
fastify.addHook('onReady', function (done) {
  // Some sync/async code
  done(null); // or done(err)
});
```

**Key Properties**:
- Executed serially (all onReady hooks run in order)
- Cannot modify routes or add new hooks
- Server only starts listening after all onReady hooks complete
- Has access to Fastify instance via `this`

### 3.3 Recommended Implementation for lg-api

**Integration Point**: `src/app.ts` after storage initialization

```typescript
// src/app.ts
export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: config.logger,
  });

  // Initialize storage FIRST
  await initializeStorage();

  // AUTO-REGISTRATION HOOK - runs before server starts listening
  fastify.addHook('onReady', async function () {
    const agentRegistry = new AgentRegistry();
    const storageProvider = getStorageProvider();

    this.log.info('Auto-registering assistants from agent-registry.yaml...');

    try {
      await autoRegisterAssistants(agentRegistry, storageProvider.assistants, this.log);
      this.log.info('Assistant auto-registration complete');
    } catch (error) {
      this.log.error({ error }, 'Assistant auto-registration failed');
      // Don't throw - allow server to start even if auto-registration fails
      // Individual agents that failed will log errors
    }
  });

  // Register cleanup hook
  fastify.addHook('onClose', async () => {
    await closeStorage();
  });

  // Register plugins and routes
  await fastify.register(corsPlugin);
  await fastify.register(swaggerPlugin);
  await fastify.register(errorHandlerPlugin);
  await fastify.register(authPlugin);

  await fastify.register(assistantsRoutes, { prefix: '/assistants' });
  await fastify.register(threadsRoutes, { prefix: '/threads' });
  await fastify.register(runsRoutes, { prefix: '/runs' });
  await fastify.register(cronsRoutes, { prefix: '/crons' });
  await fastify.register(storeRoutes, { prefix: '/store' });
  await fastify.register(systemRoutes);

  return fastify;
}
```

### 3.4 Auto-Registration Function

```typescript
// src/agents/assistant-auto-register.ts
import type { AgentRegistry } from './agent-registry.js';
import type { IAssistantStorage } from '../storage/interfaces.js';
import type { AgentConfig } from './types.js';
import { generateId } from '../utils/uuid.util.js';
import { nowISO } from '../utils/date.util.js';

export async function autoRegisterAssistants(
  agentRegistry: AgentRegistry,
  assistantStorage: IAssistantStorage,
  logger?: any
): Promise<void> {
  const graphIds = agentRegistry.getRegisteredGraphIds();

  for (const graphId of graphIds) {
    try {
      await registerAssistantForGraph(graphId, agentRegistry, assistantStorage, logger);
    } catch (error) {
      // Isolate errors: one agent failure doesn't block others
      logger?.error({ graphId, error }, `Failed to auto-register assistant for graph '${graphId}'`);
    }
  }
}

async function registerAssistantForGraph(
  graphId: string,
  agentRegistry: AgentRegistry,
  assistantStorage: IAssistantStorage,
  logger?: any
): Promise<void> {
  const agentConfig = agentRegistry.getAgentConfig(graphId);
  if (!agentConfig) {
    throw new Error(`Agent config not found for graph_id '${graphId}'`);
  }

  // Check if assistant already exists with this graph_id
  const existingResult = await assistantStorage.search(
    { limit: 1, offset: 0 },
    { graph_id: graphId, 'metadata.auto_registered': true }
  );

  if (existingResult.items.length > 0) {
    logger?.debug({ graphId }, `Assistant already exists for graph '${graphId}', skipping`);
    return;
  }

  // Create new default assistant
  const assistant = {
    assistant_id: generateId(),
    graph_id: graphId,
    name: agentConfig.name || graphId,
    description: agentConfig.description || `Default assistant for ${graphId}`,
    config: {},
    context: {},
    metadata: {
      auto_registered: true,
      agent_type: agentConfig.type,
      agent_config: sanitizeAgentConfig(agentConfig),
    },
    version: 1,
    created_at: nowISO(),
    updated_at: nowISO(),
  };

  await assistantStorage.create(assistant);
  logger?.info({ graphId, assistantId: assistant.assistant_id }, `Created default assistant for graph '${graphId}'`);
}

function sanitizeAgentConfig(config: AgentConfig): any {
  // Redact sensitive values in headers for API agents
  const sanitized = { ...config };
  if (config.type === 'api' && config.headers) {
    sanitized.headers = Object.fromEntries(
      Object.entries(config.headers).map(([key, value]) => [
        key,
        key.toLowerCase().includes('auth') || key.toLowerCase().includes('key')
          ? '***'
          : value,
      ])
    );
  }
  return sanitized;
}
```

**Key Design Decisions**:
1. **Idempotency**: Search by `graph_id` + `metadata.auto_registered: true` before creating
2. **Error Isolation**: Try/catch per agent so one failure doesn't block others
3. **Metadata Storage**: Store agent config in `metadata.agent_config` for discoverability
4. **Sensitive Data**: Redact auth headers when storing in metadata
5. **Logging**: INFO for creation, DEBUG for existing, ERROR for failures

### 3.5 Alternative Approaches Considered

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| **onReady hook** | Blocks startup, serialized, official lifecycle | Can delay server start if slow | ✅ **Recommended** |
| **Manual call in app.ts** | Simple, explicit | Not integrated with lifecycle, error handling is manual | ❌ Less robust |
| **onListen hook** | Non-blocking, server starts faster | Assistants might not be ready when first request arrives | ❌ Race condition |
| **Separate CLI tool** | Can be run independently | Requires separate execution, not automatic | ❌ Extra step |

---

## 4. Run Execution Pipeline

### 4.1 Official LangGraph Platform Flow

From the investigation of LangGraph Platform behavior:

```
Client Request (POST /threads/:id/runs)
  ↓
Assistant Lookup (by assistant_id or graph_id)
  ↓
Graph Resolution (assistant.graph_id → graph code)
  ↓
Graph Execution (runs the compiled graph with thread state + input)
  ↓
State Update (append new messages to thread state)
  ↓
Run Status Update (success/error)
  ↓
Response to Client
```

### 4.2 lg-api Equivalent Flow

**Components**:
1. **AssistantResolver**: Maps `assistant_id` or `graph_id` → Assistant entity
2. **AgentExecutor**: Maps `graph_id` → AgentConfig → Connector → Execution
3. **RequestComposer**: Builds `AgentRequest` from thread state + input
4. **Connector** (CLI or API): Executes the agent, returns `AgentResponse`
5. **Thread State Updater**: Appends agent response to thread state

**Sequence**:
```
POST /threads/:thread_id/runs { assistant_id: "passthrough", input: {...} }
  ↓
RunsService.createStateful(threadId, request)
  ↓
1. AssistantResolver.resolve(request.assistant_id)
   → Returns Assistant entity (UUID or graph_id alias)
  ↓
2. ThreadStorage.getState(threadId)
   → Returns ThreadState { values: { messages: [...] }, ... }
  ↓
3. RequestComposer.composeRequest({
     threadId, runId, assistantId: assistant.assistant_id,
     input: request.input,
     threadState: state,
   })
   → Returns AgentRequest { thread_id, run_id, messages: [...], documents: [...], state: {...} }
  ↓
4. AgentExecutor.execute(assistant.graph_id, agentRequest)
   → Registry lookup → Connector selection → Agent execution
   → Returns AgentResponse { messages: [...], state: {...} }
  ↓
5. Build new ThreadState:
   values.messages = [...existingMessages, ...newUserMessage, ...agentMessages]
   state = agentResponse.state (if any)
  ↓
6. ThreadStorage.addState(threadId, newState)
   → Persists conversation history
  ↓
7. Update Run status to 'success'
8. Update Thread status to 'idle'
  ↓
Return Run entity to client
```

### 4.3 Assistant Resolution (graph_id aliasing)

**Requirement (FR-04)**: Support both UUID and graph_id in `assistant_id` field.

```typescript
// src/agents/assistant-resolver.ts
import type { IAssistantStorage } from '../storage/interfaces.js';
import type { Assistant } from '../types/index.js';
import { ApiError } from '../errors/api-error.js';

export class AssistantResolver {
  constructor(private assistantStorage: IAssistantStorage) {}

  async resolve(assistantIdOrGraphId: string): Promise<Assistant> {
    // Try UUID lookup first
    const byId = await this.assistantStorage.getById(assistantIdOrGraphId);
    if (byId) {
      return byId;
    }

    // Try graph_id lookup (default assistant)
    const byGraphId = await this.assistantStorage.search(
      { limit: 10, offset: 0 },
      { graph_id: assistantIdOrGraphId, 'metadata.auto_registered': true }
    );

    if (byGraphId.items.length === 0) {
      throw new ApiError(404, `No assistant found for identifier '${assistantIdOrGraphId}'`);
    }

    // If multiple defaults, use the oldest (earliest created_at)
    const sorted = byGraphId.items.sort((a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    return sorted[0];
  }
}
```

**Logic**:
1. Try UUID lookup (most common case)
2. If not found, search by `graph_id` + `auto_registered: true`
3. If multiple matches (shouldn't happen but defensive), use oldest
4. If no match, throw 404

### 4.4 Thread State Update After Agent Execution

**ThreadState Structure** (from codebase scan):
```typescript
interface ThreadState {
  values: Record<string, unknown>;     // messages live at values.messages
  next: string[];
  checkpoint: {
    thread_id: string;
    checkpoint_ns: string;
    checkpoint_id: string;
    checkpoint_map?: Record<string, unknown>;
  };
  metadata: Record<string, unknown>;
  created_at: string;
  parent_checkpoint: { ... } | null;
  tasks: Array<Record<string, any>>;
}
```

**Update Logic**:
```typescript
// After agent execution in RunsService
async function updateThreadStateAfterAgent(
  threadId: string,
  userInput: Record<string, unknown>,
  agentResponse: AgentResponse,
  threadStorage: IThreadStorage
): Promise<void> {
  // Get current state
  const currentState = await threadStorage.getState(threadId);

  // Extract existing messages
  const existingMessages = (currentState?.values?.messages as any[]) || [];

  // Build new user message from input
  const userMessage = {
    type: 'human',
    content: userInput.messages?.[0]?.content || JSON.stringify(userInput),
  };

  // Append agent messages
  const agentMessages = agentResponse.messages.map((msg) => ({
    type: msg.role === 'assistant' ? 'ai' : msg.role === 'user' ? 'human' : 'system',
    content: msg.content,
  }));

  // Build new state
  const newState: ThreadState = {
    values: {
      ...currentState?.values,
      messages: [...existingMessages, userMessage, ...agentMessages],
    },
    next: [],
    checkpoint: {
      thread_id: threadId,
      checkpoint_ns: 'default',
      checkpoint_id: generateId(),
    },
    metadata: {},
    created_at: nowISO(),
    parent_checkpoint: currentState?.checkpoint || null,
    tasks: [],
  };

  // If agent returned state, store it
  if (agentResponse.state) {
    newState.values.state = agentResponse.state;
  }

  // Persist
  await threadStorage.addState(threadId, newState);

  // Update thread.values for quick access
  await threadStorage.update(threadId, {
    values: newState.values,
    updated_at: nowISO(),
  });
}
```

**Key Points**:
- Messages are stored at `values.messages` (RequestComposer expects this path)
- User message is constructed from `input` (not already in thread state)
- Agent messages are appended after user message
- Optional `state` from agent is preserved for next run
- Checkpoint structure is maintained for LangGraph compatibility

### 4.5 Streaming vs Synchronous Execution

**Three Modes** (from requirements):

| Endpoint | Mode | Agent Call | Response |
|----------|------|------------|----------|
| `POST /threads/:id/runs` | Fire-and-forget | Background (setImmediate) | Immediate (run record) |
| `POST /threads/:id/runs/wait` | Synchronous | Await | Full result |
| `POST /threads/:id/runs/stream` | Streaming | Async generator | SSE events |

**Implementation Pattern**:
```typescript
// src/modules/runs/runs.service.ts

// Fire-and-forget (current: setImmediate stub)
async createStateful(threadId: string, request: CreateRunRequest): Promise<Run> {
  const assistant = await this.assistantResolver.resolve(request.assistant_id);
  const run = await this.createRunRecord(threadId, assistant.assistant_id, request);

  // Background execution
  setImmediate(async () => {
    try {
      await this.executeAgentForRun(threadId, run.run_id, assistant.graph_id, request.input);
    } catch (error) {
      await this.handleRunError(run.run_id, error);
    }
  });

  return run; // Return immediately
}

// Synchronous (current: 200ms delay + stub)
async wait(threadId: string, request: CreateRunRequest): Promise<RunWithResult> {
  const assistant = await this.assistantResolver.resolve(request.assistant_id);
  const run = await this.createRunRecord(threadId, assistant.assistant_id, request);

  try {
    const result = await this.executeAgentForRun(threadId, run.run_id, assistant.graph_id, request.input);
    return { ...run, status: 'success', result };
  } catch (error) {
    await this.handleRunError(run.run_id, error);
    throw error;
  }
}

// Streaming (current: stub emitter)
async streamRun(threadId: string, request: CreateRunRequest, reply: FastifyReply): Promise<void> {
  const assistant = await this.assistantResolver.resolve(request.assistant_id);
  const run = await this.createRunRecord(threadId, assistant.assistant_id, request);

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  try {
    const threadState = await this.threadStorage.getState(threadId);
    const agentRequest = await this.requestComposer.composeRequest({
      threadId,
      runId: run.run_id,
      assistantId: assistant.assistant_id,
      input: request.input,
      threadState,
    });

    // Stream events from agent executor
    for await (const event of this.agentExecutor.stream(assistant.graph_id, agentRequest)) {
      this.writeSSE(reply, event.event, event.data, run.run_id);
    }

    reply.raw.end();
  } catch (error) {
    this.writeSSE(reply, 'error', { message: error.message }, run.run_id);
    reply.raw.end();
  }
}
```

---

## 5. Agent Registry YAML Schema Design

### 5.1 Discriminated Union in YAML

**Core Principle**: Use a `type` field to discriminate between agent types, with type-specific fields conditional on that discriminator.

**Best Practices (2026)**:
1. Use consistent property names (`type`, `kind`, or `tag`)
2. Use string literals (more maintainable than numbers)
3. Make the discriminant required (not optional)
4. Keep the union simple (don't overload with too many variants)
5. Document which fields apply to which type

### 5.2 Recommended Schema

```yaml
# agent-registry.yaml
agents:
  # CLI agent example
  passthrough:
    type: cli                                      # Required discriminator
    name: "Passthrough Agent"                       # Optional (defaults to key)
    description: "Pass-through test agent"          # Optional
    command: npx                                    # Required for CLI
    args: ["tsx", "agents/passthrough/src/index.ts"] # Optional (default [])
    cwd: "."                                        # Optional (default ".")
    timeout: 60000                                  # Optional (default 60000)

  # API agent example
  external-rag:
    type: api                                       # Required discriminator
    name: "External RAG Agent"                      # Optional (defaults to key)
    description: "RAG agent via REST API"           # Optional
    url: "https://rag-agent.example.com/invoke"     # Required for API
    method: POST                                    # Optional (default POST)
    headers:                                        # Optional (default {})
      Authorization: "Bearer ${RAG_AGENT_API_KEY}"  # Env var substitution
      Content-Type: "application/json"
    timeout: 30000                                  # Optional (default 60000)

  # Backward compatibility: type defaults to 'cli'
  legacy-agent:
    command: python                                 # type: cli assumed
    args: ["agent.py"]
```

### 5.3 TypeScript Type Mapping

```typescript
// src/agents/agent-registry.ts

// Raw YAML structure (what js-yaml parses)
interface RawAgentEntry {
  type?: 'cli' | 'api';                 // Optional for backward compat
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

interface RawRegistryFile {
  agents: Record<string, RawAgentEntry>;
}

// Validation and normalization
function validateAndNormalize(graphId: string, raw: RawAgentEntry): AgentConfig {
  const type = raw.type || 'cli'; // Backward compatibility
  const timeout = raw.timeout ?? 60000; // Default 60 seconds

  if (type === 'cli') {
    if (!raw.command) {
      throw new Error(`Agent '${graphId}': 'command' is required for CLI agents`);
    }

    return {
      type: 'cli',
      name: raw.name,
      description: raw.description,
      timeout,
      command: raw.command,
      args: raw.args || [],
      cwd: raw.cwd || '.',
    };
  }

  if (type === 'api') {
    if (!raw.url) {
      throw new Error(`Agent '${graphId}': 'url' is required for API agents`);
    }

    return {
      type: 'api',
      name: raw.name,
      description: raw.description,
      timeout,
      url: raw.url,
      method: raw.method || 'POST',
      headers: raw.headers || {},
    };
  }

  throw new Error(`Agent '${graphId}': Unknown type '${type}'`);
}
```

### 5.4 Environment Variable Substitution

**Current Implementation**: Already exists in `storage/yaml-config-loader.ts` for storage configs.

**Pattern to Reuse**:
```typescript
function substituteEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new Error(`Environment variable ${varName} is not defined`);
    }
    return envValue;
  });
}

// Apply recursively to headers object
function substituteEnvInHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, substituteEnvVars(value)])
  );
}
```

**Apply in AgentRegistry.load()**:
```typescript
private load(): void {
  const configPath = this.resolveConfigPath();
  const fileContent = fs.readFileSync(configPath, 'utf-8');
  const rawConfig = yaml.parse(fileContent) as RawRegistryFile;

  for (const [graphId, rawEntry] of Object.entries(rawConfig.agents)) {
    // Substitute env vars in headers (for API agents)
    if (rawEntry.headers) {
      rawEntry.headers = substituteEnvInHeaders(rawEntry.headers);
    }

    // Substitute in other fields if needed (url, command, etc.)
    if (rawEntry.url) {
      rawEntry.url = substituteEnvVars(rawEntry.url);
    }

    const config = validateAndNormalize(graphId, rawEntry);
    this.agents.set(graphId, config);
  }
}
```

### 5.5 Schema Validation Libraries

**Option 1: Zod** (runtime validation)
```typescript
import { z } from 'zod';

const CliAgentConfigSchema = z.object({
  type: z.literal('cli'),
  name: z.string().optional(),
  description: z.string().optional(),
  timeout: z.number().positive().default(60000),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().default('.'),
});

const ApiAgentConfigSchema = z.object({
  type: z.literal('api'),
  name: z.string().optional(),
  description: z.string().optional(),
  timeout: z.number().positive().default(60000),
  url: z.string().url(),
  method: z.string().default('POST'),
  headers: z.record(z.string()).default({}),
});

const AgentConfigSchema = z.discriminatedUnion('type', [
  CliAgentConfigSchema,
  ApiAgentConfigSchema,
]);

// In validateAndNormalize():
const config = AgentConfigSchema.parse(raw);
```

**Option 2: Manual validation** (current approach, lighter weight)
- Already used in the codebase (no new dependencies)
- Sufficient for this use case (simple structure)

**Recommendation**: Stick with manual validation to avoid adding Zod dependency. Consider Zod if validation logic grows complex.

---

## Assumptions & Scope

### Assumptions Made

| Assumption | Confidence | Impact if Wrong |
|------------|------------|-----------------|
| Native Node.js fetch is sufficient (no need for axios/got) | HIGH | Would require adding HTTP client library |
| API agents return complete JSON responses (not SSE streaming) | HIGH | Would require implementing SSE forwarding logic |
| Agent registry YAML is loaded synchronously on startup | HIGH | No async loading needed |
| Thread state messages are stored at `values.messages` path | HIGH | Would require adjusting RequestComposer and update logic |
| Fastify onReady hook is appropriate for blocking startup tasks | HIGH | Alternative would be manual call before server.listen() |
| Discriminated union with `type` field is preferred over inheritance | MEDIUM | Could use class inheritance, but less idiomatic in TS 2026 |

### Uncertainties & Gaps

1. **API Agent SSE Streaming**: Current scope assumes API agents return complete responses. Real-world API agents might stream SSE. Documented as future enhancement.

2. **Agent Health Checks**: Should auto-registration validate agent connectivity? Current recommendation: No (runtime-only checks).

3. **Agent Config Hot-Reload**: Should `agent-registry.yaml` changes be detected at runtime? Current scope: Startup-only load.

4. **Thread State Growth**: Unbounded message history could cause memory/storage pressure. Out of scope for this work (future: message window/truncation).

5. **Concurrent Auto-Registration**: What happens if multiple server instances start simultaneously with persistent storage? Current mitigation: `graph_id` search is idempotent, last-write-wins for duplicates.

### Clarifying Questions for Follow-up

1. **SSE Streaming Priority**: Should API agent SSE forwarding be included in Phase 2, or deferred to a later enhancement?

2. **Error Handling Granularity**: Should agent execution errors be classified (network, timeout, agent logic error) for different retry strategies?

3. **Agent Versioning**: Should `agent-registry.yaml` support version fields (e.g., `version: "1.0.0"`), or is graph_id sufficient?

4. **Multi-Tenancy**: How should agent registry handle multi-tenant scenarios (different agents per customer)?

5. **Monitoring**: Should AgentExecutor emit metrics (execution time, success/failure rates) for observability?

---

## References

### TypeScript Strategy Pattern & Discriminated Unions

- [Strategy in TypeScript / Design Patterns](https://refactoring.guru/design-patterns/strategy/typescript/example) - Refactoring Guru's canonical example of Strategy pattern in TypeScript
- [Discriminated Unions and Exhaustiveness Checking in Typescript](https://www.fullstory.com/blog/discriminated-unions-and-exhaustiveness-checking-in-typescript/) - Comprehensive guide to discriminated unions and never type checking
- [TypeScript: Documentation - Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html) - Official TypeScript handbook on type narrowing with discriminated unions
- [Modern TypeScript Patterns — Practical Guide (Mar 9, 2026)](https://www.sachith.co.uk/modern-typescript-patterns-practical-guide-mar-9-2026/) - Recent 2026 guide on modern TS patterns including discriminated unions
- [Understanding design patterns in TypeScript and Node.js - LogRocket Blog](https://blog.logrocket.com/understanding-design-patterns-typescript-node-js/) - Practical guide to design patterns in Node.js context
- [Factory Pattern In TypeScript Using Type Map | Medium](https://medium.com/codex/factory-pattern-type-script-implementation-with-type-map-ea422f38862) - Type-safe factory implementation with type maps

### Node.js Fetch, Timeout, and AbortController

- [A Complete Guide to Timeouts in Node.js | Better Stack Community](https://betterstack.com/community/guides/scaling-nodejs/nodejs-timeouts/) - Comprehensive 2026 guide to timeouts, AbortController, and best practices
- [Timeout fetch request in Node.js | Tech Tonic](https://medium.com/deno-the-complete-reference/timeout-fetch-request-in-node-js-4231f33a9b95) - Practical guide to implementing fetch timeouts
- [Managing Asynchronous Operations in Node.js with AbortController | AppSignal Blog](https://blog.appsignal.com/2025/02/12/managing-asynchronous-operations-in-nodejs-with-abortcontroller.html) - Recent 2025 guide to AbortController patterns
- [Properly Designing fetch Timeouts and Retries in Node.js - Tasuke Hub](https://tasukehub.com/articles/nodejs-fetch-timeout-retry-guide?lang=en) - Design patterns for fetch with timeout and retry logic

### SSE Forwarding and Streaming

- [Real-Time Data Streaming with Server-Sent Events (SSE) - DEV Community](https://dev.to/serifcolakel/real-time-data-streaming-with-server-sent-events-sse-1gb2) - Overview of SSE implementation patterns
- [GitHub - lukeed/fetch-event-stream](https://github.com/lukeed/fetch-event-stream) - Tiny (741b) utility for SSE streaming via fetch and Web Streams API
- [How to Stream Updates with Server-Sent Events in Node.js](https://oneuptime.com/blog/post/2026-01-24-nodejs-server-sent-events/view) - Recent 2026 guide to SSE in Node.js
- [How to stream data over HTTP using Node and Fetch API - DEV Community](https://dev.to/bsorrentino/how-to-stream-data-over-http-using-node-and-fetch-api-4ij2) - Practical guide to HTTP streaming with async generators
- [Consuming Streamed LLM Responses on the Frontend: A Deep Dive into SSE and Fetch - Tamas Piros](https://tpiros.dev/blog/streaming-llm-responses-a-deep-dive/) - Deep dive on consuming streamed AI responses

### Fastify Lifecycle Hooks and Auto-Registration

- [Hooks | Fastify](https://fastify.dev/docs/latest/Reference/Hooks/) - Official Fastify hooks documentation
- [What Are Fastify.js Lifecycle Hooks and How to Use Them? - UrhobA](https://www.urhoba.net/2025/11/what-are-fastifyjs-lifecycle-hooks-and.html?m=1) - Detailed explanation of Fastify lifecycle (November 2025)
- [Fastify Introduces the New onListen Hook! | Nearform](https://nearform.com/insights/fastify-introduces-the-new-onlisten-hook/) - When to use onListen vs onReady
- [Building Node.js Apps with Fastify: A Beginner's Guide | Better Stack Community](https://betterstack.com/community/guides/scaling-nodejs/introduction-to-fastify/) - Introduction to Fastify lifecycle and hooks

### Idempotent API Design

- [Idempotency - What is an Idempotent REST API?](https://restfulapi.net/idempotent-rest-apis/) - Core concepts of idempotency in REST
- [Making retries safe with idempotent APIs - AWS Builders Library](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/) - AWS guide to idempotency keys and patterns
- [Implementing Idempotent REST APIs in ASP.NET Core](https://www.milanjovanovic.tech/blog/implementing-idempotent-rest-apis-in-aspnetcore) - Practical implementation patterns (translatable to Node.js)
- [Designing robust and predictable APIs with idempotency - Stripe Blog](https://stripe.com/blog/idempotency) - Production-grade idempotency patterns from Stripe

### Thread State Management and Conversation History

- [Persistence - Docs by LangChain](https://docs.langchain.com/oss/python/langgraph/persistence) - Official LangGraph persistence and thread state documentation
- [Mastering Persistence in LangGraph: Checkpoints, Threads, and Beyond | Medium](https://medium.com/@vinodkrane/mastering-persistence-in-langgraph-checkpoints-threads-and-beyond-21e412aaed60) - Deep dive on LangGraph state management
- [Agent Chat History and Memory | Microsoft Learn](https://learn.microsoft.com/en-us/agent-framework/user-guide/agents/agent-memory) - Microsoft Agent Framework approach to conversation history
- [Agent Threads and State | DeepWiki](https://deepwiki.com/microsoft/agent-framework/3.5.1-agent-threads-and-state) - Agent framework thread state patterns

### Agent Execution Pipelines

- [Assistants - Docs by LangChain](https://docs.langchain.com/langsmith/assistants) - Official LangGraph assistant execution model
- [Execution Flow and State Machine | Pydantic AI](https://deepwiki.com/pydantic/pydantic-ai/2.2-tools-system) - State machine-based execution flow in Pydantic AI
- [ReAct Agent (create_react_agent) | LangGraph](https://deepwiki.com/langchain-ai/langgraph/8.1-react-agent-(create_react_agent)) - ReAct pattern implementation in LangGraph

### YAML Configuration and Validation

- [Unions | Valibot](https://valibot.dev/guides/unions/) - Discriminated unions in schema validation
- [Discriminated unions | Zod](https://zod.dev/api?id=discriminated-unions) - Zod's discriminated union API for type-safe parsing
- [Cleaner, Safer Code with Discriminated Unions | Basketry](https://basketry.io/blog/discriminated-unions) - Benefits of discriminated unions in API design

---

## Recommended Implementation Sequence

Based on the research and requirements, the following implementation order is recommended:

### Phase 1: Foundation (Types + Registry)
1. Refactor `AgentConfig` to discriminated union in `src/agents/types.ts`
2. Update `AgentRegistry` to parse new YAML format with backward compatibility
3. Update `agent-registry.yaml` to include `type` and `name` fields
4. Update `CliAgentConnector` to accept `CliAgentConfig` directly

### Phase 2: Polymorphic Connectors
1. Create `IAgentConnector` interface in `src/agents/interfaces.ts`
2. Implement `ApiAgentConnector` in `src/agents/api-connector.ts`
3. Create `ConnectorFactory` in `src/agents/connector-factory.ts`
4. Create `AgentExecutor` orchestrator in `src/agents/agent-executor.ts`

### Phase 3: Auto-Registration
1. Create `AssistantResolver` in `src/agents/assistant-resolver.ts`
2. Implement `autoRegisterAssistants()` in `src/agents/assistant-auto-register.ts`
3. Wire into `buildApp()` via `onReady` hook in `src/app.ts`

### Phase 4: Run Pipeline Wiring
1. Inject `AgentExecutor` and `AssistantResolver` into `RunsService`
2. Wire `createStateful()`: assistant lookup → agent execution → state update
3. Wire `streamRun()`: replace stub emitter with real agent streaming
4. Wire `wait()`: synchronous agent execution with full result
5. Update `RunsService` construction in routes to inject dependencies

### Phase 5: Testing & Validation
1. Unit tests for discriminated union type narrowing
2. Unit tests for `ApiAgentConnector` with timeout scenarios
3. Unit tests for `ConnectorFactory` selection logic
4. Unit tests for `autoRegisterAssistants` idempotency
5. Integration test: end-to-end run pipeline with passthrough agent
6. Integration test: auto-registration on startup with persistence

---

**End of Investigation**
