# LangGraph API Replacement -- Functional Requirements

**Project:** lg-api
**Date:** 2026-03-08
**Status:** Draft

---

## Overview

This document registers all functional requirements and feature descriptions for the LangGraph Server API drop-in replacement project.

---

## FR-01: Assistants API (11 Endpoints)

The server must expose endpoints to manage assistants -- configured instances of a graph.

| # | Method | Path | Description |
|---|--------|------|-------------|
| 1 | POST | `/assistants` | Create a new assistant with `graph_id`, `config`, `context`, `metadata`, `assistant_id`, `if_exists`, `name`, `description` |
| 2 | GET | `/assistants/{assistant_id}` | Retrieve an assistant by ID |
| 3 | PATCH | `/assistants/{assistant_id}` | Update an assistant (creates a new version) with `graph_id`, `config`, `context`, `metadata`, `name`, `description` |
| 4 | DELETE | `/assistants/{assistant_id}` | Delete an assistant; accepts `delete_threads` flag |
| 5 | POST | `/assistants/search` | Search assistants with `metadata`, `graph_id`, `name`, `limit`, `offset`, `sort_by`, `sort_order`, `select` filters |
| 6 | POST | `/assistants/count` | Count assistants matching filters (`metadata`, `graph_id`, `name`) |
| 7 | GET | `/assistants/{assistant_id}/graph` | Get the graph definition JSON; accepts `xray` parameter |
| 8 | GET | `/assistants/{assistant_id}/schemas` | Get input, output, state, config, and context JSON schemas |
| 9 | GET | `/assistants/{assistant_id}/subgraphs` | List subgraphs; accepts `namespace` path param and `recurse` query param |
| 10 | POST | `/assistants/{assistant_id}/versions` | List assistant versions with `metadata`, `limit`, `offset` |
| 11 | POST | `/assistants/{assistant_id}/latest` | Set the latest version; accepts `version` number |

### Data Model: Assistant

- `assistant_id`: UUID
- `graph_id`: string
- `config`: Config object (tags, recursion_limit, configurable)
- `context`: optional object
- `created_at`: ISO 8601 date-time
- `updated_at`: ISO 8601 date-time
- `metadata`: key-value object
- `version`: integer
- `name`: string
- `description`: string or null

### Behaviors

- `if_exists` parameter on creation controls behavior when assistant_id already exists: `raise` (409 error), `do_nothing` (return existing), `update` (update existing).
- Update operation increments the `version` field.
- Versions history is maintained per assistant.

---

## FR-02: Threads API (12 Endpoints)

The server must expose endpoints to manage threads -- accumulated outputs of a group of runs.

| # | Method | Path | Description |
|---|--------|------|-------------|
| 1 | POST | `/threads` | Create a thread with optional `metadata`, `thread_id`, `if_exists`, `supersteps`, `graph_id`, `ttl` |
| 2 | GET | `/threads/{thread_id}` | Retrieve a thread by ID; accepts `include` query param |
| 3 | PATCH | `/threads/{thread_id}` | Update thread metadata and TTL |
| 4 | DELETE | `/threads/{thread_id}` | Delete a thread and its checkpoints |
| 5 | POST | `/threads/search` | Search threads with `metadata`, `values`, `ids`, `status`, `limit`, `offset`, `sort_by`, `sort_order`, `select`, `extract` |
| 6 | POST | `/threads/count` | Count threads matching filters (`metadata`, `values`, `status`) |
| 7 | POST | `/threads/{thread_id}/copy` | Duplicate a thread with full history |
| 8 | POST | `/threads/prune` | Prune threads by `thread_ids`, `strategy` |
| 9 | GET | `/threads/{thread_id}/state` | Get current thread state; accepts `subgraphs` query param |
| 10 | POST | `/threads/{thread_id}/state` | Update thread state with `values`, `as_node`, `checkpoint`, `checkpoint_id` |
| 11 | POST | `/threads/{thread_id}/history` | Get thread state history with `limit`, `before`, `metadata`, `checkpoint` |
| 12 | GET | `/threads/{thread_id}/stream` | Join an active thread stream (SSE); accepts `stream_mode`, `last_event_id` |

### Data Model: Thread

- `thread_id`: UUID
- `created_at`: ISO 8601 date-time
- `updated_at`: ISO 8601 date-time
- `metadata`: key-value object
- `status`: enum (`idle`, `busy`, `interrupted`, `error`)
- `values`: optional object
- `interrupts`: optional array of Interrupt objects
- `ttl`: optional TTL info

### Data Model: ThreadState

- `values`: object
- `next`: array of strings
- `checkpoint`: Checkpoint object
- `metadata`: key-value object
- `created_at`: ISO 8601 date-time
- `parent_checkpoint`: optional Checkpoint
- `tasks`: array of ThreadTask objects
- `interrupts`: array of Interrupt objects

### Data Model: Checkpoint

- `thread_id`: string
- `checkpoint_ns`: string
- `checkpoint_id`: string
- `checkpoint_map`: object

---

## FR-03: Runs API (14 Endpoints)

The server must expose endpoints to manage runs -- invocations of a graph/assistant.

| # | Method | Path | Description |
|---|--------|------|-------------|
| 1 | POST | `/threads/{thread_id}/runs` | Create a stateful run on a thread |
| 2 | POST | `/runs` | Create a stateless (background) run |
| 3 | POST | `/threads/{thread_id}/runs/stream` | Create a stateful run and stream output (SSE) |
| 4 | POST | `/runs/stream` | Create a stateless run and stream output (SSE) |
| 5 | POST | `/threads/{thread_id}/runs/wait` | Create a stateful run and wait for completion |
| 6 | POST | `/runs/wait` | Create a stateless run and wait for completion |
| 7 | POST | `/runs/batch` | Create multiple stateless runs; accepts array of `RunCreate` payloads |
| 8 | GET | `/threads/{thread_id}/runs` | List runs for a thread with `limit`, `offset`, `status`, `select` |
| 9 | GET | `/threads/{thread_id}/runs/{run_id}` | Get a specific run by ID |
| 10 | POST | `/threads/{thread_id}/runs/{run_id}/cancel` | Cancel a run; accepts `wait`, `action` parameters |
| 11 | POST | `/runs/cancel` | Cancel multiple runs; accepts `thread_id`, `run_ids`, `status`, `action` |
| 12 | GET | `/threads/{thread_id}/runs/{run_id}/join` | Wait for a run to finish, return final output |
| 13 | GET | `/threads/{thread_id}/runs/{run_id}/stream` | Join the output stream of an existing run (SSE) |
| 14 | DELETE | `/threads/{thread_id}/runs/{run_id}` | Delete a finished run |

### Data Model: Run

- `run_id`: UUID
- `thread_id`: UUID
- `assistant_id`: UUID
- `created_at`: ISO 8601 date-time
- `updated_at`: ISO 8601 date-time
- `status`: enum (`pending`, `running`, `error`, `success`, `timeout`, `interrupted`)
- `metadata`: key-value object
- `multitask_strategy`: enum (`reject`, `interrupt`, `rollback`, `enqueue`)
- `kwargs`: optional object

### Run Creation Shared Parameters

All run creation endpoints accept: `input`, `command`, `stream_mode`, `stream_subgraphs`, `stream_resumable`, `metadata`, `config`, `context`, `checkpoint`, `checkpoint_id`, `checkpoint_during`, `interrupt_before`, `interrupt_after`, `feedback_keys`, `webhook`, `multitask_strategy`, `if_not_exists`, `on_disconnect`, `on_completion`, `after_seconds`, `durability`.

---

## FR-04: Crons API (6 Endpoints)

The server must expose endpoints to manage cron jobs -- periodic runs on a schedule.

| # | Method | Path | Description |
|---|--------|------|-------------|
| 1 | POST | `/threads/{thread_id}/runs/crons` | Create a stateful cron job for a thread |
| 2 | POST | `/runs/crons` | Create a stateless cron job |
| 3 | DELETE | `/runs/crons/{cron_id}` | Delete a cron job |
| 4 | PATCH | `/runs/crons/{cron_id}` | Update a cron job |
| 5 | POST | `/runs/crons/search` | Search cron jobs with filters |
| 6 | POST | `/runs/crons/count` | Count cron jobs matching filters |

### Data Model: Cron

- `cron_id`: UUID
- `assistant_id`: UUID
- `thread_id`: optional UUID
- `on_run_completed`: string
- `end_time`: optional ISO 8601 date-time
- `schedule`: cron expression string
- `created_at`: ISO 8601 date-time
- `updated_at`: ISO 8601 date-time
- `payload`: object (run creation parameters)
- `user_id`: optional string
- `next_run_date`: ISO 8601 date-time
- `metadata`: key-value object
- `enabled`: boolean

### Cron Creation Parameters

`schedule`, `input`, `config`, `metadata`, `context`, `assistant_id`, `checkpoint_during`, `interrupt_before`, `interrupt_after`, `webhook`, `multitask_strategy`, `end_time`, `enabled`, `on_run_completed`, `stream_mode`, `stream_subgraphs`, `stream_resumable`, `durability`.

---

## FR-05: Store API (5 Endpoints)

The server must expose endpoints for a namespace-aware key-value store.

| # | Method | Path | Description |
|---|--------|------|-------------|
| 1 | PUT | `/store/items` | Create or update an item with `namespace`, `key`, `value`, `index`, `ttl` |
| 2 | GET | `/store/items` | Get an item by `namespace` and `key` query params; accepts `refresh_ttl` |
| 3 | DELETE | `/store/items` | Delete an item by `namespace` and `key` in request body |
| 4 | POST | `/store/items/search` | Search items with `namespace_prefix`, `filter`, `limit`, `offset`, `query`, `refresh_ttl` |
| 5 | POST | `/store/namespaces` | List namespaces with `prefix`, `suffix`, `max_depth`, `limit`, `offset` |

### Data Model: Item

- `namespace`: array of strings
- `key`: string
- `value`: object
- `created_at`: ISO 8601 date-time
- `updated_at`: ISO 8601 date-time

### Data Model: SearchItem (extends Item)

- All Item fields plus `score`: number

---

## FR-06: System Endpoints (3 Endpoints)

| # | Method | Path | Description | Auth Required |
|---|--------|------|-------------|--------------|
| 1 | GET | `/ok` | Health check; returns 200 when server is healthy | No |
| 2 | GET | `/info` | Server information (version, capabilities) | Yes |
| 3 | GET | `/docs` | OpenAPI/Swagger UI | No |

---

## FR-07: Data Models (Shared Types)

The server must implement TypeScript type definitions for the following shared types:

- **Config**: `tags` (string[]), `recursion_limit` (number), `configurable` (object)
- **GraphSchema**: `graph_id`, `input_schema`, `output_schema`, `state_schema`, `config_schema`, `context_schema`
- **Interrupt**: `value` (any), `id` (string)
- **Command**: `goto` (string | string[]), `update` (object), `resume` (any)
- **StreamPart**: `event` (string), `data` (any), `id` (string)
- **ErrorResponse**: `detail` (string), `message` (optional string), `status` (optional number)

---

## FR-08: SSE Streaming

The streaming endpoints must:

1. Use standard Server-Sent Events (SSE) protocol (`text/event-stream` content type).
2. Emit events with correct `event:` field matching stream modes:
   - `values` -- complete state after each step
   - `updates` -- delta updates from each step
   - `messages` -- message objects
   - `messages-tuple` -- messages as tuples
   - `events` -- all execution events
   - `debug` -- debug information
   - `custom` -- custom events
   - `tasks` -- task-level events
   - `checkpoints` -- checkpoint snapshots
3. Emit `metadata` event at stream start.
4. Emit `end` event at stream completion.
5. Emit `error` event on failures.
6. Support `Last-Event-ID` header for reconnection.
7. Support multiple concurrent stream modes in a single request.

---

## FR-09: Pagination

- All search/list endpoints must support `limit` and `offset` parameters.
- Maximum `limit` is 1000.
- Responses must include headers:
  - `X-Pagination-Total`: total matching items
  - `X-Pagination-Offset`: current offset
  - `X-Pagination-Limit`: current limit

---

## FR-10: Error Handling

- HTTP status codes: 200 (OK), 204 (No Content), 404 (Not Found), 409 (Conflict), 422 (Validation Error), 500 (Internal Server Error).
- Error responses follow a consistent JSON structure: `{ "detail": "<message>" }`.
- Validation errors return 422 with descriptive messages.

---

## FR-11: Authentication Middleware

- Support `X-Api-Key` header-based authentication.
- When `LG_API_AUTH_ENABLED=true`, all API routes (except `/ok` and `/docs`) require a valid API key.
- Missing header returns `401 { "detail": "Missing X-Api-Key header" }`.
- Invalid key returns `401 { "detail": "Invalid API key" }`.
- The API key is validated against the `LG_API_KEY` environment variable.

---

## FR-12: OpenAPI Documentation

- The server must auto-generate and serve an OpenAPI 3.1 specification.
- Swagger UI must be available at `/docs`.
- All endpoints must be documented with request/response schemas.
- Security scheme for `X-Api-Key` must be declared.

---

## FR-13: Configuration Management

- All configuration is provided via environment variables.
- Missing required variables must cause the server to throw a descriptive exception at startup.
- No fallback or default values are permitted for required configuration variables.
- Required variables: `LG_API_PORT`, `LG_API_HOST`, `LG_API_AUTH_ENABLED`, `NODE_ENV`.
- Conditionally required: `LG_API_KEY` (when `LG_API_AUTH_ENABLED=true`).

---

## FR-14: CORS Support

- The server must enable CORS for cross-origin requests.
- Permissive CORS configuration for development.

---

## FR-15: Pluggable Storage Infrastructure

The server must support multiple storage backends, selectable at startup via configuration. The active provider is determined by a YAML configuration file with environment variable substitution.

### FR-15.1: Storage Providers

The following storage providers must be supported:

| Provider | Package | Use Case |
|----------|---------|----------|
| In-Memory | (built-in) | Development, testing, ephemeral workloads |
| SQLite | `better-sqlite3` | Single-server deployments, local development with persistence |
| SQL Server | `mssql` | Enterprise deployments, multi-server, high concurrency |
| Azure Blob Storage | `@azure/storage-blob` | Cloud-native deployments, large data volumes, cost optimization |

Each provider must implement the full set of entity-specific storage interfaces covering all six entity types: Thread, Assistant, Run, Cron, StoreItem, and ThreadState/Checkpoint.

### FR-15.2: Storage Abstraction Layer

- A unified `IStorageProviderFull` interface must aggregate entity-specific storage interfaces (`IThreadStorage`, `IAssistantStorage`, `IRunStorage`, `ICronStorage`, `IStoreStorage`) and a lifecycle interface (`IStorageProvider`).
- Each provider must implement `initialize()`, `close()`, `healthCheck()`, and `getProviderInfo()`.
- A provider factory must instantiate the correct provider based on configuration.
- The existing domain repositories (AssistantsRepository, ThreadsRepository, etc.) must delegate to the active storage provider while preserving their public API unchanged.

### FR-15.3: YAML Configuration System

- Storage configuration must be loaded from a YAML file whose path is specified by the `STORAGE_CONFIG_PATH` environment variable (required, no fallback).
- The YAML file must support `${ENV_VAR}` substitution patterns for secrets and environment-specific values.
- Only fields relevant to the selected provider are validated; fields for inactive providers are ignored.
- Missing required configuration fields must cause the server to throw a descriptive exception at startup. No fallback or default values are permitted.
- Credential expiration fields (`password_expires_at`, `sas_token_expires_at`) must trigger a warning when expiration is within 7 days and throw when already expired.

### FR-15.4: SQLite Provider Requirements

- Schema must use singular table names: Thread, Checkpoint, Assistant, AssistantVersion, Run, Cron, StoreItem, ThreadState, Migration.
- WAL mode must be enabled by default for better concurrency.
- JSON fields stored as TEXT with `json_extract()` used for metadata filtering.
- A version-based migration system must track and apply schema changes.
- Configurable pragmas: `synchronous_mode`, `cache_size_kb`, `temp_store`, `busy_timeout_ms`, `foreign_keys`.

### FR-15.5: SQL Server Provider Requirements

- Schema logically identical to SQLite, adapted for SQL Server types (NVARCHAR, DATETIMEOFFSET, NVARCHAR(MAX) for JSON with ISJSON checks).
- Connection pooling must be used (pool created once at startup, reused for all queries, closed on shutdown).
- Transaction support for multi-step operations (e.g., thread copy, version rollback).
- All queries must use parameterized inputs (no string interpolation).
- Password expiration monitoring with proactive warnings.

### FR-15.6: Azure Blob Storage Provider Requirements

- One container per entity type (e.g., `lg-api-threads`, `lg-api-assistants`).
- Thread state stored with state + history separation pattern: `{thread_id}/state.json` for latest state, `{thread_id}/states/{timestamp}.json` for history.
- Blob index tags set on entities for server-side search (limited to 10 tags per blob).
- Three authentication methods: connection string, DefaultAzureCredential (managed identity), SAS token.
- SAS token expiration monitoring with proactive warnings.
- Optimistic concurrency via ETags for updates.
- Client-side filtering as fallback for complex metadata queries not supported by blob tags.

### FR-15.7: Health Check Integration

- The `/ok` health check endpoint must reflect storage provider health status.
- `healthCheck()` must verify actual connectivity to the storage backend (not just return true).

### FR-15.8: Graceful Shutdown

- On server shutdown, `storageProvider.close()` must be called to release connections, close file handles, and clean up resources.

---

## FR-16: Configuration Management (Extended)

Extends FR-13 with storage-related configuration.

### Additional Required Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `STORAGE_CONFIG_PATH` | Yes | Absolute path to the storage YAML configuration file |

### Provider-Specific Environment Variables (referenced in YAML)

| Variable | Required When | Description |
|----------|--------------|-------------|
| `STORAGE_PROVIDER` | Always | Active provider: `inmemory`, `sqlite`, `sqlserver`, `azureblob` |
| `SQLITE_DB_PATH` | provider=sqlite | Path to SQLite database file or `:memory:` |
| `SQL_SERVER_HOST` | provider=sqlserver | SQL Server hostname |
| `SQL_SERVER_PORT` | provider=sqlserver | SQL Server port |
| `SQL_SERVER_DATABASE` | provider=sqlserver | Database name |
| `SQL_SERVER_USER` | provider=sqlserver | Database username |
| `SQL_SERVER_PASSWORD` | provider=sqlserver | Database password |
| `SQL_SERVER_PASSWORD_EXPIRES_AT` | Optional | ISO 8601 date for password expiration monitoring |
| `AZURE_STORAGE_ACCOUNT_NAME` | provider=azureblob | Azure Storage account name |
| `AZURE_STORAGE_CONNECTION_STRING` | One auth method required | Connection string for Azure Storage |
| `AZURE_USE_MANAGED_IDENTITY` | One auth method required | Set to `true` for managed identity auth |
| `AZURE_STORAGE_SAS_TOKEN` | One auth method required | SAS token for Azure Storage |
| `AZURE_STORAGE_SAS_TOKEN_EXPIRES_AT` | Optional | ISO 8601 date for SAS token expiration monitoring |

---

## Revision History

| Date | Version | Description |
|------|---------|-------------|
| 2026-03-09 | 1.1 | Added FR-15 (Pluggable Storage Infrastructure) and FR-16 (Extended Configuration Management) |
| 2026-03-08 | 1.0 | Initial functional requirements extracted from refined request specification |
