# lg-api

A TypeScript-based REST API server that replicates the [LangGraph Platform](https://langchain-ai.github.io/langgraph/cloud/) (Agent Server) API interface. Designed as a **drop-in replacement** for any client using the official LangGraph SDK, while allowing arbitrary custom agents (written in any language) to be plugged in as CLI subprocesses.

## Why

The official LangGraph Platform requires deploying graphs defined with LangGraph's Python/JS SDKs. `lg-api` exposes the same REST surface (50 endpoints across Assistants, Threads, Runs, Crons, Store, System) but delegates the actual agent logic to external CLI processes that communicate over stdin/stdout JSON. This lets you:

- Use existing LangGraph SDK clients (Python/JS) unchanged.
- Implement agents in any language (TypeScript, Python, Go, …) without binding to the LangGraph runtime.
- Swap storage backends (in-memory, SQLite, SQL Server, Azure Blob) via YAML config.

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Fastify v5 with TypeBox type provider
- **Schemas**: `@sinclair/typebox`
- **OpenAPI**: `@fastify/swagger` + `@fastify/swagger-ui`
- **SSE Streaming**: manual implementation over raw Node response
- **Testing**: Vitest
- **Language**: TypeScript (strict, ESM)

## Quick Start

```bash
# Install
npm install

# Configure (copy and edit)
cp .env.example .env

# Run in dev mode (hot reload)
npm run dev

# Verify
curl -s http://localhost:8123/ok | jq
```

Swagger UI: <http://localhost:8123/docs>

## Configuration

All configuration is via environment variables. **No fallback values** — missing required vars throw an exception at startup.

| Variable | Required | Description |
|---|---|---|
| `LG_API_PORT` | Yes | Server port |
| `LG_API_HOST` | Yes | Server bind address |
| `LG_API_AUTH_ENABLED` | Yes | Enable/disable API key auth (`"true"` / `"false"`) |
| `LG_API_KEY` | When auth enabled | Expected API key value |
| `STORAGE_CONFIG_PATH` | No | Path to `storage-config.yaml` (auto-detects at project root) |
| `LG_API_BODY_LIMIT` | No | Maximum request body size in bytes (default `8388608`, 8 MiB); oversized bodies get 413 |
| `AGENT_REGISTRY_PATH` | No | Path to `agent-registry.yaml` (auto-detects at project root) |
| `AZURE_OPENAI_API_KEY` | When passthrough agent uses Azure OpenAI | Azure OpenAI key |
| `AZURE_OPENAI_ENDPOINT` | When passthrough agent uses Azure OpenAI | Azure OpenAI endpoint |
| `AZURE_OPENAI_DEPLOYMENT` | When passthrough agent uses Azure OpenAI | Azure OpenAI deployment name |

## Storage

Pluggable storage layer selected via `storage-config.yaml`. Override the path with `STORAGE_CONFIG_PATH`.

| Provider | Package | Status |
|---|---|---|
| `memory` | (built-in) | Implemented |
| `sqlite` | `better-sqlite3` | Implemented |
| `sqlserver` | `mssql` | Implemented |
| `azure-blob` | `@azure/storage-blob` | Implemented |

See `storage-config.example.yaml` for example configurations.

## Agent System

Custom agents are CLI tools that communicate via stdin/stdout JSON:

```
lg-api Run → RequestComposer → AgentRequest JSON → CliAgentConnector
  → child_process.spawn(agent CLI) → stdin: JSON → Agent → LLM
  → stdout: JSON response → CliAgentConnector → SSE events → client
```

### Bundled Agents

- **`agents/passthrough/`** — Forwards requests to an LLM via LangChain. Supports Azure OpenAI, OpenAI, Anthropic, Google.
- **`agents/skill-agent/`** — Generic agent that deploys Claude Code skills (SKILL.md files) as lg-api agents through the Anthropic Messages API.
- **`agents/agent-template-ts/`** — TypeScript template for building new custom agents.

### Registering an Agent

Edit `agent-registry.yaml`:

```yaml
agents:
  my-agent:
    command: npx
    args: ["tsx", "agents/my-agent/src/index.ts"]
    cwd: "."
    description: "What this agent does"
    timeout: 60000
```

Restart lg-api. Each `graph_id` from the registry is auto-registered as an assistant on startup.

### Agent I/O Contract

**Input** (read from stdin):
```json
{
  "thread_id": "string",
  "run_id": "string",
  "assistant_id": "string",
  "messages": [{"role": "user|assistant|system", "content": "string"}],
  "documents": [{"id": "string", "title": "string", "content": "string"}],
  "state": {},
  "metadata": {}
}
```

**Output** (write to stdout — errors go to stderr only):
```json
{
  "thread_id": "string",
  "run_id": "string",
  "messages": [{"role": "assistant", "content": "string"}],
  "state": {},
  "metadata": {}
}
```

## Project Structure

```
src/
  index.ts, server.ts, app.ts   Entry, bootstrap, app factory
  config/env.config.ts          Strict env loader
  schemas/                      TypeBox schemas
  repositories/                 IRepository<T>, in-memory base, registry
  storage/                      Storage abstraction + providers
    providers/{memory,sqlite,sqlserver,azure-blob}/
  modules/                      Route modules
    assistants/  threads/  runs/  crons/  store/  system/
  streaming/stream-manager.ts   SSE session management
  agents/                       Agent registry, CLI connector, request composer
  plugins/                      cors, swagger, auth, error-handler
  errors/  utils/
agents/
  passthrough/         Pass-through LLM agent (LangChain)
  skill-agent/         Claude Code skill runner (Anthropic SDK)
  agent-template-ts/   Template for new agents
test_scripts/          Vitest test suite
docs/
  api-instructions.md  curl reference for all 50 endpoints
  design/              project-design.md, plans
  reference/           reference material
```

## Commands

```bash
npm run dev      # Hot-reload dev server (tsx watch)
npm run build    # Compile TypeScript → dist/
npm start        # Run compiled server
npm test         # Run Vitest suite
npx tsc --noEmit # Type-check without emit
```

## API Endpoints (50 total)

**Assistants (11)** · CRUD, search, count, graph, schemas, subgraphs, versions, latest
**Threads (12)** · CRUD, search, count, copy, prune, state, history, stream
**Runs (14)** · create / wait / stream (threaded + stateless), batch, list, get, cancel, join, delete
**Crons (6)** · create (threaded + stateless), update, delete, search, count
**Store (5)** · put/get/delete items, search, namespaces
**System (2)** · `/ok`, `/info`

For full curl examples covering every endpoint, see [`docs/api-instructions.md`](docs/api-instructions.md).

## Testing

Vitest. Test files in `test_scripts/` (12 files, ~170 tests).

```bash
npm test                                       # Run all
npx vitest run test_scripts/runs.test.ts       # Single file
npx vitest run --reporter=verbose              # Verbose output
```

Runs/streaming tests use mock agent executors so no live LLM keys are required. The 2 tests in `agent-connector.test.ts` that hit Azure OpenAI are skipped unless `AZURE_OPENAI_*` vars are set.

### Manual End-to-End

```bash
# Health
curl -s http://localhost:8123/ok | jq

# List auto-registered assistants
curl -s http://localhost:8123/assistants/search \
  -X POST -H 'Content-Type: application/json' -d '{}' | jq

# Create a thread
curl -s http://localhost:8123/threads \
  -X POST -H 'Content-Type: application/json' -d '{}' | jq

# Sync run
curl -s http://localhost:8123/threads/<THREAD_ID>/runs/wait \
  -X POST -H 'Content-Type: application/json' \
  -d '{"assistant_id":"passthrough","input":{"messages":[{"role":"user","content":"What is 2+2?"}]}}' | jq

# Streaming run (SSE)
curl -N http://localhost:8123/threads/<THREAD_ID>/runs/stream \
  -X POST -H 'Content-Type: application/json' \
  -d '{"assistant_id":"passthrough","input":{"messages":[{"role":"user","content":"Tell me a joke"}]}}'
```

## Docker

A `Dockerfile` and `docker/` build context are included. See those files for build/run details.

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — Authoritative project reference (tech stack, tools, structure, configuration, testing).
- [`docs/api-instructions.md`](docs/api-instructions.md) — curl examples for all 50 endpoints.
- [`docs/design/`](docs/design/) — Project design and plans.
- [`Issues - Pending Items.md`](Issues%20-%20Pending%20Items.md) — Open issues and follow-ups.
