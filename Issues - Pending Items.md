# Issues - Pending Items

## Pending Items

### P1 - Repositories use local inline types instead of shared types from types/index.ts
- **Files**: `src/modules/assistants/assistants.repository.ts`, `src/modules/threads/threads.repository.ts`, `src/modules/runs/runs.repository.ts`, `src/modules/crons/crons.repository.ts`, `src/modules/store/store.repository.ts`
- **Description**: Each repository defines its own inline interface (e.g., `Assistant`, `Thread`, `Run`, `Cron`, `Item`) with comments saying "will be replaced with the shared type from types/index.ts". The shared types exist in `src/types/index.ts` but are not used by repositories or services. This creates a risk of type drift between the schema-derived types and the inline types.
- **Severity**: Medium
- **Recommendation**: Replace inline interfaces with imports from `src/types/index.ts`.

### P2 - Thread stream endpoint returns 501 instead of proper SSE
- **File**: `src/modules/threads/threads.routes.ts`, line 246
- **Description**: The `GET /threads/:thread_id/stream` endpoint returns a 501 (Not Implemented) with a message that "SSE streaming is handled by the runs module". While the runs module does handle run-based streaming, the LangGraph SDK's `client.threads.stream()` method expects this endpoint to work and return SSE events for the active thread.
- **Severity**: Medium
- **Recommendation**: Implement this endpoint to delegate to the stream manager to join the active run stream for the thread.

### P3 - Crons count endpoint returns `{ count: N }` instead of a plain integer
- **File**: `src/modules/crons/crons.routes.ts`, line 160
- **Description**: The assistants and threads count endpoints return a plain integer, but the crons count endpoint wraps it in `{ count: N }`. This is inconsistent and may cause SDK compatibility issues if the SDK expects a plain integer.
- **Severity**: Low-Medium
- **Recommendation**: Verify the LangGraph SDK expectation and make consistent across all count endpoints.

### P5 - Unused dependency: `better-sse`
- **File**: `package.json`
- **Description**: The `better-sse` package is listed as a dependency but is never imported in any source file. SSE streaming is implemented manually via `reply.raw`.
- **Severity**: Low
- **Recommendation**: Remove from dependencies.

### P6 - `enabled` and `on_run_completed` fields are missing from crons repository's Cron interface
- **File**: `src/modules/crons/crons.repository.ts`
- **Description**: The inline `Cron` type uses `[key: string]: any` as a catch-all which masks this, but `enabled` and `on_run_completed` should be explicitly declared for type safety.
- **Severity**: Low
- **Recommendation**: Add `enabled: boolean` and `on_run_completed?: string` to the inline Cron interface.

### P7 - Run `kwargs` field allows `any` via index signature in repository type
- **File**: `src/modules/runs/runs.repository.ts`
- **Description**: The `Run` interface has `[key: string]: any` which defeats type safety. This allows any property to be set without type checking.
- **Severity**: Low
- **Recommendation**: Remove the index signature and explicitly declare needed fields.

### P8 - `GET /threads/:thread_id/state/:checkpoint_id` endpoint not implemented
- **File**: Refined request FR-02 endpoint #9 mentions this variant
- **Description**: The refined request mentions `GET /threads/{thread_id}/state/{checkpoint_id}` as a variant of the state endpoint. The `GetStateWithCheckpointParamSchema` exists in `thread.schema.ts` but no route uses it.
- **Severity**: Low
- **Recommendation**: Add the route when needed for SDK compatibility testing.

### P9 - Configuration exception: STORAGE_CONFIG_PATH defaults to file-existence detection
- **File**: `src/storage/yaml-config-loader.ts`
- **Description**: Per project rules, no fallback values are permitted for configuration. However, the storage system needs a way to work without a config file (defaulting to in-memory provider). The approach is: if `STORAGE_CONFIG_PATH` env var is not set, the loader checks if `storage-config.yaml` exists at the project root. If the file exists, it is loaded. If neither the env var nor the file exist, the system defaults to the in-memory provider. This is file-existence detection, not a config fallback -- documented as a deliberate exception per the storage infrastructure design.
- **Severity**: Info (deliberate design decision)

---

---

## Completed Items

### C6 - SQLite schema uses unquoted `values` column name (reserved keyword)
- **Files**: `src/storage/providers/sqlite/sqlite-schema.ts`, `src/storage/providers/sqlite/sqlite-thread-storage.ts`
- **Description**: The Thread and ThreadState table DDL and INSERT/UPDATE queries used `values` as a column name without quoting. `VALUES` is a reserved keyword in SQLite, causing "near values: syntax error" on table creation and all queries referencing this column.
- **Fix**: Quoted the column name as `"values"` in the schema DDL (`sqlite-schema.ts`) and in all SQL statements in `sqlite-thread-storage.ts` (INSERT INTO Thread, UPDATE Thread, INSERT INTO ThreadState).

### C4 - TypeBox `$id` fields causing Fastify serializer conflicts
- **Files**: All files in `src/schemas/`
- **Description**: TypeBox schemas with `$id` fields (especially `CheckpointSchema`, `InterruptSchema`, and enum schemas) caused Fastify's `fast-json-stringify` to throw "resolves to more than one schema" when the same schema was embedded inline in multiple response schemas.
- **Fix**: Removed all `$id` fields from TypeBox schemas. They are not needed since schemas are used inline (not via `$ref`).

### C5 - Repository singletons not shared across route modules
- **Files**: All `*.routes.ts` files
- **Description**: Each route module created its own repository instances as module-level singletons. This meant threads created via `POST /threads` were invisible to the runs module which had its own `ThreadsRepository`.
- **Fix**: Created `src/repositories/registry.ts` with a centralized `RepositoryRegistry` singleton. All route modules now use `getRepositoryRegistry()` to get shared instances.



### C1 - Stateless runs used empty string for thread_id instead of null
- **Files**: `src/modules/runs/runs.service.ts`, `src/modules/runs/runs.repository.ts`
- **Description**: The `RunSchema` defines `thread_id` as `string | null`, but the service was setting `thread_id: ''` for stateless runs. The repository's `Run` interface had `thread_id: string` (not nullable).
- **Fix**: Changed repository interface to `thread_id: string | null` and service to use `null`.

### C2 - Store SearchItem schema `score` field changed from required to optional
- **File**: `src/schemas/store.schema.ts`
- **Description**: The `SearchItemSchema` defined `score: Type.Number()` (required), but the repository only assigns `score` when a text query is provided. This would cause runtime serialization failures.
- **Fix**: Changed to `score: Type.Optional(Type.Number())`.

### C3 - Unused imports cleaned up across multiple files
- **Files**: `src/schemas/common.schema.ts`, `src/schemas/assistant.schema.ts`, `src/schemas/thread.schema.ts`, `src/schemas/run.schema.ts`, `src/schemas/cron.schema.ts`, `src/schemas/store.schema.ts`, `src/modules/runs/runs.routes.ts`
- **Description**: Removed unused `Static` imports from all schema files, unused `MetadataSchema`, `GraphSchemaSchema`, `ErrorResponseSchema` from assistant schema, unused `ConfigSchema`, `MetadataSchema` from thread schema, unused `CheckpointSchema` from cron schema, and unused `FastifyRequest`/`FastifyReply` from runs routes.
