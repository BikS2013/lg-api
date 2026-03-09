# Infrastructure Design: Storage Layer (Part 2 - Continuation)

## 5. Azure Blob Storage Deep Dive

### 5.1 Thread ID as Blob Name - Detailed Analysis

**UUID Format Validation**:

UUIDs in standard format (e.g., `550e8400-e29b-41d4-a716-446655440000`) are **fully compatible** with Azure Blob naming:
- Length: 36 characters (well within 1,024 limit)
- Characters: Only lowercase hexadecimal (0-9, a-f) and hyphens
- URL-safe: No escaping required
- Case-sensitive: Consistent (always lowercase in UUID v4)

✅ **Valid blob names using thread_id**:
```
550e8400-e29b-41d4-a716-446655440000.json
550e8400-e29b-41d4-a716-446655440000/state.json
threads/550e8400-e29b-41d4-a716-446655440000.json
2026-03/550e8400-e29b-41d4-a716-446655440000.json
```

### 5.2 Naming Pattern Detailed Comparison

**Pattern 1: Flat Structure with Thread ID**

```
Container: lg-api-threads
Blob names:
  550e8400-e29b-41d4-a716-446655440000.json
  7c9e6679-7425-40de-944b-e07fc1f90ae7.json
  9b3a7d21-3e4f-42bc-8e77-8f7c2d3e1a2b.json
```

**Operations**:
- Get thread state: `downloadBlob('550e8400-e29b-41d4-a716-446655440000.json')`
- Update state: `uploadBlob('550e8400-e29b-41d4-a716-446655440000.json', data)` (overwrites)
- List all threads: `listBlobs()` (can be slow with millions of blobs)

**Performance**:
- Single-blob operations: O(1), ~10-30ms latency
- List all: O(n), paginated (max 5000 per request)

**Pattern 2: Virtual Directories with State + History**

```
Container: lg-api-threads
Blob structure:
  550e8400-e29b-41d4-a716-446655440000/
    state.json                    ← Latest state
    history/
      2026-03-09T10:00:00Z.json  ← Checkpoint 1
      2026-03-09T10:05:00Z.json  ← Checkpoint 2
      2026-03-09T10:10:00Z.json  ← Checkpoint 3
```

**Operations**:
- Get latest state: `downloadBlob('550e8400-.../state.json')` ← Fast
- Save checkpoint: `uploadBlob('550e8400-.../history/{timestamp}.json', checkpoint)` ← Append-only
- List checkpoints: `listBlobsByPrefix('550e8400-.../history/')` ← Scoped to thread
- Get checkpoint history: List + download multiple blobs

**Performance**:
- Get state: O(1), fast
- Save checkpoint: O(1), no conflicts (append-only)
- List checkpoints for thread: O(k) where k = checkpoints for that thread
- Traverse history: Requires downloading each checkpoint blob

**Pattern 3: Time-Partitioned Prefix**

```
Container: lg-api-threads
Blob structure:
  2026-03/
    550e8400-e29b-41d4-a716-446655440000/state.json
    7c9e6679-7425-40de-944b-e07fc1f90ae7/state.json
  2026-02/
    9b3a7d21-3e4f-42bc-8e77-8f7c2d3e1a2b/state.json
```

**Operations**:
- Get state: `downloadBlob('2026-03/550e8400-.../state.json')` (need to know date)
- List current month threads: `listBlobsByPrefix('2026-03/')` ← Scoped query
- Delete old threads: `deleteBlobsByPrefix('2024-')` ← Efficient cleanup

**Lifecycle Management Benefits**:
- Automatically move old months to Cool tier (cheaper storage)
- Automatically delete very old data
- Easy to implement data retention policies

**Pattern 4: Hybrid - SQL Metadata + Blob Content**

```
SQL Server Table:
  Thread (thread_id, status, user_id, created_at, blob_url)

Azure Blob:
  threads/{thread_id}/state.json

Query flow:
  1. Search metadata in SQL (fast, indexed)
  2. Get blob_url from result
  3. Download blob for full state
```

**Benefits**:
- Fast metadata queries (SQL indexes)
- Cheap content storage (Blob)
- Best of both worlds

**Drawbacks**:
- Two systems to manage
- No transactions across SQL and Blob
- Added complexity

### 5.3 Blob Index Tags for Server-Side Filtering

**Tag Limits**:
- 10 tags per blob maximum
- Tag key: max 128 characters
- Tag value: max 256 characters
- Values are strings only (no numbers, booleans)

**Example Tags for Thread Blob**:

```typescript
await blockBlobClient.setTags({
  threadId: '550e8400-e29b-41d4-a716-446655440000',
  status: 'idle',
  userId: 'user-123',
  createdDate: '2026-03-09',
  updatedDate: '2026-03-09',
  hasInterrupts: 'false',
  messageCount: '25'  // String, not number
});
```

**Query Examples**:

```typescript
// Find all idle threads for a user
const query = `status = 'idle' AND userId = 'user-123'`;
const result = containerClient.findBlobsByTags(query);

// Find threads created today
const query = `createdDate = '2026-03-09'`;

// Complex query
const query = `status = 'idle' AND userId = 'user-123' AND createdDate >= '2026-03-01'`;
```

**Limitations**:
- Only equality (=) and comparison (>, <, >=, <=) operators
- No LIKE, no wildcards, no pattern matching
- No aggregations (COUNT, SUM, etc.)
- No JOINs across tags
- Returns up to 5000 results per query

**When Tag Search is Insufficient**:

For complex queries, use hybrid approach:
1. Store searchable metadata in SQL Server
2. Store content in Blob Storage
3. Query SQL, retrieve blob URLs, download content

### 5.4 Container Lifecycle Policies

Azure Blob Storage supports automatic lifecycle management:

```json
{
  "rules": [
    {
      "name": "MoveOldThreadsToCool",
      "enabled": true,
      "type": "Lifecycle",
      "definition": {
        "filters": {
          "blobTypes": ["blockBlob"],
          "prefixMatch": ["2024-", "2025-"]
        },
        "actions": {
          "baseBlob": {
            "tierToCool": {
              "daysAfterModificationGreaterThan": 90
            },
            "tierToArchive": {
              "daysAfterModificationGreaterThan": 365
            },
            "delete": {
              "daysAfterModificationGreaterThan": 1095
            }
          }
        }
      }
    }
  ]
}
```

**Benefits**:
- Automatic cost optimization (Cool tier is 50% cheaper, Archive is 90% cheaper)
- Automatic data retention (delete after N days)
- No code required (Azure manages it)

**Storage Tier Comparison**:

| Tier | Cost/GB/month | Access Latency | Use Case |
|------|---------------|----------------|----------|
| Hot | $0.0184 | <10ms | Active threads, recent data |
| Cool | $0.0092 | <10ms | Threads accessed occasionally |
| Archive | $0.00099 | Hours (rehydration) | Long-term retention, compliance |

**Recommendation**: Use time-prefixed blob names (Pattern 3) to leverage lifecycle policies.

### 5.5 Concurrency and Consistency

**Optimistic Concurrency with ETags**:

```typescript
// Download blob with ETag
const downloadResponse = await blockBlobClient.download();
const etag = downloadResponse.etag;
const data = await downloadResponse.readableStreamBody;

// Modify data
const updatedData = modifyState(data);

// Upload only if ETag matches (no concurrent modification)
try {
  await blockBlobClient.upload(updatedData, updatedData.length, {
    conditions: { ifMatch: etag }
  });
  console.log('Update successful');
} catch (error) {
  if (error.statusCode === 412) {
    console.log('Conflict: blob was modified by another process');
    // Retry or merge changes
  }
}
```

**Consistency Model**:
- **Strong consistency** for single-blob operations within same region
- **Eventual consistency** for cross-region replication (if enabled)

**Limitations**:
- No transactions across multiple blobs
- No atomic read-modify-write without ETags
- No foreign key constraints

**Best Practices**:
1. Use ETags for concurrent updates
2. Design append-only patterns (checkpoints as separate blobs)
3. Accept eventual consistency for cross-region scenarios

---

## 6. Migration Strategy

### 6.1 Migration Overview

Migration phases:
1. **In-Memory → SQLite**: For development/testing
2. **In-Memory → SQL Server**: For production
3. **In-Memory → Azure Blob**: For cloud deployments
4. **SQLite → SQL Server**: Scaling up
5. **SQL Server → Hybrid**: Cost optimization

### 6.2 Export/Import Utilities

**Design**: Generic export to JSON, import from JSON.

```typescript
// src/storage/migration/exporter.ts

export interface ExportFormat {
  version: string;
  exported_at: string;
  provider: string;
  data: {
    threads: Thread[];
    checkpoints: Checkpoint[];
    assistants: Assistant[];
    assistant_versions: AssistantVersion[];
    runs: Run[];
    crons: Cron[];
    store_items: StoreItem[];
  };
}

export class StorageExporter {
  constructor(private sourceProvider: IStorageProviderFull) {}

  async exportAll(outputPath: string): Promise<void> {
    const data: ExportFormat = {
      version: '1.0',
      exported_at: new Date().toISOString(),
      provider: this.sourceProvider.getProviderInfo().type,
      data: {
        threads: await this.exportThreads(),
        checkpoints: await this.exportCheckpoints(),
        assistants: await this.exportAssistants(),
        assistant_versions: await this.exportAssistantVersions(),
        runs: await this.exportRuns(),
        crons: await this.exportCrons(),
        store_items: await this.exportStoreItems()
      }
    };

    await fs.writeFile(outputPath, JSON.stringify(data, null, 2));
    console.log(`Exported to ${outputPath}`);
  }

  private async exportThreads(): Promise<Thread[]> {
    const result = await this.sourceProvider.searchThreads({
      limit: 10000,
      offset: 0
    });
    return result.items;
  }

  // ... similar methods for other entities
}

// src/storage/migration/importer.ts

export class StorageImporter {
  constructor(private targetProvider: IStorageProviderFull) {}

  async importAll(inputPath: string): Promise<void> {
    const content = await fs.readFile(inputPath, 'utf8');
    const data: ExportFormat = JSON.parse(content);

    console.log(`Importing from ${data.provider} export (${data.exported_at})`);

    // Import in dependency order
    await this.importAssistants(data.data.assistants);
    await this.importAssistantVersions(data.data.assistant_versions);
    await this.importThreads(data.data.threads);
    await this.importCheckpoints(data.data.checkpoints);
    await this.importRuns(data.data.runs);
    await this.importCrons(data.data.crons);
    await this.importStoreItems(data.data.store_items);

    console.log('Import complete');
  }

  private async importThreads(threads: Thread[]): Promise<void> {
    for (const thread of threads) {
      await this.targetProvider.createThread(thread);
    }
    console.log(`Imported ${threads.length} threads`);
  }

  // ... similar methods for other entities
}
```

**Usage**:

```bash
# Export from in-memory
npm run export-storage -- --output=./backups/export-2026-03-09.json

# Import to SQLite
npm run import-storage -- --input=./backups/export-2026-03-09.json --provider=sqlite
```

### 6.3 Zero-Downtime Migration Strategy

**Approach: Dual-Write Pattern**

```
Phase 1: Preparation
  - Deploy new storage provider (SQLite/SQL Server/Blob) alongside in-memory
  - Run schema migrations
  - Verify connectivity

Phase 2: Dual-Write (Read from Old, Write to Both)
  - Write operations go to both old and new storage
  - Read operations still use old storage
  - Gradually backfill historical data to new storage

Phase 3: Dual-Write (Read from New, Write to Both)
  - Switch reads to new storage
  - Continue writing to both (safety net)
  - Monitor for discrepancies

Phase 4: Cutover
  - Stop writing to old storage
  - Remove old storage code
  - Monitor new storage performance

Phase 5: Cleanup
  - Archive old storage data
  - Remove temporary dual-write code
```

**Implementation**:

```typescript
// src/repositories/dual-write.repository.ts

export class DualWriteRepository<T> implements IRepository<T> {
  constructor(
    private oldRepo: IRepository<T>,
    private newRepo: IRepository<T>,
    private readFrom: 'old' | 'new' = 'old'
  ) {}

  async create(id: string, item: T): Promise<T> {
    // Write to both
    const [oldResult, newResult] = await Promise.all([
      this.oldRepo.create(id, item),
      this.newRepo.create(id, item)
    ]);

    // Compare results (log discrepancies)
    this.compareResults(oldResult, newResult);

    return this.readFrom === 'old' ? oldResult : newResult;
  }

  async getById(id: string): Promise<T | null> {
    // Read from selected source
    return this.readFrom === 'old'
      ? this.oldRepo.getById(id)
      : this.newRepo.getById(id);
  }

  async update(id: string, updates: Partial<T>): Promise<T | null> {
    // Write to both
    const [oldResult, newResult] = await Promise.all([
      this.oldRepo.update(id, updates),
      this.newRepo.update(id, updates)
    ]);

    this.compareResults(oldResult, newResult);

    return this.readFrom === 'old' ? oldResult : newResult;
  }

  // ... other methods

  private compareResults(old: any, new: any): void {
    if (JSON.stringify(old) !== JSON.stringify(new)) {
      console.warn('Discrepancy detected between old and new storage', { old, new });
      // Send to monitoring system
    }
  }
}
```

**Configuration for Dual-Write**:

```yaml
storage:
  provider: dual-write
  dual_write:
    old_provider: inmemory
    new_provider: sqlserver
    read_from: old  # Switch to 'new' in Phase 3
    compare_results: true
    log_discrepancies: true

    # Provider configs
    sqlserver:
      # ... SQL Server config
```

### 6.4 Backfill Historical Data

For Phase 2 (dual-write), backfill existing data to new storage:

```typescript
// src/storage/migration/backfill.ts

export class BackfillService {
  constructor(
    private sourceRepo: IRepository<T>,
    private targetRepo: IRepository<T>
  ) {}

  async backfillAll(batchSize: number = 100): Promise<void> {
    let offset = 0;
    let processed = 0;

    while (true) {
      const batch = await this.sourceRepo.search({
        limit: batchSize,
        offset,
        sortBy: 'created_at',
        sortOrder: 'asc'
      });

      if (batch.items.length === 0) break;

      // Write batch to target
      for (const item of batch.items) {
        try {
          await this.targetRepo.create(item.id, item);
          processed++;
        } catch (error) {
          console.error(`Failed to backfill item ${item.id}`, error);
        }
      }

      console.log(`Backfilled ${processed} items`);
      offset += batchSize;

      // Throttle to avoid overloading
      await sleep(100);
    }

    console.log(`Backfill complete: ${processed} items`);
  }
}
```

**Run backfill as background job**:

```bash
npm run backfill-storage -- --entity=threads --batch-size=100
```

### 6.5 Rollback Plan

If migration fails:

1. **Phase 2**: Simply stop writing to new storage, continue with old
2. **Phase 3**: Switch `read_from` back to `old` in config, restart service
3. **Phase 4**: Re-enable writes to old storage (requires code deployment)

**Always maintain old storage** until confident in new storage (at least 1 week in production).

---

## 7. Additional Infrastructure Components

### 7.1 Agent Registry

**Purpose**: Store and discover available custom agents.

**Design Options**:

**Option A: Agents as Assistants**

Use existing Assistant entity to represent agents. Agent registration = creating an Assistant.

```typescript
// Register custom agent
const agent = await assistantRepo.create({
  assistant_id: 'agent-001',
  graph_id: 'custom_agent_graph',
  name: 'Customer Support Agent',
  description: 'Handles customer support inquiries',
  config: {
    model: 'gpt-4',
    temperature: 0.7,
    agent_type: 'custom',
    agent_endpoint: 'https://my-agent.com/execute'
  },
  context: {
    system_prompt: '...',
    knowledge_base_ids: ['kb-001', 'kb-002']
  },
  metadata: {
    owner: 'team-support',
    version: '1.0.0',
    capabilities: ['question_answering', 'sentiment_analysis']
  }
});
```

**Option B: Separate AgentRegistry Table**

```sql
CREATE TABLE AgentRegistry (
    agent_id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    agent_type TEXT NOT NULL,  -- 'custom' | 'langgraph' | 'openai'
    endpoint_url TEXT,  -- For custom agents
    config JSON NOT NULL,
    capabilities JSON,  -- Array of capability strings
    status TEXT NOT NULL,  -- 'active' | 'inactive' | 'deprecated'
    registered_at TIMESTAMP NOT NULL,
    last_health_check TIMESTAMP,
    health_status TEXT  -- 'healthy' | 'degraded' | 'unhealthy'
);
```

**Recommendation**: Use Option A (agents as Assistants) for simplicity. No new tables needed.

### 7.2 Document Processing Pipeline

**Purpose**: Process uploaded documents (text extraction, chunking, embedding generation).

**Architecture**:

```
User uploads document
    ↓
Store raw file in Azure Blob (or local filesystem)
    ↓
Create Document record in Store API (namespace: ['documents'], key: doc_id)
    ↓
Trigger async processing job
    ↓
Extract text (PDF → text, DOCX → text, etc.)
    ↓
Chunk text (e.g., 512 token chunks with overlap)
    ↓
Generate embeddings (via OpenAI API)
    ↓
Store chunks + embeddings in vector database
    ↓
Update Document record (status: 'processed', chunks: N, embeddings: N)
```

**Storage Considerations**:

- **Raw documents**: Azure Blob (cheap, durable)
- **Document metadata**: Store API (searchable)
- **Processed chunks**: Vector database (Pinecone, Weaviate, or pgvector)
- **Processing status**: Document metadata

**Implementation not in scope**: This document focuses on core storage infrastructure. Document processing pipeline is a separate feature.

### 7.3 Conversation History Manager

**Purpose**: Compose conversation history from checkpoints, manage context window.

**Key Functions**:

1. **Get conversation history** (all messages)
2. **Get recent history** (last N messages)
3. **Trim history** (remove old messages to fit context window)
4. **Summarize history** (LLM-based summarization of old messages)

**Storage Dependency**:

Requires efficient checkpoint traversal:
- SQLite/SQL Server: Recursive CTE query
- Azure Blob: List blobs by prefix, download and parse
- Hybrid: Checkpoint metadata in SQL, content in blob

**Not stored separately**: History is derived from checkpoints, not a separate entity.

### 7.4 Session Manager

**Purpose**: Manage thread lifecycle (creation, TTL, expiration, cleanup).

**Key Functions**:

1. **Create thread with TTL**:
```typescript
const thread = await threadRepo.create({
  thread_id: generateUUID(),
  status: 'idle',
  metadata: { userId: 'user-123' },
  ttl: {
    strategy: 'absolute',
    at: '2026-03-10T00:00:00Z'  // Expires in 24 hours
  }
});
```

2. **Extend TTL** (user activity detected):
```typescript
await threadRepo.update(threadId, {
  ttl: {
    strategy: 'absolute',
    at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  }
});
```

3. **Cleanup expired threads** (background job):
```typescript
// Run periodically (e.g., every hour)
const expiredThreads = await sqlStorage.query(`
  SELECT thread_id FROM Thread
  WHERE JSON_VALUE(ttl, '$.at') < @now
`, { now: new Date().toISOString() });

for (const thread of expiredThreads) {
  await threadRepo.delete(thread.thread_id);
}
```

**Storage Considerations**:

- **TTL storage**: Part of Thread entity (JSON field or separate columns)
- **Index needed**: On TTL expiration time for efficient queries
- **Cascading deletes**: Ensure FK constraints delete checkpoints, runs when thread is deleted

---

## 8. Configuration Guide

### 8.1 Configuration Options Priority

When multiple configuration sources exist, the priority (highest to lowest):

1. **Command-line arguments** (if supported): `--storage-provider=sqlite`
2. **Environment variables**: `STORAGE_PROVIDER=sqlite`
3. **YAML configuration file**: `storage.provider: sqlite`
4. **Default values**: **NOT ALLOWED** per project rules

**Important**: Per project `CLAUDE.md`, no fallback values are permitted. All required configuration must be explicitly provided.

### 8.2 Required Configuration Variables

#### For SQLite Provider

| Variable | Purpose | How to Obtain | Recommended Storage | Options | Default | Expiration |
|----------|---------|---------------|---------------------|---------|---------|------------|
| `STORAGE_PROVIDER` | Select storage backend | Set to `'sqlite'` | Environment variable | `sqlite` \| `sqlserver` \| `azureblob` \| `hybrid` | N/A (required) | N/A |
| `SQLITE_DB_PATH` | Database file location | Choose a persistent path | Environment variable | Absolute path or `:memory:` | N/A (required) | N/A |

**Development Example**:
```bash
export STORAGE_PROVIDER=sqlite
export SQLITE_DB_PATH=./data/dev.db
```

**Production Example**:
```bash
export STORAGE_PROVIDER=sqlite
export SQLITE_DB_PATH=/var/lib/lg-api/lg-api.db
```

#### For SQL Server Provider

| Variable | Purpose | How to Obtain | Recommended Storage | Expiration |
|----------|---------|---------------|---------------------|------------|
| `STORAGE_PROVIDER` | Select storage backend | Set to `'sqlserver'` | Environment variable | N/A |
| `SQL_SERVER_HOST` | Database server hostname | From IT/DevOps | Environment variable or Azure Key Vault | N/A |
| `SQL_SERVER_PORT` | Database server port | Usually `1433` | Environment variable | N/A |
| `SQL_SERVER_DATABASE` | Database name | From IT/DevOps | Environment variable | N/A |
| `SQL_SERVER_USER` | Database username | From IT/DevOps | Environment variable or Azure Key Vault | N/A |
| `SQL_SERVER_PASSWORD` | Database password | From IT/DevOps or Key Vault | **Azure Key Vault** (never in code/config) | **YES** - typically 90 days |
| `SQL_SERVER_PASSWORD_EXPIRES_AT` | Password expiration date | Set when password is created/rotated | Environment variable | Used by app to warn before expiration |

**Password Rotation Recommendation**: Implement proactive warning:

```typescript
// Check password expiration on startup
const expiresAt = new Date(process.env.SQL_SERVER_PASSWORD_EXPIRES_AT);
const daysUntilExpiration = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);

if (daysUntilExpiration < 7) {
  console.warn(`SQL Server password expires in ${daysUntilExpiration} days!`);
  // Send alert to ops team
}
```

**Production Example**:
```bash
export STORAGE_PROVIDER=sqlserver
export SQL_SERVER_HOST=sql-prod-01.company.com
export SQL_SERVER_PORT=1433
export SQL_SERVER_DATABASE=LgApiProd
export SQL_SERVER_USER=lg_api_service
export SQL_SERVER_PASSWORD=$(az keyvault secret show --vault-name my-vault --name sql-password --query value -o tsv)
export SQL_SERVER_PASSWORD_EXPIRES_AT=2026-09-01T00:00:00Z
```

#### For Azure Blob Storage Provider

| Variable | Purpose | How to Obtain | Recommended Storage | Expiration |
|----------|---------|---------------|---------------------|------------|
| `STORAGE_PROVIDER` | Select storage backend | Set to `'azureblob'` | Environment variable | N/A |
| `AZURE_STORAGE_ACCOUNT_NAME` | Storage account name | From Azure Portal | Environment variable | N/A |
| **Option 1: Connection String** | | | | |
| `AZURE_STORAGE_CONNECTION_STRING` | Full connection string | From Azure Portal → Storage Account → Access Keys | **Azure Key Vault** | **YES** - if account key is rotated |
| **Option 2: Managed Identity (Recommended)** | | | | |
| `AZURE_USE_MANAGED_IDENTITY` | Use managed identity | Set to `'true'` | Environment variable | N/A |
| (No secret needed) | Automatic credential discovery | Assign Managed Identity to VM/App Service | Managed by Azure | N/A |
| **Option 3: SAS Token** | | | | |
| `AZURE_STORAGE_SAS_TOKEN` | Shared Access Signature | Generate in Azure Portal | **Azure Key Vault** | **YES** - SAS tokens have explicit expiration |
| `AZURE_STORAGE_SAS_TOKEN_EXPIRES_AT` | SAS token expiration | Set to token's expiry time | Environment variable | Used by app to warn before expiration |

**Recommendations**:
- **Development**: Use connection string (easier, less secure)
- **Production**: Use Managed Identity (no secrets, automatic rotation)
- **Limited access scenarios**: Use SAS token with minimal permissions and short expiration

**SAS Token Expiration Monitoring**:

```typescript
// Check SAS token expiration on startup
if (process.env.AZURE_STORAGE_SAS_TOKEN_EXPIRES_AT) {
  const expiresAt = new Date(process.env.AZURE_STORAGE_SAS_TOKEN_EXPIRES_AT);
  const daysUntilExpiration = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);

  if (daysUntilExpiration < 7) {
    console.warn(`Azure SAS token expires in ${daysUntilExpiration} days!`);
    // Send alert
  }

  if (daysUntilExpiration < 0) {
    throw new Error('Azure SAS token has expired! Generate a new token.');
  }
}
```

**Production Example (Managed Identity)**:
```bash
export STORAGE_PROVIDER=azureblob
export AZURE_STORAGE_ACCOUNT_NAME=lgapiprodstore
export AZURE_USE_MANAGED_IDENTITY=true
# No secrets needed!
```

**Production Example (SAS Token)**:
```bash
export STORAGE_PROVIDER=azureblob
export AZURE_STORAGE_ACCOUNT_NAME=lgapiprodstore
export AZURE_STORAGE_SAS_TOKEN=$(az keyvault secret show --vault-name my-vault --name blob-sas --query value -o tsv)
export AZURE_STORAGE_SAS_TOKEN_EXPIRES_AT=2026-04-09T00:00:00Z
```

### 8.3 Configuration File Location

| Variable | Purpose | How to Obtain | Default |
|----------|---------|---------------|---------|
| `STORAGE_CONFIG_PATH` | Path to YAML config file | Set to absolute path | `./config/storage-config.yaml` |

**Example**:
```bash
export STORAGE_CONFIG_PATH=/etc/lg-api/storage-config.yaml
```

### 8.4 Feature Flags

Optional configuration for enabling/disabling features:

| Feature | Purpose | Options | Recommendation |
|---------|---------|---------|----------------|
| `STORAGE_AUTO_MIGRATE` | Run migrations on startup | `true` \| `false` | `true` for dev, `false` for production (manual migration) |
| `STORAGE_ENABLE_QUERY_CACHE` | Cache frequent queries in memory | `true` \| `false` | `true` (improves performance) |
| `STORAGE_CACHE_TTL_SECONDS` | How long to cache queries | Number (seconds) | `300` (5 minutes) |
| `STORAGE_ENABLE_QUERY_LOGGING` | Log all storage queries | `true` \| `false` | `false` in production (verbose), `true` in dev for debugging |
| `STORAGE_SLOW_QUERY_THRESHOLD_MS` | Log queries slower than this | Number (milliseconds) | `1000` (1 second) |

### 8.5 Credential Management Best Practices

**DO**:
✅ Store secrets in Azure Key Vault, AWS Secrets Manager, or HashiCorp Vault
✅ Use Managed Identities when available (Azure, AWS)
✅ Rotate secrets regularly (90 days for passwords)
✅ Track expiration dates for time-limited credentials
✅ Use environment variables, never hardcode in code
✅ Use restrictive permissions (principle of least privilege)

**DO NOT**:
❌ Store secrets in YAML config files committed to git
❌ Hardcode secrets in source code
❌ Use default or weak passwords
❌ Share credentials across environments (dev/staging/prod)
❌ Use connection strings with account keys in production (use Managed Identity instead)
❌ Ignore expiration dates

### 8.6 Configuration Validation

On startup, the application **MUST**:

1. Validate all required variables are set
2. Validate variable formats (UUIDs, URLs, dates)
3. Test connectivity to storage backend
4. Check credential expiration dates
5. Warn or fail if misconfigured

Per project rules: **No fallback values**. If a required configuration is missing, the application **MUST throw an exception** and refuse to start.

---

## 9. Open Questions & Decisions

### 9.1 Critical Decisions Needed Before Implementation

**Decision 1: Storage Provider for Initial Production Deployment**

Options:
- **A**: SQL Server (if existing infrastructure)
- **B**: SQLite (simplest, single-server deployments)
- **C**: Azure Blob (cloud-native, but limited query capabilities)
- **D**: Hybrid (SQL + Blob, most complex)

**Recommendation**: Start with **SQLite for v1** (simplest), plan migration to **SQL Server for v2** (scalability), consider **Hybrid for v3** (cost optimization).

**Decision 2: Checkpoint Storage Strategy**

Options:
- **A**: Store all checkpoints inline in Thread table (simple, but bloats table)
- **B**: Separate Checkpoint table with parent pointer (normalized, efficient traversal)
- **C**: Store checkpoints as separate blobs (Azure-only, cheap storage)

**Recommendation**: **Option B** (separate Checkpoint table) for SQL providers, **Option C** for Azure Blob, **Hybrid** (metadata in SQL, content in blob) for best of both.

**Decision 3: Metadata Search Strategy**

For queries like "find all threads for user X":

Options:
- **A**: Extract metadata fields to dedicated columns (fast, but rigid schema)
- **B**: Use JSON query functions (flexible, slower)
- **C**: Hybrid approach (extract commonly-queried fields, keep full JSON)

**Recommendation**: **Option C** (hybrid) for SQL providers, **Option A** (dedicated columns) for best performance.

**Decision 4: Document Storage**

Options:
- **A**: Part of Store API (simple, unified)
- **B**: Separate Document entity (more features, more complex)
- **C**: External service (e.g., Azure Blob + Azure Search)

**Recommendation**: **Option A** (part of Store API) for MVP, **Option C** (external service) if document processing becomes a major feature.

### 9.2 Uncertainties and Gaps

**Uncertainty 1: Checkpoint History Retention**

- **Question**: How many checkpoints should be retained per thread?
- **Options**:
  - All checkpoints (unlimited history, expensive)
  - Last N checkpoints (e.g., 100, bounded storage)
  - Time-based (e.g., last 30 days, automatic cleanup)
- **Impact**: Affects storage costs and history traversal features
- **Recommendation**: Configurable per assistant, default to last 100 or 30 days

**Uncertainty 2: Concurrent Thread Access**

- **Question**: Can multiple runs execute concurrently on the same thread?
- **Impact**: If yes, need row-level locking or optimistic concurrency
- **Current assumption**: `multitask_strategy` enum suggests some concurrency is allowed
- **Recommendation**: Implement optimistic concurrency (version field) in Thread entity

**Uncertainty 3: Scale Requirements**

- **Question**: What is the expected scale?
  - Number of threads: 1K, 100K, 10M?
  - Number of runs per day: 100, 10K, 1M?
  - Concurrent users: 10, 100, 1000?
- **Impact**: Determines storage provider choice and indexing strategy
- **Recommendation**: Design for 100K threads, 10K runs/day, 100 concurrent users (can scale up)

**Uncertainty 4: Cross-Thread Search**

- **Question**: Are queries needed across all threads (e.g., "find all threads with status=error")?
- **Impact**: If yes, blob storage alone is insufficient (need SQL for metadata)
- **Current assumption**: Yes, search endpoints exist in API
- **Recommendation**: Use SQL for metadata queries, blob for content (if using blob at all)

### 9.3 Areas Requiring Further Research

**Area 1: Vector Embeddings Storage**

- **Question**: If LangGraph agents use vector search (RAG), where are embeddings stored?
- **Options**: Pinecone, Weaviate, pgvector, Azure Cognitive Search
- **Gap**: This document doesn't cover vector database integration
- **Recommendation**: Research vector database options if RAG is a core feature

**Area 2: Real-Time Streaming Storage**

- **Question**: How are SSE stream events persisted (if at all)?
- **Current implementation**: In-memory stream manager, no persistence
- **Impact**: If server restarts during streaming, client loses connection
- **Recommendation**: Consider Redis for stream session persistence (out of scope for this document)

**Area 3: Multi-Tenancy**

- **Question**: Is multi-tenancy required (multiple customers sharing the system)?
- **Impact**: Affects data isolation strategy (separate databases, row-level security, separate storage accounts)
- **Gap**: This document assumes single-tenant or trusted multi-tenant
- **Recommendation**: Add tenant_id to all entities if multi-tenancy is required

---

## 10. Recommended Implementation Order

### Phase 1: Foundation (Weeks 1-2)

**Goals**: Establish storage abstraction layer, implement SQLite provider

**Tasks**:
1. Define storage provider interfaces (`IStorageProvider`, entity-specific interfaces)
2. Implement SQLite provider (`SqliteStorageProvider`)
3. Create schema migration system
4. Implement `PersistentRepository<T>` adapter
5. Write unit tests for SQLite provider
6. Update configuration system to load YAML + environment variables

**Deliverables**:
- `src/storage/interfaces/` (all interface definitions)
- `src/storage/providers/sqlite/` (complete SQLite implementation)
- `src/storage/migrations/` (migration system)
- `src/config/storage-config.loader.ts` (YAML loader with env substitution)

**Success Criteria**:
- All existing tests pass with SQLite backend
- Data persists across server restarts
- Can switch between in-memory and SQLite via config

### Phase 2: SQL Server Provider (Weeks 3-4)

**Goals**: Implement SQL Server provider for enterprise deployments

**Tasks**:
1. Implement SQL Server provider (`SqlServerStorageProvider`)
2. Adapt schema for SQL Server types (UNIQUEIDENTIFIER, DATETIMEOFFSET, JSON handling)
3. Implement connection pooling
4. Implement transaction support
5. Write integration tests with real SQL Server (Docker container)
6. Document SQL Server deployment process

**Deliverables**:
- `src/storage/providers/sqlserver/` (complete implementation)
- `docs/deployment-sqlserver.md` (deployment guide)

**Success Criteria**:
- All tests pass with SQL Server backend
- Connection pooling works correctly
- Transactions rollback on error
- Performance benchmarks meet targets (>1000 ops/sec)

### Phase 3: Azure Blob Provider (Weeks 5-6)

**Goals**: Implement Azure Blob provider for cloud deployments

**Tasks**:
1. Implement Azure Blob provider (`AzureBlobStorageProvider`)
2. Implement blob naming strategies (state + history pattern)
3. Implement blob index tag search
4. Implement DefaultAzureCredential authentication
5. Write integration tests with Azure Storage Emulator or real account
6. Document Azure deployment process

**Deliverables**:
- `src/storage/providers/azureblob/` (complete implementation)
- `docs/deployment-azureblob.md` (deployment guide)

**Success Criteria**:
- All tests pass with Azure Blob backend
- Managed Identity authentication works
- Blob index tag search works
- Handles eventual consistency gracefully

### Phase 4: Migration Tooling (Week 7)

**Goals**: Enable migration between storage providers

**Tasks**:
1. Implement export utility (any provider → JSON)
2. Implement import utility (JSON → any provider)
3. Implement dual-write repository for zero-downtime migration
4. Implement backfill service
5. Write migration guide with step-by-step procedures

**Deliverables**:
- `src/storage/migration/` (exporter, importer, backfill, dual-write)
- `docs/migration-guide.md`

**Success Criteria**:
- Can export from SQLite, import to SQL Server
- Dual-write mode works without data loss
- Backfill completes successfully for large datasets (100K+ items)

### Phase 5: Hybrid Provider (Week 8)

**Goals**: Implement hybrid SQL + Blob provider for cost optimization

**Tasks**:
1. Implement hybrid provider router
2. Implement size-based routing (small = SQL, large = blob)
3. Implement entity-type routing (metadata = SQL, content = blob)
4. Write tests for hybrid scenarios
5. Document when to use hybrid approach

**Deliverables**:
- `src/storage/providers/hybrid/` (complete implementation)
- `docs/hybrid-storage-guide.md`

**Success Criteria**:
- Can query metadata from SQL, retrieve content from blob
- Routing logic works correctly
- Performance is better than pure SQL for large data

### Phase 6: Production Hardening (Weeks 9-10)

**Goals**: Prepare for production deployment

**Tasks**:
1. Implement monitoring and metrics (Prometheus, StatsD)
2. Implement query logging and slow query detection
3. Implement connection retry logic with exponential backoff
4. Implement circuit breaker pattern for storage failures
5. Add health check endpoints for each provider
6. Performance testing and optimization
7. Security audit (credential handling, SQL injection prevention)
8. Write operational runbook

**Deliverables**:
- `src/storage/monitoring/` (metrics, logging, health checks)
- `src/storage/resilience/` (retry, circuit breaker)
- `docs/operations/storage-runbook.md`

**Success Criteria**:
- System handles storage failures gracefully
- Metrics are exported to monitoring system
- Performance meets SLAs (p95 latency < 100ms for SQLite, < 200ms for SQL Server)
- Security review passes

### Phase 7: Documentation and Training (Week 11)

**Goals**: Complete documentation for developers and operators

**Tasks**:
1. Write storage architecture documentation (high-level overview)
2. Write developer guide (how to add new providers, extend interfaces)
3. Write operator guide (configuration, troubleshooting, scaling)
4. Create training materials and demos
5. Update project README with storage configuration instructions

**Deliverables**:
- `docs/architecture/storage-architecture.md`
- `docs/development/storage-development-guide.md`
- `docs/operations/storage-operations-guide.md`

### Optional: Phase 8: Advanced Features (Future)

Not part of initial implementation, but potential future enhancements:

1. **Read replicas**: Route read queries to read-only replicas for scaling
2. **Sharding**: Partition data across multiple databases by thread_id hash
3. **Multi-region**: Deploy storage in multiple regions with async replication
4. **Time-series optimization**: Optimize checkpoint storage for time-series queries
5. **Full-text search**: Integrate with Elasticsearch or Azure Search for advanced search
6. **Vector database integration**: Add support for pgvector or Pinecone for RAG

---

## 11. Assumptions & Scope

### 11.1 Assumptions Made

| Assumption | Confidence | Impact if Wrong |
|------------|------------|-----------------|
| Single-server deployment is primary use case for v1 | HIGH | If multi-server required, need SQL Server or hybrid from start |
| Thread IDs are UUIDs in standard format | HIGH | If different format, blob naming strategy must change |
| JSON fields in SQL are acceptable (don't need full normalization) | MEDIUM | If complex queries needed, may require normalized schema |
| Checkpoints are immutable (never updated, only created) | HIGH | If checkpoints can be updated, need different concurrency strategy |
| Cross-thread search is required | HIGH | If not required, pure blob storage is viable |
| Conversation histories are moderate size (< 1 MB per thread) | MEDIUM | If larger, must use blob storage for content |
| Data retention is configurable per deployment | LOW | If fixed retention required, design may need adjustment |
| Custom agents follow stateful pattern (threads + checkpoints) | HIGH | If stateless agents only, can simplify storage |
| LangGraph Platform's PostgreSQL checkpointer is reference implementation | MEDIUM | If different approach is better, research further |

### 11.2 Explicit Scope Boundaries

**In Scope**:
- ✅ Storage abstraction layer design
- ✅ SQLite, SQL Server, Azure Blob provider specifications
- ✅ Data model design for all entities
- ✅ Configuration system design (YAML + environment variables)
- ✅ Migration strategy between providers
- ✅ Checkpoint history traversal patterns
- ✅ Blob naming conventions for Azure Blob
- ✅ Connection pooling and performance considerations
- ✅ Credential management best practices

**Out of Scope** (Future Work):
- ❌ Vector database integration (Pinecone, pgvector)
- ❌ Full-text search implementation (Elasticsearch, Azure Search)
- ❌ Document processing pipeline (PDF parsing, chunking, embedding generation)
- ❌ Real-time streaming storage (Redis, Kafka)
- ❌ Multi-region replication
- ❌ Sharding and horizontal scaling strategies
- ❌ Read replica configuration
- ❌ Backup and disaster recovery procedures (separate ops guide)
- ❌ Performance benchmarking results (to be done during implementation)

### 11.3 Clarifying Questions for Follow-Up

1. **Scale Requirements**: What are the expected scale targets?
   - Number of active threads at any time?
   - Number of messages/checkpoints per thread?
   - Expected query patterns (read-heavy vs write-heavy)?
   - Concurrent user count?

2. **Data Retention**: What are the retention requirements?
   - Keep all data indefinitely?
   - Delete after N days/months?
   - Archive to cold storage after N days?

3. **Deployment Environment**: Where will this be deployed?
   - Single server (on-premise, VM, container)?
   - Multi-server (load balanced)?
   - Cloud (Azure, AWS, GCP)?
   - Hybrid (on-premise + cloud)?

4. **Compliance Requirements**: Any regulatory requirements?
   - GDPR (right to be forgotten, data portability)?
   - HIPAA (healthcare data)?
   - SOC 2 (audit logging, encryption)?

5. **Budget Constraints**: What is the budget for storage?
   - OK to use SQL Server licenses?
   - Prefer free/open-source solutions (SQLite, PostgreSQL)?
   - Budget for cloud storage (Azure Blob, S3)?

6. **Agent Integration**: How will custom agents integrate?
   - HTTP endpoints only?
   - Other protocols (gRPC, WebSocket)?
   - Are agents long-running or short-lived?

7. **Multi-Tenancy**: Is multi-tenancy required?
   - Single customer deployment?
   - Multiple customers sharing infrastructure?
   - Isolation requirements (separate databases, row-level security)?

---

## 12. References

### Official Documentation

- [Azure Blob Storage TypeScript Quickstart](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-quickstart-blobs-nodejs-typescript) - Microsoft Learn, 2026
- [Azure Blob Naming and Referencing Conventions](https://learn.microsoft.com/en-us/rest/api/storageservices/naming-and-referencing-containers--blobs--and-metadata) - Microsoft REST API Reference
- [Blob Index Tags for TypeScript](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blob-tags-javascript) - Microsoft Learn, 2026
- [Azure Storage Performance Checklist](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-performance-checklist) - Microsoft Learn, 2026
- [SQL Server JSON Data Type](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type?view=sql-server-ver17) - Microsoft SQL Server Documentation, 2026
- [better-sqlite3 GitHub Repository](https://github.com/WiseLibs/better-sqlite3) - Official repository and API documentation
- [mssql npm package](https://www.npmjs.com/package/mssql) - Official Node.js SQL Server driver
- [LangGraph Checkpoint PostgreSQL](https://pypi.org/project/langgraph-checkpoint-postgres/) - LangGraph official PostgreSQL checkpointer
- [LangGraph Memory Documentation](https://docs.langchain.com/oss/python/langgraph/add-memory) - LangChain Docs, 2026

### Technical Articles and Guides

- [How to Use SQLite in Node.js Applications](https://oneuptime.com/blog/post/2026-02-02-sqlite-nodejs/view) - OneUpTime Blog, February 2026
- [The Repository Pattern with TypeScript](https://www.abdou.dev/blog/the-repository-pattern-with-typescript) - Abdou's Blog
- [Generic Repository with Typescript and Node.js](https://medium.com/@erickwendel/generic-repository-with-typescript-and-node-js-731c10a1b98e) - Erick Wendel, Medium
- [TypeScript Factory Pattern with Parameters: Complete Guide for 2026](https://copyprogramming.com/howto/typescript-factory-pattern-with-parameters) - CopyProgramming
- [How to Create Dependency Injection Container in TypeScript](https://oneuptime.com/blog/post/2026-01-30-typescript-dependency-injection-container/view) - OneUpTime Blog, January 2026
- [Zero-Downtime Database Migrations: Blue-Green Deployment Guide](https://drcodes.com/posts/zero-downtime-database-migrations-blue-green-deployment-guide) - DrCodes
- [How to Build a Database Migration System in Node.js](https://oneuptime.com/blog/post/2026-01-22-nodejs-database-migration-system/view) - OneUpTime Blog, January 2026
- [Mastering LangGraph Checkpointing: Best Practices for 2025](https://sparkco.ai/blog/mastering-langgraph-checkpointing-best-practices-for-2025) - Sparkco AI Blog
- [Using PostgreSQL with LangGraph for State Management](https://ai.plainenglish.io/using-postgresql-with-langgraph-for-state-management-and-vector-storage-df4ca9d9b89e) - AI in Plain English, Medium
- [Node.js Configuration Made Simple: Wrangling Environment Variables](https://conradmugabe.medium.com/node-js-configuration-made-simple-wrangling-environment-variables-040afc9f7d41) - Conrad Mugabe, Medium, October 2024

### Authentication and Security

- [How to Configure Azure DevOps Personal Access Tokens](https://oneuptime.com/blog/post/2026-02-16-how-to-configure-azure-devops-personal-access-tokens-and-manage-token-lifecycle-security/view) - OneUpTime Blog, February 2026
- [PAT Token Management and Rotation Strategies](https://www.grizzlypeaksoftware.com/library/pat-token-management-and-rotation-strategies-xjlybwrx) - Grizzly Peak Software
- [Azure SAS Token Expiration Alert (GitHub)](https://github.com/peterbax117/azure-sas-token-expiration-alert) - Sample implementation

### Repository Pattern and Storage Abstractions

- [ASP.NET Core – Azure Blob Storage – Repository Pattern](https://www.intertech.com/asp-net-core-azure-blob-storage-repository-pattern/) - Intertech
- [GitHub - MStorage: Bridges multiple storage backends](https://github.com/bloomtom/MStorage) - Multi-backend storage abstraction example
- [Connecting TypeScript to SQL Server: A Comprehensive Guide](https://www.xjavascript.com/blog/typescript-connect-to-sql-server/) - xjavascript.com

### Performance and Optimization

- [SQLite Optimizations For Ultra High-Performance](https://www.powersync.com/blog/sqlite-optimizations-for-ultra-high-performance) - PowerSync Blog
- [Understanding Better-SQLite3: The Fastest SQLite Library for Node.js](https://dev.to/lovestaco/understanding-better-sqlite3-the-fastest-sqlite-library-for-nodejs-4n8) - DEV Community
- [SQL Server JSON: Performance Cookbook](https://www.codeproject.com/Articles/5308904/SQL-Server-JSON-Performance-Cookbook) - CodeProject
- [JSON Gets a Performance Boost: Exploring the New JSON Index in SQL Server 2025](https://medium.com/@tejaswini.nareshit/json-gets-a-performance-boost-exploring-the-new-json-index-in-sql-server-2025-bddb53589912) - Medium

### Azure Storage Best Practices

- [Azure Blob Storage Architecture Best Practices](https://learn.microsoft.com/en-us/azure/well-architected/service-guides/azure-blob-storage) - Microsoft Well-Architected Framework
- [Data Partitioning Strategies](https://learn.microsoft.com/en-us/azure/architecture/best-practices/data-partitioning-strategies) - Azure Architecture Center
- [Best Practices for Using Blob Access Tiers](https://learn.microsoft.com/en-us/azure/storage/blobs/access-tiers-best-practices) - Microsoft Learn
- [How to Implement Lease Management for Blob Concurrency Control](https://oneuptime.com/blog/post/2026-02-16-how-to-implement-lease-management-for-blob-concurrency-control-in-azure-storage/view) - OneUpTime Blog, February 2026

### AI Agent State Management

- [AI Agent Memory: Build Stateful AI Systems That Remember](https://redis.io/blog/ai-agent-memory-stateful-systems/) - Redis Blog
- [LangGraph & Redis: Build smarter AI agents with memory & persistence](https://redis.io/blog/langgraph-redis-build-smarter-ai-agents-with-memory-persistence/) - Redis Blog
- [Understanding Memory Management in LangGraph: A Practical Guide](https://pub.towardsai.net/understanding-memory-management-in-langgraph-a-practical-guide-for-genai-students-b3642c9ea7e1) - Towards AI
- [Short-term memory - LangChain Docs](https://docs.langchain.com/oss/python/langchain/short-term-memory) - LangChain Documentation

---

## Document Status

**Version**: 1.0
**Status**: Research Complete, Ready for Review
**Next Steps**:
1. Review with project stakeholders
2. Answer clarifying questions (Section 11.3)
3. Make critical decisions (Section 9.1)
4. Begin Phase 1 implementation (Section 10)

**Feedback Welcome On**:
- Storage provider choice for initial deployment
- Checkpoint retention strategy
- Metadata extraction strategy (dedicated columns vs JSON queries)
- Document storage approach (Store API vs separate entity)
- Multi-tenancy requirements (if any)

---

*End of Infrastructure Design: Storage and Retrieval Layer*
