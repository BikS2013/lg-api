# Technical Design: Agent-Assistant Integration

**Project:** lg-api
**Date:** 2026-03-10
**Status:** Draft
**Requirements:** `docs/reference/refined-request-agent-assistant-integration.md` (FR-01 through FR-07)
**Plan:** `docs/design/plan-004-agent-assistant-integration.md`
**Investigation:** `docs/reference/investigation-agent-integration.md`
**Codebase Scan:** `docs/reference/codebase-scan-agent-integration.md`

---

## 1. System Architecture

### 1.1 End-to-End Component Diagram

```
+-----------------------------------------------------------------------+
|  Client (LangGraph SDK / curl / UI)                                   |
|  POST /threads/:id/runs/stream  { assistant_id, input, stream_mode }  |
+-----------------------------------+-----------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------+
|                         Fastify Server                                |
|  +--------------------------------------------------------------+    |
|  |  Runs Routes (runs.routes.ts)                                 |    |
|  |  - Resolves assistant_id (UUID or graph_id)                   |    |
|  |  - Delegates to RunsService                                   |    |
|  +----------------------------+---------------------------------+    |
|                               |                                      |
|  +----------------------------v---------------------------------+    |
|  |  RunsService (runs.service.ts)                                |    |
|  |  - Orchestrates the full run lifecycle                        |    |
|  |  - Calls AssistantResolver, RequestComposer, AgentExecutor    |    |
|  |  - Updates thread state after agent execution                 |    |
|  +------+----------+----------+-----------+---------------------+    |
|         |          |          |           |                          |
|         v          v          v           v                          |
|  +----------+ +----------+ +----------+ +-------------------------+ |
|  |Assistant | |Request   | |Agent     | |Thread                   | |
|  |Resolver  | |Composer  | |Executor  | |Storage                  | |
|  |(resolve) | |(compose) | |(execute) | |(getState / addState)    | |
|  +----+-----+ +----------+ +----+-----+ +-------------------------+ |
|       |                         |                                    |
|       v                         v                                    |
|  +----------+            +------------+                              |
|  |IAssistant|            |Connector   |                              |
|  |Storage   |            |Factory     |                              |
|  |(search)  |            +---+----+---+                              |
|  +----------+                |    |                                   |
|                              v    v                                   |
|                   +---------+ +----------+                           |
|                   |CLI      | |API       |                           |
|                   |Connector| |Connector |                           |
|                   +----+----+ +----+-----+                           |
|                        |           |                                 |
+-----------------------------------------------------------------------+
                         |           |
                         v           v
              +-----------+   +-----------+
              | CLI Agent |   | API Agent |
              | (child    |   | (HTTP     |
              |  process) |   |  endpoint)|
              |  stdin/   |   |  POST     |
              |  stdout   |   |  JSON     |
              +-----+-----+   +-----+-----+
                    |               |
                    v               v
              +---------------------------+
              |    AgentResponse JSON     |
              +-------------+-------------+
                            |
+-----------------------------------------------------------------------+
|                         Fastify Server (continued)                    |
|  +----------------------------v---------------------------------+    |
|  |  RunsService (response handling)                              |    |
|  |  1. Map AgentResponse messages to LangGraph format            |    |
|  |  2. Update thread state (addState with new messages)          |    |
|  |  3. Update run status -> success                              |    |
|  |  4. Update thread status -> idle                              |    |
|  +------+-----+------------------------------------------------+    |
|         |     |                                                      |
|         v     v                                                      |
|   SSE Events  Run Record                                             |
|   to Client   Updated                                                |
+-----------------------------------------------------------------------+
```

### 1.2 Simplified Request Flow

```
Run Request
      |
      v
AssistantResolver.resolve(assistant_id)  -- UUID lookup, then graph_id fallback
      |
      v
Assistant { graph_id, metadata }
      |
      v
RequestComposer.composeRequest()  -- thread state + input -> AgentRequest
      |
      v
AgentExecutor.execute(graph_id, agentRequest)
      |
      +---> AgentRegistry.getAgentConfig(graph_id)  -- lookup config
      |           |
      |           v
      |     AgentConfig (CliAgentConfig | ApiAgentConfig)
      |           |
      |           v
      +---> ConnectorFactory.getConnector(config.type)
                  |
                  +---> CliAgentConnector.executeAgent(config, request)  [type: cli]
                  |       |
                  |       v
                  |     child_process.spawn -> stdin JSON -> stdout JSON
                  |
                  +---> ApiAgentConnector.executeAgent(config, request)  [type: api]
                          |
                          v
                        HTTP POST -> JSON response
      |
      v
AgentResponse { messages, state?, metadata? }
      |
      v
RunsService: update thread state, emit SSE, set run=success, thread=idle
```

### 1.3 Auto-Registration Startup Flow

```
Server Startup
      |
      v
buildApp(config)
      |
      v
initializeStorage()          -- storage layer ready
      |
      v
autoRegisterAssistants()     -- NEW: agent-to-assistant sync
      |
      +---> AgentRegistry()          -- loads agent-registry.yaml
      |           |
      |           v
      |     Map<graph_id, AgentConfig>
      |
      +---> For each graph_id:
      |       |
      |       +---> assistantStorage.search({ graph_id })
      |       |
      |       +---> If none found:
      |       |       assistantStorage.create({
      |       |         assistant_id: uuid(),
      |       |         graph_id,
      |       |         name: config.name || graph_id,
      |       |         metadata: { auto_registered: true, agent_type, agent_config }
      |       |       })
      |       |       LOG INFO: "Registered default assistant for graph_id '...'"
      |       |
      |       +---> If found:
      |               LOG DEBUG: "Assistant already exists for graph_id '...'"
      |
      v
Register Plugins & Routes     -- HTTP server starts accepting requests
```

---

## 2. Interface Contracts (Exact TypeScript)

### 2a. Agent Config Types

**File:** `src/agents/types.ts`

These types replace the current flat `AgentConfig` interface (lines 63-69) with a discriminated union.

```typescript
/**
 * Base configuration shared by all agent transport types.
 */
export interface BaseAgentConfig {
  /** Transport type discriminator. */
  type: string;
  /** Human-readable agent name. Defaults to the graph_id key. */
  name?: string;
  /** Human-readable description. */
  description?: string;
  /** Maximum execution time in milliseconds. */
  timeout: number;
}

/**
 * Configuration for a CLI-based agent (child process via stdin/stdout).
 */
export interface CliAgentConfig extends BaseAgentConfig {
  type: 'cli';
  /** Executable command to spawn (e.g., 'npx', 'python'). */
  command: string;
  /** Command-line arguments (e.g., ['tsx', 'agents/passthrough/src/index.ts']). */
  args: string[];
  /** Working directory for the spawned process (default: '.'). */
  cwd: string;
}

/**
 * Configuration for an API-based agent (HTTP endpoint).
 */
export interface ApiAgentConfig extends BaseAgentConfig {
  type: 'api';
  /** Full URL of the agent's invoke endpoint. Supports ${ENV_VAR} substitution. */
  url: string;
  /** HTTP method (default: 'POST'). */
  method: string;
  /** HTTP headers. Supports ${ENV_VAR} substitution for values. */
  headers: Record<string, string>;
}

/**
 * Discriminated union of all supported agent transport configurations.
 * The `type` field is the discriminator.
 *
 * Future-proof: adding a new transport (e.g., 'in-process') requires
 * adding a new interface and extending this union.
 */
export type AgentConfig = CliAgentConfig | ApiAgentConfig;
```

**Existing types that remain unchanged:**
- `AgentMessage` (lines 12-15)
- `AgentDocument` (lines 20-25)
- `AgentRequest` (lines 30-38)
- `AgentResponse` (lines 43-49)
- `AgentStreamEvent` (lines 55-58)

### 2b. IAgentConnector Interface

**File:** `src/agents/connectors/agent-connector.interface.ts`

```typescript
import type { AgentConfig, AgentRequest, AgentResponse, AgentStreamEvent } from '../types.js';

/**
 * Interface for agent transport connectors.
 *
 * Each connector implements a specific transport mechanism (CLI, HTTP API, etc.)
 * for communicating with external agents. The AgentExecutor selects the appropriate
 * connector via the ConnectorFactory based on the agent's config.type.
 *
 * Contract:
 * - execute(): Sends request, waits for full response. Throws on error/timeout.
 * - stream(): Sends request, yields SSE-compatible events. First event is always
 *   'metadata', last is 'end' (or 'error'). The generator may call execute()
 *   internally and wrap the response into events.
 */
export interface IAgentConnector {
  /**
   * Execute the agent synchronously and return the full response.
   *
   * @param config - Agent configuration (narrowed by type at the call site)
   * @param request - The AgentRequest payload
   * @returns The agent's response
   * @throws ApiError(502) on agent error, ApiError(504) on timeout
   */
  execute(config: AgentConfig, request: AgentRequest): Promise<AgentResponse>;

  /**
   * Execute the agent and stream results as SSE-compatible events.
   *
   * Event sequence: metadata -> values -> messages (per message) -> end
   * On error: metadata -> error
   *
   * @param config - Agent configuration
   * @param request - The AgentRequest payload
   * @yields AgentStreamEvent objects
   */
  stream(config: AgentConfig, request: AgentRequest): AsyncGenerator<AgentStreamEvent>;
}
```

### 2c. AssistantResolver

**File:** `src/agents/assistant-resolver.ts`

```typescript
import type { IAssistantStorage } from '../storage/interfaces.js';
import type { Assistant } from '../types/index.js';
import { ApiError } from '../errors/api-error.js';

/**
 * Resolves an assistant identifier to an Assistant entity.
 *
 * Supports two lookup modes:
 * 1. UUID lookup: direct getById() against assistant storage
 * 2. graph_id lookup: search for an auto-registered assistant by graph_id
 *
 * This enables the LangGraph SDK pattern where assistant_id can be either
 * a UUID or a graph_id string (e.g., "passthrough").
 */
export class AssistantResolver {
  constructor(private assistantStorage: IAssistantStorage) {}

  /**
   * Resolve an assistant by UUID or graph_id.
   *
   * Resolution logic:
   * 1. Try getById(value) -- works for UUID assistant IDs
   * 2. If not found, search for assistants where graph_id === value
   * 3. Filter results for auto_registered === true in metadata
   * 4. If multiple matches: use the one with earliest created_at
   * 5. If no match: throw ApiError(404)
   *
   * @param assistantIdOrGraphId - UUID string or graph_id string
   * @returns The resolved Assistant entity
   * @throws ApiError(404) if no assistant is found
   */
  async resolve(assistantIdOrGraphId: string): Promise<Assistant> {
    // 1. Try direct UUID lookup
    const byId = await this.assistantStorage.getById(assistantIdOrGraphId);
    if (byId) {
      return byId;
    }

    // 2. Try graph_id search
    const searchResult = await this.assistantStorage.search(
      { limit: 10, offset: 0 },
      { graph_id: assistantIdOrGraphId },
    );

    // 3. Filter for auto-registered assistants
    const autoRegistered = searchResult.items.filter(
      (a) => a.metadata && (a.metadata as Record<string, unknown>)['auto_registered'] === true,
    );

    if (autoRegistered.length === 0) {
      throw new ApiError(
        404,
        `No assistant found for identifier '${assistantIdOrGraphId}'`,
      );
    }

    // 4. If multiple, use earliest created_at (the original default)
    if (autoRegistered.length > 1) {
      autoRegistered.sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
    }

    return autoRegistered[0];
  }
}
```

### 2d. AgentExecutor

**File:** `src/agents/agent-executor.ts`

```typescript
import { AgentRegistry } from './agent-registry.js';
import { ConnectorFactory } from './connectors/connector-factory.js';
import type { AgentRequest, AgentResponse, AgentStreamEvent } from './types.js';
import { ApiError } from '../errors/api-error.js';

/**
 * Central orchestrator for agent execution.
 *
 * Combines three responsibilities:
 * 1. Registry lookup: resolves graph_id to AgentConfig
 * 2. Connector selection: delegates to ConnectorFactory based on config.type
 * 3. Execution: invokes the selected connector's execute() or stream()
 *
 * The RunsService depends only on AgentExecutor, not on individual connectors
 * or the registry directly. This keeps the run pipeline decoupled from
 * transport-specific details.
 */
export class AgentExecutor {
  constructor(
    private registry: AgentRegistry,
    private connectorFactory: ConnectorFactory,
  ) {}

  /**
   * Execute an agent synchronously and return the full response.
   *
   * @param graphId - The graph_id that identifies the agent in the registry
   * @param request - The AgentRequest payload
   * @returns The agent's response
   * @throws ApiError(400) if no agent is registered for the graph_id
   * @throws ApiError(502) if the agent returns an error
   * @throws ApiError(504) if the agent times out
   */
  async execute(graphId: string, request: AgentRequest): Promise<AgentResponse> {
    const config = this.registry.getAgentConfig(graphId);
    if (!config) {
      throw new ApiError(
        400,
        `No agent registered for graph_id '${graphId}'. Check agent-registry.yaml.`,
      );
    }
    const connector = this.connectorFactory.getConnector(config);
    return connector.execute(config, request);
  }

  /**
   * Execute an agent and stream results as SSE-compatible events.
   *
   * @param graphId - The graph_id that identifies the agent
   * @param request - The AgentRequest payload
   * @yields AgentStreamEvent objects (metadata, values, messages, end/error)
   * @throws ApiError(400) if no agent is registered for the graph_id
   */
  async *stream(graphId: string, request: AgentRequest): AsyncGenerator<AgentStreamEvent> {
    const config = this.registry.getAgentConfig(graphId);
    if (!config) {
      throw new ApiError(
        400,
        `No agent registered for graph_id '${graphId}'. Check agent-registry.yaml.`,
      );
    }
    const connector = this.connectorFactory.getConnector(config);
    yield* connector.stream(config, request);
  }
}
```

### 2e. ConnectorFactory

**File:** `src/agents/connectors/connector-factory.ts`

```typescript
import type { AgentConfig } from '../types.js';
import type { IAgentConnector } from './agent-connector.interface.js';
import { CliAgentConnector } from './cli-connector.js';
import { ApiAgentConnector } from './api-connector.js';

/**
 * Factory that returns the appropriate IAgentConnector for a given AgentConfig.
 *
 * Uses a switch on config.type with TypeScript exhaustiveness checking.
 * Adding a new agent type requires:
 * 1. New interface in types.ts extending BaseAgentConfig
 * 2. New connector class implementing IAgentConnector
 * 3. New case in this factory's switch statement
 */
export class ConnectorFactory {
  private cliConnector: CliAgentConnector;
  private apiConnector: ApiAgentConnector;

  constructor() {
    this.cliConnector = new CliAgentConnector();
    this.apiConnector = new ApiAgentConnector();
  }

  /**
   * Select the appropriate connector based on the agent config type.
   *
   * @param config - The agent configuration with type discriminator
   * @returns The matching IAgentConnector implementation
   * @throws Error if config.type is unknown (exhaustiveness check)
   */
  getConnector(config: AgentConfig): IAgentConnector {
    switch (config.type) {
      case 'cli':
        return this.cliConnector;
      case 'api':
        return this.apiConnector;
      default: {
        // TypeScript exhaustiveness check: if a new type is added to the
        // AgentConfig union but not handled here, this line produces a
        // compile-time error.
        const _exhaustive: never = config;
        throw new Error(`Unknown agent type: ${(config as { type: string }).type}`);
      }
    }
  }
}
```

### 2f. ApiAgentConnector

**File:** `src/agents/connectors/api-connector.ts`

```typescript
import type { AgentConfig, ApiAgentConfig, AgentRequest, AgentResponse, AgentStreamEvent } from '../types.js';
import type { IAgentConnector } from './agent-connector.interface.js';
import { ApiError } from '../../errors/api-error.js';

/**
 * HTTP-based agent connector.
 *
 * Sends the AgentRequest as a JSON POST (or configured method) to the agent's
 * URL endpoint and parses the response as AgentResponse JSON.
 *
 * Uses native fetch (Node.js 18+) with AbortSignal.timeout() for timeout handling.
 * No external HTTP library dependency.
 *
 * For streaming: calls execute() internally and wraps the response into the
 * standard AgentStreamEvent sequence (metadata -> values -> messages -> end).
 * True SSE streaming from the API agent is not supported in this phase.
 */
export class ApiAgentConnector implements IAgentConnector {
  /**
   * Execute an API agent by sending an HTTP request.
   *
   * Error mapping:
   * - HTTP 4xx/5xx: ApiError(502, "Agent returned HTTP <status>: <body>")
   * - Timeout: ApiError(504, "Agent timed out after <timeout>ms")
   * - Network error: ApiError(502, "Agent connection failed: <message>")
   * - Invalid JSON: ApiError(502, "Agent returned invalid JSON: <snippet>")
   */
  async execute(config: AgentConfig, request: AgentRequest): Promise<AgentResponse> {
    const apiConfig = config as ApiAgentConfig;

    let response: Response;
    try {
      response = await fetch(apiConfig.url, {
        method: apiConfig.method,
        headers: {
          'Content-Type': 'application/json',
          ...apiConfig.headers,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(apiConfig.timeout),
      });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new ApiError(
          504,
          `Agent at ${apiConfig.url} timed out after ${apiConfig.timeout}ms`,
        );
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new ApiError(
        502,
        `Agent connection failed (${apiConfig.url}): ${message}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '(unreadable)');
      throw new ApiError(
        502,
        `Agent at ${apiConfig.url} returned HTTP ${response.status}: ${body.substring(0, 500)}`,
      );
    }

    let agentResponse: AgentResponse;
    const rawText = await response.text();
    try {
      agentResponse = JSON.parse(rawText) as AgentResponse;
    } catch {
      throw new ApiError(
        502,
        `Agent at ${apiConfig.url} returned invalid JSON: ${rawText.substring(0, 500)}`,
      );
    }

    // Validate required fields
    if (!agentResponse.thread_id || !agentResponse.run_id || !Array.isArray(agentResponse.messages)) {
      throw new ApiError(
        502,
        `Agent at ${apiConfig.url} response missing required fields (thread_id, run_id, messages)`,
      );
    }

    return agentResponse;
  }

  /**
   * Execute the API agent and wrap the response into SSE-compatible events.
   *
   * Follows the same event sequence as CliAgentConnector.stream():
   * metadata -> values -> messages (per message) -> end
   */
  async *stream(config: AgentConfig, request: AgentRequest): AsyncGenerator<AgentStreamEvent> {
    // Emit metadata event first
    yield {
      event: 'metadata',
      data: {
        run_id: request.run_id,
        thread_id: request.thread_id,
      },
    };

    let response: AgentResponse;
    try {
      response = await this.execute(config, request);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown agent error';
      yield { event: 'error', data: { message } };
      return;
    }

    // Emit values event with the full response state
    yield {
      event: 'values',
      data: {
        messages: response.messages.map((msg) => ({
          type: msg.role === 'assistant' ? 'ai' : msg.role === 'user' ? 'human' : 'system',
          content: msg.content,
        })),
      },
    };

    // Emit individual messages
    for (const msg of response.messages) {
      yield {
        event: 'messages',
        data: [
          {
            type: msg.role === 'assistant' ? 'AIMessageChunk' : 'HumanMessageChunk',
            content: msg.content,
          },
        ],
      };
    }

    // Emit end event
    yield { event: 'end', data: null };
  }
}
```

---

## 3. Agent Registry YAML Schema

### 3.1 Full Schema Definition

```yaml
# agent-registry.yaml
# Maps graph_id to agent configurations.
# Each entry becomes a default assistant on server startup.

agents:
  # --------------------------------------------------
  # CLI Agent: spawned as a child process
  # --------------------------------------------------
  passthrough:
    type: cli                          # REQUIRED: transport discriminator
    name: "Passthrough Agent"          # OPTIONAL: human-readable name (default: key)
    description: "Pass-through test agent - forwards requests directly to an LLM"
    command: npx                       # REQUIRED for cli: executable to spawn
    args: ["tsx", "agents/passthrough/src/index.ts"]  # OPTIONAL: command arguments (default: [])
    cwd: "."                           # OPTIONAL: working directory (default: ".")
    timeout: 60000                     # OPTIONAL: max execution time in ms (default: 60000)

  # --------------------------------------------------
  # API Agent: invoked via HTTP
  # --------------------------------------------------
  external-rag:
    type: api                          # REQUIRED: transport discriminator
    name: "External RAG Agent"         # OPTIONAL: human-readable name (default: key)
    description: "RAG agent accessible via REST API"
    url: "${RAG_AGENT_URL}/invoke"     # REQUIRED for api: endpoint URL (supports ${ENV_VAR})
    method: POST                       # OPTIONAL: HTTP method (default: "POST")
    headers:                           # OPTIONAL: HTTP headers (supports ${ENV_VAR} in values)
      Authorization: "Bearer ${RAG_AGENT_API_KEY}"
      Content-Type: "application/json"
    timeout: 30000                     # OPTIONAL: max execution time in ms (default: 60000)

  # --------------------------------------------------
  # Backward Compatibility: no type field defaults to cli
  # --------------------------------------------------
  # legacy-agent:
  #   command: python
  #   args: ["-m", "agents.legacy.main"]
  #   cwd: "./agents/legacy"
  #   timeout: 120000
```

### 3.2 Field Reference

| Field | Type | Required | Applies To | Default | Description |
|-------|------|----------|------------|---------|-------------|
| `type` | `'cli' \| 'api'` | No | all | `'cli'` | Transport type discriminator. Omitting defaults to `'cli'` for backward compatibility. |
| `name` | `string` | No | all | agent key | Human-readable name used as the assistant name during auto-registration. |
| `description` | `string` | No | all | `undefined` | Description propagated to the auto-registered assistant. |
| `timeout` | `number` | No | all | `60000` | Maximum execution time in milliseconds. |
| `command` | `string` | Yes (cli) | cli | -- | Executable to spawn (e.g., `npx`, `python`, `node`). |
| `args` | `string[]` | No | cli | `[]` | Command-line arguments passed to the spawned process. |
| `cwd` | `string` | No | cli | `'.'` | Working directory for the child process. Resolved relative to project root. |
| `url` | `string` | Yes (api) | api | -- | Agent HTTP endpoint URL. Supports `${ENV_VAR}` substitution. |
| `method` | `string` | No | api | `'POST'` | HTTP method for the agent request. |
| `headers` | `Record<string, string>` | No | api | `{}` | HTTP headers. Values support `${ENV_VAR}` substitution. |

### 3.3 Environment Variable Substitution

Both `url` and `headers` values support `${ENV_VAR}` substitution, reusing the same pattern from `yaml-config-loader.ts`:

```typescript
// Pattern: ${VARIABLE_NAME}
const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

function substituteEnvVars(value: string): string {
  return value.replace(ENV_VAR_PATTERN, (match, varName) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      throw new Error(`Environment variable ${varName} is not set`);
    }
    return envValue;
  });
}
```

### 3.4 Validation Rules

- If `type === 'cli'` (or `type` is absent): `command` is required, must be a non-empty string.
- If `type === 'api'`: `url` is required, must be a non-empty string.
- Unknown `type` values: throw `Error("Agent '<key>': unknown type '<type>'")`
- Missing required fields: throw with descriptive message including the agent key and config file path.

---

## 4. Auto-Registration Flow

### 4.1 Detailed Sequence

```
buildApp(config)
  |
  v
initializeStorage()
  |
  v                          (NEW STEP)
autoRegisterAssistants(agentRegistry, assistantStorage, logger)
  |
  v
agentRegistry.getRegisteredGraphIds()
  |
  v
['passthrough', 'external-rag', ...]
  |
  v
FOR EACH graphId:
  |
  +---> TRY:
  |       |
  |       v
  |     agentRegistry.getAgentConfig(graphId)
  |       |
  |       v
  |     config: AgentConfig  (e.g., CliAgentConfig for 'passthrough')
  |       |
  |       v
  |     assistantStorage.search({ limit: 10, offset: 0 }, { graph_id: graphId })
  |       |
  |       v
  |     searchResult.items.length === 0 ?
  |       |
  |       +--- YES (no existing assistant):
  |       |      |
  |       |      v
  |       |    assistantStorage.create({
  |       |      assistant_id: generateId(),     // new UUID
  |       |      graph_id: graphId,              // e.g., 'passthrough'
  |       |      name: config.name || graphId,   // e.g., 'Passthrough Agent'
  |       |      description: config.description || '',
  |       |      config: {},                     // empty default
  |       |      metadata: {
  |       |        auto_registered: true,
  |       |        agent_type: config.type,      // 'cli' or 'api'
  |       |        agent_config: sanitize(config) // redacted copy
  |       |      },
  |       |      version: 1,
  |       |      created_at: nowISO(),
  |       |      updated_at: nowISO(),
  |       |    })
  |       |      |
  |       |      v
  |       |    logger.info("Registered default assistant '%s' for graph_id '%s'", name, graphId)
  |       |
  |       +--- NO (assistant already exists):
  |              |
  |              v
  |            logger.debug("Assistant already exists for graph_id '%s'", graphId)
  |
  +---> CATCH (error):
          |
          v
        logger.error({ error }, "Failed to register assistant for graph_id '%s'", graphId)
        // Continue to next agent -- do NOT throw
  |
  v
NEXT graphId
  |
  v
(Auto-registration complete, continue with plugin/route registration)
```

### 4.2 Sensitive Value Redaction

When storing `agent_config` in assistant metadata, sensitive header values are redacted:

```typescript
function sanitizeConfig(config: AgentConfig): Record<string, unknown> {
  const sanitized = { ...config };
  if (config.type === 'api') {
    const apiConfig = { ...(config as ApiAgentConfig) };
    const redactedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(apiConfig.headers)) {
      // Redact values for common auth headers
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'authorization' || lowerKey.includes('key') || lowerKey.includes('token')) {
        redactedHeaders[key] = '***';
      } else {
        redactedHeaders[key] = value;
      }
    }
    apiConfig.headers = redactedHeaders;
    return apiConfig as unknown as Record<string, unknown>;
  }
  return sanitized as unknown as Record<string, unknown>;
}
```

### 4.3 Wiring in app.ts

Insert after `initializeStorage()` (line 34 of `src/app.ts`), before the `onClose` hook:

```typescript
// Auto-register default assistants from agent-registry.yaml
try {
  const { AgentRegistry } = await import('./agents/agent-registry.js');
  const { autoRegisterAssistants } = await import('./agents/assistant-auto-register.js');
  const { getStorageProvider } = await import('./repositories/registry.js');
  const agentRegistry = new AgentRegistry();
  await autoRegisterAssistants(agentRegistry, getStorageProvider().assistants, app.log);
} catch (error) {
  app.log.error({ error }, 'Agent auto-registration failed (non-fatal)');
  // Server continues -- auto-registration failure is not fatal
}
```

### 4.4 Idempotency Guarantees

- **First startup (fresh storage):** One assistant created per registered agent.
- **Subsequent restarts (persistent storage):** `search({ graph_id })` finds existing assistants; no duplicates created.
- **Agent removed from registry:** Existing assistant remains in storage. Not deleted. Can be deleted manually via `DELETE /assistants/:id`.
- **Agent added to registry:** New assistant created on next startup.
- **Concurrent startups:** In-memory provider is single-process. For persistent providers (SQLite, SQL Server), the `graph_id` search + create is not atomic, but race conditions are unlikely in practice (single server). Documented as known limitation.

---

## 5. Run Execution Pipeline (The Core)

### 5.1 Execution Modes Overview

| Mode | Endpoint Pattern | RunsService Method | Behavior |
|------|------------------|--------------------|----------|
| Fire-and-forget | `POST /threads/:id/runs`, `POST /runs` | `createStateful()`, `createStateless()` | Returns run immediately. Agent executes in background via `setImmediate`. |
| Wait | `POST /threads/:id/runs/wait`, `POST /runs/wait` | `wait()` | Blocks until agent completes. Returns result in response body. |
| Stream | `POST /threads/:id/runs/stream`, `POST /runs/stream` | `streamRun()` | Streams agent events as SSE to client in real-time. |

### 5.2 Fire-and-Forget Mode (createStateful)

**Step-by-step sequence:**

```
1.  RunsService.createStateful(threadId, request)
2.    thread = threadsRepository.getById(threadId)          // verify thread exists
3.    if (!thread) throw ApiError(404)
4.    assistant = assistantResolver.resolve(request.assistant_id)  // NEW: UUID or graph_id
5.    run = runsRepository.create({ run_id, thread_id, assistant_id: assistant.assistant_id, status: 'pending' })
6.    threadsRepository.update(threadId, { status: 'busy' })
7.    runsRepository.update(run.run_id, { status: 'running' })
8.    setImmediate(async () => {                             // background execution
9.      try {
10.       threadState = threadStorage.getState(threadId)     // get conversation history
11.       agentRequest = requestComposer.composeRequest({
12.         threadId, runId: run.run_id, assistantId: assistant.assistant_id,
13.         input: request.input || {},
14.         threadState: threadState?.values || {}
15.       })
16.       agentResponse = agentExecutor.execute(assistant.graph_id, agentRequest)
17.       updateThreadState(threadId, request.input, agentResponse, threadState)  // persist
18.       runsRepository.update(run.run_id, { status: 'success' })
19.       threadsRepository.update(threadId, { status: 'idle' })
20.     } catch (error) {
21.       runsRepository.update(run.run_id, { status: 'error' })
22.       threadsRepository.update(threadId, { status: 'error' })
23.       logger.error({ error }, 'Background run execution failed')
24.     }
25.   })
26.   return run                                             // returns immediately with 'pending'
```

**Key point:** The assistant is resolved at step 4 synchronously (before returning the run), so a 404 is returned immediately if the assistant/graph is not found. The actual agent execution happens asynchronously.

### 5.3 Wait Mode

**Step-by-step sequence:**

```
1.  RunsService.wait(threadId, request)
2.    assistant = assistantResolver.resolve(request.assistant_id)    // UUID or graph_id
3.    run = createRunRecord(threadId, assistant.assistant_id, request)
4.    runsRepository.update(run.run_id, { status: 'running' })
5.    if (threadId) threadsRepository.update(threadId, { status: 'busy' })
6.    try {
7.      threadState = threadId ? threadStorage.getState(threadId) : null
8.      agentRequest = requestComposer.composeRequest({
9.        threadId: threadId || run.run_id,
10.       runId: run.run_id,
11.       assistantId: assistant.assistant_id,
12.       input: request.input || {},
13.       threadState: threadState?.values || {}
14.     })
15.     agentResponse = agentExecutor.execute(assistant.graph_id, agentRequest)
16.     if (threadId) {
17.       updateThreadState(threadId, request.input, agentResponse, threadState)
18.       threadsRepository.update(threadId, { status: 'idle' })
19.     }
20.     runsRepository.update(run.run_id, { status: 'success' })
21.     result = {
22.       messages: agentResponse.messages.map(msg => ({
23.         type: msg.role === 'assistant' ? 'ai' : msg.role === 'user' ? 'human' : 'system',
24.         content: msg.content,
25.       }))
26.     }
27.     return { run_id, thread_id, status: 'success', result }
28.   } catch (error) {
29.     runsRepository.update(run.run_id, { status: 'error' })
30.     if (threadId) threadsRepository.update(threadId, { status: 'error' })
31.     throw error                                          // propagates to client as HTTP error
32.   }
```

**Key point:** The HTTP response is held open until the agent completes. If the agent times out (per `config.timeout`), the error propagates as an HTTP error to the client.

### 5.4 Stream Mode

**Step-by-step sequence:**

```
1.  RunsService.streamRun(threadId, request, reply)
2.    assistant = assistantResolver.resolve(request.assistant_id)
3.    run = createRunRecord(threadId, assistant.assistant_id, request)
4.    runsRepository.update(run.run_id, { status: 'running' })
5.    if (threadId) threadsRepository.update(threadId, { status: 'busy' })
6.    // Set SSE headers
7.    reply.raw.writeHead(200, {
8.      'Content-Type': 'text/event-stream',
9.      'Cache-Control': 'no-cache',
10.     'Connection': 'keep-alive',
11.     'X-Accel-Buffering': 'no',
12.   })
13.   // Create stream session for replay support
14.   session = streamManager.createSession(run.run_id, threadId, streamModes)
15.   // Compose agent request
16.   threadState = threadId ? threadStorage.getState(threadId) : null
17.   agentRequest = requestComposer.composeRequest({ ... })
18.   // Stream agent events
19.   try {
20.     collectedResponse = null
21.     for await (event of agentExecutor.stream(assistant.graph_id, agentRequest)) {
22.       writeSSE(reply, session, event.event, event.data)  // write to reply.raw
23.       if (event.event === 'values') {
24.         collectedResponse = event.data  // capture for state update
25.       }
26.     }
27.     // Update thread state with collected response
28.     if (threadId && collectedResponse) {
29.       updateThreadStateFromStreamData(threadId, request.input, collectedResponse, threadState)
30.     }
31.     runsRepository.update(run.run_id, { status: 'success' })
32.     if (threadId) threadsRepository.update(threadId, { status: 'idle' })
33.   } catch (error) {
34.     writeSSE(reply, session, 'error', { message: error.message })
35.     runsRepository.update(run.run_id, { status: 'error' })
36.     if (threadId) threadsRepository.update(threadId, { status: 'error' })
37.   } finally {
38.     streamManager.closeSession(run.run_id)
39.     reply.raw.end()
40.   }
```

**Key point:** The `RunStreamEmitter` is bypassed. `RunsService.streamRun()` writes SSE events directly using the `reply.raw` pattern already established in the codebase. The emitter class remains in the codebase but is effectively deprecated.

### 5.5 Thread State Update Logic

After agent execution, the pipeline must persist the updated conversation state:

```typescript
private async updateThreadState(
  threadId: string,
  input: Record<string, unknown>,
  agentResponse: AgentResponse,
  existingState: ThreadState | null,
): Promise<void> {
  // 1. Get existing messages from state
  const existingMessages = existingState?.values?.messages as unknown[] || [];

  // 2. Extract new user messages from input
  const inputMessages = (input?.messages as unknown[]) || [];

  // 3. Map agent response messages to LangGraph format
  const responseMessages = agentResponse.messages.map((msg) => ({
    type: msg.role === 'assistant' ? 'ai' : msg.role === 'user' ? 'human' : 'system',
    content: msg.content,
  }));

  // 4. Combine all messages
  const allMessages = [...existingMessages, ...inputMessages, ...responseMessages];

  // 5. Build new ThreadState
  const newState: ThreadState = {
    values: {
      messages: allMessages,
      ...(agentResponse.state ? { state: agentResponse.state } : {}),
    },
    next: [],
    checkpoint: {
      thread_id: threadId,
      checkpoint_ns: '',
      checkpoint_id: generateId(),
    },
    metadata: agentResponse.metadata || {},
    created_at: nowISO(),
    parent_checkpoint: existingState?.checkpoint || null,
    tasks: [],
  };

  // 6. Persist
  await this.threadStorage.addState(threadId, newState);
  await this.threadStorage.update(threadId, {
    values: newState.values,
    updated_at: nowISO(),
  });
}
```

### 5.6 Assistant ID Resolution (all modes)

All three execution modes share the same assistant resolution logic:

```
assistant_id from request
        |
        v
AssistantResolver.resolve(assistant_id)
        |
        +---> assistantStorage.getById(assistant_id)
        |       |
        |       +--- Found? -> return Assistant
        |       |
        |       +--- Not found? -> continue to graph_id search
        |
        +---> assistantStorage.search({ graph_id: assistant_id })
                |
                +--- filter for metadata.auto_registered === true
                |
                +--- Results?
                |       |
                |       +--- 0 results -> throw ApiError(404, "No assistant found for '<id>'")
                |       +--- 1 result  -> return it
                |       +--- N results -> return earliest created_at
                |
                v
              Assistant { assistant_id, graph_id, metadata, ... }
```

---

## 6. Error Handling

### 6.1 Error Scenarios and Responses

| Scenario | Where Detected | HTTP Status | Error Message | Recovery |
|----------|----------------|-------------|---------------|----------|
| Agent not found in registry | `AgentExecutor.execute()` | 400 | `No agent registered for graph_id '<id>'. Check agent-registry.yaml.` | Register the agent in `agent-registry.yaml` and restart. |
| Agent execution timeout (CLI) | `CliAgentConnector.execute()` | 500 (wrapped) | `Agent "<id>" timed out after <timeout>ms` | Increase timeout in `agent-registry.yaml`. |
| Agent execution timeout (API) | `ApiAgentConnector.execute()` | 504 | `Agent at <url> timed out after <timeout>ms` | Increase timeout or check agent health. |
| Agent returns error (CLI exit code != 0) | `CliAgentConnector.execute()` | 500 (wrapped) | `Agent "<id>" exited with code <code>. stderr: <msg>` | Fix the agent's error. |
| Agent returns HTTP error (API) | `ApiAgentConnector.execute()` | 502 | `Agent at <url> returned HTTP <status>: <body>` | Fix the agent endpoint. |
| Agent returns invalid JSON | Both connectors | 502 | `Agent returned invalid JSON: <snippet>` | Fix the agent's output format. |
| Assistant not found (UUID or graph_id) | `AssistantResolver.resolve()` | 404 | `No assistant found for identifier '<value>'` | Create the assistant or register the agent. |
| Invalid graph_id (no agent registered) | `AgentExecutor.execute()` | 400 | `No agent registered for graph_id '<id>'` | Add agent to registry. |
| Agent connection failed (API network) | `ApiAgentConnector.execute()` | 502 | `Agent connection failed (<url>): <msg>` | Check agent endpoint availability. |
| Agent spawn failed (CLI command not found) | `CliAgentConnector.execute()` | 500 (wrapped) | `Failed to spawn agent "<id>" (command: <cmd>): <msg>` | Install the agent command. |

### 6.2 Error Flow in Run Pipeline

```
Agent Error Thrown
        |
        v
+----- Execution Mode? -----+
|                            |
v                            v
Fire-and-forget          Wait / Stream
|                            |
v                            v
Caught in setImmediate()  Propagated to handler
|                            |
v                            v
Log error at ERROR level  Fastify error handler
Run status -> 'error'     converts to HTTP response
Thread status -> 'error'  (status code from ApiError)
(Client already got 200   Run status -> 'error'
 with 'pending' run)      Thread status -> 'error'
```

### 6.3 Error Isolation During Auto-Registration

```typescript
for (const graphId of graphIds) {
  try {
    // ... registration logic
  } catch (error) {
    logger.error({ error, graphId }, 'Failed to register assistant for graph_id');
    // CONTINUE to next agent -- one failure does not block others
  }
}
```

---

## 7. File Structure

### 7.1 Files to Create (7)

| File | Responsibility |
|------|---------------|
| `src/agents/connectors/agent-connector.interface.ts` | `IAgentConnector` interface definition |
| `src/agents/connectors/cli-connector.ts` | Refactored CLI connector implementing `IAgentConnector` (moved from `src/agents/cli-connector.ts`) |
| `src/agents/connectors/api-connector.ts` | HTTP-based agent connector implementing `IAgentConnector` |
| `src/agents/connectors/connector-factory.ts` | Factory selecting connector by `AgentConfig.type` |
| `src/agents/agent-executor.ts` | Central orchestrator: registry lookup + connector selection + execution |
| `src/agents/assistant-auto-register.ts` | Startup auto-registration logic |
| `src/agents/assistant-resolver.ts` | UUID/graph_id resolution to Assistant entity |

### 7.2 Files to Modify (9)

| File | Changes |
|------|---------|
| `src/agents/types.ts` | Replace flat `AgentConfig` with `BaseAgentConfig` + `CliAgentConfig` + `ApiAgentConfig` discriminated union. Add `name` field. |
| `src/agents/agent-registry.ts` | Expand `RawAgentEntry` for polymorphic fields. Refactor `validateAndRegister()` to branch on `type`. Add env var substitution for API headers. Add `getRegisteredGraphIds()` method (already exists). |
| `src/agents/cli-connector.ts` | Implement `IAgentConnector`. Change signatures from `(graphId, request)` to `(config, request)`. Remove internal `AgentRegistry` dependency. Move to `src/agents/connectors/cli-connector.ts`. |
| `src/modules/runs/runs.service.ts` | Expand constructor to accept `AgentExecutor`, `AssistantResolver`, `RequestComposer`, `IThreadStorage`. Replace all stub responses with real agent execution pipeline. Add `updateThreadState()` private method. |
| `src/modules/runs/runs.streaming.ts` | Mark as deprecated. No longer called from `streamRun()` which now writes SSE directly. Keep for backward compat with `joinStream()`. |
| `src/modules/runs/runs.routes.ts` | Update `RunsService` construction to inject new dependencies via `getAgentExecutor()`, `getAssistantResolver()`, etc. |
| `src/app.ts` | Add auto-registration call after `initializeStorage()`, before route registration. |
| `src/schemas/run.schema.ts` | Change `RunCreateRequestSchema.assistant_id` from `Type.String({ format: 'uuid' })` to `Type.String()` to allow graph_id strings. |
| `src/repositories/registry.ts` | Add `initializeAgentSystem()`, `getAgentExecutor()`, `getAssistantResolver()` exports for module-level agent system singletons. |

### 7.3 Configuration File to Modify (1)

| File | Changes |
|------|---------|
| `agent-registry.yaml` | Add explicit `type: cli` and `name` fields to passthrough agent entry. |

### 7.4 Test Files to Create (7)

| File | Scope |
|------|-------|
| `test_scripts/agent-registry-polymorphic.test.ts` | AgentRegistry parsing CLI, API, backward-compat types |
| `test_scripts/api-connector.test.ts` | ApiAgentConnector: success, timeout, HTTP error, network error, invalid JSON |
| `test_scripts/connector-factory.test.ts` | ConnectorFactory: CLI selection, API selection, exhaustiveness |
| `test_scripts/agent-executor.test.ts` | AgentExecutor: execute, stream, missing agent error |
| `test_scripts/auto-register.test.ts` | autoRegisterAssistants: creation, idempotent skip, error isolation |
| `test_scripts/assistant-resolver.test.ts` | AssistantResolver: UUID lookup, graph_id lookup, multiple matches, not found |
| `test_scripts/run-pipeline-integration.test.ts` | End-to-end: create run -> agent executes -> thread state updated |

### 7.5 Updated Project Structure (src/agents/)

```
src/agents/
  types.ts                              -- AgentConfig discriminated union + existing types
  agent-registry.ts                     -- Polymorphic YAML loader
  agent-executor.ts                     -- NEW: central orchestrator
  assistant-resolver.ts                 -- NEW: UUID/graph_id resolution
  assistant-auto-register.ts            -- NEW: startup auto-registration
  request-composer.ts                   -- unchanged
  connectors/                           -- NEW directory
    agent-connector.interface.ts        -- NEW: IAgentConnector interface
    cli-connector.ts                    -- MOVED + MODIFIED: implements IAgentConnector
    api-connector.ts                    -- NEW: HTTP connector
    connector-factory.ts                -- NEW: type-based connector selection
```

---

## 8. Implementation Units for Parallel Coding

### 8.1 Unit Dependency Graph

```
Unit A: Types + Interfaces (foundation)
  |
  +---> Unit B: Connectors (CLI refactor + API + factory)
  |
  +---> Unit C: Auto-Registration + AssistantResolver
  |
  +---> Unit D: Pipeline Wiring (depends on A + B + C)
```

### 8.2 Unit A: Types + Interfaces (Foundation)

**Dependencies:** None (can start immediately).
**Estimated effort:** Small (1-2 hours).

| File | Action |
|------|--------|
| `src/agents/types.ts` | Modify: replace `AgentConfig` with discriminated union |
| `src/agents/agent-registry.ts` | Modify: polymorphic parsing, backward compat |
| `src/agents/connectors/agent-connector.interface.ts` | Create: `IAgentConnector` interface |
| `agent-registry.yaml` | Modify: add `type` and `name` fields |

**Overlap analysis:** Only touches files in `src/agents/` and the root YAML. No overlap with Units B or C file lists.

### 8.3 Unit B: Connectors (CLI Refactor + API + Factory)

**Dependencies:** Unit A (uses `CliAgentConfig`, `ApiAgentConfig`, `IAgentConnector`).
**Estimated effort:** Medium (3-4 hours).

| File | Action |
|------|--------|
| `src/agents/connectors/cli-connector.ts` | Create (moved from `src/agents/cli-connector.ts`): implement `IAgentConnector`, accept config directly |
| `src/agents/connectors/api-connector.ts` | Create: HTTP connector with native fetch |
| `src/agents/connectors/connector-factory.ts` | Create: type-based selector |
| `src/agents/agent-executor.ts` | Create: central orchestrator |

**Overlap analysis:** All files are in `src/agents/connectors/` or new files in `src/agents/`. Does NOT touch any file that Unit C touches.

### 8.4 Unit C: Auto-Registration + AssistantResolver

**Dependencies:** Unit A (uses `AgentConfig`, `AgentRegistry`).
**Estimated effort:** Medium (2-3 hours).

| File | Action |
|------|--------|
| `src/agents/assistant-resolver.ts` | Create: resolve UUID or graph_id |
| `src/agents/assistant-auto-register.ts` | Create: startup registration |
| `src/schemas/run.schema.ts` | Modify: relax `assistant_id` UUID constraint |
| `src/app.ts` | Modify: add auto-registration after storage init |

**Overlap analysis:** Touches `run.schema.ts` and `app.ts`, which are NOT touched by Unit B. No file overlap.

### 8.5 Unit D: Pipeline Wiring (Sequential, depends on A + B + C)

**Dependencies:** Units A, B, and C must all be complete.
**Estimated effort:** Large (4-6 hours).

| File | Action |
|------|--------|
| `src/modules/runs/runs.service.ts` | Modify: replace all stubs with real execution pipeline |
| `src/modules/runs/runs.streaming.ts` | Modify: mark deprecated, keep for joinStream |
| `src/modules/runs/runs.routes.ts` | Modify: inject new dependencies |
| `src/repositories/registry.ts` | Modify: add `initializeAgentSystem()` and getters |

**Overlap analysis:** All files are in `src/modules/runs/` and `src/repositories/`. Not touched by A, B, or C.

### 8.6 Parallel Execution Verification

| Unit A Files | Unit B Files | Unit C Files | Unit D Files |
|:-------------|:-------------|:-------------|:-------------|
| `src/agents/types.ts` | `src/agents/connectors/cli-connector.ts` | `src/agents/assistant-resolver.ts` | `src/modules/runs/runs.service.ts` |
| `src/agents/agent-registry.ts` | `src/agents/connectors/api-connector.ts` | `src/agents/assistant-auto-register.ts` | `src/modules/runs/runs.streaming.ts` |
| `src/agents/connectors/agent-connector.interface.ts` | `src/agents/connectors/connector-factory.ts` | `src/schemas/run.schema.ts` | `src/modules/runs/runs.routes.ts` |
| `agent-registry.yaml` | `src/agents/agent-executor.ts` | `src/app.ts` | `src/repositories/registry.ts` |

**Confirmed:** No file appears in more than one unit. Units B and C can be developed in parallel after Unit A completes. Unit D must wait for all three.

### 8.7 Execution Order

```
Time 0:  Unit A (foundation)
         |
Time 1:  Unit B (connectors)  ||  Unit C (auto-reg)   <-- PARALLEL
         |                     ||  |
Time 2:  Unit D (pipeline wiring)  <-- SEQUENTIAL after B+C
         |
Time 3:  Phase 5: Testing
```

---

## Appendix A: Agent System Singleton Initialization

**File:** `src/repositories/registry.ts` (additions)

```typescript
import { AgentRegistry } from '../agents/agent-registry.js';
import { AgentExecutor } from '../agents/agent-executor.js';
import { AssistantResolver } from '../agents/assistant-resolver.js';
import { RequestComposer } from '../agents/request-composer.js';
import { ConnectorFactory } from '../agents/connectors/connector-factory.js';

let agentExecutor: AgentExecutor | null = null;
let assistantResolver: AssistantResolver | null = null;
let requestComposer: RequestComposer | null = null;

/**
 * Initialize the agent system singletons.
 * Must be called after initializeStorage().
 */
export function initializeAgentSystem(): void {
  const agentRegistry = new AgentRegistry();
  const connectorFactory = new ConnectorFactory();
  agentExecutor = new AgentExecutor(agentRegistry, connectorFactory);
  assistantResolver = new AssistantResolver(getStorageProvider().assistants);
  requestComposer = new RequestComposer();
}

export function getAgentExecutor(): AgentExecutor {
  if (!agentExecutor) {
    throw new Error('Agent system not initialized. Call initializeAgentSystem() first.');
  }
  return agentExecutor;
}

export function getAssistantResolver(): AssistantResolver {
  if (!assistantResolver) {
    throw new Error('Agent system not initialized. Call initializeAgentSystem() first.');
  }
  return assistantResolver;
}

export function getRequestComposer(): RequestComposer {
  if (!requestComposer) {
    throw new Error('Agent system not initialized. Call initializeAgentSystem() first.');
  }
  return requestComposer;
}
```

---

## Appendix B: Updated RunsService Constructor

```typescript
export class RunsService {
  private streamManager: StreamManager;

  constructor(
    private runsRepository: RunsRepository,
    private threadsRepository: ThreadsRepository,
    private agentExecutor: AgentExecutor,
    private assistantResolver: AssistantResolver,
    private requestComposer: RequestComposer,
    private threadStorage: IThreadStorage,
  ) {
    this.streamManager = new StreamManager();
  }

  // ... methods
}
```

---

## Appendix C: Updated runs.routes.ts Service Construction

```typescript
import { getRepositoryRegistry, getStorageProvider, getAgentExecutor, getAssistantResolver, getRequestComposer } from '../../repositories/registry.js';

export default async function registerRunRoutes(fastify: FastifyInstance): Promise<void> {
  const { runs: runsRepository, threads: threadsRepository } = getRepositoryRegistry();
  const storageProvider = getStorageProvider();
  const runsService = new RunsService(
    runsRepository,
    threadsRepository,
    getAgentExecutor(),
    getAssistantResolver(),
    getRequestComposer(),
    storageProvider.threads,
  );

  // ... route registrations (unchanged)
}
```

---

**End of Technical Design**
