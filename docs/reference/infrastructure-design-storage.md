# Infrastructure Design: Storage and Retrieval Layer for Custom Agent Integration

**Document Version:** 1.0
**Date:** 2026-03-09
**Status:** Research Complete
**Project:** lg-api

---

## Table of Contents

1. [Infrastructure Overview](#1-infrastructure-overview)
2. [Storage Provider Architecture](#2-storage-provider-architecture)
3. [YAML Configuration Design](#3-yaml-configuration-design)
4. [Data Model Design](#4-data-model-design)
5. [Azure Blob Storage Deep Dive](#5-azure-blob-storage-deep-dive)
6. [Migration Strategy](#6-migration-strategy)
7. [Additional Infrastructure Components](#7-additional-infrastructure-components)
8. [Configuration Guide](#8-configuration-guide)
9. [Open Questions & Decisions](#9-open-questions--decisions)
10. [Recommended Implementation Order](#10-recommended-implementation-order)
11. [Assumptions & Scope](#11-assumptions--scope)
12. [References](#12-references)

---

## 1. Infrastructure Overview

### 1.1 Purpose and Context

The lg-api project currently uses in-memory storage (`InMemoryRepository<T>`) for all entities (threads, runs, assistants, crons, store items). This is sufficient for development and testing but inadequate for production deployments where data must persist across server restarts, scale horizontally, and support multiple storage backends based on deployment environment.

The custom agent integration architecture (described in `docs/reference/custom-agent-integration-concepts.md`) requires persistent storage for:

- **Thread/Conversation State**: Multi-turn conversation history with checkpoint management
- **Assistant Configurations**: Agent definitions, versions, and context
- **Run History**: Execution records and status tracking
- **Scheduled Jobs (Crons)**: Recurring task configurations
- **Store API Data**: Key-value storage with hierarchical namespaces
- **Agent Registry**: Dynamic agent registration and discovery

### 1.2 Infrastructure Components Required

To transition from in-memory to persistent storage, the following infrastructure components are needed:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Application Layer                             │
│  (Routes → Services → Repositories → IRepository<T> interface)       │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────────────┐
│                   Storage Abstraction Layer                          │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  IStorageProvider Interface                                   │  │
│  │  - CRUD operations                                            │  │
│  │  - Query/filter capabilities                                  │  │
│  │  - Transaction support                                        │  │
│  │  - Checkpoint history traversal                               │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
        ┌─────────────────┼─────────────────┬─────────────────┐
        │                 │                 │                 │
┌───────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
│   SQLite     │  │ SQL Server  │  │ Azure Blob  │  │  In-Memory  │
│   Provider   │  │  Provider   │  │  Provider   │  │   Provider  │
│              │  │             │  │             │  │  (existing) │
│better-sqlite3│  │    mssql    │  │@azure/blob  │  │   Map<K,V>  │
└──────────────┘  └─────────────┘  └─────────────┘  └─────────────┘
        │                 │                 │                 │
        │                 │                 │                 │
┌───────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐          │
│  local.db    │  │  SQL Server │  │Azure Storage│          │
│    file      │  │  Database   │  │   Account   │          │
└──────────────┘  └─────────────┘  └─────────────┘          │
                                                              │
┌─────────────────────────────────────────────────────────────▼───────┐
│                    Configuration System                              │
│  storage-config.yaml → YAML Parser → Environment Variable           │
│  Substitution → Provider Factory → Active Provider Instance          │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.3 Role of Storage Layer in Custom Agent Integration

The storage layer serves as the **persistence foundation** for the custom agent integration architecture:

1. **Thread State Persistence**: When a custom agent processes a user message, the conversation state (checkpoints, metadata, values) must be persisted so the agent can resume from where it left off.

2. **Checkpoint History**: The linked-list structure of checkpoints (via `parent_checkpoint_id`) allows traversal of conversation history, time-travel debugging, and branching conversations.

3. **Assistant Registry**: Custom agent configurations are stored as Assistant entities, allowing dynamic registration and version management.

4. **Run Tracking**: Each agent execution is recorded as a Run, providing audit trails and monitoring capabilities.

5. **Store API**: The key-value store with hierarchical namespaces supports document storage, conversation context, and cross-thread memory.

The storage layer must support the existing `IRepository<T>` interface while adding storage-specific capabilities (transactions, batch operations, checkpoint traversal).

### 1.4 Relationship to Existing Repository Pattern

The current project structure uses a repository pattern:

```typescript
// src/repositories/interfaces.ts
export interface IRepository<T> {
  create(id: string, item: T): Promise<T>;
  getById(id: string): Promise<T | null>;
  update(id: string, updates: Partial<T>): Promise<T | null>;
  delete(id: string): Promise<boolean>;
  search(options: SearchOptions, filters?: Record<string, unknown>): Promise<SearchResult<T>>;
  count(filters?: Record<string, unknown>): Promise<number>;
  list(options: SearchOptions): Promise<SearchResult<T>>;
}
```

This interface is currently implemented by `InMemoryRepository<T>` which uses `Map<string, T>` for storage.

**Design Decision**: The storage providers should implement a **lower-level interface** that the repository layer consumes, rather than replacing the repository interface entirely. This maintains backward compatibility.

```
Service Layer
    ↓
Repository Layer (ThreadRepository, AssistantRepository, etc.)
    ↓ (uses)
IRepository<T> interface (existing, unchanged)
    ↓ (implemented by)
PersistentRepository<T> (new, replaces InMemoryRepository)
    ↓ (uses)
IStorageProvider interface (new)
    ↓ (implemented by)
SQLiteProvider | SqlServerProvider | AzureBlobProvider
```

---

## 2. Storage Provider Architecture

### 2.1 Provider Interface Design

#### 2.1.1 Core Storage Interface

Create a new interface that abstracts raw storage operations:

```typescript
// src/storage/interfaces/storage-provider.interface.ts

/**
 * Core storage operations that all providers must implement.
 * This is a lower-level interface than IRepository<T>.
 */
export interface IStorageProvider {
  /**
   * Initialize the storage provider (create tables, check connections, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Close connections and clean up resources
   */
  close(): Promise<void>;

  /**
   * Health check - returns true if storage is accessible
   */
  healthCheck(): Promise<boolean>;

  /**
   * Get provider metadata
   */
  getProviderInfo(): StorageProviderInfo;
}

export interface StorageProviderInfo {
  name: string;
  type: 'sqlite' | 'sqlserver' | 'azureblob' | 'inmemory';
  version: string;
  features: StorageFeature[];
}

export type StorageFeature =
  | 'transactions'
  | 'batch_operations'
  | 'full_text_search'
  | 'json_queries'
  | 'checkpoint_history'
  | 'blob_storage';
```

#### 2.1.2 Entity-Specific Storage Interfaces

Rather than a single generic interface, define specific interfaces for each entity type that map to their unique operations:

```typescript
// src/storage/interfaces/thread-storage.interface.ts

export interface IThreadStorage {
  createThread(thread: Thread): Promise<Thread>;
  getThread(threadId: string): Promise<Thread | null>;
  updateThread(threadId: string, updates: Partial<Thread>): Promise<Thread | null>;
  deleteThread(threadId: string): Promise<boolean>;
  searchThreads(options: ThreadSearchOptions): Promise<SearchResult<Thread>>;
  countThreads(filters: ThreadFilters): Promise<number>;

  // Checkpoint-specific operations
  saveCheckpoint(checkpoint: Checkpoint): Promise<void>;
  getCheckpoint(threadId: string, checkpointId: string): Promise<Checkpoint | null>;
  getLatestCheckpoint(threadId: string): Promise<Checkpoint | null>;
  getCheckpointHistory(threadId: string, options: HistoryOptions): Promise<Checkpoint[]>;
  traverseCheckpoints(threadId: string, checkpointId: string, direction: 'forward' | 'backward'): AsyncGenerator<Checkpoint>;
}

// src/storage/interfaces/assistant-storage.interface.ts

export interface IAssistantStorage {
  createAssistant(assistant: Assistant): Promise<Assistant>;
  getAssistant(assistantId: string): Promise<Assistant | null>;
  updateAssistant(assistantId: string, updates: Partial<Assistant>): Promise<Assistant | null>;
  deleteAssistant(assistantId: string, deleteThreads?: boolean): Promise<boolean>;
  searchAssistants(options: AssistantSearchOptions): Promise<SearchResult<Assistant>>;
  countAssistants(filters: AssistantFilters): Promise<number>;

  // Version-specific operations
  saveVersion(assistantId: string, version: AssistantVersion): Promise<void>;
  getVersion(assistantId: string, version: number): Promise<AssistantVersion | null>;
  listVersions(assistantId: string, options: PaginationOptions): Promise<AssistantVersion[]>;
  setLatestVersion(assistantId: string, version: number): Promise<void>;
}

// src/storage/interfaces/run-storage.interface.ts

export interface IRunStorage {
  createRun(run: Run): Promise<Run>;
  getRun(threadId: string, runId: string): Promise<Run | null>;
  updateRun(runId: string, updates: Partial<Run>): Promise<Run | null>;
  deleteRun(runId: string): Promise<boolean>;
  listRuns(threadId: string, options: ListOptions): Promise<SearchResult<Run>>;
  bulkCancelRuns(filters: RunFilters, action: CancelAction): Promise<number>;
}

// src/storage/interfaces/cron-storage.interface.ts

export interface ICronStorage {
  createCron(cron: Cron): Promise<Cron>;
  getCron(cronId: string): Promise<Cron | null>;
  updateCron(cronId: string, updates: Partial<Cron>): Promise<Cron | null>;
  deleteCron(cronId: string): Promise<boolean>;
  searchCrons(options: CronSearchOptions): Promise<SearchResult<Cron>>;
  countCrons(filters: CronFilters): Promise<number>;
  getEnabledCrons(): Promise<Cron[]>;
}

// src/storage/interfaces/store-storage.interface.ts

export interface IStoreStorage {
  putItem(item: StoreItem): Promise<StoreItem>;
  getItem(namespace: string[], key: string): Promise<StoreItem | null>;
  deleteItem(namespace: string[], key: string): Promise<boolean>;
  searchItems(options: StoreSearchOptions): Promise<SearchResult<StoreItem>>;
  listNamespaces(options: NamespaceOptions): Promise<string[][]>;
}
```

#### 2.1.3 Unified Provider Interface

Each storage provider implements all entity-specific interfaces:

```typescript
// src/storage/interfaces/storage-provider-full.interface.ts

export interface IStorageProviderFull extends
  IStorageProvider,
  IThreadStorage,
  IAssistantStorage,
  IRunStorage,
  ICronStorage,
  IStoreStorage {

  // Transaction support (optional, not all providers support it)
  beginTransaction?(): Promise<ITransaction>;
}

export interface ITransaction {
  commit(): Promise<void>;
  rollback(): Promise<void>;
  isActive(): boolean;
}
```

#### 2.1.4 Relationship to Existing IRepository<T>

**Option A: Adapter Pattern (Recommended)**

Keep `IRepository<T>` unchanged and create an adapter that wraps the storage provider:

```typescript
// src/repositories/persistent.repository.ts

export class PersistentRepository<T> implements IRepository<T> {
  constructor(
    private storageProvider: IStorageProviderFull,
    private entityType: EntityType
  ) {}

  async create(id: string, item: T): Promise<T> {
    switch (this.entityType) {
      case 'thread':
        return this.storageProvider.createThread(item as Thread) as Promise<T>;
      case 'assistant':
        return this.storageProvider.createAssistant(item as Assistant) as Promise<T>;
      // ... other types
    }
  }

  // ... implement other IRepository methods by delegating to storage provider
}
```

**Option B: Direct Replacement**

Replace `InMemoryRepository<T>` with provider-specific implementations that directly implement `IRepository<T>`:

```typescript
// src/repositories/thread.repository.ts

export class ThreadRepository implements IRepository<Thread> {
  constructor(private threadStorage: IThreadStorage) {}

  async create(id: string, item: Thread): Promise<Thread> {
    return this.threadStorage.createThread(item);
  }

  // ... implement other methods
}
```

**Recommendation**: Use Option A (Adapter Pattern) initially to minimize changes to existing code, then migrate to Option B for better type safety and performance.

---

### 2.2 SQLite Provider

#### 2.2.1 Overview

SQLite via `better-sqlite3` is the recommended choice for:
- **Development environments**: Zero configuration, fast iteration
- **Single-instance deployments**: Embedded applications, edge computing
- **Testing**: Fast, disposable databases for test suites
- **Small to medium production workloads**: Up to moderate traffic on a single server

**Why better-sqlite3 over sqlite3?**
- Synchronous API (simpler, faster for SQLite's in-process nature)
- Better performance (up to 2000 QPS with proper indexing)
- First-class transaction support
- Active maintenance and TypeScript support

#### 2.2.2 Installation

```bash
npm install better-sqlite3
npm install --save-dev @types/better-sqlite3
```

#### 2.2.3 Schema Design

**Table Naming Convention**: Singular names per project rules (Thread, not Threads)

**Thread Table**

```sql
CREATE TABLE IF NOT EXISTS Thread (
    thread_id TEXT PRIMARY KEY,  -- UUID as TEXT
    created_at TEXT NOT NULL DEFAULT (datetime('now')),  -- ISO 8601
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    metadata TEXT NOT NULL DEFAULT '{}',  -- JSON as TEXT
    status TEXT NOT NULL CHECK(status IN ('idle', 'busy', 'interrupted', 'error')),
    values TEXT,  -- JSON as TEXT, nullable
    interrupts TEXT  -- JSON array as TEXT, nullable
);

CREATE INDEX IF NOT EXISTS idx_thread_status ON Thread(status);
CREATE INDEX IF NOT EXISTS idx_thread_created_at ON Thread(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_thread_updated_at ON Thread(updated_at DESC);
```

**Checkpoint Table**

```sql
CREATE TABLE IF NOT EXISTS Checkpoint (
    checkpoint_id TEXT PRIMARY KEY,  -- UUID
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    parent_checkpoint_id TEXT,  -- NULL for first checkpoint, creates linked list
    data TEXT NOT NULL,  -- JSON state snapshot
    metadata TEXT NOT NULL DEFAULT '{}',  -- JSON
    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (thread_id) REFERENCES Thread(thread_id) ON DELETE CASCADE,
    FOREIGN KEY (parent_checkpoint_id) REFERENCES Checkpoint(checkpoint_id) ON DELETE SET NULL
);

-- Efficient query for latest checkpoint per thread
CREATE INDEX IF NOT EXISTS idx_checkpoint_thread_created ON Checkpoint(thread_id, created_at DESC);
-- Traverse history via parent pointer
CREATE INDEX IF NOT EXISTS idx_checkpoint_parent ON Checkpoint(parent_checkpoint_id);
```

**Assistant Table**

```sql
CREATE TABLE IF NOT EXISTS Assistant (
    assistant_id TEXT PRIMARY KEY,
    graph_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    config TEXT NOT NULL DEFAULT '{}',  -- JSON
    context TEXT,  -- JSON, nullable
    metadata TEXT NOT NULL DEFAULT '{}',  -- JSON
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assistant_graph_id ON Assistant(graph_id);
CREATE INDEX IF NOT EXISTS idx_assistant_name ON Assistant(name);
```

**AssistantVersion Table** (for version history)

```sql
CREATE TABLE IF NOT EXISTS AssistantVersion (
    assistant_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    graph_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    config TEXT NOT NULL DEFAULT '{}',
    context TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    PRIMARY KEY (assistant_id, version),
    FOREIGN KEY (assistant_id) REFERENCES Assistant(assistant_id) ON DELETE CASCADE
);
```

**Run Table**

```sql
CREATE TABLE IF NOT EXISTS Run (
    run_id TEXT PRIMARY KEY,
    thread_id TEXT,  -- nullable for stateless runs
    assistant_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'error', 'success', 'timeout', 'interrupted')),
    metadata TEXT NOT NULL DEFAULT '{}',
    multitask_strategy TEXT,
    kwargs TEXT,  -- JSON, nullable
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (thread_id) REFERENCES Thread(thread_id) ON DELETE CASCADE,
    FOREIGN KEY (assistant_id) REFERENCES Assistant(assistant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_run_thread_id ON Run(thread_id);
CREATE INDEX IF NOT EXISTS idx_run_status ON Run(status);
CREATE INDEX IF NOT EXISTS idx_run_created_at ON Run(created_at DESC);
```

**Cron Table**

```sql
CREATE TABLE IF NOT EXISTS Cron (
    cron_id TEXT PRIMARY KEY,
    assistant_id TEXT NOT NULL,
    thread_id TEXT,  -- nullable
    schedule TEXT NOT NULL,  -- cron expression
    enabled INTEGER NOT NULL DEFAULT 1,  -- boolean as INTEGER
    payload TEXT,  -- JSON, nullable
    metadata TEXT NOT NULL DEFAULT '{}',
    on_run_completed TEXT,  -- 'delete' or 'keep'
    end_time TEXT,  -- ISO 8601, nullable
    user_id TEXT,
    next_run_date TEXT,  -- ISO 8601, nullable
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (assistant_id) REFERENCES Assistant(assistant_id) ON DELETE CASCADE,
    FOREIGN KEY (thread_id) REFERENCES Thread(thread_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_cron_enabled ON Cron(enabled);
CREATE INDEX IF NOT EXISTS idx_cron_next_run ON Cron(next_run_date) WHERE enabled = 1;
```

**StoreItem Table**

```sql
CREATE TABLE IF NOT EXISTS StoreItem (
    namespace TEXT NOT NULL,  -- JSON array stored as TEXT, e.g., '["user","123"]'
    key TEXT NOT NULL,
    value TEXT NOT NULL,  -- JSON object
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    PRIMARY KEY (namespace, key)
);

-- Prefix search on namespace for hierarchical queries
CREATE INDEX IF NOT EXISTS idx_store_namespace ON StoreItem(namespace);
```

#### 2.2.4 JSON Field Handling

SQLite stores JSON as TEXT. Use JSON1 extension functions for queries:

```typescript
// Query metadata in TypeScript with better-sqlite3
const stmt = db.prepare(`
  SELECT * FROM Thread
  WHERE json_extract(metadata, '$.userId') = ?
`);
const threads = stmt.all('user-123');
```

**Important**: SQLite JSON functions have limitations. For complex queries, consider:
1. Extracting frequently-queried metadata fields to dedicated columns
2. Implementing client-side filtering for rare queries
3. Using full-text search (FTS5) for text content

#### 2.2.5 Performance Optimizations

**Write-Ahead Logging (WAL)**

```typescript
db.pragma('journal_mode = WAL');
```

Benefits:
- Concurrent reads while writing
- Better performance for most workloads
- Recommended for production

**Pragmas**

```typescript
db.pragma('foreign_keys = ON');  // Enforce FK constraints
db.pragma('synchronous = NORMAL');  // Balance safety/speed
db.pragma('cache_size = 20000');  // ~80MB cache
db.pragma('temp_store = MEMORY');  // Temp tables in RAM
```

**Transactions for Bulk Operations**

```typescript
const insertMany = db.transaction((threads: Thread[]) => {
  const stmt = db.prepare('INSERT INTO Thread VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const thread of threads) {
    stmt.run(
      thread.thread_id,
      thread.created_at,
      thread.updated_at,
      JSON.stringify(thread.metadata),
      thread.status,
      thread.values ? JSON.stringify(thread.values) : null,
      thread.interrupts ? JSON.stringify(thread.interrupts) : null
    );
  }
});

// 100x faster than individual inserts
insertMany(threadsArray);
```

#### 2.2.6 File Location Configuration

Configurable via YAML:

```yaml
storage:
  provider: sqlite
  sqlite:
    database_path: ${SQLITE_DB_PATH}  # Environment variable
    # Or literal path:
    # database_path: /var/lib/lg-api/data/lg-api.db
```

**Recommendations**:
- **Development**: `./data/dev.db` (relative to project root)
- **Production**: `/var/lib/lg-api/lg-api.db` (absolute path)
- **Testing**: `:memory:` (in-memory, no persistence)

#### 2.2.7 Migration Strategy

Use a simple migration system:

```typescript
// src/storage/sqlite/migrations.ts

const migrations = [
  {
    version: 1,
    up: (db: Database) => {
      db.exec(`CREATE TABLE IF NOT EXISTS Thread (...)`);
      db.exec(`CREATE TABLE IF NOT EXISTS Checkpoint (...)`);
      // ... other tables
    },
    down: (db: Database) => {
      db.exec(`DROP TABLE IF EXISTS Checkpoint`);
      db.exec(`DROP TABLE IF EXISTS Thread`);
    }
  },
  {
    version: 2,
    up: (db: Database) => {
      db.exec(`ALTER TABLE Thread ADD COLUMN ttl_expires_at TEXT`);
    },
    down: (db: Database) => {
      // SQLite doesn't support DROP COLUMN easily, recreate table
    }
  }
];

export function runMigrations(db: Database, targetVersion?: number): void {
  // Check current version
  const currentVersion = db.prepare(
    `SELECT version FROM Migration ORDER BY version DESC LIMIT 1`
  ).get()?.version ?? 0;

  // Apply migrations
  for (const migration of migrations) {
    if (migration.version > currentVersion &&
        (!targetVersion || migration.version <= targetVersion)) {
      migration.up(db);
      db.prepare('INSERT INTO Migration (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        new Date().toISOString()
      );
    }
  }
}
```

#### 2.2.8 When SQLite is the Right Choice

✅ **Use SQLite when:**
- Single-server deployment (no horizontal scaling needed)
- Moderate write concurrency (< 100 concurrent writers)
- Read-heavy workloads
- Embedded applications (desktop, mobile, edge)
- Development and testing
- Budget constraints (no database hosting costs)
- Simplicity is valued (zero configuration)

❌ **Avoid SQLite when:**
- Multiple application servers need to write concurrently
- High write throughput required (> 1000 writes/sec sustained)
- Network-accessible database needed
- Multi-tenant with tenant isolation at database level

---

### 2.3 SQL Server Provider

#### 2.3.1 Overview

SQL Server via the `mssql` package is the recommended choice for:
- **Enterprise environments**: Existing SQL Server infrastructure
- **Multi-server deployments**: Connection pooling, horizontal scaling
- **High concurrency**: Thousands of concurrent connections
- **Advanced features**: Full-text search, spatial data, reporting services integration
- **Compliance requirements**: Enterprise-grade security, auditing, encryption

#### 2.3.2 Installation

```bash
npm install mssql
npm install --save-dev @types/mssql
```

The `mssql` package uses the `tedious` driver under the hood (pure JavaScript, no native dependencies).

#### 2.3.3 Schema Design

**Logical Model**: Same as SQLite, but using SQL Server-specific types and features.

**Thread Table**

```sql
CREATE TABLE Thread (
    thread_id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    created_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    updated_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    metadata NVARCHAR(MAX) NOT NULL DEFAULT '{}' CHECK (ISJSON(metadata) = 1),
    status NVARCHAR(20) NOT NULL CHECK (status IN ('idle', 'busy', 'interrupted', 'error')),
    values NVARCHAR(MAX) CHECK (ISJSON(values) = 1 OR values IS NULL),
    interrupts NVARCHAR(MAX) CHECK (ISJSON(interrupts) = 1 OR interrupts IS NULL)
);

CREATE INDEX idx_thread_status ON Thread(status);
CREATE INDEX idx_thread_created_at ON Thread(created_at DESC);
CREATE INDEX idx_thread_updated_at ON Thread(updated_at DESC);
```

**JSON Column Strategy**

SQL Server 2016+ supports JSON natively but doesn't have a dedicated JSON data type (until SQL Server 2025). Options:

**Option A: NVARCHAR(MAX) with JSON functions** (recommended for SQL Server 2016-2022)

```sql
metadata NVARCHAR(MAX) NOT NULL CHECK (ISJSON(metadata) = 1)
```

Query with JSON functions:

```sql
SELECT * FROM Thread
WHERE JSON_VALUE(metadata, '$.userId') = 'user-123'
```

**Option B: Native JSON type** (SQL Server 2025+)

```sql
metadata JSON NOT NULL
```

Benefits of native JSON type:
- 18% smaller storage footprint
- Faster queries (pre-parsed)
- Better performance for updates

**Option C: Structured columns** (for frequently-queried fields)

```sql
CREATE TABLE Thread (
    thread_id UNIQUEIDENTIFIER PRIMARY KEY,
    -- ... other fields
    metadata_userId NVARCHAR(255),  -- Extracted for fast queries
    metadata_raw NVARCHAR(MAX) NOT NULL,  -- Full JSON

    -- Computed column alternative:
    metadata_userId AS JSON_VALUE(metadata_raw, '$.userId') PERSISTED
);

CREATE INDEX idx_thread_metadata_userId ON Thread(metadata_userId);
```

**Recommendation**: Start with Option A (NVARCHAR(MAX)), migrate to Option B when SQL Server 2025+ is available.

**Checkpoint Table**

```sql
CREATE TABLE Checkpoint (
    checkpoint_id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    thread_id UNIQUEIDENTIFIER NOT NULL,
    checkpoint_ns NVARCHAR(255) NOT NULL DEFAULT '',
    parent_checkpoint_id UNIQUEIDENTIFIER,
    data NVARCHAR(MAX) NOT NULL CHECK (ISJSON(data) = 1),
    metadata NVARCHAR(MAX) NOT NULL DEFAULT '{}' CHECK (ISJSON(metadata) = 1),
    created_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),

    CONSTRAINT FK_Checkpoint_Thread FOREIGN KEY (thread_id)
        REFERENCES Thread(thread_id) ON DELETE CASCADE,
    CONSTRAINT FK_Checkpoint_Parent FOREIGN KEY (parent_checkpoint_id)
        REFERENCES Checkpoint(checkpoint_id) ON DELETE NO ACTION
);

CREATE INDEX idx_checkpoint_thread_created ON Checkpoint(thread_id, created_at DESC);
CREATE INDEX idx_checkpoint_parent ON Checkpoint(parent_checkpoint_id);
```

**Assistant, Run, Cron, StoreItem Tables**: Similar structure to SQLite, using appropriate SQL Server types (UNIQUEIDENTIFIER, DATETIMEOFFSET, NVARCHAR).

#### 2.3.4 Connection String Configuration

```yaml
storage:
  provider: sqlserver
  sqlserver:
    host: ${SQL_SERVER_HOST}
    port: ${SQL_SERVER_PORT}
    database: ${SQL_SERVER_DATABASE}
    user: ${SQL_SERVER_USER}
    password: ${SQL_SERVER_PASSWORD}
    encrypt: true
    trustServerCertificate: false
    connectionTimeout: 30000
    requestTimeout: 30000
    pool:
      max: 10
      min: 0
      idleTimeoutMillis: 30000
```

#### 2.3.5 Connection Pooling

The `mssql` package provides built-in connection pooling:

```typescript
import sql from 'mssql';

const config: sql.config = {
  user: process.env.SQL_SERVER_USER,
  password: process.env.SQL_SERVER_PASSWORD,
  server: process.env.SQL_SERVER_HOST,
  database: process.env.SQL_SERVER_DATABASE,
  options: {
    encrypt: true,
    trustServerCertificate: false
  },
  pool: {
    max: 10,  // Maximum connections
    min: 0,   // Minimum connections
    idleTimeoutMillis: 30000  // Close idle connections after 30s
  }
};

const pool = await sql.connect(config);

// Reuse pool for all queries
const result = await pool.request()
  .input('threadId', sql.UniqueIdentifier, threadId)
  .query('SELECT * FROM Thread WHERE thread_id = @threadId');
```

**Best Practices**:
- Create pool once at startup, reuse for all queries
- Don't call `sql.connect()` repeatedly (returns cached pool)
- Close pool on graceful shutdown: `await pool.close()`
- Monitor pool metrics for tuning

#### 2.3.6 Transaction Support

SQL Server has robust transaction support:

```typescript
const transaction = new sql.Transaction(pool);

try {
  await transaction.begin();

  // Multiple operations
  await transaction.request()
    .input('threadId', sql.UniqueIdentifier, threadId)
    .query('UPDATE Thread SET status = @status WHERE thread_id = @threadId');

  await transaction.request()
    .input('checkpointId', sql.UniqueIdentifier, checkpointId)
    .query('INSERT INTO Checkpoint (...) VALUES (...)');

  await transaction.commit();
} catch (error) {
  await transaction.rollback();
  throw error;
}
```

#### 2.3.7 Performance Characteristics

- **Concurrent Connections**: Handles thousands of concurrent connections
- **Write Throughput**: High (tens of thousands of writes/sec with proper indexing)
- **Read Throughput**: Very high with read replicas and query optimization
- **Latency**: Network latency added compared to SQLite (1-10ms typical in same datacenter)
- **Scalability**: Horizontal scaling via read replicas, sharding

**JSON Query Performance**: Can be slow for large datasets. Solutions:
1. Use computed columns with indexes for frequently-queried JSON fields
2. Upgrade to SQL Server 2025+ for native JSON indexes (10x faster)
3. Consider hybrid approach: metadata in structured columns, full JSON in separate column

#### 2.3.8 When SQL Server is the Right Choice

✅ **Use SQL Server when:**
- Enterprise deployment with existing SQL Server infrastructure
- Multi-server architecture (load-balanced application tier)
- High concurrency requirements (1000+ concurrent users)
- Advanced query needs (full-text search, reporting, analytics)
- Compliance requirements (enterprise auditing, encryption at rest)
- SQL Server expertise available on team

❌ **Avoid SQL Server when:**
- Simple single-server deployment (SQLite is simpler)
- Budget constraints (licensing costs, hosting costs)
- Cloud-native architecture (Azure Blob may be more cost-effective for large data)

---

### 2.4 Azure Blob Storage Provider

#### 2.4.1 Overview

Azure Blob Storage via `@azure/storage-blob` is a unique option for:
- **Cloud-native deployments**: Serverless, pay-per-use
- **Large data volumes**: Conversation histories, documents, attachments
- **Cost optimization**: Much cheaper than database storage for large blobs
- **Global distribution**: Built-in geo-replication
- **Hybrid architectures**: Metadata in SQL, content in blobs

**Important Limitation**: Azure Blob is NOT a database. It lacks:
- Complex queries (no SQL, no indexes beyond blob tags)
- Transactional consistency across multiple blobs
- Relational integrity (no foreign keys)

**Best Use Cases**:
1. **Conversation history storage**: Store full conversation state as JSON blobs
2. **Document storage**: User-uploaded files referenced in Store API
3. **Checkpoint snapshots**: Large state snapshots that don't need querying
4. **Hybrid with SQL**: Metadata in SQL Server, content in blobs

#### 2.4.2 Installation

```bash
npm install @azure/storage-blob
npm install @azure/identity  # For DefaultAzureCredential
```

#### 2.4.3 Thread ID as Blob Name Pattern

**Blob Naming Restrictions** (from Microsoft documentation):
- Can contain any combination of characters
- Must be 1-1024 characters long
- Case-sensitive
- Reserved URL characters must be properly escaped
- Avoid ending with dot (.), forward slash (/), or backslash (\)

**UUID Format Compatibility**: UUIDs (format: `550e8400-e29b-41d4-a716-446655440000`) are VALID blob names.
- All characters (0-9, a-f, hyphens) are URL-safe
- No escaping needed
- 36 characters, well within limit

**Naming Pattern Options**:

**Option 1: Simple - Thread ID as blob name**

```
Container: threads
Blob name: {thread_id}.json

Example: 550e8400-e29b-41d4-a716-446655440000.json
```

✅ Pros:
- Simple, direct mapping
- Fast retrieval by thread_id
- Easy to understand

❌ Cons:
- No versioning (overwrites state)
- No time-based queries
- Difficult to implement checkpoint history

**Option 2: Thread ID + Timestamp (Append-only history)**

```
Container: threads
Blob name: {thread_id}/{ISO8601_timestamp}.json

Example: 550e8400-e29b-41d4-a716-446655440000/2026-03-09T14:30:00.000Z.json
```

✅ Pros:
- Preserves history (append-only)
- Can list checkpoints in time order
- Supports time-travel

❌ Cons:
- Need to list blobs to find latest
- More storage consumed

**Option 3: Thread ID + Time Period (Monthly/Daily Partitions)**

```
Container: threads
Blob name: {thread_id}/{YYYY-MM}.json

Example: 550e8400-e29b-41d4-a716-446655440000/2026-03.json
```

✅ Pros:
- Balance between history and simplicity
- Predictable blob names
- Easy lifecycle management (delete old months)

❌ Cons:
- Overwrites within period
- Arbitrary partition boundaries

**Option 4: Separate blobs for state and history**

```
Container: threads
State blob: {thread_id}/state.json
History blobs: {thread_id}/history/{checkpoint_id}.json

Example:
  550e8400-e29b-41d4-a716-446655440000/state.json
  550e8400-e29b-41d4-a716-446655440000/history/cp-001.json
  550e8400-e29b-41d4-a716-446655440000/history/cp-002.json
```

✅ Pros:
- Clear separation of concerns
- Fast access to latest state
- Complete history preserved
- Uses virtual directories for organization

❌ Cons:
- More complex
- Multiple blob operations per update

**Recommendation**: Use **Option 4** (state + history separation) for production. It provides the best balance of performance, history preservation, and query capability.

**Naming with Time Period Indicator**:

For lifecycle management, add time prefix for easy filtering:

```
Blob name: {YYYY-MM}/{thread_id}/state.json

Example: 2026-03/550e8400-e29b-41d4-a716-446655440000/state.json
```

Enables:
- List all threads from a specific month: `listBlobsByPrefix("2026-03/")`
- Delete old data by prefix: `deleteByPrefix("2024-")`

#### 2.4.4 Container Organization

**Container Naming Rules**:
- 3-63 characters long
- Lowercase letters, numbers, hyphens only
- Must start with letter or number
- No consecutive hyphens

**Strategy A: One container per entity type**

```
lg-api-threads
lg-api-assistants
lg-api-runs
lg-api-crons
lg-api-store
```

✅ Pros:
- Clear separation
- Independent access control per entity type
- Easy to manage lifecycle policies

❌ Cons:
- More containers to manage
- Can't perform cross-entity operations

**Strategy B: Single container with prefixes**

```
Container: lg-api-data

Blob prefixes:
  threads/{thread_id}/...
  assistants/{assistant_id}/...
  runs/{run_id}/...
  crons/{cron_id}/...
  store/{namespace}/{key}
```

✅ Pros:
- Simpler management (one container)
- Easier backups (single container)

❌ Cons:
- All-or-nothing access control
- Harder to apply entity-specific policies

**Recommendation**: Use Strategy A (one container per entity type) for better isolation and access control.

#### 2.4.5 Data Storage Format

All entities stored as JSON blobs:

```typescript
// Thread state blob
{
  "thread_id": "550e8400-e29b-41d4-a716-446655440000",
  "created_at": "2026-03-09T10:00:00.000Z",
  "updated_at": "2026-03-09T14:30:00.000Z",
  "metadata": {
    "userId": "user-123",
    "sessionId": "session-456"
  },
  "status": "idle",
  "values": { "messages": [...] },
  "latest_checkpoint_id": "cp-005"
}

// Checkpoint blob
{
  "checkpoint_id": "cp-005",
  "thread_id": "550e8400-e29b-41d4-a716-446655440000",
  "parent_checkpoint_id": "cp-004",
  "checkpoint_ns": "",
  "data": { /* full state snapshot */ },
  "metadata": {},
  "created_at": "2026-03-09T14:30:00.000Z"
}
```

#### 2.4.6 Query Capabilities

**Blob Metadata vs. Blob Index Tags**

**Blob Metadata**:
- Key-value pairs attached to blob
- Retrieved with blob properties
- NOT searchable server-side
- Limit: 8 KB total metadata per blob

```typescript
await blockBlobClient.setMetadata({
  threadId: '550e8400-e29b-41d4-a716-446655440000',
  userId: 'user-123',
  status: 'idle'
});
```

**Blob Index Tags** (Recommended for search):
- Key-value pairs indexed by Azure
- Searchable with `findBlobsByTags()`
- Limit: 10 tags per blob, each tag key/value max 256 characters

```typescript
await blockBlobClient.setTags({
  threadId: '550e8400-e29b-41d4-a716-446655440000',
  userId: 'user-123',
  status: 'idle',
  createdDate: '2026-03-09'
});

// Server-side search
const iterator = containerClient.findBlobsByTags(
  "status='idle' AND userId='user-123'"
);
for await (const blob of iterator) {
  console.log(blob.name);
}
```

**Query Limitations**:
- Only simple equality and AND/OR operations
- No ranges, no LIKE, no complex joins
- Tag values are strings only
- Maximum 10 tags per blob

**When to use Hybrid Approach**:

For complex queries, use SQL Server for metadata + Azure Blob for content:

```
SQL Server stores:
  - Thread (thread_id, created_at, status, user_id, latest_checkpoint_id)
  - Checkpoint (checkpoint_id, thread_id, parent_checkpoint_id, created_at, blob_url)

Azure Blob stores:
  - threads/{thread_id}/state.json (full state)
  - threads/{thread_id}/history/{checkpoint_id}.json (checkpoint data)
```

Queries hit SQL Server, content retrieval hits Blob Storage.

#### 2.4.7 Connection Configuration

```yaml
storage:
  provider: azureblob
  azureblob:
    account_name: ${AZURE_STORAGE_ACCOUNT_NAME}
    # Option 1: Connection string (simpler for dev)
    connection_string: ${AZURE_STORAGE_CONNECTION_STRING}

    # Option 2: DefaultAzureCredential (recommended for production)
    use_managed_identity: true

    # Option 3: SAS token
    sas_token: ${AZURE_STORAGE_SAS_TOKEN}
    sas_token_expires_at: ${AZURE_STORAGE_SAS_TOKEN_EXPIRES_AT}  # For monitoring

    containers:
      threads: lg-api-threads
      assistants: lg-api-assistants
      runs: lg-api-runs
      crons: lg-api-crons
      store: lg-api-store
```

**Authentication Options**:

1. **Connection String** (dev/testing):
```typescript
const blobServiceClient = BlobServiceClient.fromConnectionString(
  process.env.AZURE_STORAGE_CONNECTION_STRING
);
```

2. **DefaultAzureCredential** (production, recommended):
```typescript
import { DefaultAzureCredential } from '@azure/identity';

const credential = new DefaultAzureCredential();
const blobServiceClient = new BlobServiceClient(
  `https://${accountName}.blob.core.windows.net`,
  credential
);
```

Benefits:
- Works with Managed Identity in Azure
- Works with Azure CLI locally (development)
- No secrets in code or config
- Automatic token refresh

3. **SAS Token** (time-limited access):
```typescript
const blobServiceClient = new BlobServiceClient(
  `https://${accountName}.blob.core.windows.net${sasToken}`
);
```

**Recommendation**: Use DefaultAzureCredential for production, connection string for local development.

#### 2.4.8 Performance Characteristics

- **Latency**: Higher than SQL (10-50ms typical)
- **Throughput**: Very high (up to 20,000 requests/sec per storage account)
- **Cost**: $0.018/GB/month for hot tier (vs $0.10-0.50/GB for SQL Server)
- **Scaling**: Automatic, no limits on storage size
- **Consistency**: Strong consistency for single-blob operations

#### 2.4.9 When Azure Blob is the Right Choice

✅ **Use Azure Blob Storage when:**
- Cloud-native Azure deployment
- Large conversation histories (GB+ per thread)
- Document storage for Store API
- Cost optimization for large data volumes
- Global distribution needed (geo-replication)
- Hybrid architecture (SQL for metadata, Blob for content)

❌ **Avoid Azure Blob Storage when:**
- Complex relational queries needed
- Real-time search across all entities
- Strong transactional consistency required across multiple entities
- On-premise deployment (no Azure infrastructure)

**Recommended Hybrid Pattern**:
```
SQL Server:
  - Thread metadata (id, status, user_id, created_at)
  - Assistant metadata
  - Run metadata
  - Cron metadata

Azure Blob Storage:
  - Thread state.json (full conversation state)
  - Checkpoint history
  - Store API documents
  - User-uploaded attachments
```

This provides the best of both worlds: fast queries on SQL, cheap storage on Blob.

---

### 2.5 Hybrid Approach

#### 2.5.1 Motivation

Different data types have different storage requirements:

| Data Type | Size | Query Frequency | Best Storage |
|-----------|------|-----------------|--------------|
| Thread metadata | Small (< 1 KB) | High | SQL |
| Thread state | Medium (10-100 KB) | Medium | SQL or Blob |
| Checkpoint history | Large (MB+) | Low | Blob |
| Assistant config | Small (< 10 KB) | High | SQL |
| Run metadata | Small (< 1 KB) | High | SQL |
| Store documents | Variable (KB-MB) | Low-Medium | Blob |

A hybrid approach can optimize cost and performance.

#### 2.5.2 Hybrid Architecture Pattern

**Pattern 1: SQL for Metadata + Blob for Content**

```
┌─────────────────────────────────────────────────────────────┐
│                      Application Layer                       │
└─────────────────┬───────────────────────────────────────────┘
                  │
         ┌────────┴──────────┐
         │                   │
┌────────▼─────────┐  ┌─────▼──────────┐
│  SQL Server      │  │  Azure Blob     │
│  (Metadata)      │  │  (Content)      │
├──────────────────┤  ├─────────────────┤
│ Thread           │  │ state.json      │
│  - id            │  │ checkpoints/    │
│  - status        │  │ documents/      │
│  - user_id       │  └─────────────────┘
│  - blob_url      │
├──────────────────┤
│ Checkpoint       │
│  - id            │
│  - thread_id     │
│  - parent_id     │
│  - blob_url      │
└──────────────────┘
```

**Implementation**:

```typescript
// Thread entity with blob reference
interface ThreadMetadata {
  thread_id: string;
  created_at: string;
  updated_at: string;
  status: ThreadStatus;
  user_id: string;
  state_blob_url: string;  // Reference to blob
  latest_checkpoint_id: string;
}

// Repository implementation
class HybridThreadRepository implements IRepository<Thread> {
  constructor(
    private sqlStorage: ISqlStorage,
    private blobStorage: IAzureBlobStorage
  ) {}

  async getById(threadId: string): Promise<Thread | null> {
    // 1. Get metadata from SQL
    const metadata = await this.sqlStorage.query<ThreadMetadata>(
      'SELECT * FROM Thread WHERE thread_id = @threadId',
      { threadId }
    );

    if (!metadata) return null;

    // 2. Get full state from Blob
    const state = await this.blobStorage.downloadJson<ThreadState>(
      metadata.state_blob_url
    );

    // 3. Combine metadata + state
    return {
      thread_id: metadata.thread_id,
      created_at: metadata.created_at,
      updated_at: metadata.updated_at,
      status: metadata.status,
      metadata: state.metadata,
      values: state.values,
      interrupts: state.interrupts
    };
  }

  async update(threadId: string, updates: Partial<Thread>): Promise<Thread | null> {
    // 1. Update metadata in SQL
    await this.sqlStorage.execute(
      'UPDATE Thread SET status = @status, updated_at = @updatedAt WHERE thread_id = @threadId',
      { threadId, status: updates.status, updatedAt: new Date().toISOString() }
    );

    // 2. Update state in Blob
    const blobUrl = `threads/${threadId}/state.json`;
    await this.blobStorage.uploadJson(blobUrl, {
      metadata: updates.metadata,
      values: updates.values,
      interrupts: updates.interrupts
    });

    // 3. Return updated entity
    return this.getById(threadId);
  }
}
```

**Pattern 2: SQLite for Local Cache + Blob for Persistence**

```
Application reads/writes → SQLite (fast local access)
                              ↓
                    Background sync process
                              ↓
                    Azure Blob (durable storage)
```

Useful for edge deployments or offline-first applications.

#### 2.5.3 Configuration for Hybrid Approach

```yaml
storage:
  provider: hybrid
  hybrid:
    metadata_provider: sqlserver
    content_provider: azureblob

    # Thresholds for routing decisions
    content_size_threshold: 10240  # 10 KB - larger goes to blob

    # Provider-specific configs
    sqlserver:
      host: ${SQL_SERVER_HOST}
      database: ${SQL_SERVER_DATABASE}
      # ... other SQL config

    azureblob:
      account_name: ${AZURE_STORAGE_ACCOUNT_NAME}
      use_managed_identity: true
      containers:
        threads: lg-api-threads-content
        store: lg-api-store-content
```

#### 2.5.4 Pros and Cons

✅ **Pros**:
- Optimized cost (cheap blob storage for large data)
- Optimized performance (fast SQL queries for metadata)
- Flexibility (different storage for different needs)
- Scalability (blob storage scales independently)

❌ **Cons**:
- Increased complexity (two storage systems to manage)
- Consistency challenges (transactions don't span SQL and Blob)
- Operational overhead (two systems to monitor, backup, maintain)
- Development complexity (more code, more error handling)

#### 2.5.5 When Hybrid is the Right Choice

✅ **Use Hybrid when:**
- Very large conversation histories (GB+ per thread)
- High query frequency on metadata, low on content
- Cost optimization critical
- Cloud-native deployment (SQL + Blob both in Azure)
- Document storage needed alongside relational data

❌ **Avoid Hybrid when:**
- Simplicity is valued (single storage easier to manage)
- Data volumes are moderate (< 1 GB total)
- Budget allows for pure SQL approach
- Team lacks expertise in multiple storage systems

**Recommendation**: Start with a single storage provider (SQLite for dev, SQL Server or pure Blob for production). Migrate to hybrid only when cost or performance requirements justify the added complexity.

---

## 3. YAML Configuration Design

### 3.1 File Structure

**File Location**: `/config/storage-config.yaml` (or configurable via environment variable `STORAGE_CONFIG_PATH`)

**Complete Schema**:

```yaml
# Storage Configuration for lg-api
# Supports multiple storage backends with provider-specific settings

storage:
  # Active provider: 'inmemory' | 'sqlite' | 'sqlserver' | 'azureblob' | 'hybrid'
  provider: ${STORAGE_PROVIDER}

  # SQLite Configuration
  sqlite:
    database_path: ${SQLITE_DB_PATH}  # Path to .db file or ':memory:'
    enable_wal: true  # Write-Ahead Logging for better concurrency
    synchronous_mode: NORMAL  # FULL | NORMAL | OFF
    cache_size_kb: 20000  # Cache size in KB (~80MB)
    temp_store: MEMORY  # MEMORY | FILE | DEFAULT
    busy_timeout_ms: 5000  # Wait time when database is locked
    foreign_keys: true  # Enforce foreign key constraints

  # SQL Server Configuration
  sqlserver:
    host: ${SQL_SERVER_HOST}
    port: ${SQL_SERVER_PORT}
    database: ${SQL_SERVER_DATABASE}
    user: ${SQL_SERVER_USER}
    password: ${SQL_SERVER_PASSWORD}
    password_expires_at: ${SQL_SERVER_PASSWORD_EXPIRES_AT}  # Optional, for monitoring

    # Connection options
    encrypt: true  # Use TLS
    trustServerCertificate: false  # Validate server certificate
    connectionTimeout: 30000  # Connection timeout in ms
    requestTimeout: 30000  # Query timeout in ms

    # Connection pool
    pool:
      max: 10  # Maximum connections in pool
      min: 0  # Minimum connections to maintain
      idleTimeoutMillis: 30000  # Close idle connections after 30s
      acquireTimeoutMillis: 30000  # Max wait time to acquire connection

    # Feature flags
    use_json_type: false  # Use native JSON type (SQL Server 2025+)
    enable_json_index: false  # Use JSON indexes (SQL Server 2025+)

  # Azure Blob Storage Configuration
  azureblob:
    account_name: ${AZURE_STORAGE_ACCOUNT_NAME}

    # Authentication method (choose one)
    # Option 1: Connection string (simplest, for dev/testing)
    connection_string: ${AZURE_STORAGE_CONNECTION_STRING}

    # Option 2: Managed Identity (recommended for production)
    use_managed_identity: ${AZURE_USE_MANAGED_IDENTITY}

    # Option 3: SAS token (time-limited access)
    sas_token: ${AZURE_STORAGE_SAS_TOKEN}
    sas_token_expires_at: ${AZURE_STORAGE_SAS_TOKEN_EXPIRES_AT}  # ISO 8601 datetime

    # Container names (must be lowercase, 3-63 chars)
    containers:
      threads: lg-api-threads
      assistants: lg-api-assistants
      runs: lg-api-runs
      crons: lg-api-crons
      store: lg-api-store

    # Blob naming strategy
    naming:
      thread_pattern: state_and_history  # 'simple' | 'timestamped' | 'monthly' | 'state_and_history'
      include_time_prefix: false  # Prefix blobs with YYYY-MM/ for lifecycle management

    # Feature flags
    enable_blob_index_tags: true  # Use blob index tags for search
    max_blob_index_tags: 10  # Limit tags per blob

  # Hybrid Configuration (SQL + Blob)
  hybrid:
    metadata_provider: sqlserver  # 'sqlite' | 'sqlserver'
    content_provider: azureblob  # 'azureblob'

    # Routing rules
    content_size_threshold_bytes: 10240  # 10 KB - content larger than this goes to blob
    always_blob_entities:  # Entities that always use blob for content
      - checkpoint_history
      - store_documents

    # Provider-specific configs (reference sections above)
    sqlserver:
      # ... (same as sqlserver section)
    azureblob:
      # ... (same as azureblob section)

  # Feature flags (global, provider-independent)
  features:
    enable_soft_delete: false  # Soft delete instead of hard delete
    enable_audit_log: false  # Log all storage operations
    enable_query_cache: true  # Cache frequent queries (in-memory)
    cache_ttl_seconds: 300  # Cache entry TTL

  # Migration settings
  migration:
    auto_migrate: true  # Automatically run migrations on startup
    migration_table_name: Migration  # Table to track applied migrations

  # Monitoring and observability
  monitoring:
    enable_metrics: true  # Expose storage metrics
    enable_query_logging: false  # Log all queries (verbose, dev only)
    slow_query_threshold_ms: 1000  # Log queries slower than this
```

### 3.2 Configuration Loading

**Environment Variable Substitution**:

The YAML loader replaces `${VAR_NAME}` with values from `process.env.VAR_NAME`.

```typescript
// src/config/storage-config.loader.ts

import * as fs from 'fs';
import * as yaml from 'js-yaml';

interface StorageConfig {
  storage: {
    provider: 'inmemory' | 'sqlite' | 'sqlserver' | 'azureblob' | 'hybrid';
    sqlite?: SqliteConfig;
    sqlserver?: SqlServerConfig;
    azureblob?: AzureBlobConfig;
    hybrid?: HybridConfig;
    features?: FeatureFlags;
    migration?: MigrationConfig;
    monitoring?: MonitoringConfig;
  };
}

export function loadStorageConfig(configPath?: string): StorageConfig {
  // 1. Determine config file path
  const path = configPath || process.env.STORAGE_CONFIG_PATH || './config/storage-config.yaml';

  // 2. Read YAML file
  if (!fs.existsSync(path)) {
    throw new Error(`Storage configuration file not found: ${path}`);
  }

  const yamlContent = fs.readFileSync(path, 'utf8');

  // 3. Substitute environment variables
  const substituted = substituteEnvVars(yamlContent);

  // 4. Parse YAML
  const config = yaml.load(substituted) as StorageConfig;

  // 5. Validate configuration
  validateConfig(config);

  return config;
}

function substituteEnvVars(yamlContent: string): string {
  return yamlContent.replace(/\$\{(\w+)\}/g, (match, varName) => {
    const value = process.env[varName];
    if (value === undefined) {
      throw new Error(`Environment variable not set: ${varName}`);
    }
    return value;
  });
}

function validateConfig(config: StorageConfig): void {
  // Validate provider is set
  if (!config.storage.provider) {
    throw new Error('storage.provider is required');
  }

  // Validate provider-specific config exists
  const provider = config.storage.provider;
  if (provider !== 'inmemory' && !config.storage[provider]) {
    throw new Error(`Configuration for provider '${provider}' is missing`);
  }

  // Provider-specific validation
  switch (provider) {
    case 'sqlite':
      validateSqliteConfig(config.storage.sqlite!);
      break;
    case 'sqlserver':
      validateSqlServerConfig(config.storage.sqlserver!);
      break;
    case 'azureblob':
      validateAzureBlobConfig(config.storage.azureblob!);
      break;
    case 'hybrid':
      validateHybridConfig(config.storage.hybrid!);
      break;
  }
}

function validateSqliteConfig(config: SqliteConfig): void {
  if (!config.database_path) {
    throw new Error('sqlite.database_path is required');
  }
  // Validate path is absolute or ':memory:'
  if (config.database_path !== ':memory:' && !config.database_path.startsWith('/')) {
    throw new Error('sqlite.database_path must be an absolute path or ":memory:"');
  }
}

function validateSqlServerConfig(config: SqlServerConfig): void {
  const required = ['host', 'database', 'user', 'password'];
  for (const field of required) {
    if (!config[field]) {
      throw new Error(`sqlserver.${field} is required`);
    }
  }
}

function validateAzureBlobConfig(config: AzureBlobConfig): void {
  if (!config.account_name) {
    throw new Error('azureblob.account_name is required');
  }

  // Validate authentication method is provided
  const hasAuth = config.connection_string || config.use_managed_identity || config.sas_token;
  if (!hasAuth) {
    throw new Error('azureblob requires one of: connection_string, use_managed_identity, or sas_token');
  }

  // Validate containers are defined
  if (!config.containers) {
    throw new Error('azureblob.containers is required');
  }
}

function validateHybridConfig(config: HybridConfig): void {
  if (!config.metadata_provider || !config.content_provider) {
    throw new Error('hybrid.metadata_provider and hybrid.content_provider are required');
  }

  // Validate referenced provider configs exist
  if (!config[config.metadata_provider]) {
    throw new Error(`hybrid.${config.metadata_provider} configuration is missing`);
  }
  if (!config[config.content_provider]) {
    throw new Error(`hybrid.${config.content_provider} configuration is missing`);
  }
}
```

### 3.3 Example Configurations

#### Example 1: Development (SQLite, local file)

```yaml
storage:
  provider: sqlite
  sqlite:
    database_path: ./data/dev.db
    enable_wal: true
    synchronous_mode: NORMAL
    cache_size_kb: 10000
    temp_store: MEMORY
    busy_timeout_ms: 5000
    foreign_keys: true

  features:
    enable_soft_delete: false
    enable_audit_log: false
    enable_query_cache: false

  migration:
    auto_migrate: true

  monitoring:
    enable_metrics: true
    enable_query_logging: true
    slow_query_threshold_ms: 100
```

**Environment Variables**: None required (all literal values).

#### Example 2: Enterprise On-Premise (SQL Server)

```yaml
storage:
  provider: sqlserver
  sqlserver:
    host: ${SQL_SERVER_HOST}  # sql-prod-01.company.com
    port: ${SQL_SERVER_PORT}  # 1433
    database: ${SQL_SERVER_DATABASE}  # LgApiProd
    user: ${SQL_SERVER_USER}  # lg_api_service
    password: ${SQL_SERVER_PASSWORD}  # <from Azure Key Vault>
    password_expires_at: ${SQL_SERVER_PASSWORD_EXPIRES_AT}  # 2026-09-01T00:00:00Z

    encrypt: true
    trustServerCertificate: false
    connectionTimeout: 30000
    requestTimeout: 30000

    pool:
      max: 20
      min: 2
      idleTimeoutMillis: 60000
      acquireTimeoutMillis: 30000

    use_json_type: false
    enable_json_index: false

  features:
    enable_soft_delete: true
    enable_audit_log: true
    enable_query_cache: true
    cache_ttl_seconds: 600

  migration:
    auto_migrate: false  # Manual migration in prod

  monitoring:
    enable_metrics: true
    enable_query_logging: false
    slow_query_threshold_ms: 2000
```

**Environment Variables Required**:
- `SQL_SERVER_HOST`
- `SQL_SERVER_PORT`
- `SQL_SERVER_DATABASE`
- `SQL_SERVER_USER`
- `SQL_SERVER_PASSWORD`
- `SQL_SERVER_PASSWORD_EXPIRES_AT`

#### Example 3: Cloud Deployment (Azure Blob Storage)

```yaml
storage:
  provider: azureblob
  azureblob:
    account_name: ${AZURE_STORAGE_ACCOUNT_NAME}  # lgapiprodstore
    use_managed_identity: true  # Use Azure Managed Identity

    containers:
      threads: lg-api-prod-threads
      assistants: lg-api-prod-assistants
      runs: lg-api-prod-runs
      crons: lg-api-prod-crons
      store: lg-api-prod-store

    naming:
      thread_pattern: state_and_history
      include_time_prefix: true

    enable_blob_index_tags: true
    max_blob_index_tags: 10

  features:
    enable_soft_delete: true
    enable_audit_log: false
    enable_query_cache: true
    cache_ttl_seconds: 300

  monitoring:
    enable_metrics: true
    enable_query_logging: false
    slow_query_threshold_ms: 500
```

**Environment Variables Required**:
- `AZURE_STORAGE_ACCOUNT_NAME`

**Authentication**: Uses `DefaultAzureCredential`, which automatically discovers credentials from:
1. Environment variables (AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID)
2. Managed Identity (when running in Azure)
3. Azure CLI (when developing locally)

#### Example 4: Hybrid (SQL Server + Azure Blob)

```yaml
storage:
  provider: hybrid
  hybrid:
    metadata_provider: sqlserver
    content_provider: azureblob

    content_size_threshold_bytes: 10240
    always_blob_entities:
      - checkpoint_history
      - store_documents

    sqlserver:
      host: ${SQL_SERVER_HOST}
      port: ${SQL_SERVER_PORT}
      database: ${SQL_SERVER_DATABASE}
      user: ${SQL_SERVER_USER}
      password: ${SQL_SERVER_PASSWORD}
      encrypt: true
      pool:
        max: 15
        min: 1

    azureblob:
      account_name: ${AZURE_STORAGE_ACCOUNT_NAME}
      use_managed_identity: true
      containers:
        threads: lg-api-hybrid-threads
        store: lg-api-hybrid-store
      naming:
        thread_pattern: state_and_history
        include_time_prefix: true

  features:
    enable_soft_delete: true
    enable_audit_log: true
    enable_query_cache: true
    cache_ttl_seconds: 600

  monitoring:
    enable_metrics: true
    slow_query_threshold_ms: 1500
```

**Environment Variables Required**:
- `SQL_SERVER_HOST`, `SQL_SERVER_PORT`, `SQL_SERVER_DATABASE`, `SQL_SERVER_USER`, `SQL_SERVER_PASSWORD`
- `AZURE_STORAGE_ACCOUNT_NAME`

---

## 4. Data Model Design

### 4.1 Thread (Conversation Session)

**Purpose**: Represents a multi-turn conversation session with state management and checkpoint history.

**Fields**:

| Field | Type | Description | Indexed |
|-------|------|-------------|---------|
| `thread_id` | UUID | Primary key, unique identifier | PK |
| `created_at` | ISO 8601 datetime | When thread was created | Yes (DESC) |
| `updated_at` | ISO 8601 datetime | Last modification time | Yes (DESC) |
| `metadata` | JSON object | Arbitrary key-value pairs (userId, sessionId, etc.) | Partial (extracted fields) |
| `status` | Enum | 'idle' \| 'busy' \| 'interrupted' \| 'error' | Yes |
| `values` | JSON object (nullable) | Current state values (messages, variables) | No |
| `interrupts` | JSON array (nullable) | Pending interrupts | No |

**Storage Considerations**:

- **SQLite/SQL Server**: Store `metadata` and `values` as JSON text
- **Azure Blob**: Store as single JSON blob at `threads/{thread_id}/state.json`
- **Hybrid**: Store metadata fields + `status` in SQL, full state in blob

**Common Queries**:

1. Get thread by ID (most common)
2. List threads by user (`metadata.userId = ?`)
3. List threads by status
4. List recent threads (ORDER BY updated_at DESC)
5. Search by metadata fields

**Index Strategy**:

```sql
-- SQL Server/SQLite
CREATE INDEX idx_thread_status ON Thread(status);
CREATE INDEX idx_thread_created_at ON Thread(created_at DESC);
CREATE INDEX idx_thread_updated_at ON Thread(updated_at DESC);

-- For frequent userId queries (SQL Server with JSON)
ALTER TABLE Thread ADD metadata_userId AS JSON_VALUE(metadata, '$.userId') PERSISTED;
CREATE INDEX idx_thread_metadata_userId ON Thread(metadata_userId);

-- Azure Blob Index Tags
tags: {
  status: 'idle',
  userId: 'user-123',
  createdDate: '2026-03-09'
}
```

### 4.2 Checkpoint (State Snapshot)

**Purpose**: Immutable snapshot of conversation state at a point in time. Checkpoints form a linked list via `parent_checkpoint_id`, enabling history traversal and time-travel.

**Fields**:

| Field | Type | Description | Indexed |
|-------|------|-------------|---------|
| `checkpoint_id` | UUID | Primary key | PK |
| `thread_id` | UUID | Foreign key to Thread | Yes |
| `checkpoint_ns` | String | Namespace (default: '') | No |
| `parent_checkpoint_id` | UUID (nullable) | Previous checkpoint (NULL for first) | Yes |
| `data` | JSON object | Full state snapshot | No |
| `metadata` | JSON object | Checkpoint metadata | No |
| `created_at` | ISO 8601 datetime | When checkpoint was created | Yes |

**Linked List Structure**:

```
Thread: 550e8400-e29b-41d4-a716-446655440000

Checkpoint 1 (created_at: 2026-03-09T10:00:00Z)
  checkpoint_id: cp-001
  parent_checkpoint_id: NULL
  ↓
Checkpoint 2 (created_at: 2026-03-09T10:05:00Z)
  checkpoint_id: cp-002
  parent_checkpoint_id: cp-001
  ↓
Checkpoint 3 (created_at: 2026-03-09T10:10:00Z)
  checkpoint_id: cp-003
  parent_checkpoint_id: cp-002
  ↓
Latest checkpoint (stored in Thread.values or separate query)
```

**Traversal Queries**:

1. **Get latest checkpoint** (most common):
```sql
SELECT * FROM Checkpoint
WHERE thread_id = @threadId
ORDER BY created_at DESC
LIMIT 1;
```

2. **Get checkpoint history** (backward traversal):
```sql
-- Recursive CTE to traverse parent chain
WITH RECURSIVE history AS (
  -- Start with specific checkpoint
  SELECT * FROM Checkpoint WHERE checkpoint_id = @checkpointId

  UNION ALL

  -- Follow parent pointers
  SELECT c.* FROM Checkpoint c
  INNER JOIN history h ON c.checkpoint_id = h.parent_checkpoint_id
)
SELECT * FROM history ORDER BY created_at DESC;
```

3. **Get checkpoints after a point** (forward traversal):
```sql
SELECT * FROM Checkpoint
WHERE thread_id = @threadId
  AND created_at > (SELECT created_at FROM Checkpoint WHERE checkpoint_id = @checkpointId)
ORDER BY created_at ASC;
```

**Storage Considerations**:

- **SQLite/SQL Server**: Store full checkpoint data in `data` JSON field
- **Azure Blob**: Store as `threads/{thread_id}/history/{checkpoint_id}.json`, maintain pointer in SQL
- **Hybrid**: Store metadata (id, thread_id, parent_id, created_at, blob_url) in SQL, full data in blob

**Index Strategy**:

```sql
-- Get latest checkpoint efficiently
CREATE INDEX idx_checkpoint_thread_created ON Checkpoint(thread_id, created_at DESC);

-- Traverse history via parent pointer
CREATE INDEX idx_checkpoint_parent ON Checkpoint(parent_checkpoint_id);
```

**Checkpoint Retention**:

Checkpoints can grow large over time. Implement retention policies:
- Keep last N checkpoints per thread
- Delete checkpoints older than X days
- Archive old checkpoints to cold storage (Azure Archive tier)

### 4.3 Assistant (Agent Configuration)

**Purpose**: Stores custom agent configurations, including graph definitions, prompts, model settings, and version history.

**Fields**:

| Field | Type | Description | Indexed |
|-------|------|-------------|---------|
| `assistant_id` | UUID | Primary key | PK |
| `graph_id` | String | Graph definition identifier | Yes |
| `name` | String | Human-readable name | Yes |
| `description` | String (nullable) | Description | No |
| `config` | JSON object | Agent configuration (model, temperature, etc.) | No |
| `context` | JSON object (nullable) | Agent context data | No |
| `metadata` | JSON object | Arbitrary metadata | No |
| `version` | Integer | Current version number | No |
| `created_at` | ISO 8601 datetime | Creation time | Yes |
| `updated_at` | ISO 8601 datetime | Last update time | Yes |

**Version History**:

Separate table `AssistantVersion` stores historical versions:

| Field | Type | Description |
|-------|------|-------------|
| `assistant_id` | UUID | Foreign key |
| `version` | Integer | Version number (1, 2, 3...) |
| `graph_id` | String | Graph ID at this version |
| `name` | String | Name at this version |
| `config` | JSON object | Config at this version |
| `created_at` | ISO 8601 datetime | When version was created |

**Composite Primary Key**: `(assistant_id, version)`

**Common Queries**:

1. Get assistant by ID (current version)
2. List assistants by graph_id
3. Search by name (fuzzy or exact)
4. List versions for an assistant
5. Get specific version

**Index Strategy**:

```sql
CREATE INDEX idx_assistant_graph_id ON Assistant(graph_id);
CREATE INDEX idx_assistant_name ON Assistant(name);
CREATE INDEX idx_assistant_created_at ON Assistant(created_at DESC);
```

### 4.4 Run (Execution Record)

**Purpose**: Tracks individual executions of agents (both stateful and stateless).

**Fields**:

| Field | Type | Description | Indexed |
|-------|------|-------------|---------|
| `run_id` | UUID | Primary key | PK |
| `thread_id` | UUID (nullable) | Thread for stateful runs, NULL for stateless | Yes |
| `assistant_id` | UUID | Which assistant was executed | Yes |
| `status` | Enum | 'pending' \| 'running' \| 'error' \| 'success' \| 'timeout' \| 'interrupted' | Yes |
| `metadata` | JSON object | Run metadata | No |
| `multitask_strategy` | Enum (nullable) | 'reject' \| 'interrupt' \| 'rollback' \| 'enqueue' | No |
| `kwargs` | JSON object (nullable) | Additional arguments | No |
| `created_at` | ISO 8601 datetime | Start time | Yes (DESC) |
| `updated_at` | ISO 8601 datetime | Last status update | Yes (DESC) |

**Common Queries**:

1. List runs for a thread (ORDER BY created_at DESC)
2. Get run by ID
3. Count runs by status
4. List recent runs across all threads
5. Bulk cancel runs (UPDATE WHERE status = 'running')

**Index Strategy**:

```sql
CREATE INDEX idx_run_thread_id ON Run(thread_id);
CREATE INDEX idx_run_status ON Run(status);
CREATE INDEX idx_run_created_at ON Run(created_at DESC);
CREATE INDEX idx_run_assistant_id ON Run(assistant_id);

-- Composite index for "list runs by thread and status"
CREATE INDEX idx_run_thread_status ON Run(thread_id, status, created_at DESC);
```

### 4.5 Cron (Scheduled Job)

**Purpose**: Configuration for recurring agent executions.

**Fields**:

| Field | Type | Description | Indexed |
|-------|------|-------------|---------|
| `cron_id` | UUID | Primary key | PK |
| `assistant_id` | UUID | Which assistant to run | Yes |
| `thread_id` | UUID (nullable) | Thread to use (NULL = create new each time) | Yes |
| `schedule` | String | Cron expression (e.g., `'0 */5 * * *'`) | No |
| `enabled` | Boolean | Is cron active | Yes |
| `payload` | JSON object (nullable) | Input data for runs | No |
| `metadata` | JSON object | Arbitrary metadata | No |
| `on_run_completed` | Enum (nullable) | 'delete' \| 'keep' | No |
| `end_time` | ISO 8601 datetime (nullable) | When to stop scheduling | No |
| `user_id` | String (nullable) | Owner | No |
| `next_run_date` | ISO 8601 datetime (nullable) | Next scheduled execution | Yes |
| `created_at` | ISO 8601 datetime | Creation time | Yes |
| `updated_at` | ISO 8601 datetime | Last update | Yes |

**Common Queries**:

1. Get crons due to run (`enabled = 1 AND next_run_date <= NOW()`)
2. List crons by assistant
3. List crons by thread
4. Search by enabled status

**Index Strategy**:

```sql
CREATE INDEX idx_cron_enabled ON Cron(enabled);
CREATE INDEX idx_cron_next_run ON Cron(next_run_date) WHERE enabled = 1;
CREATE INDEX idx_cron_assistant_id ON Cron(assistant_id);
CREATE INDEX idx_cron_thread_id ON Cron(thread_id);
```

### 4.6 Store Item (Key-Value with Namespace)

**Purpose**: Hierarchical key-value store for documents, conversation context, cross-thread memory.

**Fields**:

| Field | Type | Description | Indexed |
|-------|------|-------------|---------|
| `namespace` | Array of strings | Hierarchical namespace (e.g., `['user', '123', 'documents']`) | Yes (prefix) |
| `key` | String | Item key | PK (composite) |
| `value` | JSON object | Arbitrary data | No |
| `created_at` | ISO 8601 datetime | Creation time | Yes |
| `updated_at` | ISO 8601 datetime | Last update | Yes |

**Composite Primary Key**: `(namespace, key)`

**Namespace Storage**:

- **SQLite/SQL Server**: Store as JSON array text: `'["user","123","documents"]'`
- **Azure Blob**: Use blob prefix: `store/user/123/documents/{key}.json`

**Hierarchical Queries**:

1. **List all items in namespace**:
```sql
SELECT * FROM StoreItem WHERE namespace = '["user","123","documents"]'
```

2. **List items in namespace prefix** (all user 123's data):
```sql
-- SQLite/SQL Server
SELECT * FROM StoreItem WHERE namespace LIKE '["user","123"%'

-- Azure Blob
listBlobsByPrefix('store/user/123/')
```

3. **List namespaces**:
```sql
-- Complex query, extract unique namespace prefixes
SELECT DISTINCT namespace FROM StoreItem WHERE namespace LIKE '["user"%'
```

**Index Strategy**:

```sql
-- Prefix search on namespace
CREATE INDEX idx_store_namespace ON StoreItem(namespace);

-- Composite index for get operations
CREATE UNIQUE INDEX idx_store_namespace_key ON StoreItem(namespace, key);
```

**Storage Considerations**:

- **SQL**: Good for small values (< 100 KB), frequent queries
- **Blob**: Better for large values (documents, images), infrequent queries
- **Hybrid**: Metadata in SQL (namespace, key, size, created_at, blob_url), content in blob

### 4.7 Document (Conversation Attachments)

**Purpose**: Files/documents referenced in conversations (user uploads, agent-generated content).

**Design Option A: Part of Store API**

Store documents as special store items:

```
namespace: ['thread', '{thread_id}', 'documents']
key: '{document_id}'
value: {
  filename: 'report.pdf',
  mime_type: 'application/pdf',
  size_bytes: 1048576,
  blob_url: 'https://storage.../documents/abc123.pdf',
  uploaded_at: '2026-03-09T10:00:00Z'
}
```

Actual content stored in Azure Blob.

**Design Option B: Separate Document table**

```sql
CREATE TABLE Document (
    document_id UUID PRIMARY KEY,
    thread_id UUID,  -- Nullable, not all docs belong to threads
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    storage_path TEXT NOT NULL,  -- Blob URL or file path
    metadata JSON,
    created_at TIMESTAMP NOT NULL,

    FOREIGN KEY (thread_id) REFERENCES Thread(thread_id) ON DELETE CASCADE
);

CREATE INDEX idx_document_thread_id ON Document(thread_id);
```

**Recommendation**: Use Option A (store as special Store items) for simplicity. Documents are just another type of stored data.

---

(Continued in next message due to length...)

