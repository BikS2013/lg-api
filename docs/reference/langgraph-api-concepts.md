# LangGraph Platform API: Core Concepts and Architecture

**Document Version:** 1.0
**Date:** 2026-03-09
**Status:** Complete

---

## Table of Contents

1. [Executive Overview](#executive-overview)
2. [LangGraph Platform Architecture](#langgraph-platform-architecture)
3. [Area 1: Assistants](#area-1-assistants)
4. [Area 2: Threads](#area-2-threads)
5. [Area 3: Runs & Crons](#area-3-runs--crons)
6. [Area 4: Store](#area-4-store)
7. [End-to-End Workflow: How All 4 Areas Work Together](#end-to-end-workflow-how-all-4-areas-work-together)
8. [SSE Streaming Deep Dive](#sse-streaming-deep-dive)
9. [State Management Architecture](#state-management-architecture)
10. [Stateful vs Stateless Operations](#stateful-vs-stateless-operations)
11. [Design Patterns and Best Practices](#design-patterns-and-best-practices)
12. [Implementation Scope for a Real System](#implementation-scope-for-a-real-system)
13. [Assumptions & Scope](#assumptions--scope)
14. [References](#references)

---

## Executive Overview

The **LangGraph Platform API** is a deployment and hosting infrastructure for LangGraph applications that provides a managed API server for executing graph-based AI agents. It abstracts away the complexity of graph execution, state persistence, resource management, and client communication through a well-structured REST API organized around **five primary resource types**:

1. **Assistants** — Versioned configurations of graphs with specific prompts, models, and settings
2. **Threads** — State containers for multi-turn conversations with checkpoint history
3. **Runs** — Individual executions of graphs (stateful or stateless)
4. **Crons** — Scheduled, recurring runs with cron-syntax schedules
5. **Store** — Cross-thread persistent key-value storage with namespace organization

The platform is built on the foundation of **LangGraph**, an open-source framework for building stateful, multi-agent workflows as directed graphs. While LangGraph itself is focused on graph construction and execution, the **Platform API** adds deployment, persistence, multi-tenancy, and operational capabilities necessary for production AI agent applications.

### Key Capabilities

- **Durable Execution**: Checkpointing at every super-step enables fault tolerance and human-in-the-loop workflows
- **Memory**: Thread-based state persistence enables conversational agents with context retention
- **Time Travel**: Historical checkpoint access allows debugging and forking from previous states
- **Streaming**: Real-time SSE (Server-Sent Events) streaming with multiple modes (values, updates, messages, debug, custom)
- **Configuration Management**: Separate configuration from code through assistants and versioning
- **Concurrency Control**: Multitask strategies (reject, interrupt, rollback, enqueue) for handling concurrent runs
- **Cross-Thread Memory**: Store API for sharing data across conversations and users
- **Scheduling**: Cron jobs for automated, recurring agent invocations

---

## LangGraph Platform Architecture

### Conceptual Layers

```
┌─────────────────────────────────────────────────────────────────┐
│                     LangGraph SDK Clients                        │
│            (Python langgraph-sdk / JS @langchain/langgraph-sdk)  │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP / SSE
┌──────────────────────────▼──────────────────────────────────────┐
│                   LangGraph Platform API                         │
│  ┌────────────┬────────────┬────────────┬────────────┬────────┐ │
│  │ Assistants │  Threads   │    Runs    │   Crons    │ Store  │ │
│  │    API     │    API     │    API     │    API     │  API   │ │
│  └────────────┴────────────┴────────────┴────────────┴────────┘ │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                   Execution & State Layer                        │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  Graph Compilation & Execution Engine (LangGraph Core)      ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  Checkpointer (State Snapshots at Every Super-Step)         ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  Task Queue (Durable Execution, Concurrency Control)        ││
│  └─────────────────────────────────────────────────────────────┘│
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                     Persistence Layer                            │
│  ┌──────────────┬──────────────┬──────────────┬──────────────┐  │
│  │  Thread DB   │ Checkpoint DB│   Store DB   │   Cron DB    │  │
│  │  (Threads)   │ (Snapshots)  │ (Namespaces) │ (Schedules)  │  │
│  └──────────────┴──────────────┴──────────────┴──────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Resource Relationships

```
┌──────────────┐
│   ASSISTANT  │ ◄────── Versioned configuration (prompts, model, tools)
│  (graph_id)  │         Maps to a specific graph definition
└──────┬───────┘
       │ referenced by
       ▼
┌──────────────┐         ┌──────────────┐
│     RUN      │ ────────│    THREAD    │
│  (execution) │  on     │ (state box)  │
└──────┬───────┘         └──────┬───────┘
       │                        │
       │ produces               │ contains
       ▼                        ▼
┌──────────────┐         ┌──────────────┐
│   OUTPUTS    │         │ CHECKPOINTS  │
│  (streamed)  │         │  (snapshots) │
└──────────────┘         └──────────────┘

┌──────────────┐         ┌──────────────┐
│     CRON     │ creates │     RUN      │
│  (schedule)  │ ────────│              │
└──────────────┘         └──────────────┘

┌──────────────┐
│    STORE     │ ◄────── Shared across threads
│ (namespaces) │         Cross-conversation memory
└──────────────┘
```

---

## Area 1: Assistants

### Purpose: Configuration Management Separate from Code

**Assistants** solve the problem of **separating agent behavior configuration from graph structure**. In production AI applications, you often need to deploy the same graph architecture with different configurations for different use cases, users, or environments. Instead of maintaining multiple graph codebases, assistants allow you to define one graph and create multiple **configuration variants** (different prompts, models, tools, parameters) that share the same underlying logic.

### Core Problem Solved

Imagine a general-purpose writing agent built on a common graph architecture. The graph structure (nodes, edges, state management) remains constant, but different writing styles—blog posts vs. tweets—require different system prompts, model selections, and tone parameters. Without assistants, you would need to:

1. Duplicate the graph code for each variant, or
2. Hardcode conditional logic in the graph to switch behavior based on runtime flags

Both approaches are error-prone and hard to maintain. **Assistants** provide a cleaner abstraction: one graph, many configurations.

### Core Concepts

#### Assistant Entity

An assistant is a **versioned configuration wrapper** around a graph. Key properties:

| Property | Type | Description |
|----------|------|-------------|
| `assistant_id` | UUID | Unique identifier for this assistant |
| `graph_id` | string | References the graph definition (e.g., "agent", "writing_bot") |
| `config` | object | Runtime configuration (LangGraph `RunnableConfig` format) |
| `context` | object | Additional context data passed to the graph (since LangGraph 0.2+) |
| `metadata` | object | Arbitrary key-value pairs for filtering and organization |
| `version` | integer | Version number (increments on each update) |
| `name` | string | Human-readable name |
| `description` | string | Purpose and usage notes |
| `created_at` | ISO 8601 | Timestamp of creation |
| `updated_at` | ISO 8601 | Timestamp of last modification |

#### Graph ID vs Assistant ID

- **`graph_id`**: Identifies the **code** (the graph definition in your deployment). Maps to an entry in `langgraph.json` like `"agent": "./graphs/agent.py:graph"`.
- **`assistant_id`**: Identifies a **configured instance** of that graph. Multiple assistants can reference the same `graph_id`.

When you deploy a LangGraph application, the system **automatically creates a default assistant** for each graph defined in `langgraph.json`, using the graph's default configuration. You can then create additional assistants with custom configurations.

#### Configuration Object

The `config` field follows LangGraph's `RunnableConfig` structure:

```json
{
  "configurable": {
    "system_prompt": "You are a helpful assistant specialized in technical writing.",
    "model": "gpt-4",
    "temperature": 0.7,
    "max_tokens": 2000
  },
  "tags": ["production", "writing-assistant"],
  "recursion_limit": 50
}
```

The `configurable` section contains custom key-value pairs accessible within graph nodes via `config["configurable"]["key"]`. This allows nodes to adapt their behavior based on the assistant's configuration.

#### Context Object (LangGraph 0.2+)

The `context` field provides additional data passed to the graph at compile time:

```json
{
  "user_id": "user_123",
  "organization_id": "org_456",
  "feature_flags": {
    "use_advanced_tools": true
  }
}
```

Context is distinct from state—it's **immutable during execution** and typically used for access control, feature flagging, or user-specific data.

### Lifecycle

#### 1. Creation

**POST /assistants**

```json
{
  "graph_id": "agent",
  "name": "Blog Writing Assistant",
  "config": {
    "configurable": {
      "system_prompt": "You are an expert blog writer.",
      "model": "gpt-4"
    }
  },
  "metadata": {
    "domain": "blogging",
    "language": "en"
  }
}
```

- The system validates the `graph_id` exists in the deployment.
- An `assistant_id` (UUID) is generated.
- `version` is set to 1.
- A default assistant already exists for each graph, so this creates an **additional** configured variant.

#### 2. Retrieval

**GET /assistants/{assistant_id}**

Returns the full assistant object with its current configuration and metadata.

#### 3. Update (Creates New Version)

**PATCH /assistants/{assistant_id}**

```json
{
  "config": {
    "configurable": {
      "model": "gpt-4-turbo"
    }
  }
}
```

- Updates **create a new version** (version 2, 3, etc.).
- The `assistant_id` remains the same.
- All previous versions are retained for rollback.
- The **latest version** becomes the active configuration unless specified otherwise.

#### 4. Versioning Operations

**POST /assistants/{assistant_id}/versions**

Lists all versions of an assistant with optional filtering by metadata.

**POST /assistants/{assistant_id}/latest**

```json
{
  "version": 3
}
```

Promotes a specific version to be the "latest" (active) version. This enables rollback without losing history.

#### 5. Deletion

**DELETE /assistants/{assistant_id}?delete_threads=true**

- Deletes the assistant and optionally all associated threads.
- Default assistants (created automatically at deployment) cannot be deleted.

### Relationships

#### To Graphs

- **Many-to-One**: Multiple assistants can reference the same `graph_id`.
- The graph defines the **structure** (nodes, edges, state schema).
- The assistant provides the **configuration** (model, prompts, parameters).

#### To Runs

- **One-to-Many**: An assistant can be used for multiple runs.
- When creating a run, you specify either:
  - `assistant_id` (uses that specific configuration), or
  - `graph_id` (uses the default assistant for that graph)

#### To Threads

- **Indirect**: Assistants don't "own" threads, but runs that use an assistant operate on threads.
- A single thread can have runs from different assistants (configuration switching mid-conversation).

### Real-World Usage Patterns

#### Pattern 1: User-Level Personalization

```
Assistant "user_123_agent" → config: { "tone": "formal", "language": "es" }
Assistant "user_456_agent" → config: { "tone": "casual", "language": "en" }
Both use graph_id: "customer_service_agent"
```

#### Pattern 2: Environment Staging

```
Assistant "dev_assistant" → config: { "model": "gpt-3.5-turbo", "debug": true }
Assistant "prod_assistant" → config: { "model": "gpt-4", "debug": false }
Both use graph_id: "agent"
```

#### Pattern 3: A/B Testing

```
Assistant "variant_a" → config: { "prompt": "Original prompt..." }
Assistant "variant_b" → config: { "prompt": "Experimental prompt..." }
Track performance differences via metadata and run outcomes
```

### Scope of Implementation

A **real (non-stub) implementation** must:

1. **Validate `graph_id`**: Ensure the graph exists in the deployment configuration.
2. **Store versioning history**: Maintain all previous versions with timestamps.
3. **Resolve configuration merging**: Combine assistant config with graph defaults and run-time overrides.
4. **Handle default assistant creation**: Automatically create default assistants on deployment.
5. **Enforce access control**: If multi-tenant, ensure users can only access their own assistants.
6. **Support metadata filtering**: Enable search/filtering by metadata fields.
7. **Cascade deletion logic**: Optionally delete threads when an assistant is deleted.

### Key Design Decisions

#### Why Versioning Instead of Editing?

**LangGraph's Choice**: Create a new version on every update rather than in-place editing.

**Rationale**:
- **Auditability**: Complete history of configuration changes.
- **Rollback**: Instantly revert to a previous configuration without losing data.
- **A/B Testing**: Compare performance of different versions in parallel.
- **Safety**: Production runs continue using the last known-good version while testing new configurations.

#### Why Separate `config` and `context`?

**LangGraph's Choice**: Two distinct fields for configuration data.

**Rationale**:
- **`config`**: Mutable, runtime-adjustable settings (prompts, model params).
- **`context`**: Immutable, compile-time data (user identity, feature flags).
- Separation clarifies intent and prevents accidental state mutation.

#### Why `graph_id` as a String Instead of UUID?

**LangGraph's Choice**: Use human-readable identifiers from `langgraph.json`.

**Rationale**:
- Developer experience: Easier to reference in API calls (`"agent"` vs `"f7a8e2..."`).
- Maps directly to deployment configuration without additional lookup.

---

## Area 2: Threads

### Purpose: Multi-Turn Conversation State Management

**Threads** solve the problem of **stateful, multi-turn interactions** in AI agent applications. Without threads, each agent invocation would be stateless—the agent would have no memory of previous interactions, requiring the client to manually pass the full conversation history with every request. Threads act as **persistent state containers** that:

1. Store the accumulated state of the graph across multiple runs
2. Maintain a complete checkpoint history for every super-step
3. Enable conversation continuity, debugging, and human-in-the-loop workflows

### Core Problem Solved

Consider a customer support chatbot. A user asks, "What's my account balance?" The agent needs to:

1. Authenticate the user
2. Query the balance
3. Respond with the result

If the user then asks, "Can you transfer $100 to savings?", the agent must remember:

- The user is already authenticated
- The current balance from the previous step
- The conversation context

**Threads** provide this memory layer, enabling the agent to maintain state across multiple interactions without the client having to resend everything.

### Core Concepts

#### Thread Entity

A thread is a **unique state container** for a graph's execution history. Key properties:

| Property | Type | Description |
|----------|------|-------------|
| `thread_id` | string or UUID | Unique identifier (can be client-provided or server-generated) |
| `created_at` | ISO 8601 | Timestamp of creation |
| `updated_at` | ISO 8601 | Timestamp of last modification |
| `metadata` | object | Arbitrary key-value pairs for filtering (e.g., `{"user_id": "123"}`) |
| `status` | enum | Current status: `idle`, `busy`, `interrupted`, `error` |
| `values` | object | Current state values (latest checkpoint's state) |
| `interrupts` | array | Active interrupt data (if execution is paused) |

#### Thread Status

Computed by the system from associated run states:

- **`idle`**: No active runs, last run completed successfully
- **`busy`**: A run is currently executing on this thread
- **`interrupted`**: Execution was paused (human-in-the-loop or explicit interrupt)
- **`error`**: Last run failed with an exception

Status **cannot be directly modified** via the API—it's derived from run lifecycle.

### Checkpoints: The Heart of Thread State

#### What is a Checkpoint?

A **checkpoint** is a **snapshot of the graph state** saved at every **super-step** during execution. A super-step is one "tick" of the graph execution where:

1. One or more nodes execute in parallel
2. All node outputs are collected and applied to the state
3. The state is persisted as a checkpoint

#### Checkpoint Properties

Each checkpoint (represented as a `StateSnapshot` object) contains:

| Property | Description |
|----------|-------------|
| `values` | The full state values at this point in time |
| `next` | Tuple of node names scheduled to execute next (empty if at END) |
| `config` | Configuration (thread_id, checkpoint_id, checkpoint_ns) |
| `metadata` | Metadata about this checkpoint (source, writes, step number) |
| `created_at` | Timestamp |
| `parent_config` | Reference to the previous checkpoint (forming a linked list) |
| `tasks` | Tuple of `PregelTask` objects (next scheduled tasks, interrupt data) |

#### Checkpoint Lifecycle Example

Given a simple graph:

```
START → node_a → node_b → END
```

Invoking the graph with `{"foo": "", "bar": []}` produces **4 checkpoints**:

1. **Before START**: Empty state, `next = ["__start__"]`
2. **After START, before node_a**: State = `{"foo": "", "bar": []}`, `next = ["node_a"]`
3. **After node_a, before node_b**: State = `{"foo": "a", "bar": ["a"]}`, `next = ["node_b"]`
4. **After node_b, at END**: State = `{"foo": "b", "bar": ["a", "b"]}`, `next = []` (done)

Each checkpoint is **addressable by `checkpoint_id`**, enabling time travel.

#### Checkpointer Backend

The checkpointer is a pluggable persistence layer. Common implementations:

- **In-Memory**: `InMemorySaver` (for development, not durable)
- **PostgreSQL**: `PostgresSaver` (production-ready)
- **Redis**: `RedisSaver` (fast, distributed)
- **DynamoDB + S3**: `DynamoDBSaver` (AWS-native, hybrid storage)

The LangGraph Platform API abstracts this—clients interact with threads via REST, and the platform handles checkpoint persistence internally.

### Lifecycle

#### 1. Creation

**POST /threads**

```json
{
  "thread_id": "thread_123",  // optional, auto-generated if omitted
  "metadata": {
    "user_id": "user_456",
    "conversation_type": "support"
  },
  "ttl": 86400  // optional, time-to-live in seconds
}
```

- If `thread_id` is omitted, a UUID is generated.
- Metadata enables filtering (e.g., "get all threads for user_456").
- TTL (time-to-live) enables automatic cleanup of old threads.
- The thread starts with **no checkpoints** until the first run.

#### 2. Retrieval

**GET /threads/{thread_id}?include=values**

Returns the thread object. The `include` query parameter controls what data is returned:

- `include=values`: Include the latest state values
- `include=interrupts`: Include active interrupt data

#### 3. State Operations

**GET /threads/{thread_id}/state**

Returns the **latest checkpoint** as a `StateSnapshot`:

```json
{
  "values": {"foo": "b", "bar": ["a", "b"]},
  "next": [],
  "config": {
    "configurable": {
      "thread_id": "thread_123",
      "checkpoint_id": "1ef663ba-28fe-6528-8002-5a559208592c"
    }
  },
  "metadata": {
    "source": "loop",
    "writes": {"node_b": {"foo": "b", "bar": ["b"]}},
    "step": 2
  },
  "created_at": "2024-08-29T19:19:38.821749+00:00",
  "tasks": []
}
```

**GET /threads/{thread_id}/state/{checkpoint_id}**

Returns a **specific checkpoint** by ID (time travel).

**POST /threads/{thread_id}/state**

Updates the thread state (manual intervention):

```json
{
  "values": {"foo": "modified"},
  "as_node": "node_a",  // optional, pretend the update came from this node
  "checkpoint_id": "..."  // optional, which checkpoint to update from
}
```

This enables:

- **Human-in-the-loop**: A human reviews intermediate state and modifies it before continuing.
- **Forking**: Update state from a historical checkpoint and resume execution, creating a new branch.

#### 4. History Access

**POST /threads/{thread_id}/history**

```json
{
  "limit": 10,
  "before": {"checkpoint_id": "..."},  // pagination cursor
  "metadata": {"step": {"$gte": 5}}  // filter by metadata
}
```

Returns a chronologically ordered list of all checkpoints for the thread (most recent first). Enables:

- **Debugging**: Inspect state evolution step-by-step.
- **Replay**: Re-execute from a specific checkpoint (time travel).

#### 5. Update

**PATCH /threads/{thread_id}**

```json
{
  "metadata": {"resolved": true},
  "ttl": 172800  // extend TTL
}
```

Updates metadata or TTL without affecting checkpoints.

#### 6. Deletion

**DELETE /threads/{thread_id}**

Deletes the thread and **all associated checkpoints**. This is irreversible.

### Relationships

#### To Runs

- **One-to-Many**: A thread can have multiple runs over time.
- **Sequential Execution**: Only **one run can execute on a thread at a time** (enforced by the task queue).
- Concurrent runs are handled via **multitask strategies** (reject, interrupt, rollback, enqueue).

#### To Checkpoints

- **One-to-Many**: A thread contains a linked list of checkpoints.
- Each run on the thread produces additional checkpoints.
- Checkpoints are **immutable**—updates create new checkpoints, forming a branching history if time travel is used.

#### To Assistants

- **Indirect**: Threads don't reference assistants directly.
- Runs executed on a thread can use different assistants, effectively switching configuration mid-conversation.

### Real-World Usage Patterns

#### Pattern 1: Persistent Conversations

```
Thread "user_123_session"
  - Checkpoint 1: User asks "What's my balance?"
  - Checkpoint 2: Agent authenticates, queries DB, responds
  - Checkpoint 3: User asks "Transfer $100"
  - Checkpoint 4: Agent confirms, executes transfer
```

The agent retains authentication and context across multiple turns.

#### Pattern 2: Human-in-the-Loop Approval

```
Thread "order_processing"
  - Checkpoint 1: Agent calculates order total
  - Checkpoint 2: Agent pauses (interrupt_before=["submit_order"])
  - Human reviews, modifies state: {"discount": 0.1}
  - Checkpoint 3: Agent resumes, submits order with discount
```

#### Pattern 3: Time Travel Debugging

```
Thread "bug_investigation"
  - Checkpoint history shows state evolution
  - Developer identifies wrong state at Checkpoint 5
  - Forks from Checkpoint 4, modifies state, re-executes
  - Produces new branch: Checkpoint 4 → Checkpoint 5' → Checkpoint 6'
```

### Scope of Implementation

A **real (non-stub) implementation** must:

1. **Persist checkpoints durably**: Use PostgreSQL, Redis, or similar backend.
2. **Enforce sequential execution**: Queue management to prevent concurrent runs on the same thread.
3. **Compute status dynamically**: Derive `status` from active run states.
4. **Support time travel**: Allow retrieval and forking from historical checkpoints.
5. **Handle metadata filtering**: Efficient search by metadata fields.
6. **Implement TTL expiration**: Background job to clean up expired threads.
7. **Manage checkpoint size**: Large states may require compression or external storage (S3).

### Key Design Decisions

#### Why Use `thread_id` as a String Instead of Always Generating UUIDs?

**LangGraph's Choice**: Allow clients to provide their own `thread_id`.

**Rationale**:
- **Idempotency**: Clients can use their own identifiers (e.g., `user_session_123`) to avoid duplicate threads.
- **Correlation**: Easier to correlate threads with external systems (user IDs, session IDs).
- **Flexibility**: Clients can implement their own ID schemes (namespacing, prefixing).

#### Why Immutable Checkpoints?

**LangGraph's Choice**: Checkpoints are never modified after creation.

**Rationale**:
- **Auditability**: Complete history is preserved.
- **Time Travel**: Historical states remain consistent.
- **Concurrency**: No need for locks—read-only access is safe.

Updates to state create **new checkpoints**, forming a linked list (or tree, if forking).

#### Why Enforce Sequential Execution on Threads?

**LangGraph's Choice**: At most one run can execute on a thread at any time.

**Rationale**:
- **State Consistency**: Prevents race conditions where concurrent runs overwrite each other's state.
- **Predictable Behavior**: Guarantees deterministic state evolution.
- **Multitask Strategies**: Explicit handling of "double-texting" via reject/interrupt/rollback/enqueue.

---

## Area 3: Runs & Crons

### Purpose: Execution Management and Scheduling

**Runs** solve the problem of **invoking and monitoring graph execution**, while **Crons** solve the problem of **scheduled, recurring invocations**. Together, they provide the execution layer of the LangGraph Platform API.

### Runs: Individual Executions

#### Core Problem Solved

When a client wants to execute a graph (e.g., invoke an AI agent), they need:

1. A way to **start execution** (with input and configuration)
2. A way to **monitor progress** (is it running? done? failed?)
3. A way to **receive outputs** (streaming or final result)
4. A way to **control execution** (cancel, pause, resume)

**Runs** provide a unified abstraction for all of these needs, whether the execution is **stateful (bound to a thread)** or **stateless (ephemeral, no history)**.

#### Core Concepts: Run Entity

| Property | Type | Description |
|----------|------|-------------|
| `run_id` | UUID | Unique identifier for this execution |
| `thread_id` | string or null | Thread if stateful, null if stateless |
| `assistant_id` | UUID | Which assistant (configuration) is used |
| `created_at` | ISO 8601 | When the run was created |
| `updated_at` | ISO 8601 | Last status change |
| `status` | enum | `pending`, `running`, `success`, `error`, `timeout`, `interrupted` |
| `metadata` | object | Arbitrary key-value pairs |
| `multitask_strategy` | enum | `reject`, `interrupt`, `rollback`, `enqueue` (if concurrent) |

#### Run Status Lifecycle

```
pending → running → success
                 ↘ error
                 ↘ timeout
                 ↘ interrupted (paused, can resume)
```

- **`pending`**: Run is queued, waiting for execution.
- **`running`**: Graph is actively executing.
- **`success`**: Execution completed without errors, reached END.
- **`error`**: Execution failed due to an exception.
- **`timeout`**: Execution exceeded a time limit.
- **`interrupted`**: Execution paused (human-in-the-loop or explicit interrupt).

#### Stateful vs Stateless Runs

##### Stateful Runs (Thread-Bound)

**Endpoint**: `POST /threads/{thread_id}/runs`

```json
{
  "assistant_id": "asst_123",
  "input": {"messages": [{"role": "user", "content": "Hello"}]},
  "stream_mode": ["values", "messages"]
}
```

- **Bound to a thread**: State is persisted across runs.
- **Checkpoints created**: Every super-step saves a checkpoint.
- **Sequential execution**: If another run is active on this thread, behavior depends on `multitask_strategy`.
- **Conversation continuity**: The agent "remembers" previous interactions.

##### Stateless Runs (Ephemeral)

**Endpoint**: `POST /runs`

```json
{
  "assistant_id": "asst_123",
  "input": {"messages": [{"role": "user", "content": "What's 2+2?"}]},
  "stream_mode": ["values"]
}
```

- **No thread**: State is not persisted.
- **No checkpoints**: Execution is transient.
- **Parallel execution**: Multiple stateless runs can execute simultaneously.
- **Use case**: One-off queries, stateless function calls.

#### Streaming Modes

Runs can be executed in three ways:

1. **Non-streaming** (`POST /threads/{thread_id}/runs`): Wait for completion, return final output.
2. **Streaming** (`POST /threads/{thread_id}/runs/stream`): Real-time SSE stream of execution events.
3. **Wait** (`POST /threads/{thread_id}/runs/wait`): Block until completion, return final output (like non-streaming, but with explicit wait semantics).

Streaming modes control **what** is streamed:

| Mode | Description |
|------|-------------|
| `values` | Full state after each super-step |
| `updates` | State deltas (updates) after each super-step |
| `messages` | LLM tokens + metadata (token-by-token streaming) |
| `messages-tuple` | Tuples of (message, metadata) for LLM outputs |
| `events` | All events (nodes, edges, LLM calls) |
| `debug` | Maximum verbosity (all state, tasks, metadata) |
| `custom` | User-defined custom events emitted from within nodes |
| `tasks` | Task execution details |
| `checkpoints` | Checkpoint creation events |

**Multiple modes can be combined** in a single request:

```json
{
  "stream_mode": ["values", "messages", "debug"]
}
```

The SSE stream will emit events tagged with the mode name.

#### Multitask Strategies: Handling Concurrent Runs on the Same Thread

**Problem**: A user sends a second message while the agent is still processing the first. This is the "double-texting" problem.

**Solution**: Multitask strategies define how to handle concurrent runs on the same thread.

| Strategy | Behavior |
|----------|----------|
| `reject` | **Reject the new run** with a 409 error. The original run continues uninterrupted. |
| `interrupt` | **Pause the original run** (status → `interrupted`), start the new run. The original run can be resumed later. |
| `rollback` | **Cancel and delete the original run**, start the new run from the last checkpoint before the original started. |
| `enqueue` | **Queue the new run** behind the original. Runs execute sequentially in order. |

**Example**:

```json
{
  "assistant_id": "asst_123",
  "input": {"messages": [{"role": "user", "content": "Second question"}]},
  "multitask_strategy": "enqueue"
}
```

If a run is already active, this new run will wait in the queue.

#### Run Parameters (Comprehensive)

When creating a run, you can specify:

| Parameter | Description |
|-----------|-------------|
| `input` | Input data for the graph (e.g., `{"messages": [...]}`) |
| `command` | Commands for resuming interrupted runs (`goto`, `update`, `resume`) |
| `stream_mode` | Which streaming modes to enable (array) |
| `stream_subgraphs` | Include subgraph events in the stream (boolean) |
| `stream_resumable` | Keep event log for reconnection (boolean) |
| `metadata` | Arbitrary metadata |
| `config` | Runtime configuration overrides (merged with assistant config) |
| `context` | Additional context data |
| `checkpoint` | Resume from a specific checkpoint |
| `checkpoint_id` | Specific checkpoint ID to resume from |
| `checkpoint_during` | Save checkpoints during specific node names |
| `interrupt_before` | Pause before executing these node names (array) |
| `interrupt_after` | Pause after executing these node names (array) |
| `feedback_keys` | Keys to collect human feedback on (array) |
| `webhook` | URL to POST run completion events to |
| `multitask_strategy` | How to handle concurrent runs |
| `if_not_exists` | Behavior if thread doesn't exist (`create`, `error`) |
| `on_disconnect` | What to do if client disconnects (`cancel`, `continue`) |
| `on_completion` | Post-completion action (`delete_thread`, `keep`) |
| `after_seconds` | Delay execution by N seconds |
| `durability` | Whether to persist run data |

### Lifecycle

#### 1. Creation (Non-Streaming)

**POST /threads/{thread_id}/runs**

- **Queue**: Run is added to the durable task queue with status `pending`.
- **Worker Pickup**: A queue worker acquires the run, sets status to `running`.
- **Execution**: Graph executes, checkpoints are saved.
- **Completion**: Status transitions to `success`, `error`, or `interrupted`.

#### 2. Creation (Streaming)

**POST /threads/{thread_id}/runs/stream**

- Same as above, but the response is an **SSE stream** instead of JSON.
- Events are emitted in real-time as the graph executes.
- Stream ends with an `end` event.

#### 3. Monitoring

**GET /threads/{thread_id}/runs/{run_id}**

Returns the run object with current status.

**GET /threads/{thread_id}/runs?status=running**

Lists all runs on a thread, optionally filtered by status.

#### 4. Cancellation

**POST /threads/{thread_id}/runs/{run_id}/cancel?wait=true&action=interrupt**

- `wait=true`: Block until cancellation completes.
- `action`: `interrupt` (pause, can resume) or `rollback` (delete, cannot resume).

**POST /runs/cancel**

Bulk cancellation by thread_id, run_ids, or status filter.

#### 5. Joining (Wait for Completion)

**GET /threads/{thread_id}/runs/{run_id}/join**

Blocks until the run completes, then returns the final output. Equivalent to `/runs/wait` but for an already-started run.

#### 6. Stream Join (Reconnection)

**GET /threads/{thread_id}/runs/{run_id}/stream?last_event_id=123**

Joins an active stream (or resumes a disconnected stream) using SSE's `Last-Event-ID` header for automatic reconnection.

### Crons: Scheduled Recurring Runs

#### Core Problem Solved

Many AI agent use cases require **scheduled, recurring executions**:

- Daily health log summaries
- Nightly data scrapes with AI analysis
- Hourly monitoring and alerting
- Weekly report generation

**Crons** provide a declarative way to schedule runs without building custom scheduling infrastructure.

#### Core Concepts: Cron Entity

| Property | Type | Description |
|----------|------|-------------|
| `cron_id` | UUID | Unique identifier |
| `assistant_id` | UUID | Which assistant to use |
| `thread_id` | string or null | Thread for stateful crons, null for stateless |
| `schedule` | string | Cron syntax (e.g., `"0 9 * * *"` = daily at 9 AM UTC) |
| `enabled` | boolean | Whether the cron is active |
| `created_at` | ISO 8601 | Creation timestamp |
| `updated_at` | ISO 8601 | Last modification |
| `next_run_date` | ISO 8601 | When the next execution is scheduled |
| `end_time` | ISO 8601 | Optional, stop scheduling after this time |
| `metadata` | object | Arbitrary metadata |
| `payload` | object | Run parameters (input, config, stream_mode, etc.) |
| `on_run_completed` | enum | `delete_thread`, `keep` (for stateful crons) |

#### Stateful vs Stateless Crons

##### Stateful Crons (Thread-Bound)

**Endpoint**: `POST /threads/{thread_id}/runs/crons`

```json
{
  "schedule": "0 9 * * *",
  "assistant_id": "asst_123",
  "input": {"messages": [{"role": "user", "content": "Daily summary"}]},
  "on_run_completed": "keep"
}
```

- **Bound to a thread**: Each cron execution appends to the thread's checkpoint history.
- **Cumulative state**: The agent "remembers" previous cron runs.
- **Use case**: Daily conversational summaries where context accumulates.

##### Stateless Crons

**Endpoint**: `POST /runs/crons`

```json
{
  "schedule": "0 * * * *",
  "assistant_id": "asst_123",
  "input": {"query": "Check system health"}
}
```

- **No thread**: Each cron execution is independent.
- **Fresh state**: No memory between runs.
- **Use case**: Monitoring, alerting, one-off reports.

**Alternative**: Stateless crons can also be configured to **create a new thread for each execution**:

```json
{
  "schedule": "0 9 * * *",
  "assistant_id": "asst_123",
  "input": {"date": "today"},
  "on_run_completed": "delete_thread"
}
```

This creates a new thread per run and deletes it after completion (pseudo-stateless).

### Lifecycle

#### 1. Creation

**POST /threads/{thread_id}/runs/crons**

- Validates `schedule` syntax.
- Computes `next_run_date`.
- Stores the cron configuration.
- The scheduling system (not part of the API) watches for crons and triggers runs at the scheduled times.

#### 2. Retrieval

**POST /runs/crons/search**

```json
{
  "assistant_id": "asst_123",
  "enabled": true,
  "limit": 10
}
```

Searches crons by assistant, thread, enabled status, etc.

#### 3. Update

**PATCH /runs/crons/{cron_id}**

```json
{
  "enabled": false,
  "schedule": "0 10 * * *"
}
```

Updates the cron configuration. Changes take effect on the next scheduled run.

#### 4. Deletion

**DELETE /runs/crons/{cron_id}**

Deletes the cron. In-flight runs (if any) continue but no future runs are scheduled.

### Relationships

#### Runs to Threads

- **Stateful runs**: One-to-one (each run operates on one thread).
- **Stateless runs**: No relationship (no thread).

#### Runs to Assistants

- **Many-to-one**: Multiple runs use the same assistant configuration.

#### Crons to Runs

- **One-to-many**: A cron creates multiple runs over time (one per trigger).

#### Crons to Threads

- **Stateful crons**: One-to-one (all runs append to the same thread).
- **Stateless crons**: No relationship.

### Real-World Usage Patterns

#### Pattern 1: Daily Conversational Summary (Stateful Cron)

```
Cron "daily_health_log"
  - Thread "user_123_health"
  - Schedule: "0 9 * * *" (9 AM daily)
  - Input: {"action": "summarize_yesterday"}
  - Each run appends to the thread, building a cumulative health timeline
```

#### Pattern 2: Hourly Monitoring (Stateless Cron)

```
Cron "system_monitor"
  - No thread
  - Schedule: "0 * * * *" (every hour)
  - Input: {"action": "check_health"}
  - Each run is independent, no state accumulation
```

#### Pattern 3: Weekly Report with Fresh Context (Stateless Cron, New Thread Per Run)

```
Cron "weekly_report"
  - No persistent thread
  - Schedule: "0 9 * * 1" (Monday at 9 AM)
  - on_run_completed: "delete_thread"
  - Each run creates a new thread, generates report, deletes thread
```

### Scope of Implementation

A **real (non-stub) implementation** must:

#### For Runs:

1. **Task queue with durable execution**: Use a job queue (e.g., Celery, Bull, Temporal) to ensure runs survive server restarts.
2. **Concurrency control**: Enforce multitask strategies (reject/interrupt/rollback/enqueue).
3. **Status transitions**: Accurately track run lifecycle (pending → running → success/error/interrupted).
4. **Checkpoint integration**: Coordinate with the checkpointer to save state at every super-step.
5. **SSE streaming**: Emit events in real-time with proper event formatting.
6. **Webhook delivery**: POST to external URLs on run completion (if `webhook` is specified).
7. **Timeout enforcement**: Cancel runs that exceed time limits.

#### For Crons:

1. **Cron scheduler**: Use a scheduling library (e.g., node-cron, APScheduler) to trigger runs at scheduled times.
2. **Time zone handling**: Cron expressions are in UTC; document clearly.
3. **Failure handling**: If a cron run fails, decide whether to retry or skip to the next scheduled time.
4. **`next_run_date` computation**: Calculate and store the next execution time.
5. **`end_time` enforcement**: Stop scheduling after the specified end time.
6. **Thread cleanup**: Implement `on_run_completed` logic (delete or keep threads).

### Key Design Decisions

#### Why Separate Stateful and Stateless Endpoints?

**LangGraph's Choice**: Different endpoints for thread-bound and threadless runs.

**Rationale**:
- **Clarity**: Explicit distinction between stateful and stateless operations.
- **API design**: REST best practice—`/threads/{id}/runs` clearly indicates a sub-resource relationship.
- **Validation**: Different parameter requirements (e.g., stateless runs must provide full input, stateful runs can omit it if resuming).

#### Why Multiple Streaming Modes?

**LangGraph's Choice**: Support `values`, `updates`, `messages`, `debug`, `custom` simultaneously.

**Rationale**:
- **Flexibility**: Different use cases need different levels of detail.
  - `messages`: Chat UI needs token-by-token LLM output.
  - `values`: State visualization needs full state after each step.
  - `debug`: Developers need deep introspection during troubleshooting.
- **Performance**: Clients can request only the data they need.

#### Why Multitask Strategies Instead of Always Rejecting or Always Queuing?

**LangGraph's Choice**: Let the client choose behavior via `multitask_strategy`.

**Rationale**:
- **Use-case dependent**: Some applications want to reject (e.g., strict sequential processing), others want to enqueue (e.g., batch processing).
- **Transparency**: Explicit parameter prevents surprising default behavior.
- **Control**: Clients can implement their own concurrency policies at the application level.

---

## Area 4: Store

### Purpose: Cross-Thread Persistent Memory

**Store** solves the problem of **sharing data across threads and conversations**. While threads provide per-conversation state management, many AI applications need to:

1. **Remember user preferences** across multiple conversations
2. **Share knowledge** between different agents or users
3. **Persist long-term facts** that don't fit into thread state (which is tied to graph schema)

The Store API provides a **flexible, namespace-organized key-value store** with search capabilities, enabling cross-thread memory.

### Core Problem Solved

Consider a personal assistant agent. The user has multiple conversations (threads) over time:

- Thread 1: "My favorite color is blue."
- Thread 2: "What's my favorite color?" (Agent should remember from Thread 1)
- Thread 3: "Recommend a shirt." (Agent should use color preference)

Without the Store, each thread is isolated—Thread 2 has no access to Thread 1's state. The Store provides a **shared memory layer** where the agent can:

- Store: `namespace=["user", "user_123"], key="favorite_color", value="blue"`
- Retrieve: `namespace=["user", "user_123"], key="favorite_color"` → `"blue"`

### Core Concepts

#### Store Item Entity

| Property | Type | Description |
|----------|------|-------------|
| `namespace` | array of strings | Hierarchical namespace (e.g., `["users", "user_123", "preferences"]`) |
| `key` | string | Item key within the namespace |
| `value` | any (JSON-serializable) | The stored value (string, number, object, array, etc.) |
| `created_at` | ISO 8601 | Creation timestamp |
| `updated_at` | ISO 8601 | Last modification |
| `ttl` | integer (seconds) or null | Time-to-live (optional, for automatic expiration) |
| `index` | object or array | Optional, structured data for search indexing |

#### Namespaces: Hierarchical Organization

Namespaces are **arrays of strings** representing a hierarchical path:

```json
["organization", "acme_corp", "users", "user_123", "settings"]
```

This enables:

- **Logical grouping**: Organize data by organization, user, category, etc.
- **Access control**: Grant permissions based on namespace prefixes.
- **Bulk operations**: Search or delete all items under a namespace prefix.

#### Item Identity

An item is uniquely identified by the combination of `namespace` + `key`:

- `namespace=["users", "user_123"], key="favorite_color"` → one item
- `namespace=["users", "user_456"], key="favorite_color"` → different item

#### Index Field (Optional)

The `index` field enables **structured search**. It can be:

- An **object** with fields to index:

  ```json
  {
    "index": {
      "tags": ["preference", "color"],
      "category": "ui"
    }
  }
  ```

- An **array** (simple list of values):

  ```json
  {
    "index": ["preference", "color"]
  }
  ```

When stored, the system indexes these fields, enabling search queries like:

```json
{
  "filter": {"category": "ui"}
}
```

#### TTL (Time-to-Live)

Items can have an expiration time:

```json
{
  "namespace": ["cache"],
  "key": "temp_data",
  "value": "...",
  "ttl": 3600  // expires in 1 hour
}
```

After the TTL expires, the item is automatically deleted (background cleanup job).

### Lifecycle

#### 1. Creation / Update (Upsert)

**PUT /store/items**

```json
{
  "namespace": ["users", "user_123"],
  "key": "favorite_color",
  "value": "blue",
  "index": {"category": "preference"},
  "ttl": null
}
```

- If the item exists (same namespace + key), it is **updated** (`updated_at` changes).
- If the item doesn't exist, it is **created** (`created_at` and `updated_at` set).
- This is an **upsert** (update or insert) operation.

#### 2. Retrieval (Get)

**GET /store/items?namespace=["users","user_123"]&key=favorite_color&refresh_ttl=false**

Returns the item:

```json
{
  "namespace": ["users", "user_123"],
  "key": "favorite_color",
  "value": "blue",
  "created_at": "2026-03-09T10:00:00Z",
  "updated_at": "2026-03-09T10:00:00Z"
}
```

- `refresh_ttl=true`: Resets the TTL countdown (useful for cache scenarios—accessing the item extends its lifetime).

#### 3. Search

**POST /store/items/search**

```json
{
  "namespace_prefix": ["users"],
  "filter": {"category": "preference"},
  "limit": 10,
  "offset": 0,
  "query": "blue",
  "refresh_ttl": false
}
```

- `namespace_prefix`: Match all items under this namespace path (e.g., `["users"]` matches `["users", "user_123"]`, `["users", "user_456"]`, etc.).
- `filter`: Match items where indexed fields equal specified values.
- `query`: Full-text or semantic search (if the backend supports vector search).
- Returns an array of `SearchItem` objects (includes `score` for relevance ranking).

**Example response**:

```json
[
  {
    "namespace": ["users", "user_123"],
    "key": "favorite_color",
    "value": "blue",
    "score": 0.95,
    "created_at": "...",
    "updated_at": "..."
  }
]
```

#### 4. List Namespaces

**POST /store/namespaces**

```json
{
  "prefix": ["users"],
  "suffix": ["settings"],
  "max_depth": 2,
  "limit": 100,
  "offset": 0
}
```

Returns a list of namespaces that match the criteria:

```json
[
  ["users", "user_123", "settings"],
  ["users", "user_456", "settings"]
]
```

This enables **namespace discovery** (e.g., "What users have stored settings?").

#### 5. Deletion

**DELETE /store/items**

```json
{
  "namespace": ["users", "user_123"],
  "key": "favorite_color"
}
```

Deletes the item. Returns 204 (No Content) on success.

### Relationships

#### To Threads

- **No direct relationship**: Store items are **independent of threads**.
- Agents running on threads can **read and write** to the Store.
- Use case: An agent in Thread A writes user preferences to the Store; an agent in Thread B reads those preferences.

#### To Runs

- **No direct relationship**: Runs access the Store via graph nodes.
- The Store is **orthogonal** to execution—it's a persistent data layer, not an execution artifact.

#### To Assistants

- **No direct relationship**: The Store is global (or scoped by namespace).
- Different assistants can share the same Store data (e.g., multiple agents accessing the same user preferences).

### Real-World Usage Patterns

#### Pattern 1: User Preferences

```json
{
  "namespace": ["users", "user_123", "preferences"],
  "key": "theme",
  "value": "dark"
}
```

All agents serving this user can read the theme preference.

#### Pattern 2: Knowledge Base

```json
{
  "namespace": ["kb", "company_policies"],
  "key": "vacation_policy",
  "value": "Employees receive 15 days of PTO per year...",
  "index": {"tags": ["hr", "policy"]}
}
```

Agents can search the knowledge base: `filter={"tags": "hr"}`.

#### Pattern 3: Session Data (with TTL)

```json
{
  "namespace": ["sessions"],
  "key": "session_abc123",
  "value": {"user_id": "user_123", "expires_at": "..."},
  "ttl": 1800  // 30 minutes
}
```

After 30 minutes, the session is automatically cleaned up.

#### Pattern 4: Multi-User Shared Memory

```json
{
  "namespace": ["organizations", "acme_corp", "shared"],
  "key": "company_news",
  "value": "Q4 results were excellent!"
}
```

All users in the "acme_corp" organization can access this shared data.

### Scope of Implementation

A **real (non-stub) implementation** must:

1. **Persistence backend**: Use PostgreSQL, Redis, MongoDB, or a dedicated document store.
2. **Namespace indexing**: Efficient prefix matching (e.g., B-tree or trie structure).
3. **Full-text search**: Integrate with Elasticsearch, PostgreSQL full-text search, or similar for `query` parameter.
4. **Vector search (optional)**: For semantic search, integrate with vector databases (Pinecone, Weaviate, pgvector).
5. **TTL expiration**: Background job to delete expired items.
6. **Composite key indexing**: Fast lookups by (namespace, key).
7. **Access control**: If multi-tenant, enforce namespace-based permissions.
8. **Index field support**: Store and query structured `index` data.

### Key Design Decisions

#### Why Arrays for Namespaces Instead of Dot-Separated Strings?

**LangGraph's Choice**: `["users", "user_123"]` instead of `"users.user_123"`.

**Rationale**:
- **Type safety**: Arrays enforce structure (no ambiguity about delimiters).
- **Prefix matching**: Easier to implement efficient prefix queries (SQL `LIKE 'users/%'` or array containment).
- **Flexibility**: Namespace components can contain dots, slashes, or other characters without escaping.

#### Why No Explicit "Get All Items in Namespace" Endpoint?

**LangGraph's Choice**: Use `POST /store/items/search` with `namespace_prefix`.

**Rationale**:
- **Scalability**: Explicit pagination and filtering prevent accidental bulk reads of millions of items.
- **Consistency**: All search operations use the same endpoint, reducing API surface area.

#### Why Support Both Object and Array for `index`?

**LangGraph's Choice**: Allow both structured and simple indexing.

**Rationale**:
- **Flexibility**: Simple use cases (e.g., tagging) use arrays; complex use cases (e.g., structured metadata) use objects.
- **Developer experience**: Matches common usage patterns (tags as arrays, metadata as objects).

---

## End-to-End Workflow: How All 4 Areas Work Together

### Scenario: Multi-Turn Customer Support Chatbot

Let's walk through a complete example showing how Assistants, Threads, Runs, and Store interact.

#### Setup Phase

1. **Deploy a Graph**: Deploy a customer support graph with `graph_id="support_agent"`.
2. **Create Assistants**:
   - **Default Assistant** (auto-created): Basic configuration.
   - **VIP Assistant**: Custom configuration with priority routing and personalized prompts.
   - **Escalation Assistant**: Configuration for handling escalated cases.

#### User Interaction Flow

**User "user_123" starts a conversation:**

1. **Create Thread**:

   ```http
   POST /threads
   {
     "metadata": {"user_id": "user_123", "channel": "web"}
   }
   ```

   Response: `{"thread_id": "thread_abc"}`

2. **Store User Preferences** (first-time setup):

   ```http
   PUT /store/items
   {
     "namespace": ["users", "user_123", "preferences"],
     "key": "language",
     "value": "es"
   }
   ```

3. **First Run** (User: "¿Cuál es mi saldo?"):

   ```http
   POST /threads/thread_abc/runs/stream
   {
     "assistant_id": "asst_vip",
     "input": {"messages": [{"role": "user", "content": "¿Cuál es mi saldo?"}]},
     "stream_mode": ["messages", "values"]
   }
   ```

   **What happens**:
   - Run is created with status `pending`.
   - Task queue picks up the run, status → `running`.
   - Thread status → `busy`.
   - Graph executes:
     - Node 1: Reads user language from Store (`namespace=["users", "user_123", "preferences"]`).
     - Node 2: Authenticates user (saves auth token in thread state).
     - Node 3: Queries balance API.
     - Node 4: Responds in Spanish: "Tu saldo es $1,234.56".
   - **Checkpoint created after each super-step** (4 checkpoints total).
   - SSE events streamed:
     - `event: metadata, data: {"run_id": "...", "thread_id": "thread_abc"}`
     - `event: messages, data: {"content": "Tu", ...}` (token-by-token)
     - `event: messages, data: {"content": " saldo", ...}`
     - `event: values, data: {"state": {"balance": 1234.56, ...}}`
     - `event: end, data: null`
   - Run status → `success`.
   - Thread status → `idle`.

4. **Second Run** (User: "Transfiere $100 a ahorros"):

   ```http
   POST /threads/thread_abc/runs
   {
     "assistant_id": "asst_vip",
     "input": {"messages": [{"role": "user", "content": "Transfiere $100 a ahorros"}]}
   }
   ```

   **What happens**:
   - Graph reads thread state (latest checkpoint).
   - User is **already authenticated** (auth token in state from previous run).
   - Graph executes transfer logic.
   - **New checkpoints appended** to thread history.
   - Response: "Transferencia completada."

5. **Time Travel Debugging** (Support agent reviews conversation):

   ```http
   POST /threads/thread_abc/history
   {
     "limit": 10
   }
   ```

   Response: List of all checkpoints (8 total—4 from Run 1, 4 from Run 2).

   Support agent sees the full state evolution and identifies no issues.

6. **Store Interaction History** (for analytics):

   ```http
   PUT /store/items
   {
     "namespace": ["analytics", "user_123"],
     "key": "last_interaction",
     "value": {
       "timestamp": "2026-03-09T10:30:00Z",
       "action": "transfer",
       "amount": 100
     },
     "index": {"action": "transfer"}
   }
   ```

7. **Scheduled Daily Summary** (Cron):

   ```http
   POST /threads/thread_abc/runs/crons
   {
     "schedule": "0 9 * * *",
     "assistant_id": "asst_vip",
     "input": {"messages": [{"role": "system", "content": "Generate daily summary"}]},
     "on_run_completed": "keep"
   }
   ```

   Every day at 9 AM UTC, a run is triggered on `thread_abc`, generating a summary of the previous day's activity and appending it to the thread.

### Data Flow Diagram

```
┌────────────┐
│  Client    │
└─────┬──────┘
      │ 1. POST /threads (create)
      ▼
┌────────────┐
│  Thread    │ ◄──────────────┐
│  thread_abc│                │
└─────┬──────┘                │
      │ 2. POST /runs/stream  │
      ▼                       │
┌────────────┐                │
│  Run       │                │
│  run_123   │                │
└─────┬──────┘                │
      │ 3. Execute graph      │
      ▼                       │
┌────────────────────────────┐│
│  Graph Nodes               ││
│  - Read Store (preferences)││
│  - Authenticate            ││
│  - Query Balance           ││
│  - Respond                 ││
└────┬───────────────────────┘│
     │ 4. Save checkpoints     │
     └─────────────────────────┘
     │ 5. Write to Store (analytics)
     ▼
┌────────────┐
│  Store     │
│  (shared)  │
└────────────┘
```

---

## SSE Streaming Deep Dive

### Why SSE for Agent Applications?

**Problem**: AI agent workflows are long-running (seconds to minutes) and involve multiple steps (LLM calls, tool executions, state updates). Clients need **real-time feedback** to:

1. Display LLM responses token-by-token (better UX).
2. Show progress indicators ("Step 2 of 5: Querying database...").
3. Enable responsive UIs (users can interrupt or cancel).

**Solution**: **Server-Sent Events (SSE)**, a standard HTTP protocol for server-to-client streaming.

### SSE vs WebSockets vs Polling

| Feature | SSE | WebSockets | Polling |
|---------|-----|------------|---------|
| **Directionality** | Server → Client (one-way) | Bidirectional | Client → Server (request/response) |
| **Protocol** | HTTP (standard REST) | Separate protocol (upgrade) | HTTP |
| **Reconnection** | Automatic (browser built-in) | Manual | N/A (stateless) |
| **Complexity** | Low | Medium | Low |
| **Use Case** | Real-time updates from server | Chat, gaming (bidirectional) | Inefficient for real-time |

**Why LangGraph chose SSE**:

- **One-way streaming** is sufficient (client sends input via POST, server streams output).
- **Standard HTTP** simplifies deployment (works with CDNs, load balancers).
- **Automatic reconnection** is built into browsers (`EventSource` API).

### SSE Format

SSE uses the `text/event-stream` content type. Each event is formatted as:

```
event: <event_type>
data: <json_payload>
id: <event_id>

```

**Example**:

```
event: metadata
data: {"run_id": "run_123", "thread_id": "thread_abc"}
id: 1

event: messages
data: {"content": "Hello", "type": "ai"}
id: 2

event: values
data: {"state": {"foo": "bar"}}
id: 3

event: end
data: null
id: 4

```

### LangGraph SSE Event Types

| Event Type | Description | Data Payload |
|------------|-------------|--------------|
| `metadata` | Run and thread information | `{"run_id": "...", "thread_id": "..."}` |
| `values` | Full state after a super-step | `{"state": {...}}` |
| `updates` | State delta after a super-step | `{"node_name": {"foo": "bar"}}` |
| `messages` | LLM token (token-by-token) | `{"content": "token", "type": "ai", ...}` |
| `messages-tuple` | Tuple of (message, metadata) | `[{"role": "ai", "content": "..."}, {...}]` |
| `events` | All node/edge execution events | `{"event": "on_node_start", "node": "node_a", ...}` |
| `debug` | Detailed execution trace | `{"step": 1, "state": {...}, "tasks": [...], ...}` |
| `custom` | User-defined events from nodes | `{"custom_data": "..."}` |
| `tasks` | Task execution details | `{"task_id": "...", "status": "...", ...}` |
| `checkpoints` | Checkpoint creation events | `{"checkpoint_id": "...", "state": {...}}` |
| `end` | Stream completion | `null` |
| `error` | Execution error | `{"message": "...", "traceback": "..."}` |

### Reconnection and Resumable Streams

#### Problem: Network Hiccups

If the client's connection drops mid-stream, the client needs to **resume from where it left off** without losing events.

#### Solution: `Last-Event-ID` Header

1. **Server assigns IDs**: Each SSE event includes an `id` field (incremental).
2. **Client tracks last ID**: The `EventSource` API (browser) or SDK automatically tracks the last received event ID.
3. **Reconnection**: On disconnect, the client reconnects with the `Last-Event-ID` header.
4. **Server resumes**: The server replays events starting **after** the last acknowledged ID.

**Example**:

```http
GET /threads/thread_abc/runs/run_123/stream
Last-Event-ID: 5
```

Server response: Events 6, 7, 8, ...

#### Resumable vs Non-Resumable Streams

- **`stream_resumable=true`**: The server **keeps the full event log** in memory/storage for the duration of the stream. Reconnection is supported.
- **`stream_resumable=false`**: Events are **consumed and discarded**. Reconnection is not supported (client must restart from the beginning).

**Trade-off**:

- Resumable: Higher memory usage, better reliability.
- Non-resumable: Lower memory usage, faster cleanup.

### Streaming Modes in Practice

#### Example: Chat Application (Token-by-Token)

```http
POST /threads/thread_abc/runs/stream
{
  "assistant_id": "asst_123",
  "input": {"messages": [{"role": "user", "content": "Tell me a joke"}]},
  "stream_mode": ["messages"]
}
```

SSE stream:

```
event: metadata
data: {"run_id": "run_123", "thread_id": "thread_abc"}
id: 1

event: messages
data: {"content": "Why", "type": "ai"}
id: 2

event: messages
data: {"content": " did", "type": "ai"}
id: 3

event: messages
data: {"content": " the", "type": "ai"}
id: 4

...

event: end
data: null
id: 25
```

The client displays each token as it arrives, building the full message incrementally.

#### Example: State Visualization (Full State)

```http
POST /threads/thread_abc/runs/stream
{
  "assistant_id": "asst_123",
  "input": {"messages": [...]},
  "stream_mode": ["values"]
}
```

SSE stream:

```
event: metadata
data: {"run_id": "run_123"}
id: 1

event: values
data: {"foo": "", "bar": []}
id: 2

event: values
data: {"foo": "a", "bar": ["a"]}
id: 3

event: values
data: {"foo": "b", "bar": ["a", "b"]}
id: 4

event: end
data: null
id: 5
```

The client visualizes state evolution step-by-step.

#### Example: Debugging (Multiple Modes)

```http
POST /threads/thread_abc/runs/stream
{
  "assistant_id": "asst_123",
  "input": {"messages": [...]},
  "stream_mode": ["values", "updates", "debug"]
}
```

SSE stream includes events from **all three modes**, tagged by event type:

```
event: metadata
...

event: values
data: {"foo": "a"}
id: 2

event: updates
data: {"node_a": {"foo": "a"}}
id: 3

event: debug
data: {"step": 1, "node": "node_a", "state": {...}, "tasks": [...]}
id: 4

event: values
data: {"foo": "b"}
id: 5

...
```

The client can process each event type independently.

### Implementation Requirements

A **real SSE streaming implementation** must:

1. **Set correct headers**:
   ```
   Content-Type: text/event-stream
   Cache-Control: no-cache
   Connection: keep-alive
   ```

2. **Emit properly formatted events**: `event:`, `data:`, `id:`, blank line separator.

3. **Handle client disconnection**:
   - Detect when the client closes the connection.
   - If `stream_resumable=true`, keep the event log.
   - If `on_disconnect=cancel`, cancel the run.

4. **Support `Last-Event-ID`**:
   - Parse the header on reconnection.
   - Replay events from the specified ID.

5. **Flush events promptly**: Don't buffer—send each event immediately for low latency.

6. **Emit `end` event**: Signal stream completion.

7. **Emit `error` event**: If the run fails, send an error event before closing.

---

## State Management Architecture

### The Three Layers of State

LangGraph Platform API manages state at **three distinct layers**:

#### 1. Graph State (Per Execution)

- **Scope**: Single run execution.
- **Schema**: Defined by the graph's `State` TypedDict (or equivalent).
- **Lifecycle**: Created at run start, updated by nodes, persisted as checkpoints.
- **Example**:

  ```python
  class State(TypedDict):
      messages: list[Message]
      balance: float
      authenticated: bool
  ```

- **Access**: Within graph nodes via `state` parameter.

#### 2. Thread State (Per Conversation)

- **Scope**: Accumulated state across multiple runs on a thread.
- **Persistence**: Checkpoint history (linked list of `StateSnapshot` objects).
- **Lifecycle**: Created when the thread is created, grows with each run, can be manually updated or forked.
- **Example**: A customer support thread retains authentication status, conversation history, and context across multiple interactions.
- **Access**: Via API (`GET /threads/{id}/state`) or within nodes (latest checkpoint is loaded at run start).

#### 3. Store State (Cross-Thread, Global)

- **Scope**: Shared across all threads (or scoped by namespace).
- **Persistence**: Key-value store with hierarchical namespaces.
- **Lifecycle**: Explicitly created/updated/deleted via Store API, optionally with TTL.
- **Example**: User preferences, knowledge base articles, session data.
- **Access**: Via API (`PUT /store/items`, `GET /store/items`, `POST /store/items/search`) or within nodes (graph code calls the Store SDK).

### State Flow During a Run

```
1. Run starts on Thread "thread_abc"
   └─> Load latest checkpoint from thread → Graph State (initial)

2. Node A executes
   ├─> Read from Store (user preferences)
   ├─> Update Graph State (add data)
   └─> Save Checkpoint 1 → Thread State

3. Node B executes
   ├─> Read Graph State (from Checkpoint 1)
   ├─> Update Graph State (process data)
   └─> Save Checkpoint 2 → Thread State

4. Node C executes
   ├─> Read Graph State (from Checkpoint 2)
   ├─> Write to Store (analytics)
   ├─> Update Graph State (final result)
   └─> Save Checkpoint 3 → Thread State

5. Run completes
   └─> Thread State contains Checkpoints 1, 2, 3 (full history)
```

### Checkpoint Structure Deep Dive

Each checkpoint is a **complete snapshot** of the graph state at a specific point in time, plus metadata about execution:

```python
StateSnapshot(
    values={...},               # Full state at this point
    next=("node_b",),           # Next node(s) to execute
    config={
        "configurable": {
            "thread_id": "thread_abc",
            "checkpoint_id": "uuid...",
            "checkpoint_ns": ""     # Namespace (for subgraphs)
        }
    },
    metadata={
        "source": "loop",           # How this checkpoint was created ("input", "loop", "update")
        "writes": {                 # What was written to state in this step
            "node_a": {"foo": "a"}
        },
        "step": 1                   # Step number in execution
    },
    created_at="2026-03-09T10:00:00Z",
    parent_config={...},           # Reference to previous checkpoint (linked list)
    tasks=(                        # Next scheduled tasks
        PregelTask(
            id="task_uuid",
            name="node_b",
            error=None,
            interrupts=()
        ),
    )
)
```

### Checkpoint Parents: Linked List Structure

Checkpoints form a **singly linked list** via `parent_config`:

```
Checkpoint 0 (START)
    ↓ parent_config
Checkpoint 1 (after node_a)
    ↓ parent_config
Checkpoint 2 (after node_b)
    ↓ parent_config
Checkpoint 3 (after node_c, END)
```

This enables:

- **History traversal**: Walk backward through the checkpoint chain.
- **Time travel**: Jump to any checkpoint and inspect state.
- **Forking**: Update state at Checkpoint 2, resume execution, creating a new branch:

  ```
  Checkpoint 0 → Checkpoint 1 → Checkpoint 2 → Checkpoint 3 (original)
                                         ↘
                                          Checkpoint 2' → Checkpoint 3' (fork)
  ```

### State Reducers (Advanced)

LangGraph supports **state reducers** for specific channels (fields) of the state:

```python
from operator import add

class State(TypedDict):
    messages: Annotated[list[Message], add]  # Reducer: concatenate lists
```

**Behavior**:

- Node A returns `{"messages": [msg1]}`.
- Node B returns `{"messages": [msg2]}`.
- Final state: `{"messages": [msg1, msg2]}` (concatenated, not overwritten).

This is how **conversation history** is accumulated in chat applications.

### State Updates: Merge vs Replace

By default, node outputs are **merged** into the state:

- Current state: `{"foo": "a", "bar": 1}`
- Node returns: `{"bar": 2, "baz": 3}`
- New state: `{"foo": "a", "bar": 2, "baz": 3}` (merge)

For channels with reducers, the reducer function is applied instead of simple replacement.

---

## Stateful vs Stateless Operations

### Key Distinction

| Aspect | Stateful (Thread-Bound) | Stateless (No Thread) |
|--------|-------------------------|------------------------|
| **Endpoint** | `POST /threads/{id}/runs` | `POST /runs` |
| **State Persistence** | Yes, checkpoints saved | No, transient execution |
| **Memory** | Retains state across runs | No memory between runs |
| **Use Case** | Conversations, multi-turn workflows | One-off queries, pure functions |
| **Concurrency** | Sequential (one run at a time per thread) | Parallel (unlimited) |
| **Multitask Strategy** | Applicable (reject, interrupt, etc.) | Not applicable |
| **Checkpoint Access** | Available after execution | Not available |

### When to Use Stateful

1. **Multi-turn conversations**: Chat applications, customer support.
2. **Human-in-the-loop**: Pausing, reviewing, and resuming workflows.
3. **Fault tolerance**: Resume execution after errors or interruptions.
4. **Debugging**: Inspect state history, time travel.
5. **Contextual agents**: Agents that need to remember previous interactions.

### When to Use Stateless

1. **One-off queries**: "What's 2+2?", "Translate 'hello' to Spanish".
2. **Batch processing**: Parallel processing of independent requests.
3. **Stateless functions**: No need for memory or context.
4. **High throughput**: No contention—unlimited parallel execution.
5. **Cost optimization**: No checkpoint storage overhead.

### Hybrid Pattern: Stateless Crons with Per-Run Threads

A cron can be **stateless** but create a **new thread for each execution**:

```json
{
  "schedule": "0 9 * * *",
  "assistant_id": "asst_123",
  "input": {...},
  "on_run_completed": "delete_thread"
}
```

**Behavior**:

- Each cron trigger creates a new thread.
- The run executes on that thread (stateful within the run).
- After completion, the thread is deleted (pseudo-stateless).

**Use case**: Daily reports where each day's report is independent, but the agent benefits from checkpoint-based fault tolerance during execution.

---

## Design Patterns and Best Practices

### Pattern 1: User-Scoped Threads

**Problem**: Multiple users, each with their own conversation history.

**Solution**: Use `thread_id` that includes the user ID:

```json
{
  "thread_id": "user_123_session_456",
  "metadata": {"user_id": "user_123"}
}
```

**Benefits**:

- Easy to query all threads for a user: `POST /threads/search {"metadata": {"user_id": "user_123"}}`.
- No risk of cross-user state leakage.

### Pattern 2: Store for User Profiles

**Problem**: User preferences need to persist across conversations.

**Solution**: Store user data in the Store with a user-scoped namespace:

```json
{
  "namespace": ["users", "user_123"],
  "key": "profile",
  "value": {"name": "Alice", "language": "en", "theme": "dark"}
}
```

**Access in graph nodes**:

```python
def node_function(state: State, store: Store):
    profile = store.get(namespace=["users", state["user_id"]], key="profile")
    # Use profile data...
```

### Pattern 3: Multi-Assistant Configuration Switching

**Problem**: Mid-conversation, escalate from a basic assistant to an expert assistant.

**Solution**: Run different assistants on the same thread:

```json
// Initial run with basic assistant
POST /threads/thread_abc/runs
{
  "assistant_id": "asst_basic",
  "input": {...}
}

// Escalation: next run with expert assistant
POST /threads/thread_abc/runs
{
  "assistant_id": "asst_expert",
  "input": {...}
}
```

**Benefits**:

- Thread state (conversation history) is preserved.
- Configuration changes on the fly without losing context.

### Pattern 4: Interrupt Before Expensive Operations

**Problem**: Confirm with the user before executing a costly or irreversible action.

**Solution**: Use `interrupt_before`:

```json
{
  "assistant_id": "asst_123",
  "input": {...},
  "interrupt_before": ["submit_payment"]
}
```

**Flow**:

1. Run executes up to `submit_payment`, then pauses.
2. Thread status → `interrupted`.
3. Client fetches state: `GET /threads/{id}/state` → shows payment details.
4. User confirms.
5. Client resumes: `POST /threads/{id}/runs {"command": {"resume": null}}`.
6. Run continues from `submit_payment`.

### Pattern 5: Time Travel for A/B Testing

**Problem**: Test different prompts on the same conversation.

**Solution**:

1. Execute a run with Prompt A, record checkpoint IDs.
2. Fork from Checkpoint 2, update state with Prompt B's config:

   ```json
   POST /threads/{id}/state
   {
     "values": {"prompt": "Prompt B"},
     "checkpoint_id": "checkpoint_2_id"
   }
   ```

3. Resume execution:

   ```json
   POST /threads/{id}/runs
   {
     "checkpoint_id": "checkpoint_2_id",
     "input": null  // Resume from checkpoint
   }
   ```

4. Compare outcomes from the two branches.

---

## Implementation Scope for a Real System

### Core Components to Implement

#### 1. API Server

- **Framework**: Express, Fastify, or similar.
- **Endpoints**: 45+ REST endpoints across Assistants, Threads, Runs, Crons, Store, System.
- **Validation**: Request schema validation (JSON Schema, Zod, TypeBox).
- **Error handling**: Consistent error responses (4xx, 5xx).
- **Authentication**: API key validation, optional OAuth.
- **Rate limiting**: Prevent abuse.

#### 2. Task Queue

- **Purpose**: Durable, reliable run execution.
- **Requirements**:
  - Queue runs with priority (pending → running).
  - Worker pool to execute runs.
  - Lease management (ensure one worker per run).
  - Retry on failure.
  - Timeout enforcement.
- **Technologies**: Celery, Bull, BullMQ, Temporal, or AWS SQS + Lambda.

#### 3. Checkpointer Backend

- **Purpose**: Persist graph state at every super-step.
- **Requirements**:
  - Store checkpoints with (thread_id, checkpoint_id) as key.
  - Linked list structure (parent references).
  - Efficient retrieval by thread_id.
  - Pagination for history queries.
  - Optional: Compression for large states.
  - Optional: Hybrid storage (metadata in DB, large payloads in S3).
- **Technologies**: PostgreSQL, Redis, DynamoDB, Firestore.

#### 4. Store Backend

- **Purpose**: Cross-thread key-value storage.
- **Requirements**:
  - Composite key: (namespace, key).
  - Namespace prefix matching.
  - Indexing for `index` field.
  - Full-text search (optional).
  - Vector search (optional, for semantic search).
  - TTL expiration.
- **Technologies**: PostgreSQL (with jsonb and full-text), MongoDB, Elasticsearch, Redis.

#### 5. Cron Scheduler

- **Purpose**: Trigger runs at scheduled times.
- **Requirements**:
  - Parse cron expressions (standard 5-field syntax).
  - Calculate `next_run_date`.
  - Trigger run creation at scheduled time.
  - Handle `end_time` (stop scheduling).
  - Handle `enabled` flag (pause/resume).
- **Technologies**: node-cron, APScheduler (Python), Quartz (Java), or dedicated services like AWS EventBridge.

#### 6. SSE Streaming Layer

- **Purpose**: Real-time event streaming to clients.
- **Requirements**:
  - Emit events in SSE format (`event:`, `data:`, `id:`).
  - Handle multiple stream modes simultaneously.
  - Track event IDs for reconnection.
  - Support `Last-Event-ID` header.
  - Buffer management (prevent memory leaks).
  - Graceful handling of client disconnections.
- **Technologies**: Native HTTP (Node.js `res.write()`), libraries like `better-sse`, `sse-channel`.

#### 7. Graph Execution Engine (LangGraph Core)

- **Purpose**: Compile and execute graphs.
- **Requirements**:
  - Load graph definitions from deployment config.
  - Compile graphs with checkpointers.
  - Execute nodes in topological order.
  - Handle state reducers.
  - Support interrupts (pause/resume).
  - Emit events for streaming.
- **Technologies**: LangGraph library (Python or JS).

#### 8. Configuration & Deployment Layer

- **Purpose**: Manage graph deployments and assistant configurations.
- **Requirements**:
  - Parse `langgraph.json` to discover graphs.
  - Create default assistants on deployment.
  - Store assistant configurations and versions.
  - Resolve configuration merging (graph defaults + assistant config + run overrides).
- **Technologies**: Config files, database (PostgreSQL), S3 for graph artifacts.

#### 9. Monitoring & Observability

- **Purpose**: Track system health and performance.
- **Requirements**:
  - Metrics: Run latency, success rate, queue depth.
  - Logs: Structured logging for all operations.
  - Traces: Distributed tracing for run execution (optional).
  - Alerts: Notify on failures, high latency.
- **Technologies**: Prometheus, Grafana, Datadog, LangSmith (built-in telemetry).

### Scaling Considerations

#### Horizontal Scaling

- **API Server**: Stateless, can scale horizontally with load balancers.
- **Workers**: Scale worker pool based on queue depth.
- **Database**: Use read replicas for query load, sharding for write load.

#### Concurrency Control

- **Thread Locking**: Ensure only one worker executes a run on a thread at a time.
  - Use database row locks, Redis locks, or distributed locks (e.g., Redlock).
- **Stateless Runs**: No locking needed (parallel execution).

#### Checkpoint Storage Optimization

- **Large States**: Store full state in S3, metadata in PostgreSQL.
- **Compression**: Gzip or similar for large state objects.
- **Pruning**: Archive or delete old checkpoints based on TTL or retention policy.

---

## Assumptions & Scope

### Assumptions Made

| Assumption | Confidence | Impact if Wrong |
|------------|------------|-----------------|
| **LangGraph Platform API is REST-based with SSE for streaming** (not gRPC, not WebSockets). | HIGH | If gRPC is primary, REST API might be a secondary interface or not exist. Would require gRPC implementation instead. |
| **Checkpoints are immutable** and form a linked list (or tree with forking). | HIGH | If checkpoints are mutable, time travel and auditing become much harder. Implementation would need versioning or snapshot isolation. |
| **Thread status is computed from run states**, not directly settable. | MEDIUM | If status is directly settable, API would need a `PATCH /threads/{id}` with status field. Implementation would need status transition validation. |
| **Store API supports both namespace prefix search and index-based filtering**. | MEDIUM | If only one is supported, implementation complexity is lower. Search capabilities would be limited. |
| **Multitask strategies are enforced by the queue**, not the graph. | HIGH | If the graph handles concurrency, the queue becomes simpler but graph logic becomes more complex. |
| **Cron schedules use standard 5-field cron syntax** (minute hour day month weekday), not extended formats. | HIGH | If extended formats are needed (e.g., seconds, years), cron parser must support them. |
| **SSE is the only streaming protocol** (no WebSocket alternative). | MEDIUM | If WebSockets are supported, additional endpoints and protocol handling are needed. |
| **Assistant versioning is automatic on update**, not manual. | HIGH | If manual versioning is allowed, API needs explicit version creation endpoint. |
| **Stateless runs can execute in parallel without limits**. | MEDIUM | If there are global rate limits or concurrency caps, queue must enforce them. |
| **Store items can be any JSON-serializable type** (not just strings). | HIGH | If only strings are supported, clients must handle serialization/deserialization. |

### Uncertainties & Gaps

#### 1. Exact Error Response Format

**Uncertainty**: The LangGraph Platform API's precise error response structure is not fully documented.

**What we know**:

- Standard HTTP status codes (404, 409, 422, 500).
- Errors likely include `detail` or `message` fields.

**What we don't know**:

- Exact schema for validation errors (422): Does it follow FastAPI's format with `{"detail": [{"loc": [...], "msg": "...", "type": "..."}]}`?
- Error codes: Are there machine-readable error codes (e.g., `THREAD_NOT_FOUND`, `CONCURRENT_RUN_REJECTED`)?

**Impact**: Minor—reasonable approximations are sufficient for a stub implementation. Real implementation would reverse-engineer from SDK error handling.

#### 2. Webhook Delivery Semantics

**Uncertainty**: How are webhooks delivered? What format? Retry policy?

**What we know**:

- The `webhook` parameter accepts a URL.
- Likely POSTed to on run completion.

**What we don't know**:

- Payload format: Full run object? State snapshot? Custom format?
- Retry policy: Exponential backoff? Max retries?
- Authentication: Does the webhook include a signature or token?

**Impact**: Medium—webhook delivery is a common feature but details matter for reliability.

#### 3. Rate Limiting and Quotas

**Uncertainty**: Does the LangGraph Platform API enforce rate limits? Per user? Per assistant?

**What we know**: Not explicitly documented.

**What we don't know**:

- Rate limit values (e.g., 100 req/min).
- Scope (per IP, per API key, per thread).
- Response format (429 status code, `Retry-After` header?).

**Impact**: Low for initial implementation—can be added later.

#### 4. Vector Search in Store

**Uncertainty**: Does the Store API support semantic/vector search via the `query` parameter?

**What we know**:

- The `query` parameter exists in `POST /store/items/search`.
- Likely supports full-text search at minimum.

**What we don't know**:

- Is vector similarity search supported (e.g., embedding-based retrieval)?
- If yes, how are embeddings generated (server-side? client-provided?)?

**Impact**: Medium—vector search is a differentiator for advanced use cases.

#### 5. Checkpoint Retention Policies

**Uncertainty**: Are there automatic checkpoint pruning policies?

**What we know**:

- Threads have optional TTL (expire after N seconds).
- No explicit checkpoint TTL in the API.

**What we don't know**:

- Are old checkpoints automatically archived or deleted?
- Can clients configure checkpoint retention (e.g., "keep last 100 checkpoints per thread")?

**Impact**: High for production—unbounded checkpoint growth could exhaust storage.

### Clarifying Questions for Follow-up Research

1. **Error Responses**: Can you provide example error responses for 404, 409, 422, 500? Are there machine-readable error codes?

2. **Webhook Delivery**: What is the exact payload format for webhook POST? Is there a retry mechanism? Authentication?

3. **Rate Limiting**: Are there rate limits? What are the values and scopes?

4. **Store Query Semantics**: Does the `query` parameter support vector search? If so, how are embeddings handled?

5. **Checkpoint Retention**: Are there automatic pruning policies for old checkpoints? Can clients configure retention?

6. **Subgraph Streaming**: How are subgraph events namespaced in the SSE stream? The documentation mentions `(namespace, data)` tuples—can you provide a complete example?

7. **Thread Status Transitions**: What are the exact rules for status transitions? Can a thread go from `error` back to `idle` after recovery?

8. **Multitask Strategy Defaults**: If `multitask_strategy` is not specified, what is the default behavior? Reject? Enqueue?

9. **Assistant Context vs Config**: When should developers use `context` vs `config`? Are there access control implications (e.g., context for user identity)?

10. **Cron Failure Handling**: If a cron run fails, does the next scheduled run still trigger? Or does it wait until the failed run is resolved?

---

## References

### Official LangGraph Documentation

- [LangGraph Platform Overview](https://deepwiki.com/langchain-ai/langgraph/8-langgraph-platform)
- [LangGraph Platform API Reference](https://langchain-ai.github.io/langgraph/cloud/reference/api/api_ref.html)
- [Assistants - Docs by LangChain](https://docs.langchain.com/langsmith/assistants)
- [Persistence - Docs by LangChain](https://docs.langchain.com/oss/python/langgraph/persistence)
- [Streaming - Docs by LangChain](https://docs.langchain.com/oss/python/langgraph/streaming)
- [Threads and State Management | DeepWiki](https://deepwiki.com/langchain-ai/langgraph/7.2-threads-and-state-management)
- [Streaming and Events | DeepWiki](https://deepwiki.com/langchain-ai/langgraph/7.4-streaming-and-events)
- [Store System | DeepWiki](https://deepwiki.com/langchain-ai/langgraph/4.3-store-system)

### Long-Term Memory and Store

- [Launching Long-Term Memory Support in LangGraph](https://blog.langchain.com/launching-long-term-memory-support-in-langgraph/)
- [LangChain - Changelog | LangGraph long-term memory support](https://changelog.langchain.com/announcements/langgraph-long-term-memory-support)
- [Long-term memory - Docs by LangChain](https://docs.langchain.com/oss/python/deepagents/long-term-memory)
- [Powering Long-Term Memory For Agents With LangGraph And MongoDB](https://www.mongodb.com/company/blog/product-release-announcements/powering-long-term-memory-for-agents-langgraph)

### Checkpoints and State Management

- [Mastering Persistence in LangGraph: Checkpoints, Threads, and Beyond](https://medium.com/@vinodkrane/mastering-persistence-in-langgraph-checkpoints-threads-and-beyond-21e412aaed60)
- [Debugging Non-Deterministic LLM Agents: Checkpoint-Based State Replay with LangGraph Time Travel](https://dev.to/sreeni5018/debugging-non-deterministic-llm-agents-implementing-checkpoint-based-state-replay-with-langgraph-5171)
- [Time Travel in Agentic AI](https://pub.towardsai.net/time-travel-in-agentic-ai-3063c20e5fe2)
- [Build durable AI agents with LangGraph and Amazon DynamoDB](https://aws.amazon.com/blogs/database/build-durable-ai-agents-with-langgraph-and-amazon-dynamodb/)

### Cron Jobs and Scheduling

- [Use cron jobs - Docs by LangChain](https://docs.langchain.com/langsmith/cron-jobs)
- [Automate AI Workflows with Cron Jobs in LangGraph: Daily Summaries Example](https://medium.com/@sangeethasaravanan/automate-ai-workflows-with-cron-jobs-in-langgraph-daily-summaries-example-be2908a4c615)

### Streaming and SSE

- [LangGraph Streaming 101: 5 Modes to Build Responsive AI Applications](https://dev.to/sreeni5018/langgraph-streaming-101-5-modes-to-build-responsive-ai-applications-4p3f)
- [Mastering LangGraph Streaming: Advanced Techniques](https://sparkco.ai/blog/mastering-langgraph-streaming-advanced-techniques-and-best-practices)
- [What is LangGraph Streaming](https://medium.com/@arpatnurmamat/what-is-langgraph-streaming-8c8af12a112e)
- [Server-Sent Events (SSE) with LangChain: Streaming Response Tutorial](https://langchain-tutorials.github.io/server-sent-events-langchain-streaming-tutorial/)

### Multitask Strategies

- [Enqueue - How-To](https://langchain-ai.github.io/langgraph/cloud/how-tos/enqueue_concurrent/)
- [How to use the Rollback option](https://langchain-ai.github.io/langgraph/cloud/how-tos/rollback_concurrent/)
- [Interrupt concurrent - Docs by LangChain](https://docs.langchain.com/langgraph-platform/interrupt-concurrent)
- [Reject - How-To](https://langchain-ai.github.io/langgraph/cloud/how-tos/reject_concurrent/)

### General Architecture

- [Agent Server - Docs by LangChain](https://docs.langchain.com/langsmith/agent-server)
- [LangGraph: Agent Orchestration Framework for Reliable AI Agents](https://www.langchain.com/langgraph)
- [API Endpoints and Resources | DeepWiki](https://deepwiki.com/langchain-ai/langgraphjs/5.3-commands-and-control-flow)

### Project-Specific References

- [Refined Request: LangGraph Server API Drop-in Replacement](/Users/giorgosmarinos/aiwork/agent-platform/lg-api/docs/reference/refined-request-langgraph-api-replacement.md)
- [Investigation: LangGraph Server API Replacement - TypeScript Implementation](/Users/giorgosmarinos/aiwork/agent-platform/lg-api/docs/reference/investigation-langgraph-api-replacement.md)
- [Technical Design: LangGraph Server API Drop-in Replacement](/Users/giorgosmarinos/aiwork/agent-platform/lg-api/docs/design/project-design.md)

---

**End of Document**
