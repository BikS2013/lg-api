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
  plugins/              - Fastify plugins (cors, swagger, auth, error-handler)
  errors/               - ApiError class
  utils/                - UUID, date, pagination helpers
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

## Commands

```bash
npm run dev      # Start dev server with hot reload (tsx watch)
npm run build    # Compile TypeScript
npm start        # Run compiled server
npm test         # Run test suite (vitest)
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
