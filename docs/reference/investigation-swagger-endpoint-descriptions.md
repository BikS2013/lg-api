# LangGraph Platform API Endpoint Descriptions Investigation

**Document Version:** 1.0
**Date:** 2026-03-10
**Purpose:** Comprehensive descriptions for all 50 lg-api endpoints based on official LangGraph Platform documentation

---

## Executive Summary

This document provides comprehensive, authoritative descriptions for all 50 endpoints implemented in the lg-api project, gathered from official LangGraph Platform and LangSmith Deployment documentation. These descriptions are structured for direct integration into Swagger/OpenAPI documentation.

The LangGraph Platform (formerly LangGraph Cloud, now part of LangSmith Deployment) provides an Agent Server API that enables stateful, multi-turn agent execution with persistent storage, scheduled tasks, and real-time streaming. The API is organized around five core resource types:

1. **Assistants** (11 endpoints) - Versioned graph configurations with specific prompts, models, and settings
2. **Threads** (12 endpoints) - Persistent conversation containers maintaining state across multiple runs
3. **Runs** (14 endpoints) - Individual graph executions, either stateful (bound to threads) or stateless
4. **Crons** (6 endpoints) - Scheduled recurring runs with cron-expression based scheduling
5. **Store** (5 endpoints) - Cross-thread key-value storage organized by namespaces
6. **System** (2 endpoints) - Health checks and server capability discovery

All descriptions below are sourced from official LangSmith Deployment documentation and align with the official LangGraph SDK behavior.

---

## Endpoint Descriptions

### Assistants (11 endpoints)

#### 1. POST /assistants - Create Assistant

**Summary:** Create a new assistant

**Description:**

Creates a new assistant with a specified graph configuration. An assistant is a versioned instance of a graph template bound to specific configuration settings such as model parameters, tools, prompts, and runtime context. Multiple assistants can reference the same graph_id but with different configurations, enabling reuse of graph logic across different use cases.

In the LangGraph Platform, assistants are the primary deployment artifact. When you deploy a graph to Agent Server, the system automatically creates a default assistant for each graph. Additional assistants can be created via this endpoint to support variations like different models, system prompts, or tool configurations.

This endpoint creates both the assistant entity and its initial version simultaneously. The `if_exists` parameter controls duplicate handling: `"raise"` returns an error if an assistant with the same ID exists, while `"do_nothing"` returns the existing assistant without modification.

Key parameters include:
- `graph_id` (required): References the graph blueprint defined in langgraph.json
- `assistant_id` (optional): UUID for the assistant; auto-generated if not provided
- `config`: Graph-specific configuration (model, prompt, tools)
- `metadata`: Arbitrary key-value pairs for filtering and organization
- `name` and `description`: Human-readable labels for UI display

After creation, the assistant is immediately available for run execution and can be updated via PATCH to create new versions.

---

#### 2. GET /assistants/:assistant_id - Get Assistant

**Summary:** Retrieve an assistant by ID

**Description:**

Retrieves the complete configuration and metadata for a specific assistant. This endpoint returns the assistant's current version, which includes all configuration settings, graph references, creation timestamps, and metadata.

In the LangGraph Platform, assistants are versioned entities. The GET operation always returns the assistant at its currently active version (the "latest" version pointer). To inspect historical versions, use the versions endpoint.

The response includes:
- `assistant_id`: Unique identifier
- `graph_id`: The graph blueprint this assistant uses
- `config`: The complete configuration object passed to graph execution
- `context`: Static context injected into every run
- `metadata`: User-defined key-value pairs
- `version`: Current version number
- `created_at` and `updated_at`: Timestamps
- `name` and `description`: Display labels

This endpoint is commonly used to:
- Verify assistant configuration before creating runs
- Retrieve metadata for display in client UIs
- Validate that an assistant exists before stateless run execution
- Inspect the active configuration version

Authentication via `X-Api-Key` header is required for all assistant operations.

---

#### 3. PATCH /assistants/:assistant_id - Update Assistant

**Summary:** Update an assistant

**Description:**

Updates an existing assistant by creating a new version with modified configuration. Unlike typical PATCH semantics that merge partial updates, this endpoint creates a complete new version from scratch. All fields you want to retain must be included in the request body, as prior version data is not merged.

In the LangGraph Platform, assistants are immutable once created. Updates always produce a new version, and the assistant's "latest" pointer is updated to reference the new version. This versioning model enables:
- Safe rollback to previous configurations
- Audit trails of configuration changes
- A/B testing between assistant versions
- Reproducible run execution tied to specific version snapshots

The operation is atomic: if the update succeeds, the new version becomes active immediately. Runs initiated after the update will use the new configuration.

Important behavioral notes:
- The request body is a full replacement, not a merge. Omitted fields will be set to their default values (e.g., null for optional fields).
- The `graph_id` can be changed, effectively reassigning the assistant to a different graph.
- Metadata updates are useful for tracking ownership, environment (dev/staging/prod), or feature flags.
- The `version` counter increments automatically; you cannot specify the version number.

Use this endpoint when:
- Tuning prompts, models, or tool configurations
- Migrating assistants between graphs
- Updating metadata for filtering or UI display

To view version history, use POST /assistants/:assistant_id/versions. To switch to a previous version, use POST /assistants/:assistant_id/latest.

---

#### 4. DELETE /assistants/:assistant_id - Delete Assistant

**Summary:** Delete an assistant

**Description:**

Permanently deletes an assistant and all its associated versions. This operation is irreversible and should be used with caution, particularly in production environments.

In the LangGraph Platform, deleting an assistant does not delete threads or runs that were executed with that assistant. Threads remain accessible and their state history is preserved, but future runs cannot be created with the deleted assistant_id.

Behavior and side effects:
- All version history for the assistant is deleted
- Active cron jobs referencing the assistant will fail on their next scheduled execution
- Attempting to create runs with the deleted assistant_id will return a 404 error
- Metadata searches will no longer return the deleted assistant

This endpoint is typically used for:
- Cleanup of development/test assistants
- Removing deprecated assistant configurations
- Enforcing organizational policies (e.g., removing assistants tied to revoked API keys)

Best practices:
- Before deletion, list and cancel any active cron jobs associated with the assistant (use POST /runs/crons/search with metadata filter)
- If the assistant is used in production, consider creating a replacement assistant and migrating client references before deletion
- Archive assistant metadata externally if audit trails are required

Authentication is required. The operation returns 204 No Content on success or 404 if the assistant does not exist.

---

#### 5. POST /assistants/search - Search Assistants

**Summary:** Search and filter assistants

**Description:**

Searches for assistants matching specified filters and returns a paginated list. This endpoint serves dual purposes: filtered search and full listing (when called with no filters).

In the LangGraph Platform, assistants are often organized by graph_id, environment metadata, or team ownership. The search endpoint provides flexible querying to support multi-tenant applications, environment-specific assistant selection, and UI assistant pickers.

Filter parameters:
- `metadata`: Exact match filter for each key-value pair (e.g., `{"env": "production"}`)
- `graph_id`: Filter assistants by their graph blueprint
- `name`: Case-insensitive substring match on assistant name (e.g., searching "sales" matches "Sales Agent", "sales-bot")

Pagination and sorting:
- `limit`: Maximum results per page (1-1000, default 10)
- `offset`: Skip N results (for pagination)
- `sort_by`: Field to sort by (assistant_id, created_at, updated_at, name, graph_id)
- `sort_order`: "asc" or "desc"

Field selection:
- `select`: Array of field names to return (e.g., `["assistant_id", "name", "config"]`). If omitted, all fields are returned. Useful for reducing payload size in UI scenarios.

Common use cases:
- **List all assistants**: Call with no filters
- **Environment filtering**: `{"metadata": {"env": "production"}}`
- **Graph-specific lookup**: `{"graph_id": "customer-support-agent"}`
- **UI autocomplete**: `{"name": "sales", "select": ["assistant_id", "name"]}`

The response is an array of assistant objects. Empty array if no matches. The endpoint does not return a total count; use POST /assistants/count for that.

Authentication via X-Api-Key is required.

---

#### 6. POST /assistants/count - Count Assistants

**Summary:** Count assistants matching filters

**Description:**

Returns the total count of assistants matching the specified filters. This endpoint accepts the same filter parameters as POST /assistants/search (metadata, graph_id, name) but returns only an integer count instead of the full assistant objects.

In the LangGraph Platform, the count endpoint is used for pagination UI (displaying "Page 1 of 5"), quota enforcement (checking if a workspace has hit assistant limits), and analytics (tracking assistant proliferation by graph or metadata tags).

Filter parameters (identical to search):
- `metadata`: Exact match filter
- `graph_id`: Filter by graph
- `name`: Case-insensitive substring match

Unlike search, the count endpoint does not support:
- Pagination parameters (limit/offset) - returns a single total
- Sorting parameters - count has no order
- Field selection - returns only a count

Behavioral notes:
- The count is computed at query time and reflects the current assistant set
- Deleted assistants are not counted
- If no filters are provided, returns the total count of all assistants in the deployment

Use cases:
- **Pagination calculation**: Call count with filters, then search with offset/limit
- **Quota checks**: Verify workspace is under assistant limits before creating new ones
- **Dashboard metrics**: Display assistant counts by graph_id or environment

The response is a simple JSON object with a count field: `{"count": 42}`.

Authentication required.

---

#### 7. GET /assistants/:assistant_id/graph - Get Assistant Graph

**Summary:** Get assistant graph structure

**Description:**

Returns a JSON representation of the assistant's graph structure, including nodes, edges, conditional branches, and entry/exit points. This endpoint provides introspection into the graph topology that the assistant executes.

In the LangGraph Platform, graphs are defined as state machines with nodes (functions/tools), edges (transitions), and conditional routing. The graph representation returned by this endpoint is the compiled, resolved structure after all configuration has been applied.

The response includes:
- **Nodes**: Array of node definitions (name, type, function reference)
- **Edges**: Array of transitions between nodes (from, to, condition)
- **Entry points**: The initial node(s) where execution begins
- **Conditional routing**: Branch logic for nodes with multiple outgoing edges
- **Subgraphs**: References to nested subgraphs (if any)

Use cases:
- **Visualization**: Client applications can render graph diagrams using this data (e.g., Studio UI)
- **Debugging**: Inspect graph structure to understand execution flow
- **Documentation generation**: Automatically generate graph documentation
- **Validation**: Verify that graph configuration matches expectations

Important notes:
- The graph structure is static metadata. It does not include runtime state or execution history (use threads for that).
- Graphs are resolved at deployment time. This endpoint returns the graph as deployed, not the source code definition.
- For graphs with dynamic node selection (runtime-conditional graphs), the response shows all possible nodes and edges, not just the active path.

The response format is LangGraph-specific JSON. For schemas of node inputs/outputs, use GET /assistants/:assistant_id/schemas instead.

Authentication required. Returns 404 if the assistant does not exist or the graph definition is unavailable.

---

#### 8. GET /assistants/:assistant_id/schemas - Get Assistant Schemas

**Summary:** Get input/output schemas for the assistant's graph

**Description:**

Returns the JSON schemas for the assistant's graph input, output, and state structures. These schemas define the expected format for run inputs, the structure of returned outputs, and the shape of thread state.

In the LangGraph Platform, graphs are strongly typed: each graph defines an input schema (the structure of messages or parameters passed to the graph), an output schema (the structure of the graph's final return value), and a state schema (the internal data structure maintained across nodes). This endpoint exposes those schemas for client validation and documentation.

The response typically includes:
- **input_schema**: JSON Schema describing the expected format for run input (e.g., `{"messages": [{"role": "string", "content": "string"}]}`)
- **output_schema**: JSON Schema for the graph's return value
- **state_schema**: JSON Schema for the graph's internal state (e.g., message arrays, intermediate computation results)

Use cases:
- **Client validation**: Validate user input against the schema before sending a run request
- **Code generation**: Generate TypeScript/Python types from schemas for SDK clients
- **Documentation**: Auto-generate API documentation with input/output examples
- **UI form generation**: Dynamically build input forms based on the schema (e.g., for no-code tools)

Behavioral notes:
- Schemas are derived from the graph's type annotations (e.g., Pydantic models in Python, TypeScript interfaces in JS)
- If the graph does not define explicit schemas, the endpoint may return generic schemas or empty objects
- Schemas are static metadata tied to the assistant's current version. Updating the assistant may change schemas.

The response is a JSON object with schema definitions using JSON Schema format (Draft 7 or later).

Authentication required.

---

#### 9. GET /assistants/:assistant_id/subgraphs - Get Assistant Subgraphs

**Summary:** Get nested subgraphs of the assistant's graph

**Description:**

Returns metadata about nested subgraphs (child graphs) embedded within the assistant's main graph. Subgraphs are reusable graph components that can be invoked as nodes within a parent graph, enabling modular agent design.

In the LangGraph Platform, complex agents are often composed of multiple subgraphs. For example, a customer support agent might have subgraphs for "intent classification", "knowledge retrieval", and "response generation". Each subgraph is a full LangGraph graph with its own nodes, edges, and state.

The response includes an array of subgraph metadata:
- **subgraph_id**: Unique identifier for the subgraph
- **name**: Human-readable label
- **parent_node**: The node in the parent graph that invokes this subgraph
- **input_schema** and **output_schema**: Schemas for subgraph I/O
- **nested_subgraphs**: Recursive list if the subgraph itself contains subgraphs

Use cases:
- **Visualization**: Render hierarchical graph diagrams showing parent-child relationships
- **Debugging**: Trace execution into subgraphs during multi-step runs
- **Modular design**: Understand the composition of complex agents
- **Documentation**: Auto-generate documentation for subgraph-based agents

Behavioral notes:
- If the graph has no subgraphs, the response is an empty array
- Subgraphs are fully isolated: each has its own state and checkpoint history
- Execution inside a subgraph is tracked separately in run events (use stream mode "debug" to see subgraph entry/exit)

The response format is LangGraph-specific JSON with nested structures.

Authentication required.

---

#### 10. POST /assistants/:assistant_id/versions - List Assistant Versions

**Summary:** List version history of an assistant

**Description:**

Returns the complete version history for an assistant, showing all past configurations and when each version was created. This endpoint enables audit trails, rollback workflows, and A/B testing between assistant versions.

In the LangGraph Platform, assistants are immutable and versioned. Every PATCH operation creates a new version with an auto-incremented version number. The "latest" pointer determines which version is used for new runs.

The response is an array of version objects, each containing:
- `version`: Integer version number (1, 2, 3, ...)
- `assistant_id`: The assistant this version belongs to
- `config`: The full configuration for this version
- `metadata`: Metadata as of this version
- `created_at`: Timestamp when the version was created
- `is_latest`: Boolean indicating if this is the active version

Pagination:
- `limit`: Maximum versions to return (default 10)
- `offset`: Skip N versions (for pagination)
- Versions are returned in descending order (newest first)

Use cases:
- **Audit trails**: Review who changed what and when
- **Rollback**: Identify a stable version and use POST /assistants/:assistant_id/latest to switch back
- **A/B testing**: Compare configuration differences between versions
- **Debugging**: Determine if a run failure correlates with a recent assistant update

Behavioral notes:
- Version numbers are immutable and assigned sequentially starting at 1
- Deleting an assistant deletes all its versions
- Versions are not soft-deleted; once deleted via DELETE /assistants/:assistant_id, they cannot be recovered

The response format is an array of version objects.

Authentication required.

---

#### 11. POST /assistants/:assistant_id/latest - Set Latest Version

**Summary:** Set a specific version as the latest

**Description:**

Updates the assistant's "latest" pointer to reference a specific version. This enables rollback to previous configurations without deleting or recreating assistants.

In the LangGraph Platform, the "latest" version determines which configuration is used when creating new runs. By default, the latest version is the most recently created version (via POST or PATCH). This endpoint allows you to override that and designate any historical version as "latest".

Request body:
- `version`: Integer version number to set as latest (required)

Behavior:
- The operation is idempotent: setting the latest version to the current latest version succeeds without side effects
- All future runs will use the newly designated latest version
- Active runs (in-progress) are not affected; they continue using the version they started with
- Cron jobs will use the new latest version on their next scheduled execution

Use cases:
- **Rollback**: Revert to a known-good configuration after detecting issues with a recent update
- **A/B testing**: Manually control which version is active for new runs
- **Staged rollouts**: Update to a new version in dev, test it, then promote to production by setting latest

Behavioral notes:
- Setting latest to a version that doesn't exist returns 404
- The assistant's `updated_at` timestamp is updated to reflect the latest change
- Version history is not modified; the old "latest" version remains in the version list

Response: Returns the updated assistant object with the new latest version pointer.

Authentication required.

---

### Threads (12 endpoints)

#### 1. POST /threads - Create Thread

**Summary:** Create a new conversation thread

**Description:**

Creates a new persistent conversation thread. A thread is a stateful container that maintains graph state across multiple run invocations, enabling multi-turn conversations and long-running workflows.

In the LangGraph Platform, threads are the foundation of stateful execution. Each thread has a unique ID and stores:
- **State history**: All checkpoints (state snapshots) from past runs
- **Metadata**: User-defined key-value pairs for filtering and organization (e.g., user_id, session_id)
- **Status**: Current execution status (idle, busy, interrupted, error)
- **Values**: The current state data (e.g., message history, intermediate computations)

Threads can be created in three ways:

1. **Empty thread** (most common): Create a thread with no initial state. The first run will initialize the state.
   ```json
   {}
   ```

2. **Thread with metadata**: Useful for multi-tenant applications or filtering.
   ```json
   {"metadata": {"user_id": "user-123", "env": "production"}}
   ```

3. **Thread with prepopulated state** (advanced): Create a thread with existing state by providing `supersteps` (checkpoint history). This is used for:
   - Migrating conversations from another system
   - Resuming conversations from a previous session
   - Setting up test scenarios with specific initial states

Use cases:
- **Chat applications**: One thread per user conversation
- **Multi-step workflows**: Maintain state across async operations (e.g., approval workflows)
- **Background processing**: Track progress of long-running tasks
- **Testing**: Create threads with specific initial states for reproducible tests

Behavioral notes:
- Thread IDs are UUIDs generated server-side if not provided
- Threads persist indefinitely unless explicitly deleted or pruned via TTL configuration
- Empty threads consume minimal storage until the first run
- Threads are independent: state in one thread does not affect others

Response: Returns the created thread object with `thread_id`, `created_at`, `updated_at`, `metadata`, `status`, and `values`.

Authentication required.

---

#### 2. GET /threads/:thread_id - Get Thread

**Summary:** Retrieve a thread by ID

**Description:**

Retrieves the metadata and current status for a specific thread. This endpoint returns thread-level information but not the full state or history (use GET /threads/:thread_id/state for that).

In the LangGraph Platform, the GET thread operation is a lightweight way to check thread existence, retrieve metadata, or verify thread status before creating a run.

The response includes:
- `thread_id`: Unique identifier
- `created_at`: Thread creation timestamp
- `updated_at`: Last modification timestamp (updated after each run)
- `metadata`: User-defined key-value pairs
- `status`: One of "idle", "busy", "interrupted", "error"
  - **idle**: No active run, ready for new runs
  - **busy**: A run is currently executing on this thread
  - **interrupted**: A run was paused waiting for human input
  - **error**: The last run failed with an unhandled error
- `config`: The configurable parameters passed to the last run
- `values`: A summary of current state (may be omitted in some implementations)

Use cases:
- **Pre-run validation**: Check if a thread exists and is idle before creating a run
- **UI display**: Show thread metadata in conversation lists
- **Status polling**: Monitor thread status (though streaming is preferred for real-time updates)

Behavioral notes:
- The status field reflects the most recent run's outcome
- Status transitions: idle → busy (run starts) → idle/interrupted/error (run ends)
- The updated_at timestamp changes on every run, even if state didn't change
- Threads do not automatically transition out of "error" status; a new successful run is required

Response: JSON thread object.

Authentication required. Returns 404 if thread does not exist.

---

#### 3. PATCH /threads/:thread_id - Update Thread

**Summary:** Update thread metadata

**Description:**

Updates the metadata for an existing thread. This endpoint modifies only the metadata field; it does not modify thread state (use POST /threads/:thread_id/state for state updates).

In the LangGraph Platform, thread metadata is used for organization, filtering, and application-specific tagging. Common metadata use cases include user IDs, session IDs, environment tags, feature flags, and conversation topics.

Request body:
- `metadata`: Object with key-value pairs to merge into existing metadata

Behavior:
- The operation performs a **merge**: new keys are added, existing keys are updated, and absent keys are left unchanged
- To remove a metadata key, explicitly set it to null
- Metadata updates do not create new checkpoints or affect thread state
- The thread's `updated_at` timestamp is updated

Use cases:
- **Tagging**: Add labels like `{"resolved": true}` when a conversation ends
- **User attribution**: Associate threads with user IDs after authentication
- **Feature flags**: Enable/disable features per thread (e.g., `{"beta_features": true}`)
- **Analytics**: Tag threads for cohort analysis (e.g., `{"experiment_group": "A"}`)

Example:
```json
PATCH /threads/abc-123
{"metadata": {"user_id": "user-456", "topic": "billing"}}
```

If the thread already had `{"env": "prod"}`, the result is:
```json
{"env": "prod", "user_id": "user-456", "topic": "billing"}
```

Behavioral notes:
- Metadata updates are synchronous and immediate
- Search and filter operations (POST /threads/search) use metadata fields
- Metadata is included in all thread API responses

Response: Returns the updated thread object.

Authentication required. Returns 404 if thread does not exist.

---

#### 4. DELETE /threads/:thread_id - Delete Thread

**Summary:** Permanently delete a thread

**Description:**

Deletes a thread and all its associated state history, checkpoints, and metadata. This operation is irreversible and should be used with caution.

In the LangGraph Platform, deleting a thread removes:
- All checkpoints (state snapshots)
- All metadata
- Thread configuration
- The thread record itself

Behavior and side effects:
- **Runs are preserved**: Run records may be retained for audit purposes (implementation-dependent), but the thread state they reference is deleted
- **Active runs are not cancelled**: If a run is currently executing on the thread, it continues but cannot write new checkpoints after deletion
- **Cron jobs will fail**: Scheduled cron jobs targeting the deleted thread will fail on next execution

Use cases:
- **Privacy compliance**: Delete user data on account deletion (GDPR, CCPA)
- **Storage cleanup**: Remove inactive threads to reduce storage costs
- **Test cleanup**: Delete threads after integration tests
- **Session expiry**: Remove threads for expired sessions

Best practices:
- Before deletion, export important conversation data if needed (use GET /threads/:thread_id/state or /history)
- Check for active runs (GET /threads/:thread_id) and consider cancelling them first
- If using cron jobs, delete or update them before thread deletion

Response: 204 No Content on success, 404 if thread does not exist.

Authentication required.

---

#### 5. POST /threads/search - Search Threads

**Summary:** Search and filter threads

**Description:**

Searches for threads matching specified filters and returns a paginated list. This endpoint supports metadata filtering, status filtering, and pagination for multi-tenant applications and conversation management UIs.

In the LangGraph Platform, applications often manage thousands of threads across multiple users, sessions, or environments. The search endpoint provides flexible querying to power conversation lists, admin dashboards, and analytics.

Filter parameters:
- `metadata`: Exact match filter for each key-value pair (e.g., `{"user_id": "user-123"}`)
- `status`: Filter by thread status ("idle", "busy", "interrupted", "error")
- `graph_id`: Filter threads by the graph they were created for (if metadata includes graph_id)

Pagination and sorting:
- `limit`: Maximum results per page (1-1000, default 10)
- `offset`: Skip N results (for cursor-based pagination)
- `sort_by`: Field to sort by (thread_id, status, created_at, updated_at)
- `sort_order`: "asc" or "desc"

Field selection:
- `select`: Array of field names to return (e.g., `["thread_id", "status", "metadata"]`). Omit for all fields.

Common use cases:
- **User conversation history**: `{"metadata": {"user_id": "user-123"}, "sort_by": "updated_at", "sort_order": "desc"}`
- **Active threads**: `{"status": "busy"}`
- **Error monitoring**: `{"status": "error", "limit": 100}`
- **Pagination**: First page: `{"limit": 20, "offset": 0}`, second page: `{"limit": 20, "offset": 20}`

Behavioral notes:
- Empty filters return all threads (subject to limit)
- The search is eventually consistent in distributed deployments (typically <1s lag)
- Large result sets should use pagination to avoid timeouts

Response: Array of thread objects matching filters.

Authentication required.

---

#### 6. POST /threads/count - Count Threads

**Summary:** Count threads matching filters

**Description:**

Returns the total count of threads matching specified filters. This endpoint accepts the same filter parameters as POST /threads/search but returns only an integer count.

In the LangGraph Platform, the count endpoint is used for pagination UI (showing "Page 1 of 10"), quota enforcement (checking if a user has hit thread limits), and dashboard metrics (displaying active conversation counts).

Filter parameters (identical to search):
- `metadata`: Exact match filter
- `status`: Filter by thread status
- `graph_id`: Filter by graph

Unlike search, count does not support:
- Pagination (limit/offset) - returns a single total
- Sorting - count has no order
- Field selection - returns only a count

Use cases:
- **Pagination calculation**: Get count, then calculate page offsets for search
- **User quotas**: Check if user is under thread limit before creating new threads
- **Dashboard stats**: Display counts by status or user
- **Monitoring**: Alert if error thread count exceeds threshold

Example:
```json
POST /threads/count
{"status": "error"}
```
Response: `{"count": 5}`

Behavioral notes:
- Count is computed at query time
- Deleted threads are excluded
- Count is eventually consistent in distributed systems

Response: JSON object with integer count field.

Authentication required.

---

#### 7. POST /threads/:thread_id/copy - Copy Thread

**Summary:** Clone a thread with its state history

**Description:**

Creates a new thread that is an exact copy of an existing thread, including all state history and checkpoints up to the point of copy. The new thread is fully independent and can diverge from the original.

In the LangGraph Platform, copying threads is useful for:
- **Branching conversations**: Explore "what if" scenarios without affecting the original conversation
- **A/B testing**: Create variants of a conversation to test different agent responses
- **Templates**: Create a "seed" thread with initial state, then copy it for new users
- **Debugging**: Copy a production thread to a test environment for investigation

Request body (optional):
- `metadata`: Metadata for the new thread (replaces original metadata)

Behavior:
- All checkpoints from the original thread are copied to the new thread
- The new thread starts with status "idle" (even if the original is busy)
- The new thread gets a new UUID thread_id
- State values are deep-copied (modifications to the copy don't affect the original)
- The copy operation is atomic: either all checkpoints are copied or none

Use cases:
- **Conversation branching**: User asks "What if I chose option B?" → copy thread, then run with alternate input
- **Test data generation**: Copy production threads (with PII removed) to test environments
- **Snapshot for analysis**: Copy thread before making destructive state changes

Behavioral notes:
- Large threads (many checkpoints) may take longer to copy
- Copy operation does not trigger graph execution
- The copied thread's `created_at` timestamp is the copy time, not the original thread's creation time

Response: Returns the newly created thread object with its new thread_id.

Authentication required. Returns 404 if source thread does not exist.

---

#### 8. POST /threads/prune - Prune Threads

**Summary:** Delete old or inactive threads in bulk

**Description:**

Bulk deletes threads matching specified criteria. This endpoint is designed for storage management and cleanup of inactive conversations.

In the LangGraph Platform, threads persist indefinitely by default. Over time, this can lead to storage bloat from abandoned conversations, test threads, or expired sessions. The prune endpoint enables automated cleanup policies.

Filter parameters:
- `metadata`: Exact match filter for threads to delete
- `status`: Delete threads with a specific status
- `created_before`: ISO 8601 timestamp - delete threads created before this time
- `updated_before`: ISO 8601 timestamp - delete threads not updated since this time

Safety parameters:
- `limit`: Maximum number of threads to delete in one operation (prevents accidental mass deletion)
- `dry_run`: If true, returns the count of threads that would be deleted without actually deleting them

Use cases:
- **Retention policy**: Delete threads older than 90 days
  ```json
  {"created_before": "2024-01-01T00:00:00Z", "limit": 1000}
  ```
- **Test cleanup**: Remove test threads after CI runs
  ```json
  {"metadata": {"env": "test"}, "limit": 500}
  ```
- **Error cleanup**: Delete threads in error state after manual review
  ```json
  {"status": "error", "updated_before": "2024-06-01T00:00:00Z"}
  ```

Behavioral notes:
- Deletion is irreversible; use dry_run first to preview impact
- The operation is batched: large prune requests may be split into multiple transactions
- Active runs are not cancelled; threads with busy status should be filtered out or handled carefully
- Response includes count of deleted threads

Response: JSON object with deleted count: `{"deleted": 42}`

Authentication required. Use with caution in production.

---

#### 9. GET /threads/:thread_id/state - Get Thread State

**Summary:** Get the current state of a thread

**Description:**

Retrieves the current state values and checkpoint metadata for a thread. This endpoint returns the thread's state at its most recent checkpoint, including all accumulated data from past runs.

In the LangGraph Platform, thread state is the core of stateful execution. State includes:
- **values**: The graph's state object (e.g., message arrays, tool outputs, intermediate results)
- **next**: Array of node names scheduled to execute next (empty if thread is idle)
- **checkpoint**: Metadata about the current checkpoint (ID, timestamp, namespace)
- **metadata**: Checkpoint-specific metadata (e.g., source node, step number, parent checkpoint)
- **created_at**: Timestamp when this checkpoint was created

Optional parameters:
- `checkpoint_id`: Retrieve state at a specific historical checkpoint instead of the latest

Use cases:
- **Display conversation history**: Extract messages from state.values.messages
- **Resume execution**: Read state before creating a new run
- **Debugging**: Inspect state to understand why a graph took a specific path
- **Time-travel**: View historical state by passing a checkpoint_id

Behavioral notes:
- The state structure is graph-specific; each graph defines its own state schema
- State is read-only via GET; use POST /threads/:thread_id/state to modify
- If the thread has never run, values may be empty or contain defaults
- Next is populated for interrupted threads (waiting for human input)

Response structure:
```json
{
  "values": {"messages": [...]},
  "next": [],
  "checkpoint": {"checkpoint_id": "...", "thread_id": "..."},
  "metadata": {"step": 5, "source": "call_model"},
  "created_at": "2024-01-15T10:30:00Z"
}
```

Authentication required. Returns 404 if thread does not exist.

---

#### 10. POST /threads/:thread_id/state - Update Thread State

**Summary:** Manually update thread state

**Description:**

Manually modifies the state of a thread by creating a new checkpoint with updated values. This endpoint enables direct state manipulation outside of normal graph execution, useful for corrections, admin overrides, and testing.

In the LangGraph Platform, thread state is normally updated only by graph execution. This endpoint provides an "escape hatch" to inject state changes programmatically.

Request body:
- `values`: Object containing state updates (merged with existing state)
- `as_node`: (Optional) The node name to attribute this update to (for checkpoint metadata)
- `checkpoint_id`: (Optional) The checkpoint to update from (for branching)

Behavior:
- The operation creates a new checkpoint with updated state
- Values are merged: specified keys are updated, unspecified keys are preserved
- The thread's status remains unchanged (use PATCH /threads/:thread_id to update status)
- Subsequent runs will see the updated state

Use cases:
- **Error correction**: Fix incorrect state after a buggy run
- **Admin overrides**: Manually add or remove messages
- **Testing**: Set up specific state conditions for test scenarios
- **Human-in-the-loop**: Inject human edits into conversation state

Example - Add a system message:
```json
POST /threads/abc-123/state
{
  "values": {
    "messages": [{"role": "system", "content": "You are a helpful assistant."}]
  },
  "as_node": "human_override"
}
```

Behavioral notes:
- State updates do not trigger graph execution
- Checkpoint metadata will show `source: "update"` and the specified `as_node`
- For complex state mutations, consider implementing a graph node instead
- State updates are atomic and versioned (can be reverted via checkpoint rollback)

Response: Returns the updated state object with new checkpoint_id.

Authentication required. Returns 404 if thread does not exist.

---

#### 11. POST /threads/:thread_id/history - Get Thread History

**Summary:** Get state history (checkpoints) of a thread

**Description:**

Retrieves the complete checkpoint history for a thread, showing every state snapshot from all past runs. This endpoint enables time-travel debugging, execution audits, and state replay.

In the LangGraph Platform, checkpoints are created at configurable intervals during graph execution (controlled by durability mode). Each checkpoint captures:
- The full state at that point in execution
- Metadata: step number, source node, writes performed
- Parent checkpoint reference (for branching)
- Timestamp

Request parameters:
- `limit`: Maximum checkpoints to return (default 10)
- `offset`: Skip N checkpoints (for pagination)
- `before`: Filter checkpoints before a specific checkpoint_id
- `metadata`: Filter checkpoints by metadata key-value pairs

Response: Array of checkpoint objects in reverse chronological order (newest first).

Use cases:
- **Time-travel debugging**: Inspect state at each step to identify where an error occurred
- **Audit trails**: Review all state changes for compliance or security analysis
- **Execution replay**: Reproduce a run by starting from a historical checkpoint
- **Branching**: Identify a checkpoint to branch from (use POST /threads/:thread_id/state with checkpoint_id)

Behavioral notes:
- Checkpoint density depends on durability mode: "high" creates more checkpoints than "low"
- Large threads may have thousands of checkpoints; use pagination
- Checkpoints include full state, so history responses can be large
- Deleted threads have no history (returns 404)

Response structure:
```json
[
  {
    "checkpoint_id": "...",
    "values": {...},
    "metadata": {"step": 5, "source": "node_name"},
    "created_at": "2024-01-15T10:30:00Z",
    "parent_checkpoint_id": "..."
  },
  ...
]
```

Authentication required.

---

#### 12. GET /threads/:thread_id/stream - Stream Thread Events (SSE Stub)

**Summary:** Stream thread events via Server-Sent Events (not implemented)

**Description:**

This endpoint is reserved for future functionality to stream real-time events from a thread, independent of a specific run. In the current implementation, it returns 501 Not Implemented.

In the LangGraph Platform API specification, thread streaming would enable clients to:
- Subscribe to all events on a thread (across multiple runs)
- Receive notifications when new runs start or complete
- Monitor thread state changes in real-time

However, the standard pattern for streaming in LangGraph is to stream individual runs via:
- POST /threads/:thread_id/runs/stream (for new runs)
- GET /threads/:thread_id/runs/:run_id/stream (for existing runs)

Thread-level streaming is not commonly needed because:
- Runs are the unit of execution and event generation
- Clients typically stream a specific run, not all activity on a thread
- Cross-run event streaming is better handled by webhooks or polling

For real-time updates in your application, use the run streaming endpoints instead.

Response: 501 Not Implemented with message indicating the endpoint is not supported.

No authentication required (as it's not implemented).

---

### Runs (14 endpoints)

#### 1. POST /threads/:thread_id/runs - Create Stateful Run

**Summary:** Create and execute a run on a thread

**Description:**

Creates and executes a new run on an existing thread. A run is an invocation of an assistant's graph with specific input, executed within the context of a thread's accumulated state. This is the primary endpoint for stateful, multi-turn agent interactions.

In the LangGraph Platform, stateful runs:
- Load the thread's current state as initial input to the graph
- Execute the graph with the provided input (typically new user messages)
- Update the thread's state with execution results
- Create checkpoints for durability and time-travel debugging

Request body:
- `assistant_id`: The assistant (graph + config) to execute (required)
- `input`: The input to pass to the graph, typically `{"messages": [{"role": "user", "content": "..."}]}` (optional, graph-dependent)
- `config`: Runtime configuration overrides (e.g., model parameters, tool selection) (optional)
- `metadata`: Run-specific metadata for filtering and audit trails (optional)
- `stream_mode`: If provided, the response is immediate and the run executes asynchronously. Use streaming endpoints for real-time updates. (optional)
- `multitask_strategy`: How to handle concurrent runs on the same thread ("reject", "enqueue", "interrupt") (optional)

Behavior:
- The run is enqueued in the task queue and picked up by a queue worker
- The worker loads the graph, initializes it with the thread's state, and begins execution
- Checkpoints are written at configurable intervals (durability mode)
- On completion, the thread's state is updated with final values

Use cases:
- **Chat applications**: Each user message creates a new run on the user's thread
- **Multi-step workflows**: Chain multiple runs on the same thread to build up state
- **Human-in-the-loop**: Create a run, wait for interrupt, provide input, create another run

Behavioral notes:
- By default, only one run can execute on a thread at a time (enforced by the task queue)
- If a run is already active, the new run waits in queue (or is rejected based on multitask_strategy)
- Run execution is asynchronous by default; use POST /threads/:thread_id/runs/wait for synchronous behavior
- For real-time updates, use POST /threads/:thread_id/runs/stream instead

Response: Returns the created run object with `run_id`, `thread_id`, `assistant_id`, `status` ("pending"), and timestamps.

Authentication required. Returns 404 if thread or assistant does not exist.

---

#### 2. POST /runs - Create Stateless Run

**Summary:** Create and execute a stateless run (no thread)

**Description:**

Creates and executes a stateless run without a thread. Stateless runs are ephemeral: they do not persist state before or after execution. Each stateless run is fully independent.

In the LangGraph Platform, stateless runs are used for:
- **One-off requests**: Single-turn interactions that don't need conversation history
- **Batch processing**: Process many independent inputs in parallel without thread overhead
- **Stateless APIs**: Expose agents as pure functions (input → output) without session management

Request body:
- `assistant_id`: The assistant to execute (required)
- `input`: The input to pass to the graph (required)
- `config`: Runtime configuration overrides (optional)
- `metadata`: Run-specific metadata (optional)

Behavior:
- A temporary thread is created internally, the run executes, and the thread is discarded after completion
- Checkpoints are written for durability during execution but are not retained after the run finishes
- No state accumulates between stateless runs; each is independent

Use cases:
- **Stateless APIs**: `{"input": {"question": "What is LangGraph?"}}` → answer, no history
- **Batch processing**: Process 1000 independent documents in parallel as stateless runs
- **Simple workflows**: One-step agents that don't need multi-turn state

Differences from stateful runs:
| Feature | Stateful (POST /threads/:id/runs) | Stateless (POST /runs) |
|---------|-----------------------------------|------------------------|
| Thread | Required (pre-created) | None (temporary, discarded) |
| State persistence | Yes, accumulates | No, ephemeral |
| Multi-turn | Yes | No |
| Concurrency | One run per thread (default) | Unlimited parallelism |

Behavioral notes:
- Stateless runs are faster to initialize (no state loading)
- No thread_id in the response (or a temporary ID that becomes invalid after completion)
- Cannot use /threads/:thread_id/state or /history on stateless runs

Response: Returns the created run object with `run_id`, `assistant_id`, `status`, and timestamps.

Authentication required.

---

#### 3. POST /threads/:thread_id/runs/stream - Stream Stateful Run (SSE)

**Summary:** Create and stream a stateful run via Server-Sent Events

**Description:**

Creates a new run on a thread and streams execution events in real-time using Server-Sent Events (SSE). This is the streaming variant of POST /threads/:thread_id/runs.

In the LangGraph Platform, streaming enables real-time UIs where users see agent progress as it happens: thinking indicators, intermediate results, tool calls, and incremental LLM token generation.

Request body (same as POST /threads/:thread_id/runs):
- `assistant_id`: The assistant to execute (required)
- `input`: Graph input (optional)
- `config`: Runtime overrides (optional)
- `metadata`: Run metadata (optional)
- `stream_mode`: Controls event granularity (optional, default "values")

Stream modes:
- **values**: Emits full state after each node execution (coarse-grained, easy to consume)
- **messages**: Emits incremental LLM tokens as they're generated (fine-grained, for typewriter effect)
- **events**: Emits lifecycle events (node start/end, tool calls)
- **debug**: Emits all internal events including subgraph entry/exit

Response format:
- Content-Type: `text/event-stream`
- Each event is formatted as:
  ```
  event: <event_type>
  data: <JSON payload>

  ```

Event types:
- `metadata`: Run metadata (run_id, thread_id)
- `values`: State update (in values mode)
- `messages/partial`: Token chunk (in messages mode)
- `error`: Execution error
- `end`: Run completed

Use cases:
- **Chat UIs**: Stream LLM responses token-by-token for typewriter effect
- **Progress indicators**: Show "Agent is thinking...", "Calling tool X...", etc.
- **Real-time debugging**: Watch graph execution in real-time

Behavioral notes:
- The connection remains open until the run completes or the client disconnects
- If the client disconnects, the run continues in the background (use `cancel_on_disconnect: true` to auto-cancel)
- SSE is unidirectional (server → client). For bidirectional communication, use websockets (not part of this API).
- For large state objects, values mode can produce large events. Use messages mode for lower bandwidth.

Client example (JavaScript):
```javascript
const eventSource = new EventSource('/threads/abc-123/runs/stream', {
  method: 'POST',
  body: JSON.stringify({assistant_id: 'agent', input: {...}})
});
eventSource.addEventListener('messages/partial', (e) => {
  console.log('Token:', JSON.parse(e.data));
});
```

Authentication: X-Api-Key header must be included in the request (not in EventSource constructor for browser clients; use a server-side proxy).

---

#### 4. POST /runs/stream - Stream Stateless Run (SSE)

**Summary:** Create and stream a stateless run via Server-Sent Events

**Description:**

Creates a stateless run (no thread) and streams execution events in real-time using Server-Sent Events (SSE). This is the streaming variant of POST /runs.

In the LangGraph Platform, stateless streaming is used for one-off agent requests where you want real-time updates but don't need persistent state.

Request body:
- `assistant_id`: The assistant to execute (required)
- `input`: Graph input (required)
- `config`: Runtime overrides (optional)
- `metadata`: Run metadata (optional)
- `stream_mode`: Controls event granularity (optional, default "values")

Behavior (same as stateful streaming):
- Events are streamed via SSE as execution progresses
- A temporary thread is created, used for the run, and discarded after completion
- All stream_mode options (values, messages, events, debug) are supported

Differences from stateful streaming:
- No thread_id in the response metadata
- Cannot resume or inspect the run after it completes (no thread to query)
- Ideal for stateless APIs where you don't need conversation history

Use cases:
- **Stateless chat APIs**: User sends a message, get a streaming response, no session
- **Batch processing with progress**: Process documents and stream progress events
- **Function-style agents**: Pure input/output with streaming for real-time UX

Response format: Same as POST /threads/:thread_id/runs/stream (text/event-stream with typed events).

Behavioral notes:
- Stateless streaming runs are fully independent; no state accumulates
- The temporary thread ID (if returned in metadata) cannot be used for subsequent operations
- Lower latency than stateful streaming (no state loading overhead)

Client example:
```javascript
const eventSource = new EventSource('/runs/stream', {
  method: 'POST',
  body: JSON.stringify({
    assistant_id: 'agent',
    input: {messages: [{role: 'user', content: 'Hello'}]},
    stream_mode: 'messages'
  })
});
eventSource.addEventListener('messages/partial', (e) => {
  // Handle streaming tokens
});
```

Authentication required.

---

#### 5. POST /threads/:thread_id/runs/wait - Run and Wait (Stateful)

**Summary:** Create a stateful run and wait for completion

**Description:**

Creates a new run on a thread and blocks until execution completes. This is the synchronous variant of POST /threads/:thread_id/runs, useful when you need the final result immediately and don't require streaming updates.

In the LangGraph Platform, the "wait" endpoints provide a request-response programming model: send input, wait for processing, receive output. This is simpler than streaming for clients that don't need real-time updates.

Request body (same as POST /threads/:thread_id/runs):
- `assistant_id`: The assistant to execute (required)
- `input`: Graph input (optional)
- `config`: Runtime overrides (optional)
- `metadata`: Run metadata (optional)

Behavior:
- The run is created and enqueued
- The HTTP connection remains open while the run executes
- The response is sent only after the run reaches a terminal status (success, error, interrupted)
- If the run is interrupted (human-in-the-loop), the response includes the interrupt details

Response includes:
- `run_id`: Unique run identifier
- `status`: "success", "error", or "interrupted"
- `values`: Final state values (if success)
- `error`: Error details (if error)
- `interrupt`: Interrupt details (if interrupted, includes required input schema)

Use cases:
- **Simple request-response workflows**: User asks a question, wait for answer
- **Synchronous APIs**: Expose agents as blocking HTTP endpoints
- **Testing**: Simpler to write tests with synchronous calls

Behavioral notes:
- Long-running runs may timeout based on HTTP client/server timeout settings (use streaming for long runs)
- If the client disconnects, the run continues in the background (use POST /threads/:thread_id/runs/:run_id/cancel to stop it)
- The "wait" model is less efficient than streaming for real-time UX but simpler to implement

Timeout handling:
- Set appropriate HTTP client timeouts (recommended: 5+ minutes for agent runs)
- If timeout is hit, the run continues in background; use GET /threads/:thread_id/runs/:run_id to poll status

Response: JSON object with run result.

Authentication required.

---

#### 6. POST /runs/wait - Run and Wait (Stateless)

**Summary:** Create a stateless run and wait for completion

**Description:**

Creates a stateless run (no thread) and blocks until execution completes. This is the synchronous variant of POST /runs, providing a simple request-response API for one-off agent invocations.

In the LangGraph Platform, stateless wait is the simplest way to invoke an agent: send input, get output. No threads, no streaming, no state management.

Request body:
- `assistant_id`: The assistant to execute (required)
- `input`: Graph input (required)
- `config`: Runtime overrides (optional)
- `metadata`: Run metadata (optional)

Behavior:
- A temporary thread is created, the run executes, the response is returned, and the thread is discarded
- The HTTP connection remains open until the run completes
- No state persists after the response

Use cases:
- **Stateless APIs**: Simple function-style agent invocations
- **One-shot questions**: "What is the capital of France?" → answer
- **Batch processing**: Process many independent inputs synchronously

Differences from stateful wait:
| Feature | Stateful Wait | Stateless Wait |
|---------|---------------|----------------|
| Thread | Pre-created | Temporary (discarded) |
| State persistence | Yes | No |
| Multi-turn | Yes | No |
| Response includes thread_id | Yes | No (or temporary) |

Behavioral notes:
- Simplest programming model: pure input/output
- No follow-up queries to thread state (no thread to query)
- Lower latency (no state loading) but cannot resume conversations

Response: JSON object with run result (status, values, error).

Authentication required.

---

#### 7. POST /runs/batch - Batch Create Runs

**Summary:** Create multiple stateless runs in a single request

**Description:**

Creates multiple stateless runs in a single batch request. This endpoint is optimized for bulk processing where you need to run the same assistant on many independent inputs.

In the LangGraph Platform, batch runs are executed in parallel on available queue workers, making this significantly faster than creating runs sequentially.

Request body:
- Array of run configurations, each with:
  - `assistant_id`: The assistant to execute (required)
  - `input`: Graph input (required)
  - `config`: Runtime overrides (optional)
  - `metadata`: Run metadata (optional)

Example:
```json
[
  {"assistant_id": "agent", "input": {"question": "What is 2+2?"}},
  {"assistant_id": "agent", "input": {"question": "What is 3+3?"}},
  {"assistant_id": "agent", "input": {"question": "What is 4+4?"}}
]
```

Behavior:
- All runs are stateless (temporary threads, no state persistence)
- Runs execute in parallel subject to queue worker capacity
- The request returns immediately with run IDs; runs execute asynchronously in the background
- Runs are independent: one failure does not affect others

Response:
- Array of created run objects, each with `run_id` and `status: "pending"`
- Client must poll GET /threads/:thread_id/runs/:run_id or use webhooks to get results

Use cases:
- **Document processing**: Process 1000 documents in parallel
- **Batch inference**: Run an agent on a dataset for evaluation
- **Load testing**: Create many runs to test throughput

Behavioral notes:
- Batch size limits may apply (implementation-dependent, typically 100-1000 runs per batch)
- Results are not returned in the response; use run IDs to retrieve results after completion
- For very large batches, consider splitting into multiple batch requests
- Batch runs share queue capacity with regular runs; large batches may impact interactive user experience

Response: Array of run objects with run_id and pending status.

Authentication required.

---

#### 8. GET /threads/:thread_id/runs - List Runs for a Thread

**Summary:** List all runs for a thread

**Description:**

Retrieves a list of all runs that have been executed on a specific thread. This endpoint supports pagination and filtering for large thread histories.

In the LangGraph Platform, threads accumulate runs over time. The runs list provides a chronological view of all agent invocations on a thread, useful for audit trails, debugging, and conversation history.

Query parameters:
- `limit`: Maximum runs to return (default 10, max 100)
- `offset`: Skip N runs (for pagination)
- `status`: Filter by run status ("pending", "running", "success", "error", "interrupted", "cancelled")

Response: Array of run objects, each including:
- `run_id`: Unique run identifier
- `thread_id`: The thread this run belongs to
- `assistant_id`: The assistant used for this run
- `status`: Current run status
- `created_at`: When the run was created
- `started_at`: When execution began (null if pending)
- `ended_at`: When execution completed (null if in progress)
- `metadata`: Run-specific metadata

Use cases:
- **Conversation history UI**: Display list of past agent invocations
- **Debugging**: Review run history to identify failures
- **Analytics**: Count runs per thread for usage tracking
- **Pagination**: Display "Page 1 of 5" conversation history

Behavioral notes:
- Runs are returned in reverse chronological order (newest first)
- Stateless runs do not appear here (they have no thread_id)
- Deleted runs may or may not appear (implementation-dependent)

Example:
```
GET /threads/abc-123/runs?limit=20&offset=0&status=success
```

Response: Array of run objects.

Authentication required. Returns 404 if thread does not exist.

---

#### 9. GET /threads/:thread_id/runs/:run_id - Get Run by ID

**Summary:** Retrieve a specific run

**Description:**

Retrieves the full details of a specific run, including its status, input, output, and metadata.

In the LangGraph Platform, the get run endpoint provides a snapshot of a run's execution state, useful for polling run status, retrieving results, or debugging failures.

Response includes:
- `run_id`: Unique identifier
- `thread_id`: The thread (if stateful) or null (if stateless)
- `assistant_id`: The assistant used
- `status`: One of:
  - **pending**: Queued, not yet started
  - **running**: Currently executing
  - **success**: Completed successfully
  - **error**: Failed with an error
  - **interrupted**: Paused waiting for human input
  - **cancelled**: Manually cancelled before completion
- `input`: The input provided to the run
- `output`: The final result (if completed)
- `error`: Error details (if status is error)
- `created_at`, `started_at`, `ended_at`: Execution timeline
- `metadata`: Run metadata

Use cases:
- **Status polling**: Check if a run is complete (`while (run.status === 'running') { await sleep(1000); run = await getRun(...) }`)
- **Result retrieval**: Get the output after a background run completes
- **Error debugging**: Inspect error details for failed runs

Behavioral notes:
- Output is only populated for completed runs (status: success or interrupted)
- Error field is only populated for failed runs (status: error)
- For stateless runs, thread_id may be null or a temporary ID that cannot be queried

Response: JSON run object.

Authentication required. Returns 404 if run does not exist.

---

#### 10. POST /threads/:thread_id/runs/:run_id/cancel - Cancel Run

**Summary:** Cancel an in-progress run

**Description:**

Cancels a running or pending run on a thread. The run is terminated gracefully, any in-progress checkpoints are finalized, and the run status is set to "cancelled".

In the LangGraph Platform, cancellation is useful for stopping long-running or stuck runs, handling user-initiated cancellations, or cleaning up after errors.

Behavior:
- If the run is **pending** (queued but not started), it is removed from the queue and marked cancelled
- If the run is **running** (actively executing), the worker is signaled to stop, ongoing work is finalized, and the run is marked cancelled
- If the run is **completed** (success/error/interrupted), the request succeeds but has no effect (idempotent)

Graceful shutdown:
- The graph execution is interrupted at the next checkpoint boundary
- Any in-progress node execution completes before stopping (not a hard kill)
- Partial state is saved to the final checkpoint
- The thread remains in a valid state (can be resumed with a new run)

Use cases:
- **User cancellation**: User clicks "Stop" in the UI
- **Timeout handling**: Cancel runs that exceed a time budget
- **Error recovery**: Cancel stuck runs that are not progressing

Behavioral notes:
- Cancellation is asynchronous: the response is immediate, but the run may take a few seconds to fully stop
- After cancellation, the thread status is "idle" (can accept new runs)
- For streaming runs, the SSE stream will emit an "end" event with status "cancelled"

Response: JSON object confirming the cancellation.

Authentication required. Returns 404 if run or thread does not exist.

---

#### 11. POST /runs/cancel - Bulk Cancel Runs

**Summary:** Cancel multiple runs by filter

**Description:**

Cancels multiple runs matching specified filters in a single request. This is the bulk variant of POST /threads/:thread_id/runs/:run_id/cancel.

In the LangGraph Platform, bulk cancellation is used for:
- Emergency stop: Cancel all running runs in a deployment
- User-initiated: Cancel all runs for a specific user (via metadata filter)
- Maintenance: Cancel pending runs before taking a deployment offline

Filter parameters:
- `status`: Cancel runs with specific status (e.g., "running" or "pending")
- `metadata`: Cancel runs matching metadata filters (e.g., `{"user_id": "user-123"}`)
- `thread_id`: Cancel all runs on a specific thread
- `assistant_id`: Cancel all runs for a specific assistant

Safety parameters:
- `limit`: Maximum runs to cancel (prevents accidental mass cancellation)

Use cases:
- **User account deletion**: Cancel all runs for a user
  ```json
  {"metadata": {"user_id": "user-123"}}
  ```
- **Emergency stop**: Cancel all running runs
  ```json
  {"status": "running", "limit": 1000}
  ```
- **Thread cleanup**: Cancel pending runs on a thread before deletion
  ```json
  {"thread_id": "abc-123", "status": "pending"}
  ```

Behavioral notes:
- Cancellation is asynchronous and eventual (may take seconds to propagate)
- Response includes count of runs marked for cancellation
- Already completed runs are not affected
- Use with caution: bulk cancellation can disrupt production workloads

Response: JSON object with cancelled count: `{"cancelled": 15}`

Authentication required.

---

#### 12. GET /threads/:thread_id/runs/:run_id/join - Join Run (Wait for Completion)

**Summary:** Wait for an existing run to complete

**Description:**

Blocks and waits for an already-created run to reach a terminal status (success, error, interrupted, cancelled). This is the "wait after create" variant, useful when you create a run asynchronously and later want to retrieve its result synchronously.

In the LangGraph Platform, the join operation is the complement to asynchronous run creation (POST /threads/:thread_id/runs). It enables workflows like: start run, do other work, then join and get the result.

Behavior:
- If the run is already completed, the response is immediate
- If the run is pending or running, the HTTP connection blocks until completion
- The response includes the final run status and output

Use cases:
- **Async-then-sync workflow**: Create multiple runs in parallel, then join each to collect results
- **Reconnecting**: Client created a run, disconnected, then reconnects and joins to get the result
- **Polling alternative**: Instead of polling GET /threads/:thread_id/runs/:run_id, use join (long-poll)

Behavioral notes:
- Subject to HTTP timeout limits (set client timeout appropriately)
- If the run never completes (stuck), the join request hangs until timeout
- For real-time updates before completion, use streaming instead

Response: JSON run object with final status and output.

Authentication required. Returns 404 if run or thread does not exist.

---

#### 13. GET /threads/:thread_id/runs/:run_id/stream - Join Stream (Resume SSE Stream)

**Summary:** Join an existing run's SSE stream

**Description:**

Connects to the SSE stream of an already-running run. This enables clients to reconnect to a streaming run after disconnection or to "join" a run that was started by another client.

In the LangGraph Platform, SSE streams are resumable: if a client disconnects, they can reconnect and continue receiving events from where they left off (using the `Last-Event-ID` header).

Query parameters:
- `stream_mode`: Override the original stream mode (optional)

Headers:
- `Last-Event-ID`: Resume from this event ID (for resumability)

Behavior:
- If the run is still executing, events are streamed in real-time
- If the run has completed, the final events are sent and the stream closes
- If the run hasn't started yet (pending), the stream waits until execution begins

Use cases:
- **Reconnecting**: Client lost connection during streaming, reconnects to continue
- **Multi-viewer**: Multiple clients watch the same run's progress (e.g., admin monitoring)
- **Delayed join**: User navigates away, comes back later, resumes stream

Behavioral notes:
- The stream uses Server-Sent Events (text/event-stream)
- Resume is supported via `Last-Event-ID` header (events have IDs)
- If the run was not created with streaming, join-stream may return limited events

Response: text/event-stream with run events.

Authentication required. Returns 404 if run or thread does not exist.

---

#### 14. DELETE /threads/:thread_id/runs/:run_id - Delete Run

**Summary:** Delete a run record

**Description:**

Permanently deletes a run record and its associated metadata. This operation does not affect the thread's state (which was already updated by the run), only the run record itself.

In the LangGraph Platform, run deletion is used for:
- Audit log cleanup: Remove old run records to reduce storage
- Privacy compliance: Delete runs containing sensitive data
- Test cleanup: Remove test runs after CI

Behavior:
- The run record is permanently deleted
- Thread state is not affected (state updates from the run persist)
- Checkpoints created by the run may be retained (implementation-dependent)

Use cases:
- **Retention policy**: Delete runs older than 90 days
- **Privacy**: Remove runs with PII after processing
- **Test cleanup**: Delete runs after integration tests

Behavioral notes:
- Deletion is irreversible
- Deleted runs do not appear in GET /threads/:thread_id/runs
- Deleting a run does not revert thread state (use checkpoint rollback for that)
- Active runs should be cancelled before deletion (or the delete may fail)

Response: 204 No Content on success, 404 if run does not exist.

Authentication required.

---

### Crons (6 endpoints)

#### 1. POST /threads/:thread_id/runs/crons - Create Stateful Cron Job

**Summary:** Create a scheduled recurring run on a thread

**Description:**

Creates a cron job that periodically executes a run on a specific thread. The cron job runs on a schedule defined by a cron expression, enabling automated recurring agent tasks bound to a persistent conversation state.

In the LangGraph Platform, stateful cron jobs are used for:
- Recurring workflows that build on previous results (e.g., daily summary emails that reference past summaries)
- User-specific scheduled tasks (e.g., daily reminders for a user's thread)
- Stateful monitoring (e.g., check a condition daily and take action based on history)

Request body:
- `assistant_id`: The assistant to execute (required)
- `schedule`: Cron expression in UTC (required, e.g., "0 9 * * *" for 9 AM daily)
- `input`: The input to pass on each run (optional, same input every time)
- `metadata`: Cron job metadata (optional)
- `end_time`: ISO 8601 timestamp when the cron should stop (optional, null means run forever)

Cron expression format (5 fields):
```
┌───────────── minute (0 - 59)
│ ┌───────────── hour (0 - 23)
│ │ ┌───────────── day of month (1 - 31)
│ │ │ ┌───────────── month (1 - 12)
│ │ │ │ ┌───────────── day of week (0 - 6) (Sunday=0)
│ │ │ │ │
* * * * *
```

Example schedules:
- `"0 9 * * *"`: Daily at 9:00 AM UTC
- `"30 */2 * * *"`: Every 2 hours at :30
- `"0 0 * * 0"`: Weekly on Sundays at midnight
- `"0 12 1 * *"`: Monthly on the 1st at noon

Behavior:
- The cron job creates a new run on the specified thread at each scheduled time
- The same input is used for every run
- State accumulates on the thread (each run sees previous runs' state)
- If a run is still executing when the next schedule triggers, the new run is queued

Use cases:
- **Daily summaries**: Run daily, summarize new activity, email results (state tracks what was already summarized)
- **Recurring reminders**: Check user tasks daily and send reminders (state tracks reminder history)
- **Stateful monitoring**: Monitor a condition daily, escalate if condition persists (state tracks escalation level)

Important: Delete cron jobs when no longer needed to avoid unwanted LLM API charges!

Response: Cron job object with `cron_id`, `thread_id`, `assistant_id`, `schedule`, `next_run_date`.

Authentication required. Returns 404 if thread or assistant does not exist.

---

#### 2. POST /runs/crons - Create Stateless Cron Job

**Summary:** Create a scheduled recurring run without a thread

**Description:**

Creates a cron job that periodically executes a stateless run. Each scheduled execution creates a new temporary thread, executes the run, and discards the thread (unless `on_run_completed: "keep"` is specified).

In the LangGraph Platform, stateless cron jobs are used for:
- Recurring tasks that don't need state (e.g., fetch data, process, send notification)
- Scheduled batch processing (e.g., nightly data ingestion)
- Independent periodic checks (e.g., health checks, monitoring)

Request body:
- `assistant_id`: The assistant to execute (required)
- `schedule`: Cron expression in UTC (required)
- `input`: The input to pass on each run (optional)
- `metadata`: Cron job metadata (optional)
- `end_time`: When to stop the cron (optional)
- `on_run_completed`: "delete" (default) or "keep" (optional)
  - **"delete"**: Thread is deleted after each run (no history)
  - **"keep"**: Thread is preserved for later retrieval (useful for auditing)

Behavior:
- Each scheduled execution is fully independent (no state accumulation)
- New threads are created for each run
- If `on_run_completed: "keep"`, threads accumulate over time (remember to configure TTL to auto-delete old threads)

Use cases:
- **Nightly batch jobs**: Process all new records daily (each run is independent)
- **Scheduled notifications**: Send a daily email (no need for state)
- **Health checks**: Ping an API every hour and alert on failure

Thread management with `on_run_completed: "keep"`:
```python
# Create cron with thread retention
cron = await client.crons.create(
    assistant_id="agent",
    schedule="0 9 * * *",
    input={...},
    on_run_completed="keep"
)

# Later, retrieve runs from the cron
runs = await client.runs.search(
    metadata={"cron_id": cron["cron_id"]}
)
```

Important:
- Delete cron jobs when done to avoid charges
- If using `on_run_completed: "keep"`, configure TTL in langgraph.json to auto-delete old threads

Response: Cron job object with `cron_id`, `assistant_id`, `schedule`, `next_run_date`.

Authentication required.

---

#### 3. DELETE /runs/crons/:cron_id - Delete Cron Job

**Summary:** Delete a scheduled cron job

**Description:**

Permanently deletes a cron job, stopping all future scheduled runs. This operation does not affect runs that have already executed.

In the LangGraph Platform, deleting cron jobs is critical for cost management. Forgotten cron jobs can accumulate significant LLM API charges over time.

Behavior:
- The cron job is removed from the scheduler
- No future runs will be created
- Already-completed runs remain in the thread (if stateful) or in storage (if stateless with `on_run_completed: "keep"`)
- If a run is currently executing when the cron is deleted, that run completes normally

Use cases:
- **Cleanup**: Remove cron jobs that are no longer needed
- **User actions**: User cancels a scheduled task
- **Expiration**: Automatically delete crons after end_time (handled server-side, but can also be done explicitly)

Best practices:
- Always delete cron jobs when they're no longer needed
- For temporary crons (e.g., trial periods), set `end_time` to auto-stop
- Use metadata to track cron ownership and audit deletion

Response: 204 No Content on success, 404 if cron does not exist.

Authentication required.

---

#### 4. PATCH /runs/crons/:cron_id - Update Cron Job

**Summary:** Update a cron job's schedule or configuration

**Description:**

Updates an existing cron job's schedule, input, metadata, or end time. This enables dynamic cron management without deleting and recreating jobs.

In the LangGraph Platform, cron updates are useful for:
- Adjusting schedules (e.g., user changes "daily" to "weekly")
- Updating input (e.g., change the summary prompt)
- Extending or shortening expiration (e.g., extend a trial period)

Request body (all fields optional):
- `schedule`: New cron expression
- `input`: New input for future runs
- `metadata`: Updated metadata (merged with existing)
- `end_time`: New expiration timestamp

Behavior:
- Only specified fields are updated; others remain unchanged
- The `next_run_date` is recalculated if `schedule` changes
- Already-scheduled runs (in queue) are not affected; changes apply to the next scheduled run

Use cases:
- **User preferences**: User changes notification time from 9 AM to 8 AM
- **Dynamic input**: Update the input based on user settings changes
- **Expiration management**: Extend a cron's lifetime (update `end_time`)

Behavioral notes:
- Updating `schedule` does not retroactively change missed runs
- The cron continues to target the same thread (for stateful crons)
- Metadata updates are merged (like PATCH /threads/:thread_id)

Response: Updated cron job object.

Authentication required. Returns 404 if cron does not exist.

---

#### 5. POST /runs/crons/search - Search Cron Jobs

**Summary:** Search and filter cron jobs

**Description:**

Searches for cron jobs matching specified filters. This endpoint supports filtering by metadata, assistant, thread, and schedule, with pagination.

In the LangGraph Platform, cron search is used for:
- Listing a user's scheduled tasks
- Admin dashboards showing all active crons
- Finding crons to delete or update

Filter parameters:
- `metadata`: Exact match filter (e.g., `{"user_id": "user-123"}`)
- `assistant_id`: Filter by assistant
- `thread_id`: Filter by thread (for stateful crons)
- `status`: Filter by status ("active", "paused", "expired")

Pagination and sorting:
- `limit`: Maximum results per page (default 10)
- `offset`: Skip N results
- `sort_by`: Field to sort by (cron_id, created_at, next_run_date)
- `sort_order`: "asc" or "desc"

Response: Array of cron job objects, each including:
- `cron_id`: Unique identifier
- `assistant_id`: The assistant
- `thread_id`: The thread (if stateful) or null
- `schedule`: Cron expression
- `next_run_date`: When the cron will run next
- `end_time`: Expiration time (if set)
- `metadata`: Cron metadata

Use cases:
- **User dashboard**: List all crons for a user
  ```json
  {"metadata": {"user_id": "user-123"}, "sort_by": "next_run_date"}
  ```
- **Admin monitoring**: Find all active crons
  ```json
  {"status": "active", "limit": 100}
  ```
- **Cleanup**: Find expired crons to delete
  ```json
  {"status": "expired"}
  ```

Response: Array of cron objects.

Authentication required.

---

#### 6. POST /runs/crons/count - Count Cron Jobs

**Summary:** Count cron jobs matching filters

**Description:**

Returns the total count of cron jobs matching specified filters. This endpoint accepts the same filter parameters as POST /runs/crons/search but returns only an integer count.

In the LangGraph Platform, cron count is used for:
- Pagination UI (displaying "Page 1 of 3")
- Quota enforcement (checking if a user has hit their cron limit)
- Monitoring (alerting if total crons exceeds a threshold)

Filter parameters (identical to search):
- `metadata`: Exact match filter
- `assistant_id`: Filter by assistant
- `thread_id`: Filter by thread
- `status`: Filter by status

Use cases:
- **Quota checks**: Verify user is under cron limit before creating new cron
- **Dashboard metrics**: Display "You have 5 scheduled tasks"
- **Pagination**: Calculate total pages for cron list UI

Response: JSON object with count field: `{"count": 12}`

Authentication required.

---

### Store (5 endpoints)

#### 1. PUT /store/items - Put Store Item

**Summary:** Create or update an item in the store

**Description:**

Creates or updates a key-value item in the cross-thread store. The store provides persistent memory that can be shared across threads, scoped by namespace hierarchies.

In the LangGraph Platform, the store is used for:
- **User profiles**: Store user preferences, settings, history
- **Shared knowledge**: Facts, documents, or data accessed by multiple threads
- **Cross-session memory**: Persist information beyond a single conversation
- **Feature flags**: Store per-user or per-org feature toggles

Request body:
- `namespace`: Array of namespace segments (e.g., `["users", "user-123", "preferences"]`)
- `key`: String key within the namespace (e.g., `"theme"`)
- `value`: Arbitrary JSON value (object, array, string, number, boolean, null)

Namespace structure:
Namespaces are hierarchical paths that organize items. Each segment is a string.

Examples:
- `["users", "user-123"]`: User-specific namespace
- `["org", "acme-corp", "config"]`: Organization-level config
- `["agents", "assistant-456", "memory"]`: Per-assistant memory

Behavior:
- If an item with the same namespace + key exists, it is overwritten
- If the item doesn't exist, it is created
- Namespaces are created implicitly (no need to pre-create)
- Values can be any JSON-serializable type

Use cases:
- **User settings**: `PUT namespace: ["users", "u123"], key: "theme", value: "dark"`
- **Shared facts**: `PUT namespace: ["knowledge"], key: "company_founded", value: 2020`
- **Per-thread metadata**: `PUT namespace: ["threads", "t456"], key: "summary", value: "..."`

Behavioral notes:
- Store items persist indefinitely (no automatic expiration)
- Large values (>1MB) may have performance implications
- For vector search use cases, consider specialized store backends (PostgreSQL, MongoDB)

Response: JSON object confirming the operation: `{"status": "ok", "namespace": [...], "key": "..."}`

Authentication required.

---

#### 2. GET /store/items - Get Store Item

**Summary:** Retrieve an item from the store

**Description:**

Retrieves a single item from the store by namespace and key. This is the read counterpart to PUT /store/items.

In the LangGraph Platform, store retrieval is used to load persisted data into graph execution context, such as user preferences or shared knowledge.

Query parameters:
- `namespace`: Comma-separated namespace path (e.g., `users,user-123,preferences`)
- `key`: The item key (e.g., `theme`)

Example:
```
GET /store/items?namespace=users,user-123,preferences&key=theme
```

Response: JSON object with the item value:
```json
{
  "namespace": ["users", "user-123", "preferences"],
  "key": "theme",
  "value": "dark"
}
```

Behavior:
- If the item exists, its value is returned
- If the item does not exist, 404 is returned

Use cases:
- **Load user preferences**: Retrieve theme, language, notification settings
- **Fetch shared data**: Load a company knowledge base entry
- **Retrieve per-thread metadata**: Get thread-specific summary or context

Behavioral notes:
- The response includes the full namespace and key for clarity
- Values are returned as-is (no transformation)

Response: JSON object with namespace, key, and value.

Authentication required. Returns 404 if item does not exist.

---

#### 3. DELETE /store/items - Delete Store Item

**Summary:** Delete an item from the store

**Description:**

Permanently deletes a single item from the store by namespace and key. This operation is irreversible.

In the LangGraph Platform, store deletion is used for:
- User data deletion (GDPR, CCPA compliance)
- Cleanup of temporary or expired data
- Removing obsolete knowledge

Query parameters:
- `namespace`: Comma-separated namespace path
- `key`: The item key

Example:
```
DELETE /store/items?namespace=users,user-123,preferences&key=theme
```

Behavior:
- If the item exists, it is deleted
- If the item does not exist, the operation succeeds (idempotent)

Use cases:
- **User account deletion**: Delete all items under `["users", "user-123"]` (requires multiple delete calls or a batch endpoint)
- **Cache invalidation**: Remove stale data
- **Feature cleanup**: Remove deprecated feature flags

Behavioral notes:
- Deletion does not support wildcard or recursive deletion (must delete items one by one)
- For bulk deletion, call DELETE in a loop or use a batch endpoint if available

Response: 204 No Content on success.

Authentication required.

---

#### 4. POST /store/items/search - Search Store Items

**Summary:** Search items in the store

**Description:**

Searches for store items matching specified filters. Supports namespace prefix matching, metadata filtering, and optional vector similarity search.

In the LangGraph Platform, store search enables:
- Listing all items in a namespace (e.g., all user preferences)
- Finding items by metadata tags
- Semantic search (if vector embeddings are stored)

Request body:
- `namespace_prefix`: Array of namespace segments to filter by (e.g., `["users", "user-123"]` matches all items under that user)
- `filter`: Metadata filter (key-value pairs, exact match)
- `limit`: Maximum results (default 10)
- `offset`: Pagination offset

Example - List all preferences for a user:
```json
POST /store/items/search
{
  "namespace_prefix": ["users", "user-123", "preferences"],
  "limit": 100
}
```

Response: Array of item objects:
```json
[
  {"namespace": ["users", "user-123", "preferences"], "key": "theme", "value": "dark"},
  {"namespace": ["users", "user-123", "preferences"], "key": "language", "value": "en"}
]
```

Behavioral notes:
- Namespace prefix matching is hierarchical: `["users"]` matches `["users", "u123"]` and `["users", "u456", "prefs"]`
- Empty namespace_prefix matches all items (use with caution in large stores)
- For vector search, additional query parameters are required (query_vector, distance metric)

Use cases:
- **List user data**: Get all items for a user
- **Namespace exploration**: Discover what's stored under a namespace
- **Semantic search**: Find documents similar to a query embedding (requires vector store backend)

Response: Array of item objects.

Authentication required.

---

#### 5. POST /store/namespaces - List Store Namespaces

**Summary:** List namespaces in the store

**Description:**

Lists all unique namespace prefixes in the store, optionally filtered by a parent namespace. This enables hierarchical navigation of the store.

In the LangGraph Platform, namespace listing is used for:
- Discovering what namespaces exist (e.g., list all users)
- Building UI navigation (e.g., folder-like exploration)
- Audit and compliance (e.g., list all orgs with stored data)

Request body:
- `prefix`: Array of namespace segments to filter by (e.g., `["users"]` lists all user IDs)
- `max_depth`: How many levels deep to return (optional, default 1)
- `limit`: Maximum namespaces to return
- `offset`: Pagination offset

Example - List all user IDs:
```json
POST /store/namespaces
{
  "prefix": ["users"],
  "max_depth": 1
}
```

Response: Array of namespace arrays:
```json
[
  ["users", "user-123"],
  ["users", "user-456"],
  ["users", "user-789"]
]
```

Behavioral notes:
- Namespaces are derived from stored items; empty namespaces (no items) are not returned
- `max_depth` controls how many levels of hierarchy to return (1 = immediate children, 2 = children + grandchildren, etc.)

Use cases:
- **List users**: `{"prefix": ["users"], "max_depth": 1}` returns all user IDs
- **List organizations**: `{"prefix": ["orgs"], "max_depth": 1}`
- **Discover top-level namespaces**: `{"prefix": [], "max_depth": 1}`

Response: Array of namespace arrays.

Authentication required.

---

### System (2 endpoints)

#### 1. GET /ok - Health Check

**Summary:** Health check endpoint

**Description:**

Returns a simple success response indicating the server is running and able to handle requests. This endpoint is used for load balancer health checks, uptime monitoring, and deployment verification.

In the LangGraph Platform, the health check endpoint does not verify connectivity to dependent services (database, Redis, etc.). It only confirms the HTTP server process is responsive.

Response:
```json
{"status": "ok"}
```

HTTP status: 200 OK

Use cases:
- **Load balancer health checks**: Configure ALB/NLB to ping /ok
- **Uptime monitoring**: External services (Pingdom, Datadog) can poll /ok
- **Deployment verification**: CI/CD pipelines can check /ok after deployment

Behavioral notes:
- No authentication required (public endpoint)
- Minimal processing (returns immediately)
- Does not check database, queue, or other service dependencies

Response: JSON object with status "ok".

No authentication required.

---

#### 2. GET /info - Server Information

**Summary:** Retrieve server information and capabilities

**Description:**

Returns metadata about the server, including version, supported features, and configuration capabilities. This endpoint enables clients to discover what the server supports and adjust behavior accordingly.

In the LangGraph Platform, the /info endpoint is used for:
- Version negotiation (client checks server version for compatibility)
- Feature detection (client checks if streaming, cron jobs, or store are supported)
- Debugging (client logs server version in error reports)

Response includes:
- `version`: Server version string (e.g., "1.0.0")
- `capabilities`: Array of supported feature flags (e.g., ["streaming", "cron", "store", "batch_runs"])
- `graph_ids`: List of available graph IDs (from langgraph.json)
- `assistant_count`: Number of assistants in the deployment (optional)

Example response:
```json
{
  "version": "1.0.0",
  "capabilities": ["streaming", "cron", "store", "batch_runs"],
  "graph_ids": ["agent", "customer-support", "data-processor"]
}
```

Use cases:
- **Client compatibility checks**: Client requires streaming; checks if "streaming" is in capabilities
- **UI feature toggles**: Show cron UI only if "cron" capability is present
- **Version logging**: Include server version in client error reports

Behavioral notes:
- No authentication required (or authentication optional, implementation-dependent)
- Response is static or cached (does not query live server state)

Response: JSON object with server metadata.

No authentication required (or optional, depending on implementation).

---

## Tag Descriptions

These descriptions are intended for the OpenAPI `tags` array at the top-level of the specification (in `src/plugins/swagger.plugin.ts`). They provide context for each API group in the Swagger UI.

### Assistants

**Description:**

Assistants are versioned configurations of your deployed graphs. Each assistant references a specific graph (defined in langgraph.json) and binds it to a particular configuration including model parameters, system prompts, tools, and runtime context. Multiple assistants can reference the same graph with different configurations, enabling reuse of graph logic across different use cases (e.g., one assistant for customer support, another for sales, both using the same base graph).

When you deploy a graph to LangGraph Platform, a default assistant is automatically created. Additional assistants can be created, updated, and versioned via these endpoints. Assistants are immutable once created; updates create new versions, and you can roll back to previous versions at any time.

Use the Assistants endpoints to:
- Create and configure assistants for different use cases
- List and search assistants by metadata or graph
- Inspect graph structure, schemas, and subgraphs
- Manage assistant versions and rollback configurations
- Retrieve assistant details before creating runs

---

### Threads

**Description:**

Threads are persistent conversation containers that maintain state across multiple run invocations. Each thread has a unique ID and stores the accumulated state (messages, intermediate values, checkpoint history) from all runs executed on it. Threads enable multi-turn conversations, long-running workflows, and stateful agent interactions.

Without threads, each run would be stateless with no memory of previous interactions. Threads are the foundation of stateful execution in LangGraph Platform, allowing agents to remember context, build on previous results, and maintain conversation history across sessions.

Use the Threads endpoints to:
- Create new conversation threads with optional initial state
- Retrieve and update thread metadata
- Inspect thread state and checkpoint history
- Search and filter threads by status or metadata
- Copy threads for branching conversations
- Prune old or inactive threads for storage management
- Manually update thread state outside of graph execution

---

### Runs

**Description:**

Runs are individual executions of an assistant's graph. Each run processes input (typically user messages), executes the graph's logic, and produces output. Runs can be stateful (bound to a thread, accumulating state) or stateless (ephemeral, no persistence).

The Runs endpoints support multiple execution modes:
- **Synchronous (wait)**: Block until the run completes and return the result
- **Asynchronous (create)**: Start the run in the background and poll for results
- **Streaming (SSE)**: Stream execution events in real-time for live UIs
- **Batch**: Execute multiple runs in parallel for bulk processing

Runs are the execution engine of LangGraph Platform. They bridge clients (web apps, mobile apps, APIs) to agent logic, handling request routing, state management, error handling, and result delivery.

Use the Runs endpoints to:
- Execute agents synchronously or asynchronously
- Stream real-time execution events for interactive UIs
- Batch process multiple inputs in parallel
- Monitor, cancel, and retrieve run results
- List run history for debugging and analytics

---

### Crons

**Description:**

Crons are scheduled recurring runs that execute on a user-defined schedule. They enable automated periodic agent tasks without requiring manual invocation or external schedulers. Cron schedules use standard cron expression syntax (5-field format) and are interpreted in UTC.

Cron jobs can be stateful (bound to a specific thread, accumulating state across executions) or stateless (creating a new thread for each execution). Stateless crons can optionally preserve threads after execution for audit purposes.

Common use cases for cron jobs include:
- Daily summaries or reports
- Periodic monitoring and alerting
- Scheduled data processing pipelines
- Recurring reminders or notifications
- Automated maintenance tasks

**Important**: It is critical to delete cron jobs when they are no longer needed to avoid unwanted LLM API charges from recurring executions.

Use the Crons endpoints to:
- Schedule recurring runs on threads or as stateless jobs
- Update cron schedules or input dynamically
- Delete crons to stop scheduled executions
- Search and filter crons by metadata or status
- Monitor upcoming and past cron executions

---

### Store

**Description:**

The Store provides persistent, cross-thread key-value storage organized by hierarchical namespaces. It enables long-term memory that can be shared across conversations, users, or agents. Unlike thread state (which is scoped to a single conversation), store items persist indefinitely and can be accessed from any thread.

Store items are organized by namespace (an array of string segments, similar to a file path) and key. Namespaces enable logical organization and access control:
- `["users", "user-123", "preferences"]` - User-specific settings
- `["org", "acme-corp", "knowledge"]` - Organization-level shared knowledge
- `["agents", "assistant-456", "memory"]` - Per-assistant memory

Common use cases for the store include:
- User profiles and preferences
- Shared knowledge bases or documents
- Feature flags and configuration
- Cross-session memory (facts learned across conversations)

Use the Store endpoints to:
- Store and retrieve key-value items
- Search items by namespace prefix or metadata
- Delete items for cleanup or compliance
- List namespaces to discover stored data hierarchies
- Organize data with hierarchical namespace structures

---

### System

**Description:**

System endpoints provide health checks and server metadata. These endpoints are used by infrastructure (load balancers, monitoring tools), client applications (feature detection, version compatibility), and operators (deployment verification).

Use the System endpoints to:
- Perform health checks for uptime monitoring and load balancer configuration
- Retrieve server version and supported capabilities
- Discover available graphs and assistants in the deployment
- Verify server responsiveness after deployment

---

## Assumptions & Scope

### Assumptions Made

| Assumption | Confidence | Impact if Wrong |
|------------|------------|-----------------|
| Official LangSmith Deployment (Agent Server) documentation is authoritative for LangGraph Platform API | HIGH | Descriptions may not align with official SDK behavior; would require revision based on alternative sources |
| The lg-api project aims for 100% API compatibility with LangGraph Platform | HIGH | Descriptions may be overly detailed or include features lg-api doesn't implement; project may be a simplified subset |
| All 50 endpoints are part of the LangSmith Deployment Agent Server API | MEDIUM | Some endpoints (e.g., /threads/:thread_id/stream stub) may not exist in official API; would need clarification |
| Stream mode options (values, messages, events, debug) are standard across all streaming endpoints | MEDIUM | Actual stream modes may vary by endpoint; would need verification from official API reference |
| Store namespace structure is hierarchical and user-defined (no enforced schema) | MEDIUM | There may be reserved namespaces or schema enforcement; would affect Store endpoint descriptions |

### Uncertainties & Gaps

- **Stream mode details**: While the documentation mentions stream modes (values, messages, events, debug), the exact event structure and payload format for each mode is not fully detailed in the sources. This would require testing against a live LangGraph Platform deployment or consulting detailed SDK source code.

- **Error response formats**: The descriptions focus on success cases. Standard error response structures (status codes, error schemas) are not covered in this investigation. These should be documented separately or inferred from TypeBox schemas.

- **Pagination cursor details**: The search endpoints use offset/limit pagination. It's unclear if cursor-based pagination is also supported or preferred for large result sets. The official API may have evolved to use cursors.

- **Store vector search**: The Store search endpoint mentions optional vector similarity search, but the exact query parameters, embedding models, and distance metrics are not detailed. This feature may require specialized store backends (PostgreSQL, MongoDB).

- **Webhook support**: The Agent Server documentation mentions webhooks as an alternative to polling/streaming, but webhook endpoints are not included in the 50-endpoint specification. This may be a separate API surface or future functionality.

- **Batch runs response format**: POST /runs/batch creates multiple runs asynchronously, but the mechanism for retrieving results is not fully specified. It may require polling individual run IDs or using metadata search.

- **Thread TTL configuration**: Thread pruning and cron thread cleanup reference TTL (time-to-live) configuration in langgraph.json, but the exact configuration schema is not detailed. This is an operational concern outside the API endpoint scope.

### Clarifying Questions for Follow-up

1. **Stream event schema**: Can you provide the exact JSON schema for events emitted in each stream mode (values, messages, events, debug)?

2. **Stateless run thread IDs**: When POST /runs creates a stateless run, does the response include a thread_id (temporary) or is it null? Can this thread_id be used for any queries before it's discarded?

3. **Cron concurrency**: If a stateful cron's previous run is still executing when the next schedule triggers, what happens? Is the new run queued, skipped, or does it fail?

4. **Store item size limits**: Are there size limits on store item values (e.g., max 10MB per item)? What happens if a client tries to store a very large value?

5. **Assistant version semantics**: When PATCH /assistants/:assistant_id creates a new version, does the "latest" pointer update automatically, or is a separate POST /assistants/:assistant_id/latest call required?

6. **Error status codes**: What HTTP status codes are used for common errors (404 for not found, 409 for conflicts, 400 for validation errors, 500 for internal errors)? Is there a standard error response schema?

7. **Authentication details**: The descriptions mention X-Api-Key authentication. Are there other authentication methods (OAuth, JWT)? Are some endpoints public (no auth required)?

8. **Webhook endpoints**: Are webhooks part of the Agent Server API? If so, what are the endpoints for configuring webhooks?

---

## References

### Official Documentation Sources

1. **LangSmith Agent Server Overview**
   - URL: https://docs.langchain.com/langsmith/agent-server
   - Content: Overview of Agent Server architecture, deployment, and runtime components

2. **LangGraph Threads Usage Guide**
   - URL: https://docs.langchain.com/langsmith/use-threads
   - Content: Creating, inspecting, and managing threads; state management and checkpoint history

3. **LangGraph Cron Jobs Guide**
   - URL: https://docs.langchain.com/langsmith/cron-jobs
   - Content: Creating stateful and stateless cron jobs; schedule syntax; thread cleanup

4. **LangGraph Memory Overview**
   - URL: https://docs.langchain.com/oss/python/langgraph/memory
   - Content: Store system concepts; cross-thread memory; namespace organization

5. **Agent Server API Reference - Create Assistant**
   - URL: https://docs.langchain.com/langsmith/agent-server-api/assistants/create-assistant
   - Content: POST /assistants endpoint specification

6. **Agent Server API Reference - Search Assistants**
   - URL: https://docs.langchain.com/langsmith/agent-server-api/assistants/search-assistants
   - Content: POST /assistants/search endpoint specification

7. **Agent Server API Reference - Patch Assistant**
   - URL: https://docs.langchain.com/langsmith/agent-server-api/assistants/patch-assistant
   - Content: PATCH /assistants/:assistant_id endpoint specification

8. **Agent Server API Reference - Get Assistant Graph**
   - URL: https://docs.langchain.com/langsmith/agent-server-api/assistants/get-assistant-graph
   - Content: GET /assistants/:assistant_id/graph endpoint specification

9. **Agent Server API Reference - Get Assistant Subgraphs**
   - URL: https://docs.langchain.com/langsmith/agent-server-api/assistants/get-assistant-subgraphs
   - Content: GET /assistants/:assistant_id/subgraphs endpoint specification

10. **Agent Server API Reference - Create Run Batch**
    - URL: https://docs.langchain.com/langsmith/agent-server-api/stateless-runs/create-run-batch
    - Content: POST /runs/batch endpoint specification

11. **LangGraph Python SDK Reference - Assistants Client**
    - URL: https://reference.langchain.com/python/langgraph-sdk/_sync/client
    - Content: AssistantsClient, ThreadsClient, RunsClient, CronsClient, StoreClient method reference

12. **LangGraph JavaScript SDK Reference - RunsClient**
    - URL: https://langchain-ai.github.io/langgraphjs/reference/classes/sdk_client.RunsClient.html
    - Content: RunsClient method signatures and usage

13. **LangGraph Local Server Documentation**
    - URL: https://docs.langchain.com/oss/python/langgraph/local-server
    - Content: POST /runs/stream endpoint specification; stream mode examples

14. **LangChain Blog - LangGraph Platform Announcement**
    - URL: https://blog.langchain.com/langgraph-platform-announce/
    - Content: LangGraph Platform overview; core concepts (assistants, threads, runs, crons, store)

### Search Results Referenced

15. **LangGraph Platform API Reference (mentioned but 404)**
    - URL: https://langchain-ai.github.io/langgraph/cloud/reference/api/api_ref.html
    - Status: 404 Not Found (documentation may have moved to docs.langchain.com)

16. **LangGraph Platform Reference Overview**
    - URL: https://docs.langchain.com/langgraph-platform/reference-overview
    - Content: Entry point for LangGraph Platform SDK and API references

17. **LangGraph SDK - PyPI**
    - URL: https://pypi.org/project/langgraph-sdk/
    - Content: Package metadata; latest version 0.7.65 (March 5, 2026)

18. **LangGraph Store System - DeepWiki**
    - URL: https://deepwiki.com/langchain-ai/langgraph/4.3-store-system
    - Content: Store API concepts; namespace organization; cross-thread memory

19. **LangGraph Storage Reference**
    - URL: https://reference.langchain.com/python/langgraph/store/
    - Content: BaseStore interface; put, get, search, list_namespaces methods

### Project Context Documents

20. **lg-api Reference - LangGraph API Concepts**
    - File: `/Users/giorgosmarinos/aiwork/agent-platform/lg-api/docs/reference/langgraph-api-concepts.md`
    - Content: Comprehensive overview of LangGraph Platform API architecture, core concepts, and workflows

21. **lg-api Reference - Refined Request for Swagger Endpoint Descriptions**
    - File: `/Users/giorgosmarinos/aiwork/agent-platform/lg-api/docs/reference/refined-request-swagger-endpoint-descriptions.md`
    - Content: Detailed requirement specification for Swagger documentation enhancement

22. **lg-api Reference - Codebase Scan for Swagger Endpoints**
    - File: `/Users/giorgosmarinos/aiwork/agent-platform/lg-api/docs/reference/codebase-scan-swagger-endpoints.md`
    - Content: Current state of Swagger metadata in lg-api codebase; route file structure

---

**End of Document**
