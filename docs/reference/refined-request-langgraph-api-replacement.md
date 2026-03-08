# Refined Request: LangGraph Server API Drop-in Replacement

## Objective

Build a TypeScript-based REST API server that accurately replicates the LangGraph Platform (Agent Server) API interface, enabling it to function as a **drop-in replacement** for any client using the official LangGraph SDK (Python or JavaScript). The server must expose identical endpoints, accept the same request schemas, and return the same response structures as the original LangGraph Server.

The backend engine powering the API operations must initially be **dummy/stub implementations** that return valid, well-formed responses without performing actual graph execution. The primary focus is **API surface accuracy** -- ensuring that the LangGraph Python SDK (`langgraph-sdk`) and JavaScript SDK (`@langchain/langgraph-sdk`) can connect to this server and operate without modification.

---

## Scope

### In Scope

1. **Complete REST API surface replication** of the LangGraph Platform Server, covering all endpoint groups:
   - Assistants API (11 endpoints)
   - Threads API (12 endpoints)
   - Runs API (11 endpoints)
   - Crons API (6 endpoints)
   - Store API (5 endpoints)
   - System endpoints (health check, info)

2. **Accurate request/response schemas** matching the LangGraph SDK type definitions (TypedDicts, enums, etc.)

3. **Server-Sent Events (SSE) streaming** for run stream endpoints, emitting well-formed SSE events with correct event types

4. **Pagination support** using `limit`, `offset`, and `X-Pagination-*` response headers

5. **Authentication middleware** supporting the `X-Api-Key` header pattern

6. **OpenAPI/Swagger documentation** auto-generated and served at `/docs`

7. **Dummy/stub engine** that returns realistic but static/generated responses for all endpoints

8. **HTTP status code accuracy** matching the original API (200, 204, 404, 409, 422, 500)

9. **Multitask strategy support** in request schemas (`reject`, `interrupt`, `rollback`, `enqueue`)

10. **Streaming modes** in request schemas (`values`, `updates`, `messages`, `messages-tuple`, `events`, `debug`, `custom`, `tasks`, `checkpoints`)

### Out of Scope

1. Actual graph compilation, execution, or state management
2. Real checkpoint persistence or state history tracking
3. LLM integration or tool execution
4. Real cron job scheduling (accept the configuration but do not schedule)
5. Actual store persistence (in-memory stub is acceptable)
6. Agent-to-Agent (A2A) protocol endpoints
7. Model Context Protocol (MCP) endpoints
8. gRPC interface
9. LangSmith integration or telemetry
10. Production-grade database backing
11. Horizontal scaling or queue-based task distribution

---

## Functional Requirements

### FR-01: Assistants API

The server must expose the following Assistants endpoints:

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

### FR-02: Threads API

The server must expose the following Threads endpoints:

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
| 9 | GET | `/threads/{thread_id}/state` | Get current thread state; accepts `subgraphs` query param. Also supports `GET /threads/{thread_id}/state/{checkpoint_id}` |
| 10 | POST | `/threads/{thread_id}/state` | Update thread state with `values`, `as_node`, `checkpoint`, `checkpoint_id` |
| 11 | POST | `/threads/{thread_id}/history` | Get thread state history with `limit`, `before`, `metadata`, `checkpoint` |
| 12 | GET | `/threads/{thread_id}/stream` | Join an active thread stream (SSE); accepts `stream_mode`, `last_event_id` |

### FR-03: Runs API

The server must expose the following Runs endpoints:

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
| 13 | GET | `/threads/{thread_id}/runs/{run_id}/stream` | Join the output stream of an existing run (SSE); accepts `cancel_on_disconnect`, `stream_mode`, `last_event_id` |
| 14 | DELETE | `/threads/{thread_id}/runs/{run_id}` | Delete a finished run |

**Run creation shared parameters:** `input`, `command`, `stream_mode`, `stream_subgraphs`, `stream_resumable`, `metadata`, `config`, `context`, `checkpoint`, `checkpoint_id`, `checkpoint_during`, `interrupt_before`, `interrupt_after`, `feedback_keys`, `webhook`, `multitask_strategy`, `if_not_exists`, `on_disconnect`, `on_completion`, `after_seconds`, `durability`

### FR-04: Crons API

The server must expose the following Crons endpoints:

| # | Method | Path | Description |
|---|--------|------|-------------|
| 1 | POST | `/threads/{thread_id}/runs/crons` | Create a stateful cron job for a thread |
| 2 | POST | `/runs/crons` | Create a stateless cron job |
| 3 | DELETE | `/runs/crons/{cron_id}` | Delete a cron job |
| 4 | PATCH | `/runs/crons/{cron_id}` | Update a cron job |
| 5 | POST | `/runs/crons/search` | Search cron jobs with `assistant_id`, `thread_id`, `enabled`, `limit`, `offset`, `sort_by`, `sort_order`, `select` |
| 6 | POST | `/runs/crons/count` | Count cron jobs matching filters (`assistant_id`, `thread_id`) |

**Cron creation parameters:** `schedule`, `input`, `config`, `metadata`, `context`, `assistant_id`, `checkpoint_during`, `interrupt_before`, `interrupt_after`, `webhook`, `multitask_strategy`, `end_time`, `enabled`, `on_run_completed`, `stream_mode`, `stream_subgraphs`, `stream_resumable`, `durability`

### FR-05: Store API

The server must expose the following Store endpoints:

| # | Method | Path | Description |
|---|--------|------|-------------|
| 1 | PUT | `/store/items` | Create or update an item with `namespace`, `key`, `value`, `index`, `ttl` |
| 2 | GET | `/store/items` | Get an item by `namespace` and `key` query params; accepts `refresh_ttl` |
| 3 | DELETE | `/store/items` | Delete an item by `namespace` and `key` in request body |
| 4 | POST | `/store/items/search` | Search items with `namespace_prefix`, `filter`, `limit`, `offset`, `query`, `refresh_ttl` |
| 5 | POST | `/store/namespaces` | List namespaces with `prefix`, `suffix`, `max_depth`, `limit`, `offset` |

### FR-06: System Endpoints

| # | Method | Path | Description |
|---|--------|------|-------------|
| 1 | GET | `/ok` | Health check endpoint; returns 200 when server is healthy |
| 2 | GET | `/info` | Server information (version, capabilities) |
| 3 | GET | `/docs` | OpenAPI/Swagger UI |

### FR-07: Data Models

The server must implement TypeScript type definitions matching the following LangGraph SDK schemas:

- **Assistant**: `assistant_id`, `graph_id`, `config`, `context`, `created_at`, `updated_at`, `metadata`, `version`, `name`, `description`
- **AssistantVersion**: Same as Assistant base fields
- **Thread**: `thread_id`, `created_at`, `updated_at`, `metadata`, `status` (enum: `idle`, `busy`, `interrupted`, `error`), `values`, `interrupts`
- **ThreadState**: `values`, `next`, `checkpoint`, `metadata`, `created_at`, `parent_checkpoint`, `tasks`, `interrupts`
- **ThreadTask**: `id`, `name`, `error`, `interrupts`, `checkpoint`, `state`, `result`
- **Run**: `run_id`, `thread_id`, `assistant_id`, `created_at`, `updated_at`, `status` (enum: `pending`, `running`, `error`, `success`, `timeout`, `interrupted`), `metadata`, `multitask_strategy`
- **Cron**: `cron_id`, `assistant_id`, `thread_id`, `on_run_completed`, `end_time`, `schedule`, `created_at`, `updated_at`, `payload`, `user_id`, `next_run_date`, `metadata`, `enabled`
- **Item**: `namespace`, `key`, `value`, `created_at`, `updated_at`
- **SearchItem**: extends Item with `score`
- **Checkpoint**: `thread_id`, `checkpoint_ns`, `checkpoint_id`, `checkpoint_map`
- **Config**: `tags`, `recursion_limit`, `configurable`
- **GraphSchema**: `graph_id`, `input_schema`, `output_schema`, `state_schema`, `config_schema`, `context_schema`
- **Interrupt**: `value`, `id`
- **Command**: `goto`, `update`, `resume`
- **StreamPart**: `event`, `data`, `id`

### FR-08: SSE Streaming

The streaming endpoints must:
- Use standard Server-Sent Events (SSE) protocol (`text/event-stream` content type)
- Emit events with correct `event:` field matching stream modes (`values`, `updates`, `messages`, `events`, `debug`, `custom`, `tasks`, `checkpoints`, `messages-tuple`)
- Emit `metadata` event at stream start
- Emit `end` event at stream completion
- Emit `error` event on failures
- Support `Last-Event-ID` header for reconnection
- Support multiple concurrent stream modes in a single request

### FR-09: Pagination

- All search/list endpoints must support `limit` (default varies, max 1000) and `offset` parameters
- Responses must include `X-Pagination-Total`, `X-Pagination-Offset`, `X-Pagination-Limit` headers where applicable

### FR-10: Error Handling

- Return appropriate HTTP status codes: 200 (OK), 204 (No Content), 404 (Not Found), 409 (Conflict), 422 (Validation Error), 500 (Internal Server Error)
- Error responses must follow a consistent JSON structure with `detail` or `message` fields

### FR-11: Authentication Middleware

- Support `X-Api-Key` header-based authentication
- The API key validation logic should be configurable (initially accept any non-empty key)
- Reject unauthenticated requests with 401 status

---

## Technical Constraints

1. **Language**: TypeScript (strict mode)
2. **Runtime**: Node.js (v18+)
3. **HTTP Framework**: Express.js or Fastify (prefer Fastify for performance and OpenAPI support)
4. **Configuration**: All configuration settings must be provided via environment variables. Missing required settings must throw an exception -- no fallback/default values (per project convention)
5. **Configuration variables** (minimum):
   - `LG_API_PORT` -- Server port (required)
   - `LG_API_HOST` -- Server bind address (required)
   - `LG_API_AUTH_ENABLED` -- Enable/disable API key authentication (required)
   - `LG_API_KEY` -- Expected API key when auth is enabled (required when auth enabled)
6. **Database**: Not required for initial stub implementation; in-memory storage is acceptable. When persistence is added, table naming must be singular (per project convention)
7. **No SQLAlchemy**: Not applicable (TypeScript project), but if any Python tooling is used, avoid SQLAlchemy
8. **Package management**: npm or pnpm
9. **Testing**: Unit tests for route registration and schema validation; integration tests for SDK compatibility
10. **Code structure**: Modular -- separate route handlers, schemas/types, middleware, and stub engine into distinct modules
11. **OpenAPI spec**: Must be generated/served and should be compatible with the LangGraph SDK's expected API shape
12. **SSE implementation**: Must use proper SSE format (`text/event-stream`, `event:`, `data:`, `id:` fields)
13. **CORS**: Must be enabled for cross-origin requests

---

## Acceptance Criteria

### AC-01: API Surface Completeness
All 45+ endpoints listed in the Functional Requirements are implemented and return appropriate HTTP status codes and response structures.

### AC-02: SDK Compatibility
The official LangGraph Python SDK (`langgraph-sdk`) can be configured to point at this server (`get_client(url="http://localhost:<port>")`) and successfully execute:
- `client.assistants.create(...)`, `.get(...)`, `.search(...)`, `.delete(...)`
- `client.threads.create(...)`, `.get(...)`, `.search(...)`, `.get_state(...)`, `.update_state(...)`
- `client.runs.create(...)`, `.stream(...)`, `.wait(...)`, `.list(...)`, `.cancel(...)`
- `client.crons.create(...)`, `.search(...)`, `.delete(...)`
- `client.store.put_item(...)`, `.get_item(...)`, `.search_items(...)`, `.list_namespaces(...)`

### AC-03: Schema Validation
Request bodies are validated against the expected schemas. Invalid requests return 422 with descriptive error messages.

### AC-04: Streaming Functionality
SSE streaming endpoints emit well-formed events that the LangGraph SDK stream decoder can parse without error.

### AC-05: Health Check
`GET /ok` returns 200 with a valid response when the server is running.

### AC-06: OpenAPI Documentation
`GET /docs` serves an interactive Swagger/OpenAPI UI documenting all endpoints.

### AC-07: Configuration Enforcement
The server refuses to start if required configuration variables are missing, throwing a descriptive exception (no fallback values).

### AC-08: Dummy Engine Responses
All stub responses contain realistic, well-structured data including proper UUIDs, timestamps, and status values that match the LangGraph schema expectations.

---

## Open Questions

1. **Exact error response format**: The LangGraph server returns errors in a specific JSON structure. Should we reverse-engineer the exact format from the SDK error handling code, or is a reasonable approximation sufficient for the initial version?

2. **Webhook delivery**: The API accepts `webhook` parameters on run creation. Should the stub acknowledge these without delivery, or should there be a mock webhook delivery mechanism?

3. **Rate limiting**: Does the original LangGraph server implement rate limiting? Should the replacement include it?

4. **Versioning**: The LangGraph API may evolve. Which specific version of the API should be the target? The current latest (`langgraph-api 0.7.65`, `langgraph-sdk 0.3.9` as of March 2026)?

5. **A2A and MCP endpoints**: The latest LangGraph Server includes Agent-to-Agent and Model Context Protocol endpoint groups. Should these be included in a future phase?

6. **`if_exists` behavior**: The assistant and thread creation endpoints accept an `if_exists` parameter (e.g., `do_nothing`, `update`, `error`). Should the stub implement these semantics against in-memory storage?

7. **Multitask strategy enforcement**: Should the stub actually enforce `reject`/`interrupt`/`rollback`/`enqueue` semantics, or just accept the parameter and ignore it?

8. **Thread status transitions**: Should the stub maintain realistic thread status transitions (`idle` -> `busy` -> `idle`/`interrupted`/`error`) during run execution?

9. **`/info` endpoint content**: What exactly should the `/info` endpoint return? Server version, supported features, available graphs?

10. **Persistence phase**: When should in-memory storage be replaced with a database? What database should be used (PostgreSQL in Docker, per project conventions)?

---

## Original Request

> I want you to study the langgraph server API interface and collect all the information needed to build an API implementation to be used as a drop in replacement of the langgraph server. The actual engine responsible to provide the operations needed to support the API endpoints, initially must be dummy. Our primary focus is the accurate replication of the API interface offered by the langgraph server.

---

## Reference Sources

- [LangGraph Platform API Reference (docs.langchain.com)](https://docs.langchain.com/langgraph-platform/server-api-ref)
- [LangGraph Platform Overview (DeepWiki)](https://deepwiki.com/langchain-ai/langgraph/8-langgraph-platform)
- [LangGraph JS SDK API Endpoints (DeepWiki)](https://deepwiki.com/langchain-ai/langgraphjs/5.3-commands-and-control-flow)
- [Agent Protocol Specification (GitHub)](https://github.com/langchain-ai/agent-protocol)
- [LangGraph SDK Python Source (GitHub)](https://github.com/langchain-ai/langgraph/tree/main/libs/sdk-py)
- [LangGraph SDK Python Reference](https://reference.langchain.com/python/langgraph-sdk/_sync/client)
- [LangGraph Streaming Documentation](https://docs.langchain.com/oss/python/langgraph/streaming)
- [LangGraph Cron Jobs Guide](https://docs.langchain.com/langsmith/cron-jobs)
- [LangGraph OpenAPI Security](https://docs.langchain.com/langgraph-platform/openapi-security)
