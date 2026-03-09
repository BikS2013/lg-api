# Plan 002 -- Storage Infrastructure Implementation

**Project:** lg-api
**Date:** 2026-03-09
**Status:** Draft
**Depends On:** plan-001-langgraph-api-replacement (completed)
**Reference:** `docs/reference/infrastructure-design-storage.md`, `docs/reference/infrastructure-design-storage-part2.md`

---

## Table of Contents

1. [Objective](#1-objective)
2. [Current State Analysis](#2-current-state-analysis)
3. [Architecture Overview](#3-architecture-overview)
4. [Phase 1 -- Storage Abstraction Layer](#4-phase-1----storage-abstraction-layer)
5. [Phase 2 -- YAML Configuration System](#5-phase-2----yaml-configuration-system)
6. [Phase 3 -- SQLite Provider](#6-phase-3----sqlite-provider)
7. [Phase 4 -- SQL Server Provider](#7-phase-4----sql-server-provider)
8. [Phase 5 -- Azure Blob Provider](#8-phase-5----azure-blob-provider)
9. [Phase 6 -- Registry Migration & Integration](#9-phase-6----registry-migration--integration)
10. [Dependency Graph & Parallelism](#10-dependency-graph--parallelism)
11. [Risk Register](#11-risk-register)

---

## 1. Objective

Replace the current in-memory-only storage with a pluggable storage infrastructure that supports four backends: **In-Memory** (existing, preserved), **SQLite**, **SQL Server**, and **Azure Blob Storage**. The active backend is selected at startup via a YAML configuration file with environment variable substitution. No fallback values are permitted for required configuration -- missing values must throw an exception.

---

## 2. Current State Analysis

### 2.1 Existing Repository Layer

| File | Role |
|------|------|
| `src/repositories/interfaces.ts` | Defines `IRepository<T>`, `SearchOptions`, `SearchResult<T>` |
| `src/repositories/in-memory.repository.ts` | Generic `InMemoryRepository<T>` backed by `Map<string, T>` |
| `src/repositories/registry.ts` | Singleton `RepositoryRegistry` that creates hard-coded in-memory instances |

### 2.2 Domain-Specific Repositories

| File | Extends | Extra Capabilities |
|------|---------|-------------------|
| `src/modules/assistants/assistants.repository.ts` | `InMemoryRepository<Assistant>` | Version management (`versions` Map), `searchByGraphId`, `searchByName`, `getVersions`, `addVersion`, `setLatestVersion` |
| `src/modules/threads/threads.repository.ts` | `InMemoryRepository<Thread>` | State management (`states` Map), `searchByStatus`, `searchByIds`, `getState`, `addState`, `getStateHistory`, `copyThread` |
| `src/modules/runs/runs.repository.ts` | `InMemoryRepository<Run>` | `listByThreadId`, `searchByStatus` |
| `src/modules/crons/crons.repository.ts` | `InMemoryRepository<Cron>` | `searchByAssistantId`, `searchByThreadId` |
| `src/modules/store/store.repository.ts` | **Does NOT extend** `InMemoryRepository` | Composite key (namespace+key), TTL, namespace search, custom `StoreSearchOptions` |

### 2.3 Key Observations

1. **StoreRepository is not generic** -- it uses composite keys and has a completely different interface. It cannot be forced into `IRepository<T>`.
2. **ThreadsRepository and AssistantsRepository carry secondary data** (states/versions) stored in separate Maps, not in the main store.
3. **Domain-specific methods** (e.g., `searchByGraphId`, `listByThreadId`, `copyThread`) go beyond the generic `IRepository<T>` contract.
4. **The registry** (`registry.ts`) hard-codes `new AssistantsRepository()` etc., with no configuration-driven selection.

### 2.4 Design Decision (from reference design)

Use the **Adapter Pattern**: introduce entity-specific storage interfaces (`IThreadStorage`, `IAssistantStorage`, etc.) as the low-level contract. Each storage provider implements all entity-specific interfaces. The existing domain repository classes are refactored to delegate to the storage provider rather than extending `InMemoryRepository`.

---

## 3. Architecture Overview

```
Route Handlers
     |
Domain Repositories (AssistantsRepository, ThreadsRepository, ...)
     |  delegate to
Entity-Specific Storage Interfaces (IThreadStorage, IAssistantStorage, ...)
     |  implemented by
Storage Providers (InMemoryProvider, SqliteProvider, SqlServerProvider, AzureBlobProvider)
     ^  created by
Provider Factory  <--  StorageConfig  <--  YAML Loader  <--  storage-config.yaml + env vars
```

### Target File Structure (new files marked with `+`)

```
src/
  storage/                                    + NEW directory
    interfaces/                               +
      storage-provider.interface.ts           + IStorageProvider, StorageProviderInfo, StorageFeature
      thread-storage.interface.ts             + IThreadStorage
      assistant-storage.interface.ts          + IAssistantStorage
      run-storage.interface.ts                + IRunStorage
      cron-storage.interface.ts               + ICronStorage
      store-storage.interface.ts              + IStoreStorage
      storage-provider-full.interface.ts      + IStorageProviderFull (composite)
      index.ts                                + barrel export
    providers/
      inmemory/                               +
        inmemory.provider.ts                  + InMemoryStorageProvider implementing IStorageProviderFull
        index.ts                              +
      sqlite/                                 +
        sqlite.provider.ts                    + SqliteStorageProvider implementing IStorageProviderFull
        sqlite.schema.ts                      + CREATE TABLE statements
        sqlite.migrations.ts                  + Migration runner
        index.ts                              +
      sqlserver/                              +
        sqlserver.provider.ts                 + SqlServerStorageProvider implementing IStorageProviderFull
        sqlserver.schema.ts                   + CREATE TABLE statements
        sqlserver.migrations.ts               + Migration runner
        index.ts                              +
      azureblob/                              +
        azureblob.provider.ts                 + AzureBlobStorageProvider implementing IStorageProviderFull
        azureblob.containers.ts               + Container setup and naming
        index.ts                              +
    factory/                                  +
      provider-factory.ts                     + createStorageProvider()
      index.ts                                +
    config/                                   +
      storage-config.types.ts                 + StorageConfig, SqliteConfig, etc.
      storage-config.loader.ts                + YAML loader with env var substitution
      storage-config.validator.ts             + Validation (throw on missing)
      index.ts                                +
  config/
    env.config.ts                             MODIFY -- add STORAGE_CONFIG_PATH
  repositories/
    interfaces.ts                             KEEP unchanged
    in-memory.repository.ts                   KEEP unchanged (backward compat)
    registry.ts                               MODIFY -- delegate to provider factory
  modules/
    assistants/assistants.repository.ts       MODIFY -- delegate to IAssistantStorage
    threads/threads.repository.ts             MODIFY -- delegate to IThreadStorage
    runs/runs.repository.ts                   MODIFY -- delegate to IRunStorage
    crons/crons.repository.ts                 MODIFY -- delegate to ICronStorage
    store/store.repository.ts                 MODIFY -- delegate to IStoreStorage
  app.ts                                      MODIFY -- initialize storage on startup

config/                                       + NEW directory at project root
  storage-config.yaml                         + Default config file (example / dev)
  storage-config.example.yaml                 + Documented example with all providers
```

---

## 4. Phase 1 -- Storage Abstraction Layer

**Dependencies:** None
**Parallel with:** Nothing (must complete before Phases 2-5)
**Estimated effort:** 2-3 days

### 4.1 Goal

Define the complete set of storage interfaces and the provider factory skeleton so that Phases 2-5 can be developed independently against a stable contract.

### 4.2 Files to Create

#### 4.2.1 `src/storage/interfaces/storage-provider.interface.ts`

Core lifecycle interface that every provider implements:

```typescript
export interface IStorageProvider {
  initialize(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<boolean>;
  getProviderInfo(): StorageProviderInfo;
}

export interface StorageProviderInfo {
  name: string;
  type: StorageProviderType;
  version: string;
  features: StorageFeature[];
}

export type StorageProviderType = 'inmemory' | 'sqlite' | 'sqlserver' | 'azureblob';

export type StorageFeature =
  | 'transactions'
  | 'batch_operations'
  | 'full_text_search'
  | 'json_queries'
  | 'checkpoint_history'
  | 'blob_storage';
```

#### 4.2.2 `src/storage/interfaces/thread-storage.interface.ts`

Must capture all operations currently in `ThreadsRepository` plus checkpoint operations from the design:

```typescript
export interface IThreadStorage {
  createThread(thread: Thread): Promise<Thread>;
  getThread(threadId: string): Promise<Thread | null>;
  updateThread(threadId: string, updates: Partial<Thread>): Promise<Thread | null>;
  deleteThread(threadId: string): Promise<boolean>;
  searchThreads(options: SearchOptions, filters?: Record<string, unknown>): Promise<SearchResult<Thread>>;
  countThreads(filters?: Record<string, unknown>): Promise<number>;
  searchByStatus(status: string, options: SearchOptions): Promise<SearchResult<Thread>>;
  searchByIds(ids: string[], options: SearchOptions): Promise<SearchResult<Thread>>;

  // State/checkpoint operations
  getState(threadId: string): Promise<ThreadState | null>;
  addState(threadId: string, state: ThreadState): Promise<void>;
  getStateHistory(threadId: string, options: SearchOptions): Promise<SearchResult<ThreadState>>;
  copyThread(threadId: string, newThreadId: string): Promise<Thread | null>;
}
```

#### 4.2.3 `src/storage/interfaces/assistant-storage.interface.ts`

```typescript
export interface IAssistantStorage {
  createAssistant(assistant: Assistant): Promise<Assistant>;
  getAssistant(assistantId: string): Promise<Assistant | null>;
  updateAssistant(assistantId: string, updates: Partial<Assistant>): Promise<Assistant | null>;
  deleteAssistant(assistantId: string): Promise<boolean>;
  searchAssistants(options: SearchOptions, filters?: Record<string, unknown>): Promise<SearchResult<Assistant>>;
  countAssistants(filters?: Record<string, unknown>): Promise<number>;
  searchByGraphId(graphId: string, options: SearchOptions): Promise<SearchResult<Assistant>>;
  searchByName(name: string, options: SearchOptions): Promise<SearchResult<Assistant>>;

  // Version operations
  getVersions(assistantId: string): Promise<Assistant[]>;
  addVersion(assistantId: string, version: Assistant): Promise<void>;
  setLatestVersion(assistantId: string, version: number): Promise<Assistant | null>;
}
```

#### 4.2.4 `src/storage/interfaces/run-storage.interface.ts`

```typescript
export interface IRunStorage {
  createRun(run: Run): Promise<Run>;
  getRun(runId: string): Promise<Run | null>;
  updateRun(runId: string, updates: Partial<Run>): Promise<Run | null>;
  deleteRun(runId: string): Promise<boolean>;
  searchRuns(options: SearchOptions, filters?: Record<string, unknown>): Promise<SearchResult<Run>>;
  countRuns(filters?: Record<string, unknown>): Promise<number>;
  listByThreadId(threadId: string, options: SearchOptions): Promise<SearchResult<Run>>;
  searchByStatus(status: string, options: SearchOptions): Promise<SearchResult<Run>>;
}
```

#### 4.2.5 `src/storage/interfaces/cron-storage.interface.ts`

```typescript
export interface ICronStorage {
  createCron(cron: Cron): Promise<Cron>;
  getCron(cronId: string): Promise<Cron | null>;
  updateCron(cronId: string, updates: Partial<Cron>): Promise<Cron | null>;
  deleteCron(cronId: string): Promise<boolean>;
  searchCrons(options: SearchOptions, filters?: Record<string, unknown>): Promise<SearchResult<Cron>>;
  countCrons(filters?: Record<string, unknown>): Promise<number>;
  searchByAssistantId(assistantId: string, options: SearchOptions): Promise<SearchResult<Cron>>;
  searchByThreadId(threadId: string, options: SearchOptions): Promise<SearchResult<Cron>>;
}
```

#### 4.2.6 `src/storage/interfaces/store-storage.interface.ts`

Must mirror the custom `StoreRepository` interface (not `IRepository<T>`):

```typescript
export interface IStoreStorage {
  putItem(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
    index?: boolean | string[],
    ttl?: number
  ): Promise<Item>;
  getItem(namespace: string[], key: string): Promise<Item | null>;
  deleteItem(namespace: string[], key: string): Promise<boolean>;
  searchItems(namespacePrefix: string[], options?: StoreSearchOptions): Promise<SearchResult<SearchItem>>;
  listNamespaces(options?: ListNamespacesOptions): Promise<string[][]>;
}
```

#### 4.2.7 `src/storage/interfaces/storage-provider-full.interface.ts`

Composite interface -- every provider must implement all of these:

```typescript
export interface IStorageProviderFull extends
  IStorageProvider,
  IThreadStorage,
  IAssistantStorage,
  IRunStorage,
  ICronStorage,
  IStoreStorage {}
```

#### 4.2.8 `src/storage/interfaces/index.ts`

Barrel export for all interfaces.

#### 4.2.9 `src/storage/config/storage-config.types.ts`

Type definitions for the YAML configuration:

```typescript
export type StorageProviderType = 'inmemory' | 'sqlite' | 'sqlserver' | 'azureblob';

export interface StorageConfig {
  storage: {
    provider: StorageProviderType;
    sqlite?: SqliteConfig;
    sqlserver?: SqlServerConfig;
    azureblob?: AzureBlobConfig;
  };
}

export interface SqliteConfig {
  database_path: string;
  enable_wal?: boolean;
  synchronous_mode?: 'FULL' | 'NORMAL' | 'OFF';
  cache_size_kb?: number;
  temp_store?: 'MEMORY' | 'FILE' | 'DEFAULT';
  busy_timeout_ms?: number;
  foreign_keys?: boolean;
}

export interface SqlServerConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  password_expires_at?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  connectionTimeout?: number;
  requestTimeout?: number;
  pool?: {
    max?: number;
    min?: number;
    idleTimeoutMillis?: number;
  };
}

export interface AzureBlobConfig {
  account_name: string;
  connection_string?: string;
  use_managed_identity?: boolean;
  sas_token?: string;
  sas_token_expires_at?: string;
  containers?: {
    threads?: string;
    assistants?: string;
    runs?: string;
    crons?: string;
    store?: string;
  };
}
```

#### 4.2.10 `src/storage/factory/provider-factory.ts`

Skeleton factory -- actual provider construction implemented as each Phase delivers:

```typescript
export async function createStorageProvider(
  config: StorageConfig
): Promise<IStorageProviderFull> {
  const providerType = config.storage.provider;

  switch (providerType) {
    case 'inmemory':
      // Phase 6 delivers the InMemoryStorageProvider
      ...
    case 'sqlite':
      // Phase 3
      ...
    case 'sqlserver':
      // Phase 4
      ...
    case 'azureblob':
      // Phase 5
      ...
    default:
      throw new Error(`Unsupported storage provider: ${providerType}`);
  }
}
```

### 4.3 Files to Modify

None in this phase.

### 4.4 Acceptance Criteria

| # | Criterion |
|---|-----------|
| AC-1.1 | All interface files compile without errors (`npx tsc --noEmit`) |
| AC-1.2 | `StorageConfig` types match the YAML schema documented in the reference design |
| AC-1.3 | `IStorageProviderFull` aggregates all entity-specific interfaces |
| AC-1.4 | Entity-specific interfaces cover every public method currently exposed by their respective domain repositories |
| AC-1.5 | `IStoreStorage` preserves the composite-key semantics of `StoreRepository` (not forced into `IRepository<T>`) |
| AC-1.6 | Factory skeleton compiles and throws for unsupported providers |

### 4.5 Verification Commands

```bash
npx tsc --noEmit                         # TypeScript compilation check
npx vitest run --reporter=verbose        # Ensure existing tests still pass
```

---

## 5. Phase 2 -- YAML Configuration System

**Dependencies:** Phase 1 (needs `StorageConfig` types)
**Parallel with:** Can start as soon as Phase 1 types are merged
**Estimated effort:** 2 days

### 5.1 Goal

Implement a YAML configuration loader that reads `storage-config.yaml`, performs environment variable substitution, validates all required fields (throwing on missing -- NO fallbacks), and integrates with the existing `env.config.ts` system.

### 5.2 Files to Create

#### 5.2.1 `config/storage-config.yaml` (project root)

Default development configuration:

```yaml
storage:
  provider: ${STORAGE_PROVIDER}

  sqlite:
    database_path: ${SQLITE_DB_PATH}
    enable_wal: true
    synchronous_mode: NORMAL
    cache_size_kb: 20000
    temp_store: MEMORY
    busy_timeout_ms: 5000
    foreign_keys: true

  sqlserver:
    host: ${SQL_SERVER_HOST}
    port: ${SQL_SERVER_PORT}
    database: ${SQL_SERVER_DATABASE}
    user: ${SQL_SERVER_USER}
    password: ${SQL_SERVER_PASSWORD}
    password_expires_at: ${SQL_SERVER_PASSWORD_EXPIRES_AT}
    encrypt: true
    trustServerCertificate: false
    connectionTimeout: 30000
    requestTimeout: 30000
    pool:
      max: 10
      min: 0
      idleTimeoutMillis: 30000

  azureblob:
    account_name: ${AZURE_STORAGE_ACCOUNT_NAME}
    connection_string: ${AZURE_STORAGE_CONNECTION_STRING}
    use_managed_identity: ${AZURE_USE_MANAGED_IDENTITY}
    sas_token: ${AZURE_STORAGE_SAS_TOKEN}
    sas_token_expires_at: ${AZURE_STORAGE_SAS_TOKEN_EXPIRES_AT}
    containers:
      threads: lg-api-threads
      assistants: lg-api-assistants
      runs: lg-api-runs
      crons: lg-api-crons
      store: lg-api-store
```

#### 5.2.2 `config/storage-config.example.yaml`

Fully documented example with comments explaining every field.

#### 5.2.3 `src/storage/config/storage-config.loader.ts`

Responsibilities:
- Read YAML file from the path specified by `STORAGE_CONFIG_PATH` environment variable (required, no fallback).
- Parse YAML using the `yaml` npm package.
- Walk the parsed object and substitute `${ENV_VAR}` patterns with `process.env[ENV_VAR]`.
- For env vars referenced but not set, and the field is required for the active provider: throw `Error`.
- Return a validated `StorageConfig` object.

Key implementation details:
- Only validate fields relevant to the **selected provider**. For example, if `provider: sqlite`, SQL Server fields are ignored even if their env vars are missing.
- The `provider` field itself is required and must be one of the allowed values.
- Credential expiration fields (`password_expires_at`, `sas_token_expires_at`) are optional but, when present, the loader must log a warning if expiration is within 7 days and throw if already expired.

#### 5.2.4 `src/storage/config/storage-config.validator.ts`

Validation rules per provider:

| Provider | Required Fields |
|----------|----------------|
| `inmemory` | None |
| `sqlite` | `sqlite.database_path` |
| `sqlserver` | `sqlserver.host`, `sqlserver.port`, `sqlserver.database`, `sqlserver.user`, `sqlserver.password` |
| `azureblob` | `azureblob.account_name` + at least one of: `connection_string`, `use_managed_identity=true`, `sas_token` |

All validation errors must be thrown as exceptions with descriptive messages. **No fallback values.**

#### 5.2.5 `src/storage/config/index.ts`

Barrel export.

### 5.3 Files to Modify

#### 5.3.1 `src/config/env.config.ts`

Add `STORAGE_CONFIG_PATH` to the `AppConfig` interface and `loadConfig()` function:

```typescript
export interface AppConfig {
  port: number;
  host: string;
  authEnabled: boolean;
  apiKey: string;
  storageConfigPath: string;  // NEW
}
```

The `STORAGE_CONFIG_PATH` variable is **required** (no fallback). Add it to the `loadConfig()` function using the existing `requireEnv()` helper.

### 5.4 NPM Dependencies to Add

```bash
npm install yaml
```

The `yaml` package (https://www.npmjs.com/package/yaml) is the standard YAML parser for Node.js with full YAML 1.2 support and TypeScript types.

### 5.5 Acceptance Criteria

| # | Criterion |
|---|-----------|
| AC-2.1 | Loader reads a valid YAML file and returns a typed `StorageConfig` object |
| AC-2.2 | Environment variable substitution works for `${VAR}` patterns |
| AC-2.3 | Missing `STORAGE_CONFIG_PATH` throws with descriptive message |
| AC-2.4 | Missing required field for the active provider throws with descriptive message |
| AC-2.5 | Missing fields for inactive providers do NOT throw |
| AC-2.6 | Expired credentials throw; near-expiry credentials log a warning |
| AC-2.7 | Invalid `provider` value throws |
| AC-2.8 | Unit tests cover: valid config, missing env vars, invalid provider, expiry checks |

### 5.6 Verification Commands

```bash
npx tsc --noEmit
npx vitest run src/storage/config/ --reporter=verbose
npx vitest run src/config/ --reporter=verbose
```

---

## 6. Phase 3 -- SQLite Provider

**Dependencies:** Phase 1 (interfaces)
**Parallel with:** Phase 2, Phase 4, Phase 5 (all independent of each other after Phase 1)
**Estimated effort:** 4-5 days

### 6.1 Goal

Implement a complete SQLite storage provider using `better-sqlite3`, including schema creation, CRUD operations for all six entity types, JSON field handling, and a migration system.

### 6.2 NPM Dependencies to Add

```bash
npm install better-sqlite3
npm install --save-dev @types/better-sqlite3
```

### 6.3 Files to Create

#### 6.3.1 `src/storage/providers/sqlite/sqlite.schema.ts`

Contains all `CREATE TABLE` and `CREATE INDEX` statements. Table naming follows project convention: **singular**.

Tables to create:

| Table | Primary Key | Notable Columns |
|-------|-------------|-----------------|
| `Thread` | `thread_id TEXT` | `status TEXT`, `metadata TEXT` (JSON), `values TEXT` (JSON), `interrupts TEXT` (JSON) |
| `ThreadState` | `id INTEGER AUTOINCREMENT` | `thread_id TEXT FK`, `values TEXT` (JSON), `next TEXT` (JSON), `checkpoint TEXT` (JSON), `metadata TEXT` (JSON), `parent_checkpoint TEXT` (JSON), `tasks TEXT` (JSON), `interrupts TEXT` (JSON), `created_at TEXT` |
| `Checkpoint` | `checkpoint_id TEXT` | `thread_id TEXT FK`, `checkpoint_ns TEXT`, `parent_checkpoint_id TEXT FK`, `data TEXT` (JSON), `metadata TEXT` (JSON) |
| `Assistant` | `assistant_id TEXT` | `graph_id TEXT`, `name TEXT`, `config TEXT` (JSON), `context TEXT` (JSON), `metadata TEXT` (JSON), `version INTEGER` |
| `AssistantVersion` | `(assistant_id, version)` composite | Same columns as Assistant |
| `Run` | `run_id TEXT` | `thread_id TEXT FK`, `assistant_id TEXT`, `status TEXT`, `metadata TEXT` (JSON), `kwargs TEXT` (JSON), `multitask_strategy TEXT` |
| `Cron` | `cron_id TEXT` | `assistant_id TEXT`, `thread_id TEXT FK`, `schedule TEXT`, `payload TEXT` (JSON), `metadata TEXT` (JSON) |
| `StoreItem` | `(namespace, key)` composite | `namespace TEXT` (JSON array as TEXT), `value TEXT` (JSON) |
| `Migration` | `version INTEGER` | `applied_at TEXT` |

**Important**: The `ThreadState` table is a new addition not present in the reference design's original schema. It is needed because `ThreadsRepository` currently stores states separately from threads (in a `Map<string, ThreadState[]>`). This must be persisted as a separate table with a foreign key to `Thread`.

Indexes as specified in the reference design (Section 2.2.3).

SQLite pragmas to set on connection open:
- `PRAGMA journal_mode = WAL;`
- `PRAGMA foreign_keys = ON;`
- `PRAGMA synchronous = NORMAL;` (configurable)
- `PRAGMA cache_size = -20000;` (configurable, in KB)
- `PRAGMA temp_store = MEMORY;` (configurable)
- `PRAGMA busy_timeout = 5000;` (configurable)

#### 6.3.2 `src/storage/providers/sqlite/sqlite.migrations.ts`

Simple version-based migration runner:
- Create a `Migration` table to track applied versions.
- Each migration has a `version` number, `up()` function, and `down()` function.
- `runMigrations(db)` applies all unapplied migrations in order.
- Version 1 = initial schema (all tables above).

#### 6.3.3 `src/storage/providers/sqlite/sqlite.provider.ts`

Class `SqliteStorageProvider implements IStorageProviderFull`.

Constructor accepts `SqliteConfig`. The `initialize()` method:
1. Opens the database file (creates if not exists).
2. Sets pragmas.
3. Runs migrations.

**JSON field handling pattern** (used throughout):
- **Writing**: `JSON.stringify(value)` before INSERT/UPDATE.
- **Reading**: `JSON.parse(row.column)` after SELECT.
- **Querying**: Use `json_extract(column, '$.field')` for metadata filtering.

**Key implementation notes per entity**:

- **Thread CRUD**: Standard INSERT/UPDATE/DELETE/SELECT. JSON columns serialized/deserialized.
- **Thread State**: `addState` inserts into `ThreadState` table. `getState` selects the latest row by `created_at DESC`. `getStateHistory` selects with pagination in reverse chronological order.
- **Thread Copy**: Transaction wrapping INSERT into Thread + bulk INSERT into ThreadState (copying all state rows with updated `thread_id`).
- **Assistant Versions**: `addVersion` inserts into `AssistantVersion`. `getVersions` selects from `AssistantVersion` ordered by version. `setLatestVersion` reads from `AssistantVersion` and updates `Assistant` within a transaction.
- **Store Items**: Composite primary key `(namespace, key)` where namespace is stored as JSON-serialized array. `searchItems` uses `namespace LIKE ?` for prefix matching. `listNamespaces` uses `SELECT DISTINCT namespace` with client-side filtering for prefix/suffix/maxDepth.
- **TTL for StoreItems**: Add `expires_at INTEGER` column (Unix timestamp). `getItem` checks expiry and deletes if expired. `searchItems` filters out expired entries.

All `better-sqlite3` operations are synchronous but the interface methods return Promises (wrap with `Promise.resolve()` or use `async` functions) to maintain the async contract.

#### 6.3.4 `src/storage/providers/sqlite/index.ts`

Barrel export.

### 6.4 Files to Modify

#### 6.4.1 `src/storage/factory/provider-factory.ts`

Add the `sqlite` case:

```typescript
case 'sqlite': {
  if (!config.storage.sqlite) {
    throw new Error('SQLite configuration is required when provider is "sqlite"');
  }
  const { SqliteStorageProvider } = await import('../providers/sqlite/index.js');
  const provider = new SqliteStorageProvider(config.storage.sqlite);
  await provider.initialize();
  return provider;
}
```

### 6.5 Test Files to Create

#### 6.5.1 `src/storage/providers/sqlite/__tests__/sqlite.provider.test.ts`

Use `:memory:` database for fast, isolated tests. Test groups:

1. **Thread CRUD** -- create, get, update, delete, search, count
2. **Thread State** -- addState, getState, getStateHistory, copyThread
3. **Assistant CRUD** -- create, get, update, delete, search, count
4. **Assistant Versions** -- addVersion, getVersions, setLatestVersion
5. **Run CRUD** -- create, get, update, delete, listByThreadId
6. **Cron CRUD** -- create, get, update, delete, searchByAssistantId
7. **Store Items** -- putItem, getItem, deleteItem, searchItems, listNamespaces, TTL expiry
8. **Lifecycle** -- initialize, close, healthCheck
9. **JSON metadata filtering** -- search with metadata filters
10. **Migrations** -- verify schema version tracking

### 6.6 Acceptance Criteria

| # | Criterion |
|---|-----------|
| AC-3.1 | All six entity types support full CRUD via SQLite |
| AC-3.2 | Thread state history is persisted and retrievable across restarts |
| AC-3.3 | Assistant version history is persisted |
| AC-3.4 | Store items with composite keys work correctly |
| AC-3.5 | Store item TTL expiry works (expired items not returned) |
| AC-3.6 | JSON metadata filtering works (e.g., search threads by metadata.userId) |
| AC-3.7 | Migration system creates schema from scratch |
| AC-3.8 | WAL mode is enabled and configurable |
| AC-3.9 | `healthCheck()` returns true when DB is accessible |
| AC-3.10 | All tests pass with `:memory:` database |
| AC-3.11 | Provider can be instantiated via the factory with `provider: sqlite` config |

### 6.7 Verification Commands

```bash
npx tsc --noEmit
npx vitest run src/storage/providers/sqlite/ --reporter=verbose
```

---

## 7. Phase 4 -- SQL Server Provider

**Dependencies:** Phase 1 (interfaces)
**Parallel with:** Phase 2, Phase 3, Phase 5
**Estimated effort:** 4-5 days

### 7.1 Goal

Implement a complete SQL Server storage provider using the `mssql` package, with connection pooling, JSON column handling, and transaction support.

### 7.2 NPM Dependencies to Add

```bash
npm install mssql
npm install --save-dev @types/mssql
```

### 7.3 Files to Create

#### 7.3.1 `src/storage/providers/sqlserver/sqlserver.schema.ts`

Same logical schema as SQLite, adapted for SQL Server types:

| SQLite Type | SQL Server Type |
|-------------|-----------------|
| `TEXT` (UUID) | `NVARCHAR(36)` or `UNIQUEIDENTIFIER` |
| `TEXT` (datetime) | `DATETIMEOFFSET` |
| `TEXT` (JSON) | `NVARCHAR(MAX)` with `CHECK (ISJSON(col) = 1)` |
| `INTEGER` (boolean) | `BIT` |
| `INTEGER` | `INT` |

Table naming: **singular** (same as SQLite).

Foreign key constraints with appropriate `ON DELETE` actions (CASCADE for child entities, RESTRICT for referenced entities).

Indexes mirror the SQLite indexes.

#### 7.3.2 `src/storage/providers/sqlserver/sqlserver.migrations.ts`

Same migration pattern as SQLite but using SQL Server DDL syntax. The `Migration` table tracks applied versions.

#### 7.3.3 `src/storage/providers/sqlserver/sqlserver.provider.ts`

Class `SqlServerStorageProvider implements IStorageProviderFull`.

Constructor accepts `SqlServerConfig`. The `initialize()` method:
1. Creates a connection pool using `mssql.ConnectionPool`.
2. Connects to the pool.
3. Runs migrations.
4. Checks credential expiration and logs warnings.

**Connection pooling**:
- Pool created once in `initialize()`.
- All queries use `pool.request()`.
- Pool closed in `close()`.
- Pool configuration from `SqlServerConfig.pool`.

**JSON column handling**:
- **Writing**: `JSON.stringify()` before parameterized INSERT/UPDATE.
- **Reading**: `JSON.parse()` from NVARCHAR(MAX) columns.
- **Querying**: `JSON_VALUE(metadata, '$.field')` for filtering.

**Parameterized queries**: All queries MUST use parameterized inputs (`request.input('name', sql.NVarChar, value)`) to prevent SQL injection. Never interpolate values into query strings.

**Transaction support**: Used for multi-step operations (e.g., `copyThread`, `setLatestVersion`):

```typescript
const transaction = new sql.Transaction(this.pool);
await transaction.begin();
try {
  // operations
  await transaction.commit();
} catch (err) {
  await transaction.rollback();
  throw err;
}
```

**Credential expiration monitoring**: On `initialize()`, if `password_expires_at` is set, check days until expiration. Log warning if < 7 days.

#### 7.3.4 `src/storage/providers/sqlserver/index.ts`

Barrel export.

### 7.4 Files to Modify

#### 7.4.1 `src/storage/factory/provider-factory.ts`

Add the `sqlserver` case with dynamic import and pool initialization.

### 7.5 Test Files to Create

#### 7.5.1 `src/storage/providers/sqlserver/__tests__/sqlserver.provider.test.ts`

Integration tests require a running SQL Server instance. Use a Docker-based SQL Server for CI:

```bash
docker run -e "ACCEPT_EULA=Y" -e "SA_PASSWORD=YourStrong!Pass123" \
  -p 1433:1433 -d mcr.microsoft.com/mssql/server:2022-latest
```

Test structure mirrors SQLite tests (same groups, same assertions). Tests should be tagged/skipped when no SQL Server is available (use `describe.skipIf(!process.env.SQL_SERVER_HOST)`).

### 7.6 Acceptance Criteria

| # | Criterion |
|---|-----------|
| AC-4.1 | All six entity types support full CRUD via SQL Server |
| AC-4.2 | Connection pooling works (pool reused across requests) |
| AC-4.3 | Transactions commit on success, rollback on error |
| AC-4.4 | JSON metadata queries work with `JSON_VALUE` |
| AC-4.5 | All parameterized queries -- no string interpolation |
| AC-4.6 | Password expiration warning logged when < 7 days |
| AC-4.7 | `healthCheck()` returns true when pool is connected |
| AC-4.8 | `close()` properly closes the connection pool |
| AC-4.9 | Integration tests pass against Docker SQL Server |
| AC-4.10 | Provider can be instantiated via the factory with `provider: sqlserver` config |

### 7.7 Verification Commands

```bash
npx tsc --noEmit
npx vitest run src/storage/providers/sqlserver/ --reporter=verbose
```

---

## 8. Phase 5 -- Azure Blob Provider

**Dependencies:** Phase 1 (interfaces)
**Parallel with:** Phase 2, Phase 3, Phase 4
**Estimated effort:** 4-5 days

### 8.1 Goal

Implement an Azure Blob Storage provider using `@azure/storage-blob`, with container-per-entity organization, JSON serialization, blob index tags for search/filter, and time-period-based blob naming for lifecycle management.

### 8.2 NPM Dependencies to Add

```bash
npm install @azure/storage-blob @azure/identity
```

### 8.3 Files to Create

#### 8.3.1 `src/storage/providers/azureblob/azureblob.containers.ts`

Container setup and naming utilities:

- Default container names (configurable via YAML):
  - `lg-api-threads`
  - `lg-api-assistants`
  - `lg-api-runs`
  - `lg-api-crons`
  - `lg-api-store`
- `ensureContainersExist()` -- creates containers if they do not exist.
- Helper functions for blob naming patterns.

#### 8.3.2 `src/storage/providers/azureblob/azureblob.provider.ts`

Class `AzureBlobStorageProvider implements IStorageProviderFull`.

Constructor accepts `AzureBlobConfig`. The `initialize()` method:
1. Creates `BlobServiceClient` using one of: connection string, DefaultAzureCredential, or SAS token.
2. Ensures all containers exist.
3. Checks SAS token expiration if applicable.

**Authentication priority**:
1. If `use_managed_identity` is true: use `DefaultAzureCredential`.
2. Else if `connection_string` is set: use `BlobServiceClient.fromConnectionString()`.
3. Else if `sas_token` is set: append to URL.
4. Else: throw -- no valid authentication method.

**Blob naming patterns** (using Option 4 from reference design -- state + history separation):

| Entity | Container | Blob Name Pattern |
|--------|-----------|-------------------|
| Thread | `lg-api-threads` | `{thread_id}/state.json` |
| Thread State | `lg-api-threads` | `{thread_id}/states/{timestamp}.json` |
| Assistant | `lg-api-assistants` | `{assistant_id}.json` |
| Assistant Version | `lg-api-assistants` | `{assistant_id}/versions/{version}.json` |
| Run | `lg-api-runs` | `{YYYY-MM}/{thread_id}/{run_id}.json` |
| Cron | `lg-api-crons` | `{cron_id}.json` |
| Store Item | `lg-api-store` | `{namespace_joined}/{key}.json` |

**Thread ID with time period**: For thread state blobs, the thread_id is used as a virtual directory. For runs, time-period prefix (`YYYY-MM/`) is used for lifecycle management.

**Blob Index Tags** (for server-side search):

| Entity | Tags |
|--------|------|
| Thread | `threadId`, `status`, `createdDate`, `updatedDate` |
| Assistant | `assistantId`, `graphId`, `name` |
| Run | `runId`, `threadId`, `status`, `assistantId` |
| Cron | `cronId`, `assistantId`, `threadId` |
| Store Item | `namespace` (dot-joined), `key` |

**Blob Metadata** (non-searchable, for quick property access):
- Full `metadata` JSON is stored as blob metadata (if < 8 KB).

**JSON serialization**: All entities serialized as JSON with `JSON.stringify()` before upload, `JSON.parse()` after download.

**Search implementation**: Azure Blob has limited query capabilities:
- Simple filters (status, threadId) use `findBlobsByTags()`.
- Complex metadata filters require downloading blobs and filtering client-side.
- Pagination is implemented by collecting matching blobs and slicing.
- `count()` operations require listing/tagging (no native COUNT).

**Concurrency**: Use ETags for optimistic concurrency on updates.

**Limitations to document**:
- No transaction support across multiple blobs.
- Search is limited compared to SQL providers.
- `count()` may be slow for large datasets.
- Complex metadata queries fall back to client-side filtering.

#### 8.3.3 `src/storage/providers/azureblob/index.ts`

Barrel export.

### 8.4 Files to Modify

#### 8.4.1 `src/storage/factory/provider-factory.ts`

Add the `azureblob` case with dynamic import and container initialization.

### 8.5 Test Files to Create

#### 8.5.1 `src/storage/providers/azureblob/__tests__/azureblob.provider.test.ts`

Integration tests require Azure Storage. Options:
- **Azurite** (local emulator): `docker run -p 10000:10000 mcr.microsoft.com/azure-storage/azurite`
- **Real Azure account** (CI/CD with secrets).

Tests tagged/skipped when no Azure storage is available. Same test groups as SQLite/SQL Server.

### 8.6 Acceptance Criteria

| # | Criterion |
|---|-----------|
| AC-5.1 | All six entity types support full CRUD via Azure Blob |
| AC-5.2 | Containers are created if they do not exist |
| AC-5.3 | Three authentication methods work (connection string, managed identity, SAS) |
| AC-5.4 | SAS token expiration warning logged when < 7 days |
| AC-5.5 | Blob index tags set correctly for searchable fields |
| AC-5.6 | Tag-based search returns correct results |
| AC-5.7 | Client-side metadata filtering works for complex queries |
| AC-5.8 | Thread state + history pattern produces correct blob structure |
| AC-5.9 | ETags used for concurrent update protection |
| AC-5.10 | `healthCheck()` returns true when storage account is accessible |
| AC-5.11 | Provider can be instantiated via the factory with `provider: azureblob` config |

### 8.7 Verification Commands

```bash
npx tsc --noEmit
npx vitest run src/storage/providers/azureblob/ --reporter=verbose
```

---

## 9. Phase 6 -- Registry Migration & Integration

**Dependencies:** Phase 1, Phase 2, and at least one of Phase 3/4/5 complete
**Parallel with:** None -- this is the integration phase
**Estimated effort:** 3-4 days

### 9.1 Goal

Wire everything together: migrate the existing in-memory implementation to be a pluggable provider, update the repository registry to use the provider factory, update the Fastify app startup to initialize storage, and ensure all route modules work without changes.

### 9.2 Files to Create

#### 9.2.1 `src/storage/providers/inmemory/inmemory.provider.ts`

Class `InMemoryStorageProvider implements IStorageProviderFull`.

This is a **new wrapper** that reuses the logic from the existing repositories. It encapsulates:
- A `Map<string, Thread>` for threads.
- A `Map<string, ThreadState[]>` for thread states.
- A `Map<string, Assistant>` for assistants.
- A `Map<string, Assistant[]>` for assistant versions.
- A `Map<string, Run>` for runs.
- A `Map<string, Cron>` for crons.
- The `StoreRepository` logic (composite keys, TTL, namespace search).

The methods directly replicate the behavior of the current in-memory repositories but behind the `IStorageProviderFull` interface.

`initialize()`: no-op (in-memory needs no setup).
`close()`: clears all Maps.
`healthCheck()`: returns true.

#### 9.2.2 `src/storage/providers/inmemory/index.ts`

Barrel export.

### 9.3 Files to Modify

#### 9.3.1 `src/storage/factory/provider-factory.ts`

Complete the `inmemory` case:

```typescript
case 'inmemory': {
  const { InMemoryStorageProvider } = await import('../providers/inmemory/index.js');
  const provider = new InMemoryStorageProvider();
  await provider.initialize();
  return provider;
}
```

#### 9.3.2 `src/repositories/registry.ts`

Refactor from hard-coded instantiation to factory-driven:

```typescript
import type { IStorageProviderFull } from '../storage/interfaces/index.js';
import type { StorageConfig } from '../storage/config/index.js';
import { createStorageProvider } from '../storage/factory/index.js';

export interface RepositoryRegistry {
  assistants: AssistantsRepository;
  threads: ThreadsRepository;
  runs: RunsRepository;
  crons: CronsRepository;
  store: StoreRepository;
  storageProvider: IStorageProviderFull;  // NEW -- exposed for health checks
}

let registry: RepositoryRegistry | null = null;

export async function initializeRepositoryRegistry(
  config: StorageConfig
): Promise<RepositoryRegistry> {
  const provider = await createStorageProvider(config);

  registry = {
    assistants: new AssistantsRepository(provider),
    threads: new ThreadsRepository(provider),
    runs: new RunsRepository(provider),
    crons: new CronsRepository(provider),
    store: new StoreRepository(provider),
    storageProvider: provider,
  };

  return registry;
}

export function getRepositoryRegistry(): RepositoryRegistry {
  if (!registry) {
    throw new Error(
      'Repository registry not initialized. Call initializeRepositoryRegistry() first.'
    );
  }
  return registry;
}

export async function shutdownRepositoryRegistry(): Promise<void> {
  if (registry) {
    await registry.storageProvider.close();
    registry = null;
  }
}

// Keep for test compatibility
export function resetRepositoryRegistry(): void {
  registry = null;
}
```

**Note**: `getRepositoryRegistry()` now throws instead of auto-creating. This is intentional -- the registry must be explicitly initialized with config.

#### 9.3.3 Domain Repository Refactoring

Each domain repository must be refactored to delegate to the storage provider instead of extending `InMemoryRepository`. The public API of each repository **must remain identical** so that route handlers require zero changes.

**`src/modules/assistants/assistants.repository.ts`**:

```typescript
export class AssistantsRepository {
  constructor(private storage: IAssistantStorage) {}

  async create(id: string, item: Assistant): Promise<Assistant> {
    return this.storage.createAssistant(item);
  }

  async getById(id: string): Promise<Assistant | null> {
    return this.storage.getAssistant(id);
  }

  // ... delegate all methods to this.storage
}
```

**`src/modules/threads/threads.repository.ts`**: Same pattern, delegate to `IThreadStorage`.

**`src/modules/runs/runs.repository.ts`**: Delegate to `IRunStorage`.

**`src/modules/crons/crons.repository.ts`**: Delegate to `ICronStorage`.

**`src/modules/store/store.repository.ts`**: Delegate to `IStoreStorage`.

**Critical constraint**: The method signatures visible to route handlers must NOT change. If a route handler calls `registry.threads.getState(threadId)`, that must still work. The delegation is an internal refactor.

#### 9.3.4 `src/app.ts`

Update `buildApp()` to accept `StorageConfig` and initialize the registry:

```typescript
import { loadStorageConfig } from './storage/config/index.js';
import { initializeRepositoryRegistry, shutdownRepositoryRegistry } from './repositories/registry.js';

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: true }).withTypeProvider<TypeBoxTypeProvider>();

  // Load storage config and initialize storage
  const storageConfig = loadStorageConfig(config.storageConfigPath);
  await initializeRepositoryRegistry(storageConfig);

  // Decorate with config
  app.decorate('config', config);

  // Register graceful shutdown hook
  app.addHook('onClose', async () => {
    await shutdownRepositoryRegistry();
  });

  // ... rest of plugin/route registration unchanged
}
```

#### 9.3.5 `src/modules/system/system.routes.ts` (optional enhancement)

Update the `/ok` health check to include storage health:

```typescript
const registry = getRepositoryRegistry();
const storageHealthy = await registry.storageProvider.healthCheck();
```

### 9.4 Backward Compatibility

- Setting `STORAGE_PROVIDER=inmemory` must produce behavior identical to the current system.
- All existing tests must pass without modification when using the in-memory provider.
- The `InMemoryRepository<T>` base class and `src/repositories/in-memory.repository.ts` are **kept** in the codebase but no longer used by domain repositories. They can be removed in a future cleanup.

### 9.5 Test Files to Create

#### 9.5.1 `src/storage/providers/inmemory/__tests__/inmemory.provider.test.ts`

Same test suite structure as SQLite tests, verifying the in-memory provider produces identical results.

#### 9.5.2 `src/repositories/__tests__/registry.integration.test.ts`

Integration tests that:
1. Initialize registry with in-memory config.
2. Verify all domain repositories work.
3. Verify `shutdownRepositoryRegistry()` cleans up.
4. Verify `getRepositoryRegistry()` throws when not initialized.

### 9.6 Acceptance Criteria

| # | Criterion |
|---|-----------|
| AC-6.1 | `initializeRepositoryRegistry()` creates the correct provider based on config |
| AC-6.2 | All 50 API endpoints work with the in-memory provider (regression) |
| AC-6.3 | All 50 API endpoints work with the SQLite provider |
| AC-6.4 | Domain repository public APIs are unchanged (no route handler modifications) |
| AC-6.5 | Graceful shutdown calls `storageProvider.close()` |
| AC-6.6 | Health check endpoint reflects storage provider health |
| AC-6.7 | `getRepositoryRegistry()` throws descriptively when not initialized |
| AC-6.8 | Existing test suite passes without modification |

### 9.7 Verification Commands

```bash
npx tsc --noEmit
npx vitest run --reporter=verbose          # Full test suite
npx vitest run src/repositories/ --reporter=verbose
npx vitest run src/storage/ --reporter=verbose
```

---

## 10. Dependency Graph & Parallelism

```
Phase 1 (Abstraction Layer)
  |
  +---> Phase 2 (YAML Config)
  |       |
  |       +---> Phase 6 (Registry Migration) <--- requires Phase 2 + at least one provider
  |
  +---> Phase 3 (SQLite) --------+
  |                               |
  +---> Phase 4 (SQL Server) ----+--> Phase 6
  |                               |
  +---> Phase 5 (Azure Blob) ----+
```

### Parallelism Summary

| Phase | Can Start After | Can Run In Parallel With |
|-------|-----------------|-------------------------|
| Phase 1 | Immediately | Nothing |
| Phase 2 | Phase 1 complete | Phases 3, 4, 5 |
| Phase 3 | Phase 1 complete | Phases 2, 4, 5 |
| Phase 4 | Phase 1 complete | Phases 2, 3, 5 |
| Phase 5 | Phase 1 complete | Phases 2, 3, 4 |
| Phase 6 | Phase 2 complete + at least one of Phase 3/4/5 | Nothing (integration phase) |

### Minimum Critical Path

Phase 1 --> Phase 3 (SQLite, simplest provider) --> Phase 6 --> Done (MVP)

Phases 4 and 5 can be delivered after Phase 6 as incremental additions (only requires adding a new case to the factory and the provider implementation).

### Estimated Timeline

| Phase | Duration | Start (earliest) | End (earliest) |
|-------|----------|-------------------|----------------|
| Phase 1 | 2-3 days | Day 1 | Day 3 |
| Phase 2 | 2 days | Day 4 | Day 5 |
| Phase 3 | 4-5 days | Day 4 | Day 8 |
| Phase 4 | 4-5 days | Day 4 | Day 8 |
| Phase 5 | 4-5 days | Day 4 | Day 8 |
| Phase 6 | 3-4 days | Day 9 | Day 12 |

**Total (sequential):** ~18 days
**Total (with parallelism, 1 developer):** ~12 days
**Total (with parallelism, 2+ developers):** ~8-10 days

---

## 11. Risk Register

| # | Risk | Probability | Impact | Mitigation |
|---|------|-------------|--------|------------|
| R1 | `better-sqlite3` native module build fails on some platforms | Medium | High | Pin to known-good version; document build prerequisites (Python, C++ compiler) |
| R2 | SQL Server Docker image unavailable in CI | Low | Medium | Use `describe.skipIf` for SQL Server tests; run integration tests in a separate CI job |
| R3 | Azure Blob search (tag-based) insufficient for complex queries | High | Medium | Document limitations clearly; client-side filtering as fallback; recommend hybrid approach for production |
| R4 | Domain repository refactoring breaks route handlers | Medium | High | Keep public method signatures identical; run full E2E test suite after refactoring |
| R5 | `StoreRepository` composite-key semantics hard to map to Blob Storage | Medium | Medium | Use `{namespace_joined}/{key}.json` blob naming; thorough test coverage |
| R6 | Performance regression when wrapping synchronous `better-sqlite3` in async | Low | Low | `better-sqlite3` is fast (~microseconds per op); Promise wrapping overhead is negligible |
| R7 | YAML parsing edge cases (special characters, multiline strings) | Low | Low | Use the `yaml` npm package (YAML 1.2 compliant); test with varied config files |

---

## Revision History

| Date | Version | Description |
|------|---------|-------------|
| 2026-03-09 | 1.0 | Initial plan created |
