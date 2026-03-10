# LangGraph Server API Drop-in Replacement (lg-api)

## Overview

A TypeScript-based REST API server that replicates the LangGraph Platform (Agent Server) API interface, designed to function as a drop-in replacement for any client using the official LangGraph SDK.

## Tech Stack

- **Runtime**: Node.js (v18+)
- **Framework**: Fastify v5 with TypeBox type provider
- **Schema Validation**: @sinclair/typebox (TypeBox)
- **OpenAPI**: @fastify/swagger + @fastify/swagger-ui
- **SSE Streaming**: Manual implementation via Node.js raw response
- **Testing**: Vitest
- **Language**: TypeScript (strict mode, ESM)

## Configuration

All configuration is via environment variables. **No fallback values** - missing required vars throw an exception.

| Variable | Required | Description |
|----------|----------|-------------|
| `LG_API_PORT` | Yes | Server port |
| `LG_API_HOST` | Yes | Server bind address |
| `LG_API_AUTH_ENABLED` | Yes | Enable/disable API key auth ("true"/"false") |
| `LG_API_KEY` | When auth enabled | Expected API key value |
| `STORAGE_CONFIG_PATH` | No | Path to storage-config.yaml (auto-detects at project root if not set) |
| `AGENT_REGISTRY_PATH` | No | Path to agent-registry.yaml (auto-detects at project root if not set) |
| `AZURE_OPENAI_API_KEY` | When using passthrough agent with Azure OpenAI | Azure OpenAI API key |
| `AZURE_OPENAI_ENDPOINT` | When using passthrough agent with Azure OpenAI | Azure OpenAI endpoint URL |
| `AZURE_OPENAI_DEPLOYMENT` | When using passthrough agent with Azure OpenAI | Azure OpenAI deployment name |

## Project Structure

```
src/
  index.ts              - Entry point
  server.ts             - Server bootstrap
  app.ts                - Fastify app factory
  config/
    env.config.ts       - Strict env var loader
  schemas/              - TypeBox schema definitions
  types/
    index.ts            - Static type exports
  repositories/
    interfaces.ts       - IRepository<T> interface
    in-memory.repository.ts - Base in-memory store
    registry.ts         - Shared repository registry
  storage/
    interfaces.ts       - Storage abstraction interfaces
    config.ts           - Storage config types
    yaml-config-loader.ts - YAML config loader with env substitution
    provider-factory.ts - Storage provider factory
    index.ts            - Barrel export
    providers/
      memory/
        memory-provider.ts - In-memory IStorageProvider implementation
  modules/
    assistants/         - 11 endpoints
    threads/            - 12 endpoints
    runs/               - 14 endpoints (incl. SSE streaming)
    crons/              - 6 endpoints
    store/              - 5 endpoints
    system/             - 2 endpoints (/ok, /info)
  streaming/
    stream-manager.ts   - SSE session management
  agents/
    types.ts            - AgentRequest/Response interfaces
    agent-registry.ts   - Loads agent-registry.yaml
    cli-connector.ts    - Spawns CLI agents, handles stdin/stdout
    request-composer.ts - Builds AgentRequest from thread state + input
  plugins/              - Fastify plugins (cors, swagger, auth, error-handler)
  errors/               - ApiError class
  utils/                - UUID, date, pagination helpers
agents/
  passthrough/          - Isolated pass-through test agent (own package.json)
```

## Storage Layer

The project uses a pluggable storage abstraction layer (`src/storage/`) that supports multiple backends selected via YAML configuration.

### Architecture
- `src/storage/interfaces.ts` -- Entity-specific storage interfaces (IThreadStorage, IAssistantStorage, IRunStorage, ICronStorage, IStoreStorage) and the combined IStorageProvider
- `src/storage/config.ts` -- StorageConfig types for each provider (memory, sqlite, sqlserver, azure-blob)
- `src/storage/yaml-config-loader.ts` -- Loads storage-config.yaml with ${ENV_VAR} substitution
- `src/storage/provider-factory.ts` -- Creates the appropriate IStorageProvider based on config
- `src/storage/providers/memory/memory-provider.ts` -- In-memory adapter wrapping existing repositories
- `src/storage/index.ts` -- Barrel export

### Configuration
Storage is configured via `storage-config.yaml` at the project root. Override the path with the `STORAGE_CONFIG_PATH` env var. If neither the env var nor the default file exists, the in-memory provider is used (see Issues P9 for the documented exception).

### Supported Providers
| Provider | Package | Status | Files |
|----------|---------|--------|-------|
| `memory` | (built-in) | Implemented | `src/storage/providers/memory/` |
| `sqlite` | better-sqlite3 | Implemented | `src/storage/providers/sqlite/` |
| `sqlserver` | mssql | Implemented | `src/storage/providers/sqlserver/` |
| `azure-blob` | @azure/storage-blob | Implemented | `src/storage/providers/azure-blob/` |

## Agent System

### Architecture
Custom agents are implemented as isolated CLI tools that communicate via stdin/stdout JSON. The lg-api connects to them through a CLI Agent Connector that spawns child processes, passes the agent request as JSON on stdin, and reads the agent response from stdout.

```
lg-api Run -> RequestComposer -> AgentRequest JSON -> CliAgentConnector
  -> child_process.spawn(agent CLI) -> stdin: JSON -> Agent -> LLM
  -> stdout: JSON response -> CliAgentConnector -> SSE events -> UI
```

### Configuration Files
- `agent-registry.yaml` - Maps assistant graph_ids to CLI agent commands
- `agents/passthrough/llm-config.yaml` - LLM provider config (named profiles, ${ENV_VAR} substitution)

### Components
- `src/agents/agent-registry.ts` - Loads agent-registry.yaml, resolves agent configs by graph_id
- `src/agents/cli-connector.ts` - Spawns CLI agents, handles stdin/stdout JSON, timeouts, streaming
- `src/agents/request-composer.ts` - Builds AgentRequest from thread state + run input + documents
- `src/agents/types.ts` - AgentRequest, AgentResponse, AgentMessage, AgentDocument interfaces
- `agents/passthrough/` - Isolated pass-through test agent (own package.json, LangChain)

## Tools

<passthrough-agent>
    <objective>
        Pass-through test agent that forwards user requests directly to a configurable LLM via LangChain. Used for testing the agent integration pipeline end-to-end.
    </objective>
    <command>
        echo '{"thread_id":"t1","run_id":"r1","assistant_id":"a1","messages":[{"role":"user","content":"Hello"}]}' | npx tsx agents/passthrough/src/index.ts
    </command>
    <info>
        An isolated CLI tool (separate package.json under agents/passthrough/) that:
        - Reads an AgentRequest JSON object from stdin
        - Sends the messages to a configured LLM via LangChain
        - Writes an AgentResponse JSON object to stdout
        - Errors go to stderr only (never stdout)

        LLM configuration: agents/passthrough/llm-config.yaml
        Supports named profiles per provider (provider + profile fields).

        Supported LLM providers:
        - azure-openai: Requires AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT
        - openai: Requires OPENAI_API_KEY
        - anthropic: Requires ANTHROPIC_API_KEY
        - google: Requires GOOGLE_API_KEY

        Input format (AgentRequest):
        {
          "thread_id": "string",
          "run_id": "string",
          "assistant_id": "string",
          "messages": [{"role": "user|assistant|system", "content": "string"}],
          "documents": [{"id": "string", "title": "string", "content": "string"}],  // optional
          "state": {},     // optional - arbitrary state object exchanged between lg-api and agent
          "metadata": {}   // optional
        }

        Output format (AgentResponse):
        {
          "thread_id": "string",
          "run_id": "string",
          "messages": [{"role": "assistant", "content": "string"}],
          "state": {},     // optional - agent can return modified state
          "metadata": {}   // optional
        }

        Examples:
        # Simple question
        echo '{"thread_id":"t1","run_id":"r1","assistant_id":"a1","messages":[{"role":"user","content":"What is 2+2?"}]}' | npx tsx agents/passthrough/src/index.ts

        # With conversation history
        echo '{"thread_id":"t1","run_id":"r1","assistant_id":"a1","messages":[{"role":"user","content":"Hi"},{"role":"assistant","content":"Hello!"},{"role":"user","content":"How are you?"}]}' | npx tsx agents/passthrough/src/index.ts

        # With documents
        echo '{"thread_id":"t1","run_id":"r1","assistant_id":"a1","messages":[{"role":"user","content":"Summarize the doc"}],"documents":[{"id":"d1","title":"Report","content":"Q1 revenue was $10M..."}]}' | npx tsx agents/passthrough/src/index.ts

        Setup:
        cd agents/passthrough && npm install
        # Set env vars in agents/passthrough/.env or export them
    </info>
</passthrough-agent>

<cli-agent-connector>
    <objective>
        Bridges the lg-api server to CLI-based custom agents. Spawns agents as child processes, passes requests via stdin JSON, and reads responses from stdout JSON.
    </objective>
    <command>
        Used programmatically from src/agents/. Not a standalone CLI tool.
    </command>
    <info>
        Components:
        - AgentRegistry (src/agents/agent-registry.ts): Loads agent-registry.yaml, provides getAgentConfig(graphId)
        - CliAgentConnector (src/agents/cli-connector.ts): executeAgent(graphId, request), streamAgent(graphId, request)
        - RequestComposer (src/agents/request-composer.ts): composeRequest({threadId, runId, assistantId, input, threadState})

        Configuration: agent-registry.yaml at project root
        Override path with AGENT_REGISTRY_PATH env var.

        agent-registry.yaml format:
        agents:
          passthrough:                    # graph_id used in assistant config
            command: npx                  # executable to run
            args: ["tsx", "agents/passthrough/src/index.ts"]  # command arguments
            cwd: "."                      # working directory
            description: "description"    # human-readable description
            timeout: 60000               # max execution time in ms

        Adding a new agent:
        1. Create the agent CLI tool (any language, reads JSON stdin, writes JSON stdout)
        2. Add an entry to agent-registry.yaml with its graph_id and command
        3. Create an assistant in lg-api with that graph_id

        Programmatic usage:
        import { AgentRegistry } from './agents/agent-registry.js';
        import { CliAgentConnector } from './agents/cli-connector.js';
        import { RequestComposer } from './agents/request-composer.js';

        const registry = new AgentRegistry();
        const connector = new CliAgentConnector(registry);
        const composer = new RequestComposer();

        const request = await composer.composeRequest({
          threadId: 'thread-1', runId: 'run-1', assistantId: 'asst-1',
          input: { messages: [{ role: 'user', content: 'Hello' }] },
          threadState: { values: { messages: [...history] } }
        });

        const response = await connector.executeAgent('passthrough', request);
        // Or stream: for await (const event of connector.streamAgent('passthrough', request)) { ... }
    </info>
</cli-agent-connector>

## Commands

```bash
npm run dev      # Start dev server with hot reload (tsx watch)
npm run build    # Compile TypeScript
npm start        # Run compiled server
npm test         # Run test suite (vitest)
```

## Testing

### Automated Tests

The project uses **Vitest** as its test framework. All test files reside in the `test_scripts/` directory.

```bash
npm test                           # Run all tests (170 total)
npx vitest run test_scripts/runs.test.ts   # Run a specific test file
npx vitest run --reporter=verbose  # Verbose output with individual test names
```

**Test files (12):**

| File | Scope | Tests |
|------|-------|-------|
| `storage-memory.test.ts` | In-memory storage provider | 7 |
| `storage-config.test.ts` | YAML config loader | 15 |
| `storage-factory.test.ts` | Storage provider factory | 4 |
| `storage-sqlite.test.ts` | SQLite storage provider | 58 |
| `agent-connector.test.ts` | Agent registry, request composer, CLI connector | 7 (2 skipped without Azure keys) |
| `assistants.test.ts` | Assistants CRUD endpoints | 16 |
| `threads.test.ts` | Threads CRUD endpoints | 13 |
| `runs.test.ts` | Runs CRUD, wait, batch endpoints | 15 |
| `runs-streaming.test.ts` | SSE streaming endpoints | 9 |
| `crons.test.ts` | Crons CRUD endpoints | 10 |
| `store.test.ts` | Store CRUD endpoints | 9 |
| `system.test.ts` | Health check, server info | 7 |

**Notes:**
- Tests for runs and streaming use **mock agent dependencies** (`createMockAgentExecutor`, `createMockAssistantResolver`) so they don't require real LLM API keys or agent processes
- The 2 skipped tests in `agent-connector.test.ts` require Azure OpenAI env vars (`AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`)
- Tests that use the full Fastify app (system, crons, store, assistants) will show `[auto-register]` log messages — this is normal (the app auto-registers agents from `agent-registry.yaml` on startup)

### Manual End-to-End Testing

Prerequisites: Start the server (`npm run dev`) and ensure the passthrough agent's LLM env vars are set.

```bash
# 1. Verify server is running
curl -s http://localhost:8123/ok | jq

# 2. Check auto-registered assistants
curl -s http://localhost:8123/assistants/search \
  -X POST -H 'Content-Type: application/json' -d '{}' | jq

# 3. Create a conversation thread
curl -s http://localhost:8123/threads \
  -X POST -H 'Content-Type: application/json' -d '{}' | jq
# → note the thread_id from the response

# 4. Synchronous run (wait for agent response)
curl -s http://localhost:8123/threads/<THREAD_ID>/runs/wait \
  -X POST -H 'Content-Type: application/json' \
  -d '{"assistant_id":"passthrough","input":{"messages":[{"role":"user","content":"What is 2+2?"}]}}' | jq

# 5. Streaming run (SSE)
curl -N http://localhost:8123/threads/<THREAD_ID>/runs/stream \
  -X POST -H 'Content-Type: application/json' \
  -d '{"assistant_id":"passthrough","input":{"messages":[{"role":"user","content":"Tell me a joke"}]}}'

# 6. Check thread state (conversation history persists across runs)
curl -s http://localhost:8123/threads/<THREAD_ID>/state | jq

# 7. Stateless run (no thread, single-shot)
curl -s http://localhost:8123/runs/wait \
  -X POST -H 'Content-Type: application/json' \
  -d '{"assistant_id":"passthrough","input":{"messages":[{"role":"user","content":"Hello"}]}}' | jq
```

### TypeScript Compilation Check

```bash
npx tsc --noEmit    # Verify all types without emitting files
```

## API curl Reference

For detailed curl examples covering all 50 endpoints, see [docs/api-instructions.md](docs/api-instructions.md).
When asked to perform an API call against lg-api, consult that document for the exact curl syntax, headers, and request body format.

## API Endpoints (50 total)

### Assistants (11)
- POST /assistants, GET/PATCH/DELETE /assistants/:id
- POST /assistants/search, POST /assistants/count
- GET /assistants/:id/graph, /schemas, /subgraphs
- POST /assistants/:id/versions, POST /assistants/:id/latest

### Threads (12)
- POST /threads, GET/PATCH/DELETE /threads/:id
- POST /threads/search, POST /threads/count
- POST /threads/:id/copy, POST /threads/prune
- GET /threads/:id/state, POST /threads/:id/state
- POST /threads/:id/history, GET /threads/:id/stream

### Runs (14)
- POST /threads/:id/runs, POST /runs
- POST /threads/:id/runs/stream, POST /runs/stream (SSE)
- POST /threads/:id/runs/wait, POST /runs/wait
- POST /runs/batch
- GET /threads/:id/runs, GET /threads/:id/runs/:run_id
- POST /threads/:id/runs/:run_id/cancel, POST /runs/cancel
- GET /threads/:id/runs/:run_id/join, GET /threads/:id/runs/:run_id/stream
- DELETE /threads/:id/runs/:run_id

### Crons (6)
- POST /threads/:id/runs/crons, POST /runs/crons
- DELETE/PATCH /runs/crons/:id
- POST /runs/crons/search, POST /runs/crons/count

### Store (5)
- PUT/GET/DELETE /store/items
- POST /store/items/search, POST /store/namespaces

### System (2)
- GET /ok (health check)
- GET /info (server info + capabilities)
