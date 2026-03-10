# lg-api Project Overview

## Purpose
LangGraph Server API drop-in replacement - a TypeScript REST API that replicates the LangGraph Platform API interface.

## Tech Stack
- Runtime: Node.js v18+
- Framework: Fastify v5 with TypeBox type provider
- Schema: @sinclair/typebox
- OpenAPI: @fastify/swagger + @fastify/swagger-ui
- Testing: Vitest
- Language: TypeScript (strict mode, ESM)

## Structure
- `src/` - Main source (index.ts, server.ts, app.ts)
- `src/modules/` - API modules (assistants, threads, runs, crons, store, system)
- `src/storage/` - Pluggable storage layer (memory, sqlite, sqlserver, azure-blob)
- `src/agents/` - CLI agent connector system
- `src/schemas/` - TypeBox schema definitions
- `src/plugins/` - Fastify plugins (cors, swagger, auth, error-handler)
- `agents/passthrough/` - Test agent (isolated package)
- `test_scripts/` - Vitest tests

## 50 API Endpoints
- Assistants: 11, Threads: 12, Runs: 14, Crons: 6, Store: 5, System: 2
