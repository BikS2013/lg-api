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

## Commands

```bash
npm run dev      # Start dev server with hot reload (tsx watch)
npm run build    # Compile TypeScript
npm start        # Run compiled server
npm test         # Run test suite (vitest)
```

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
