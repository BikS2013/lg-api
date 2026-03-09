# Custom Agent Integration Through the LangGraph API Interface

**Document Version:** 1.0
**Date:** 2026-03-09
**Status:** Design Specification

---

## Table of Contents

1. [Overview](#1-overview)
2. [Agent Request Model](#2-agent-request-model)
3. [Agent Response Model](#3-agent-response-model)
4. [API Surface Mapping](#4-api-surface-mapping)
5. [Proposed Additional Features and Components](#5-proposed-additional-features-and-components)
6. [Data Flow Diagrams](#6-data-flow-diagrams)
7. [State Management Strategy](#7-state-management-strategy)
8. [Agent Interface Contract](#8-agent-interface-contract)
9. [Open Questions and Decisions](#9-open-questions-and-decisions)
10. [Assumptions & Scope](#10-assumptions--scope)
11. [References](#11-references)

---

## 1. Overview

### 1.1 What We're Building

A bridge between the **LangGraph API interface** and **custom agent implementations**. This architecture enables developers to register custom agents as LangGraph-compatible "graphs" and invoke them through the standardized LangGraph Platform API, exposing them to any client using the official LangGraph SDK (Python or JavaScript).

**Core Concept**: Agents are registered as "assistants" (versioned graph configurations) and invoked via "runs" (stateful or stateless executions). Each run receives a structured request containing conversation history, documents, and the new user input, then returns a response that updates thread state.

### 1.2 The Vision

Each custom agent receives requests composed of:

1. **Conversation history so far** - Previous messages exchanged in the thread
2. **Documents used so far** - Files and context accumulated across conversation turns
3. **The new user request** - The current input message or command
4. **Additional documents** - New files or context provided with this specific request

The agent processes this context and returns:

- A response message or structured output
- Updated state values
- Optionally: new documents, updated memory, or commands for control flow

### 1.3 Architectural Position

This design sits at the intersection of:

- **LangGraph Platform API** (standard REST interface)
- **Custom Agent Implementations** (user-defined logic)
- **State Management Layer** (threads, checkpoints, store)
- **Document Management Layer** (file storage, retrieval, search)

```
┌─────────────────────────────────────────────────────────┐
│              LangGraph SDK Clients                      │
│         (Python / JavaScript / HTTP)                    │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│           LangGraph Platform API Interface              │
│   Assistants | Threads | Runs | Crons | Store          │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│          Custom Agent Integration Layer                 │
│   • Agent Registry                                      │
│   • Context Assembly Engine                             │
│   • Document Management                                 │
│   • Agent Middleware Pipeline                           │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│           Custom Agent Implementations                  │
│   (User-defined graphs/agents)                         │
└─────────────────────────────────────────────────────────┘
```

---

## 2. Agent Request Model

The structured request that each agent receives when invoked.

### 2.1 Conversation History

**Purpose**: Provides the agent with the full conversational context leading up to the current request.

#### 2.1.1 Data Source Mapping

**Primary Source**: Thread state `values` field containing a messages array
**Secondary Source**: Thread checkpoint history (for time-travel scenarios)

```typescript
interface ConversationMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: string;
  metadata?: Record<string, any>;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ConversationHistory {
  messages: ConversationMessage[];
  thread_id: string;
  checkpoint_id?: string;
  total_messages: number;
}
```

#### 2.1.2 API Operations That Populate History

1. **Thread Creation with Supersteps** (`POST /threads`)
   - The `supersteps` parameter allows pre-populating conversation history when creating a thread
   - Each superstep defines a state update that builds initial context

2. **Thread State Updates** (`POST /threads/{thread_id}/state`)
   - Updates state values including messages array
   - Can append new messages or modify existing state

3. **Run Input** (`POST /threads/{thread_id}/runs`)
   - New messages are typically added through run input
   - The `input` field contains the new user message
   - After execution, the agent's response messages are appended to state

4. **Thread State Retrieval** (`GET /threads/{thread_id}/state`)
   - Retrieves current state including full message history
   - Used by the context assembly engine before agent invocation

#### 2.1.3 Format and Structure

LangGraph follows the OpenAI messages format:

```typescript
// Stored in thread state values
{
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful assistant specialized in document analysis."
    },
    {
      "role": "user",
      "content": "What are the key findings in the uploaded report?",
      "timestamp": "2026-03-09T10:15:00Z"
    },
    {
      "role": "assistant",
      "content": "Based on the report, the three key findings are...",
      "timestamp": "2026-03-09T10:15:05Z"
    }
  ]
}
```

#### 2.1.4 Propagation to Agent

**Context Assembly Process**:

1. Fetch current thread state: `GET /threads/{thread_id}/state`
2. Extract `values.messages` array from state
3. Optionally truncate or summarize based on context window limits
4. Include in agent's input schema under `history` or `messages` field

**Truncation Strategies** (borrowed from OpenAI Assistants API pattern):
- `auto`: System determines what to keep based on importance
- `last_messages`: Keep N most recent messages
- `summarization`: Compress older messages into summaries

### 2.2 Documents (Existing in Conversation)

**Purpose**: Make files and context accumulated across conversation turns available to the agent.

#### 2.2.1 Storage Location Options

**Option A: Thread State Values**

Store document references directly in thread state:

```typescript
// Thread state structure
{
  "messages": [...],
  "documents": [
    {
      "document_id": "doc_abc123",
      "filename": "quarterly_report.pdf",
      "mime_type": "application/pdf",
      "size_bytes": 245600,
      "uploaded_at": "2026-03-09T10:00:00Z",
      "namespace": ["user_456", "documents"],
      "store_key": "doc_abc123",
      "metadata": {
        "type": "financial_report",
        "quarter": "Q4_2025"
      }
    }
  ]
}
```

**Pros**: Documents are tied to thread lifecycle, easy to query with state
**Cons**: State can grow large, limited querying capabilities

**Option B: Store API with Thread-Scoped Namespace**

Store documents in the Store API using thread-based namespaces:

```typescript
// Store namespace pattern
["threads", thread_id, "documents"]

// Store item structure
{
  "namespace": ["threads", "thread_01", "documents"],
  "key": "doc_abc123",
  "value": {
    "filename": "quarterly_report.pdf",
    "mime_type": "application/pdf",
    "content_url": "s3://bucket/files/doc_abc123.pdf",
    "extracted_text": "...",
    "metadata": {
      "type": "financial_report",
      "page_count": 45
    }
  },
  "index": true // Enable vector search
}
```

**Pros**: Powerful search, cross-thread sharing, vector search support, separate lifecycle
**Cons**: Requires additional API calls, more complex to manage

**Option C: Hybrid Approach (Recommended)**

- Store **document references** in thread state
- Store **document content and metadata** in Store API
- Thread state contains pointers, Store contains actual data

```typescript
// Thread state (lightweight)
{
  "messages": [...],
  "document_refs": ["doc_abc123", "doc_xyz789"]
}

// Store API (rich content)
// Namespace: ["threads", thread_id, "documents"]
{
  "key": "doc_abc123",
  "value": {
    "filename": "report.pdf",
    "content": "...",
    "embeddings": [...]
  }
}
```

#### 2.2.2 How Documents Accumulate

**Across Conversation Turns**:

1. **User uploads document** → Stored in Store API with thread namespace
2. **Document ref added to state** → State update appends document_id to refs
3. **Subsequent runs** → Context assembly fetches all referenced documents
4. **Agent response** → May reference existing docs or add new ones

**API Flow**:

```
User Upload → POST /store/items
  namespace: ["threads", thread_id, "documents"]
  key: document_id
  value: {content, metadata}

State Update → POST /threads/{thread_id}/state
  values: {document_refs: [...existing, new_doc_id]}

Agent Invocation → Context Assembly:
  1. GET /threads/{thread_id}/state → Get document_refs
  2. POST /store/items/search → Fetch documents by refs
  3. Assemble into agent input
```

#### 2.2.3 Metadata Structure

Each document should carry:

```typescript
interface DocumentMetadata {
  document_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  uploaded_at: string;
  uploaded_by?: string;

  // Store location
  namespace: string[];
  store_key: string;

  // Content metadata
  page_count?: number;
  word_count?: number;
  language?: string;

  // Processing status
  processing_status: "pending" | "processed" | "failed";
  extracted_text?: string;
  extracted_metadata?: Record<string, any>;

  // Search support
  embeddings?: number[];
  chunk_ids?: string[];

  // Lifecycle
  ttl?: number; // Time-to-live in seconds
  expires_at?: string;

  // Custom metadata
  tags?: string[];
  custom?: Record<string, any>;
}
```

#### 2.2.4 Agent Access Pattern

The context assembly engine fetches documents before agent invocation:

```typescript
async function assembleDocumentContext(
  threadId: string,
  documentRefs: string[]
): Promise<DocumentContext> {

  // Fetch documents from Store
  const documents = await store.search({
    namespace_prefix: ["threads", threadId, "documents"],
    filter: { key: { $in: documentRefs } },
    limit: 100
  });

  return {
    count: documents.length,
    items: documents.map(doc => ({
      id: doc.key,
      filename: doc.value.filename,
      content: doc.value.extracted_text || doc.value.content,
      metadata: doc.value.metadata
    }))
  };
}
```

### 2.3 New User Request

**Purpose**: The current input that triggers the agent invocation.

#### 2.3.1 Maps to Run Input Field

When creating a run, the `input` field contains the new request:

```typescript
// POST /threads/{thread_id}/runs
{
  "assistant_id": "asst_123",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": "Can you summarize the financial report?"
      }
    ]
  },
  "config": { ... },
  "metadata": { ... }
}
```

#### 2.3.2 Input Structure Options

**Option 1: Simple String**
```typescript
{ "input": "Summarize the report" }
```

**Option 2: Messages Array (Recommended)**
```typescript
{
  "input": {
    "messages": [
      { "role": "user", "content": "Summarize the report" }
    ]
  }
}
```

**Option 3: Structured Input with Context**
```typescript
{
  "input": {
    "type": "query",
    "query": "Summarize the report",
    "context": {
      "focus_areas": ["revenue", "expenses"],
      "format": "bullet_points"
    }
  }
}
```

#### 2.3.3 API Delivery to Agent

The `input` field is passed directly to the graph's entry point:

```python
# LangGraph agent receives
def agent_node(state: AgentState, config: RunnableConfig):
    # state contains merged data:
    # - Previous state from checkpoint (history, documents)
    # - New input from run creation

    messages = state["messages"]  # Includes history + new input
    documents = state["documents"]  # From thread state

    # Process and return updates
    return {"messages": [response]}
```

### 2.4 Additional Documents (Per-Request)

**Purpose**: New files or context provided with this specific request.

#### 2.4.1 Attachment Methods

**Method 1: Inline in Input Field**

```typescript
{
  "input": {
    "messages": [
      { "role": "user", "content": "Analyze this new contract" }
    ],
    "attachments": [
      {
        "filename": "contract.pdf",
        "content_type": "application/pdf",
        "content_base64": "JVBERi0xLjQK..."
      }
    ]
  }
}
```

**Pros**: Single API call, atomic operation
**Cons**: Large payloads, base64 encoding overhead

**Method 2: Pre-upload to Store, Reference in Input**

```typescript
// Step 1: Upload to Store
// PUT /store/items
{
  "namespace": ["threads", thread_id, "temp_attachments"],
  "key": "upload_xyz",
  "value": {
    "filename": "contract.pdf",
    "content": "...",
    "temp": true
  }
}

// Step 2: Reference in run input
// POST /threads/{thread_id}/runs
{
  "input": {
    "messages": [
      { "role": "user", "content": "Analyze this new contract" }
    ],
    "attachment_refs": ["upload_xyz"]
  }
}
```

**Pros**: Handles large files, resumable uploads, no size limits
**Cons**: Two API calls, more complex flow

**Method 3: Via Context Field (Recommended)**

Use the run's `context` field for request-scoped data:

```typescript
{
  "input": {
    "messages": [...]
  },
  "context": {
    "attachments": [
      {
        "store_namespace": ["threads", thread_id, "attachments"],
        "store_key": "upload_xyz"
      }
    ]
  }
}
```

#### 2.4.2 Delivery Alongside Request

The context assembly engine combines:

1. **Persistent documents** from thread state/store
2. **New attachments** from run input/context
3. Presents unified document list to agent

```typescript
interface AgentInput {
  // Conversation
  messages: ConversationMessage[];

  // Existing documents
  existing_documents: Document[];

  // New attachments for this request
  new_attachments: Document[];

  // Request metadata
  request_metadata: {
    thread_id: string;
    run_id: string;
    user_id?: string;
  };
}
```

---

## 3. Agent Response Model

### 3.1 What the Agent Returns

Each agent execution returns state updates that the API uses to:

1. Update thread state (conversation history, documents)
2. Generate client response (streaming or complete)
3. Determine next actions (interrupt, continue, end)

#### 3.1.1 Response Structure

```typescript
interface AgentResponse {
  // Primary output
  messages: ConversationMessage[];

  // State updates
  state_updates?: Record<string, any>;

  // Documents produced
  new_documents?: DocumentMetadata[];

  // Control flow
  status: "success" | "error" | "interrupted" | "waiting_for_input";
  next_steps?: string[];

  // Metadata
  metadata?: {
    tokens_used?: number;
    tools_called?: string[];
    processing_time_ms?: number;
  };
}
```

### 3.2 Mapping to Thread State Updates

After agent execution, the API updates thread state:

```typescript
// POST /threads/{thread_id}/state
{
  "values": {
    "messages": [...existing_messages, ...new_response_messages],
    "documents": [...existing_docs, ...new_doc_refs],
    "custom_state": agent_response.state_updates
  },
  "as_node": "agent_node" // Which node produced this update
}
```

### 3.3 Streaming vs Complete Responses

#### 3.3.1 Complete Response Flow

```
POST /threads/{thread_id}/runs
  → Agent executes fully
  → Response: Run object with status="success"
  → Client polls: GET /threads/{thread_id}/runs/{run_id}
  → Client retrieves final state: GET /threads/{thread_id}/state
```

#### 3.3.2 Streaming Response Flow (SSE)

```
POST /threads/{thread_id}/runs/stream
  → SSE connection established
  → Agent executes, yielding chunks
  → Events emitted:
    event: metadata
    data: {"run_id": "...", "thread_id": "..."}

    event: messages
    data: {"role": "assistant", "content": "Based on "}

    event: messages
    data: {"role": "assistant", "content": "the report, "}

    event: end
    data: {"status": "success"}
```

**Key Stream Modes**:
- `messages`: Token-by-token message streaming
- `values`: Complete state snapshots after each node
- `updates`: Incremental state changes
- `events`: All internal events (tools, prompts, etc.)

### 3.4 Error and Interrupt Responses

#### 3.4.1 Error Response

```typescript
{
  "status": "error",
  "error": {
    "type": "validation_error",
    "message": "Required document not found",
    "code": "DOCUMENT_NOT_FOUND"
  },
  "partial_result": {
    "messages": [...] // What was completed before error
  }
}
```

Thread state is rolled back or marked with error status.

#### 3.4.2 Interrupt Response

```typescript
{
  "status": "interrupted",
  "interrupt": {
    "reason": "human_approval_required",
    "data": {
      "proposed_action": "delete_file",
      "file_id": "doc_123"
    }
  },
  "resume_instructions": "Call POST /threads/{id}/runs with command.resume"
}
```

Thread status becomes `interrupted`, run status becomes `interrupted`. Execution can be resumed with a command.

---

## 4. API Surface Mapping

### 4.1 Assistants API → Agent Registration

**Role**: Registers custom agents as versioned configurations.

#### 4.1.1 POST /assistants - Register Agent

```typescript
// Request
{
  "graph_id": "document_analyst",  // Agent type identifier
  "assistant_id": "asst_doc_analyzer_v1", // Optional specific ID
  "name": "Document Analysis Agent",
  "description": "Analyzes financial and legal documents",
  "config": {
    "model": "gpt-4",
    "temperature": 0.7,
    "max_tokens": 4000,
    "agent_specific": {
      "supported_formats": ["pdf", "docx", "txt"],
      "analysis_depth": "detailed"
    }
  },
  "metadata": {
    "capabilities": ["document_analysis", "summarization", "qa"],
    "version": "1.2.0",
    "author": "team@company.com",
    "tags": ["finance", "legal"]
  },
  "if_exists": "update" // or "error", "do_nothing"
}
```

**Response**: Assistant object with version 1

#### 4.1.2 graph_id as Agent Type Identifier

The `graph_id` maps to:
- A compiled LangGraph graph (`.langgraph` directory)
- A custom agent implementation class
- An agent factory function

**Implementation Mapping**:

```typescript
// Agent Registry maps graph_id → Agent Implementation
const agentRegistry = new Map<string, AgentFactory>();

agentRegistry.set("document_analyst", {
  factory: () => new DocumentAnalystAgent(),
  schemas: {
    input: DocumentAnalystInputSchema,
    output: DocumentAnalystOutputSchema,
    state: DocumentAnalystStateSchema
  }
});

// When assistant created with graph_id="document_analyst"
const assistant = await assistants.create({
  graph_id: "document_analyst",
  config: {...}
});
```

#### 4.1.3 Config for Agent-Specific Settings

The `config` field contains:
- **System config**: Model, temperature, max tokens
- **Agent-specific config**: Custom parameters for the agent implementation

```typescript
interface AssistantConfig {
  // Standard LangGraph config
  tags?: string[];
  recursion_limit?: number;
  configurable?: Record<string, any>;

  // Agent-specific (validated against agent's config schema)
  agent_specific?: Record<string, any>;
}
```

Agents access config at runtime:

```python
def agent_node(state, config: RunnableConfig):
    agent_config = config.get("configurable", {}).get("agent_specific", {})
    analysis_depth = agent_config.get("analysis_depth", "standard")
    # ...
```

#### 4.1.4 Metadata for Agent Discovery

Metadata enables finding agents by capabilities:

```typescript
// POST /assistants/search
{
  "metadata": {
    "capabilities": {"$contains": "document_analysis"}
  },
  "limit": 10
}
```

**Recommended Metadata Fields**:
- `capabilities`: Array of capability strings
- `supported_input_types`: Array of MIME types
- `version`: Semantic version string
- `category`: Agent category (e.g., "analysis", "generation")
- `tags`: Searchable tags
- `author`: Team/user identifier

#### 4.1.5 Versioning for Agent Updates

**Versioning Strategy**:

1. **PATCH /assistants/{id}** creates a new version automatically
2. Each version has a unique `version` number (1, 2, 3...)
3. **POST /assistants/{id}/latest** sets which version is "production"

```typescript
// V1: Initial version
POST /assistants
{
  "graph_id": "doc_analyst",
  "config": { "model": "gpt-4" }
}
// Response: version=1

// V2: Update model
PATCH /assistants/asst_123
{
  "config": { "model": "gpt-4-turbo" }
}
// Response: version=2

// Set V2 as latest
POST /assistants/asst_123/latest
{ "version": 2 }
```

**Version Routing**:
- Client specifies `assistant_id` → uses latest version
- Client specifies `assistant_id@version` → uses specific version
- Enables A/B testing, rollback, gradual rollout

### 4.2 Threads API → Conversation Management

**Role**: Holds conversation state across multiple agent invocations.

#### 4.2.1 POST /threads - Initialize Agent Context

```typescript
{
  "thread_id": "thread_user_123_session_1", // Optional
  "metadata": {
    "user_id": "user_123",
    "session_type": "document_review",
    "created_by": "web_app"
  },
  "supersteps": [ // Pre-populate conversation
    {
      "values": {
        "messages": [
          {"role": "system", "content": "You are a document analyst."}
        ],
        "documents": []
      }
    }
  ],
  "ttl": 86400 // Expire after 24 hours
}
```

**Supersteps** allow initializing threads with:
- System prompts
- Few-shot examples
- Pre-loaded documents
- Initial state values

#### 4.2.2 Thread State as Carrier

Thread state structure:

```typescript
interface ThreadState {
  // Core data
  values: {
    messages: ConversationMessage[];
    documents: DocumentReference[];
    custom_state?: Record<string, any>;
  };

  // Execution metadata
  next: string[]; // Next nodes to execute
  checkpoint: CheckpointMetadata;
  tasks: ThreadTask[];
  interrupts: Interrupt[];

  // Timestamps
  created_at: string;
  updated_at: string;
}
```

**GET /threads/{id}/state** retrieves full context for agent invocation.

#### 4.2.3 State Updates Between Turns

After each run:

```typescript
// Automatic state update by LangGraph runtime
POST /threads/{thread_id}/state
{
  "values": {
    "messages": [...previous, ...new_from_agent],
    "documents": [...previous, ...new_refs]
  },
  "as_node": "agent_node",
  "checkpoint": {
    "checkpoint_ns": "",
    "checkpoint_id": "uuid-..."
  }
}
```

**Manual state updates** also supported for corrections:

```typescript
POST /threads/{thread_id}/state
{
  "values": {
    "messages": [...corrected_history]
  }
}
```

### 4.3 Runs API → Agent Invocation

**Role**: The primary mechanism for executing agents.

#### 4.3.1 POST /threads/{id}/runs - Primary Invocation

```typescript
{
  "assistant_id": "asst_doc_analyzer_v1",

  "input": {
    "messages": [
      {"role": "user", "content": "What are the key risks in the contract?"}
    ]
  },

  "config": {
    "configurable": {
      "user_id": "user_123",
      "analysis_depth": "detailed"
    }
  },

  "stream_mode": ["messages", "events"],
  "metadata": {
    "request_id": "req_789",
    "source": "web_ui"
  }
}
```

**Flow**:
1. API validates assistant_id and thread_id
2. Fetches thread state (history + documents)
3. Merges with run input
4. Invokes agent via agent registry
5. Streams or returns response
6. Updates thread state with results

#### 4.3.2 The input Field as New User Request

The `input` field is merged with thread state to form complete agent input:

```typescript
// Context Assembly
const agentInput = {
  // From thread state
  messages: threadState.values.messages, // History
  documents: threadState.values.documents, // Existing docs

  // From run input - APPENDED to messages
  ...runInput, // New messages

  // From run context
  attachments: runContext.attachments // New docs
};
```

Agent's graph receives the merged state as initial input.

#### 4.3.3 The config Field for Runtime Parameters

```typescript
{
  "config": {
    "tags": ["priority"],
    "recursion_limit": 50,
    "configurable": {
      // Agent-specific runtime params
      "temperature": 0.9,
      "max_analysis_time": 60,
      "user_preferences": {
        "format": "markdown",
        "detail_level": "high"
      }
    }
  }
}
```

Agents access via `RunnableConfig`:

```python
def agent_node(state, config: RunnableConfig):
    user_prefs = config["configurable"].get("user_preferences", {})
    format = user_prefs.get("format", "text")
    # ...
```

#### 4.3.4 Streaming Modes for Agents

**Key Streaming Modes**:

| Mode | Purpose | Agent Output | Client Receives |
|------|---------|--------------|-----------------|
| `messages` | Token streaming | Yields message chunks | Real-time tokens |
| `values` | State snapshots | Emits full state after each node | Complete state updates |
| `updates` | State deltas | Emits only changed fields | Incremental updates |
| `events` | Tool calls, prompts | All internal events | Full observability |
| `debug` | Debugging | Internal execution details | Logs, traces |

**For LLM-based agents**, use `messages` for token streaming:

```typescript
// POST /threads/{id}/runs/stream
{
  "stream_mode": ["messages"],
  "stream_resumable": true // Allow reconnection
}

// SSE events
event: messages
data: {"role": "assistant", "content": "The "}

event: messages
data: {"role": "assistant", "content": "key "}

event: messages
data: {"role": "assistant", "content": "risks "}
```

**For workflow agents**, use `values` for step-by-step progress:

```typescript
{
  "stream_mode": ["values"]
}

// SSE events
event: values
data: {"step": "analysis", "progress": 25, "status": "Processing..."}

event: values
data: {"step": "summary", "progress": 75, "status": "Generating summary..."}
```

#### 4.3.5 Stateful vs Stateless Runs

**Stateful Run** (`POST /threads/{id}/runs`):
- Requires thread_id
- Updates thread state after execution
- Conversation history persists
- Supports interrupts and resumption

**Stateless Run** (`POST /runs`):
- No thread_id required
- Ephemeral execution
- No state persistence
- Useful for one-off queries, background tasks

```typescript
// Stateless run
POST /runs
{
  "assistant_id": "asst_123",
  "input": {
    "messages": [{"role": "user", "content": "Analyze this text: ..."}]
  }
}
// Response includes result, but no state saved
```

### 4.4 Store API → Document and Knowledge Management

**Role**: Persistent storage for documents, embeddings, and cross-thread memory.

#### 4.4.1 Namespaces for Organization

**Namespace Patterns**:

```typescript
// Thread-scoped documents
["threads", thread_id, "documents"]

// User-scoped knowledge base
["users", user_id, "knowledge"]

// Agent-scoped memory
["agents", agent_id, "memories"]

// Shared organizational knowledge
["org", org_id, "policies"]
```

**Hierarchical Organization**:

```
["users", "user_123", "documents", "invoices"]
["users", "user_123", "documents", "contracts"]
["users", "user_123", "preferences"]
```

#### 4.4.2 Agent Read/Write Patterns

**Reading Documents**:

```python
from langgraph.runtime import Runtime

async def agent_node(state, runtime: Runtime):
    # Search for relevant documents
    docs = await runtime.store.asearch(
        namespace=("threads", state["thread_id"], "documents"),
        query=state["messages"][-1].content,
        limit=5
    )

    context = "\n".join([d.value["content"] for d in docs])
    # Use in agent processing
```

**Writing New Documents**:

```python
async def agent_node(state, runtime: Runtime):
    # Agent produces a summary document
    summary = "..."

    await runtime.store.aput(
        namespace=("threads", state["thread_id"], "documents"),
        key=f"summary_{uuid.uuid4()}",
        value={
            "type": "summary",
            "content": summary,
            "created_by": "agent",
            "source_messages": state["messages"][-5:]
        }
    )
```

#### 4.4.3 Cross-Thread Document Sharing

**Pattern**: User-scoped or org-scoped namespaces

```typescript
// Upload to user namespace
PUT /store/items
{
  "namespace": ["users", "user_123", "shared_docs"],
  "key": "company_policy",
  "value": {
    "filename": "policy.pdf",
    "content": "..."
  }
}

// Access from any thread
// Agent in thread_A
docs = await runtime.store.asearch(
    namespace=("users", "user_123", "shared_docs"),
    query="vacation policy"
)

// Agent in thread_B can access same documents
```

**Use Cases**:
- Personal knowledge base across conversations
- Organizational policies accessible to all agents
- Shared reference materials

#### 4.4.4 Search Capabilities

**Vector Search** (with embeddings):

```typescript
POST /store/items/search
{
  "namespace_prefix": ["users", "user_123", "documents"],
  "query": "financial projections for 2026",
  "limit": 10
}
```

Requires Store configured with embeddings:

```python
from langchain.embeddings import init_embeddings
from langgraph.store.memory import InMemoryStore

embeddings = init_embeddings("openai:text-embedding-3-small")
store = InMemoryStore(
    index={
        "embed": embeddings,
        "dims": 1536
    }
)
```

**Structured Filter Search**:

```typescript
POST /store/items/search
{
  "namespace_prefix": ["threads", "thread_123", "documents"],
  "filter": {
    "type": "invoice",
    "date": {"$gte": "2026-01-01"}
  }
}
```

### 4.5 Crons API → Scheduled Agent Tasks

**Role**: Enable periodic agent invocations without user input.

#### 4.5.1 How Crons Enable Periodic Invocations

```typescript
// POST /threads/{thread_id}/runs/crons
{
  "schedule": "0 9 * * *", // Daily at 9 AM
  "input": {
    "messages": [
      {"role": "system", "content": "Generate daily summary"}
    ]
  },
  "assistant_id": "asst_summarizer",
  "enabled": true
}
```

**Cron automatically creates runs** at scheduled times, as if user invoked the agent.

#### 4.5.2 Use Cases

1. **Monitoring Agents**
   - Check for new documents every hour
   - Alert on anomalies in data

2. **Digest Agents**
   - Daily summary of activities
   - Weekly report generation

3. **Maintenance Agents**
   - Prune old documents
   - Archive completed threads
   - Update cached data

4. **Proactive Agents**
   - Check deadlines and send reminders
   - Monitor external systems

**Example: Daily Document Summary Cron**

```typescript
{
  "schedule": "0 18 * * 1-5", // 6 PM on weekdays
  "assistant_id": "asst_summarizer",
  "input": {
    "messages": [
      {"role": "system", "content": "Summarize all documents added today"}
    ]
  },
  "metadata": {
    "type": "daily_digest"
  }
}
```

---

## 5. Proposed Additional Features and Components

### 5.1 Agent Registry

**Purpose**: System to register, discover, and manage custom agent implementations.

#### 5.1.1 Registry Interface

```typescript
interface AgentRegistry {
  // Registration
  register(registration: AgentRegistration): Promise<void>;
  unregister(graphId: string): Promise<void>;

  // Discovery
  get(graphId: string): Promise<AgentMetadata>;
  search(query: AgentSearchQuery): Promise<AgentMetadata[]>;
  listAll(): Promise<AgentMetadata[]>;

  // Lifecycle
  enable(graphId: string): Promise<void>;
  disable(graphId: string): Promise<void>;

  // Health
  healthCheck(graphId: string): Promise<HealthStatus>;
}

interface AgentRegistration {
  graph_id: string;
  name: string;
  description: string;

  // Implementation
  factory: AgentFactory;
  implementation_type: "graph" | "function" | "class";

  // Schemas
  schemas: {
    input: JSONSchema;
    output: JSONSchema;
    state: JSONSchema;
    config: JSONSchema;
  };

  // Capabilities
  capabilities: string[];
  supported_input_types: string[];
  supported_stream_modes: StreamMode[];

  // Metadata
  version: string;
  author: string;
  tags: string[];
  documentation_url?: string;

  // Requirements
  required_config: string[];
  required_store: boolean;
  max_execution_time_ms: number;
}
```

#### 5.1.2 Agent Discovery

**By Capability**:

```typescript
const agents = await registry.search({
  capabilities: ["document_analysis", "summarization"]
});
```

**By Input Type**:

```typescript
const agents = await registry.search({
  supported_input_types: ["application/pdf"]
});
```

**By Metadata**:

```typescript
const agents = await registry.search({
  tags: ["finance"],
  version: ">=1.0.0"
});
```

#### 5.1.3 Version Management

Registry tracks multiple versions of same agent:

```typescript
{
  "graph_id": "document_analyst",
  "versions": [
    {
      "version": "1.0.0",
      "status": "deprecated",
      "factory": DocumentAnalystV1
    },
    {
      "version": "1.1.0",
      "status": "stable",
      "factory": DocumentAnalystV1_1
    },
    {
      "version": "2.0.0-beta",
      "status": "preview",
      "factory": DocumentAnalystV2
    }
  ],
  "latest": "1.1.0"
}
```

### 5.2 Document Management Layer

**Purpose**: Handle document upload, storage, parsing, retrieval.

#### 5.2.1 Document Upload API

```typescript
// POST /documents/upload
multipart/form-data:
  - file: binary
  - metadata: {
      "thread_id": "thread_123",
      "user_id": "user_456",
      "tags": ["invoice", "Q4_2025"]
    }

// Response
{
  "document_id": "doc_abc123",
  "status": "processing",
  "store_location": {
    "namespace": ["threads", "thread_123", "documents"],
    "key": "doc_abc123"
  }
}
```

#### 5.2.2 Document Processing Pipeline

```typescript
interface DocumentProcessor {
  // Extract text
  extractText(file: Buffer, mimeType: string): Promise<string>;

  // Extract metadata
  extractMetadata(file: Buffer, mimeType: string): Promise<Record<string, any>>;

  // Generate embeddings
  generateEmbeddings(text: string): Promise<number[]>;

  // Chunk for vector search
  chunk(text: string, chunkSize: number): Promise<string[]>;
}
```

**Pipeline Flow**:

```
Upload → Store Raw → Extract Text → Generate Embeddings →
  Store Processed → Update Thread State
```

#### 5.2.3 Supported Document Types

| Type | MIME Type | Processor |
|------|-----------|-----------|
| PDF | application/pdf | pdf-parse, PyPDF2 |
| Word | application/vnd.openxml... | mammoth, docx2txt |
| Text | text/plain | Direct read |
| Markdown | text/markdown | Direct read |
| HTML | text/html | cheerio, BeautifulSoup |
| Images | image/* | OCR (Tesseract) |
| JSON | application/json | JSON parse |
| CSV | text/csv | Papa Parse, pandas |

#### 5.2.4 Lifecycle Management

**TTL-based Expiration**:

```typescript
PUT /store/items
{
  "namespace": ["threads", "thread_123", "documents"],
  "key": "temp_doc",
  "value": {...},
  "ttl": 3600 // Expire in 1 hour
}
```

**Manual Cleanup**:

```typescript
// Background job
async function cleanupOldDocuments() {
  const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000); // 30 days

  const oldDocs = await store.search({
    namespace_prefix: ["threads"],
    filter: {
      "created_at": { "$lt": cutoff },
      "type": "temporary"
    }
  });

  for (const doc of oldDocs) {
    await store.delete(doc.namespace, doc.key);
  }
}
```

### 5.3 Agent Middleware / Hooks

**Purpose**: Pre/post-processing, validation, logging for agent invocations.

#### 5.3.1 Middleware Architecture

```typescript
interface AgentMiddleware {
  name: string;
  order: number;

  // Pre-processing
  beforeInvoke?(context: InvokeContext): Promise<InvokeContext>;

  // Post-processing
  afterInvoke?(context: InvokeContext, result: AgentResponse): Promise<AgentResponse>;

  // Error handling
  onError?(context: InvokeContext, error: Error): Promise<void>;
}

interface InvokeContext {
  agent: AgentMetadata;
  thread_id?: string;
  run_id: string;
  input: AgentInput;
  config: RunConfig;
  user_id?: string;
}
```

#### 5.3.2 Pre-Processing Middleware Examples

**Input Validation**:

```typescript
class InputValidationMiddleware implements AgentMiddleware {
  async beforeInvoke(context: InvokeContext): Promise<InvokeContext> {
    const schema = context.agent.schemas.input;
    const valid = validate(schema, context.input);

    if (!valid.success) {
      throw new ValidationError(valid.errors);
    }

    return context;
  }
}
```

**Document Extraction**:

```typescript
class DocumentExtractionMiddleware implements AgentMiddleware {
  async beforeInvoke(context: InvokeContext): Promise<InvokeContext> {
    // Extract attachment_refs from input
    const refs = context.input.attachment_refs || [];

    // Fetch from Store
    const docs = await fetchDocuments(refs);

    // Inject into context
    context.input.documents = docs;

    return context;
  }
}
```

**Context Assembly**:

```typescript
class ContextAssemblyMiddleware implements AgentMiddleware {
  async beforeInvoke(context: InvokeContext): Promise<InvokeContext> {
    if (!context.thread_id) return context;

    // Fetch thread state
    const state = await getThreadState(context.thread_id);

    // Merge history
    context.input.messages = [
      ...state.values.messages,
      ...context.input.messages
    ];

    // Add existing documents
    context.input.existing_documents = state.values.documents;

    return context;
  }
}
```

#### 5.3.3 Post-Processing Middleware Examples

**Response Formatting**:

```typescript
class ResponseFormattingMiddleware implements AgentMiddleware {
  async afterInvoke(context, result): Promise<AgentResponse> {
    // Ensure response follows schema
    const formatted = {
      messages: result.messages || [],
      state_updates: result.state_updates || {},
      status: result.status || "success"
    };

    return formatted;
  }
}
```

**State Update**:

```typescript
class StateUpdateMiddleware implements AgentMiddleware {
  async afterInvoke(context, result): Promise<AgentResponse> {
    if (!context.thread_id) return result;

    // Update thread state with response
    await updateThreadState(context.thread_id, {
      messages: result.messages,
      documents: result.new_documents,
      custom_state: result.state_updates
    });

    return result;
  }
}
```

**Audit Logging**:

```typescript
class AuditLogMiddleware implements AgentMiddleware {
  async afterInvoke(context, result): Promise<AgentResponse> {
    await auditLog.write({
      event: "agent_invocation",
      agent_id: context.agent.graph_id,
      thread_id: context.thread_id,
      run_id: context.run_id,
      user_id: context.user_id,
      input_length: JSON.stringify(context.input).length,
      output_length: JSON.stringify(result).length,
      tokens_used: result.metadata?.tokens_used,
      duration_ms: result.metadata?.processing_time_ms,
      status: result.status,
      timestamp: new Date().toISOString()
    });

    return result;
  }
}
```

#### 5.3.4 Middleware Pipeline

```typescript
class MiddlewarePipeline {
  private middlewares: AgentMiddleware[] = [];

  use(middleware: AgentMiddleware) {
    this.middlewares.push(middleware);
    this.middlewares.sort((a, b) => a.order - b.order);
  }

  async execute(
    context: InvokeContext,
    agentFn: (ctx: InvokeContext) => Promise<AgentResponse>
  ): Promise<AgentResponse> {

    // Pre-processing
    let ctx = context;
    for (const mw of this.middlewares) {
      if (mw.beforeInvoke) {
        ctx = await mw.beforeInvoke(ctx);
      }
    }

    // Agent execution
    let result: AgentResponse;
    try {
      result = await agentFn(ctx);
    } catch (error) {
      // Error handling
      for (const mw of this.middlewares) {
        if (mw.onError) {
          await mw.onError(ctx, error);
        }
      }
      throw error;
    }

    // Post-processing
    for (const mw of this.middlewares.reverse()) {
      if (mw.afterInvoke) {
        result = await mw.afterInvoke(ctx, result);
      }
    }

    return result;
  }
}
```

### 5.4 Context Assembly Engine

**Purpose**: Gather history + documents + new request into complete agent input.

#### 5.4.1 Assembly Process

```typescript
class ContextAssemblyEngine {
  async assemble(
    threadId: string | undefined,
    runInput: RunInput,
    runConfig: RunConfig,
    runContext: RunContext
  ): Promise<AgentInput> {

    const context: AgentInput = {
      messages: [],
      existing_documents: [],
      new_attachments: [],
      request_metadata: {
        run_id: generateRunId(),
        thread_id: threadId,
        user_id: runConfig.user_id
      }
    };

    // 1. Fetch conversation history
    if (threadId) {
      const threadState = await this.fetchThreadState(threadId);
      context.messages = threadState.values.messages || [];
      context.existing_documents = await this.resolveDocumentRefs(
        threadId,
        threadState.values.document_refs || []
      );
    }

    // 2. Append new input messages
    if (runInput.messages) {
      context.messages.push(...runInput.messages);
    }

    // 3. Fetch new attachments
    if (runContext.attachments) {
      context.new_attachments = await this.fetchAttachments(
        runContext.attachments
      );
    }

    // 4. Apply truncation if needed
    context.messages = await this.truncateHistory(
      context.messages,
      runConfig.max_context_tokens
    );

    return context;
  }

  private async fetchThreadState(threadId: string): Promise<ThreadState> {
    // GET /threads/{threadId}/state
    return await threadsApi.getState(threadId);
  }

  private async resolveDocumentRefs(
    threadId: string,
    refs: string[]
  ): Promise<Document[]> {
    // POST /store/items/search
    const items = await store.search({
      namespace_prefix: ["threads", threadId, "documents"],
      filter: { key: { $in: refs } }
    });

    return items.map(item => ({
      id: item.key,
      filename: item.value.filename,
      content: item.value.extracted_text,
      metadata: item.value.metadata
    }));
  }

  private async fetchAttachments(
    attachmentRefs: AttachmentRef[]
  ): Promise<Document[]> {
    const docs = [];
    for (const ref of attachmentRefs) {
      const item = await store.get(ref.store_namespace, ref.store_key);
      docs.push({
        id: ref.store_key,
        filename: item.value.filename,
        content: item.value.content,
        metadata: item.value.metadata
      });
    }
    return docs;
  }

  private async truncateHistory(
    messages: ConversationMessage[],
    maxTokens?: number
  ): Promise<ConversationMessage[]> {
    if (!maxTokens) return messages;

    // Estimate tokens
    let totalTokens = 0;
    const truncated = [];

    // Keep system message always
    const systemMsg = messages.find(m => m.role === "system");
    if (systemMsg) {
      truncated.push(systemMsg);
      totalTokens += this.estimateTokens(systemMsg.content);
    }

    // Add messages from end (most recent)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "system") continue;

      const tokens = this.estimateTokens(msg.content);
      if (totalTokens + tokens > maxTokens) break;

      truncated.unshift(msg);
      totalTokens += tokens;
    }

    return truncated;
  }

  private estimateTokens(text: string): number {
    // Rough estimate: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }
}
```

#### 5.4.2 Query Orchestration

The engine queries multiple APIs:

```
Context Assembly Flow:

  ┌─────────────────┐
  │  Run Request    │
  │  (input + ctx)  │
  └────────┬────────┘
           │
           ▼
  ┌─────────────────────────┐
  │  Thread State Query     │
  │  GET /threads/{id}/state│
  └────────┬────────────────┘
           │
           ▼
  ┌─────────────────────────┐
  │  Document Resolution    │
  │  POST /store/items/     │
  │       search            │
  └────────┬────────────────┘
           │
           ▼
  ┌─────────────────────────┐
  │  Attachment Fetch       │
  │  GET /store/items       │
  └────────┬────────────────┘
           │
           ▼
  ┌─────────────────────────┐
  │  Context Truncation     │
  │  (if needed)            │
  └────────┬────────────────┘
           │
           ▼
  ┌─────────────────────────┐
  │  Complete Agent Input   │
  └─────────────────────────┘
```

### 5.5 Streaming Response Handler

**Purpose**: Stream agent responses back through SSE.

#### 5.5.1 Token-by-Token Streaming

```typescript
class StreamingResponseHandler {
  async streamMessages(
    agentGenerator: AsyncGenerator<MessageChunk>,
    response: ServerResponse
  ): Promise<void> {

    // Set SSE headers
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    // Send metadata event
    this.sendEvent(response, 'metadata', {
      run_id: generateRunId(),
      timestamp: new Date().toISOString()
    });

    // Stream message chunks
    try {
      for await (const chunk of agentGenerator) {
        this.sendEvent(response, 'messages', {
          role: chunk.role,
          content: chunk.content
        });
      }

      // Send end event
      this.sendEvent(response, 'end', {
        status: 'success'
      });

    } catch (error) {
      // Send error event
      this.sendEvent(response, 'error', {
        message: error.message,
        type: error.constructor.name
      });
    }

    response.end();
  }

  private sendEvent(
    response: ServerResponse,
    event: string,
    data: any
  ): void {
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}
```

#### 5.5.2 Progress Events for Long-Running Agents

```typescript
async function* workflowAgentGenerator(
  input: AgentInput
): AsyncGenerator<ProgressEvent> {

  yield { type: 'progress', step: 'analyzing', percent: 25 };
  const analysis = await analyze(input.documents);

  yield { type: 'progress', step: 'summarizing', percent: 50 };
  const summary = await summarize(analysis);

  yield { type: 'progress', step: 'formatting', percent: 75 };
  const formatted = await format(summary);

  yield { type: 'result', data: formatted, percent: 100 };
}
```

**SSE Output**:

```
event: values
data: {"type":"progress","step":"analyzing","percent":25}

event: values
data: {"type":"progress","step":"summarizing","percent":50}

event: values
data: {"type":"result","data":{...},"percent":100}

event: end
data: {"status":"success"}
```

### 5.6 Agent Health and Monitoring

**Purpose**: Track agent availability, performance, errors.

#### 5.6.1 Health Check Interface

```typescript
interface AgentHealthCheck {
  agent_id: string;
  status: "healthy" | "degraded" | "unhealthy";
  last_check: string;

  metrics: {
    avg_response_time_ms: number;
    success_rate: number;
    error_rate: number;
    total_invocations: number;
  };

  issues: HealthIssue[];
}

interface HealthIssue {
  type: "timeout" | "error" | "overload";
  message: string;
  first_seen: string;
  occurrences: number;
}
```

**Health Check Endpoint**:

```typescript
// GET /agents/{agent_id}/health
async function checkAgentHealth(agentId: string): Promise<AgentHealthCheck> {
  const agent = await registry.get(agentId);

  // Attempt invocation with health check input
  const start = Date.now();
  try {
    await agent.factory().invoke({
      messages: [{ role: "system", content: "health_check" }]
    }, { timeout: 5000 });

    const responseTime = Date.now() - start;

    return {
      agent_id: agentId,
      status: responseTime < 1000 ? "healthy" : "degraded",
      last_check: new Date().toISOString(),
      metrics: await getAgentMetrics(agentId),
      issues: []
    };

  } catch (error) {
    return {
      agent_id: agentId,
      status: "unhealthy",
      last_check: new Date().toISOString(),
      metrics: await getAgentMetrics(agentId),
      issues: [{
        type: "error",
        message: error.message,
        first_seen: new Date().toISOString(),
        occurrences: 1
      }]
    };
  }
}
```

#### 5.6.2 Invocation Metrics

```typescript
class AgentMetrics {
  private metrics = new Map<string, AgentMetricData>();

  record(agentId: string, event: InvocationEvent): void {
    const data = this.metrics.get(agentId) || this.initMetrics();

    data.total_invocations++;
    data.response_times.push(event.duration_ms);

    if (event.status === "success") {
      data.success_count++;
    } else {
      data.error_count++;
    }

    this.metrics.set(agentId, data);
  }

  get(agentId: string): AgentMetrics {
    const data = this.metrics.get(agentId) || this.initMetrics();

    return {
      avg_response_time_ms: this.average(data.response_times),
      success_rate: data.success_count / data.total_invocations,
      error_rate: data.error_count / data.total_invocations,
      total_invocations: data.total_invocations,
      p50_response_time_ms: this.percentile(data.response_times, 0.5),
      p95_response_time_ms: this.percentile(data.response_times, 0.95),
      p99_response_time_ms: this.percentile(data.response_times, 0.99)
    };
  }
}
```

#### 5.6.3 Circuit Breaker Pattern

```typescript
class AgentCircuitBreaker {
  private state: "closed" | "open" | "half_open" = "closed";
  private failureCount = 0;
  private lastFailureTime: number = 0;

  private readonly FAILURE_THRESHOLD = 5;
  private readonly TIMEOUT_MS = 60000; // 1 minute
  private readonly HALF_OPEN_ATTEMPTS = 3;

  async execute<T>(
    agentId: string,
    fn: () => Promise<T>
  ): Promise<T> {

    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime > this.TIMEOUT_MS) {
        this.state = "half_open";
        this.failureCount = 0;
      } else {
        throw new Error(`Circuit breaker open for agent ${agentId}`);
      }
    }

    try {
      const result = await fn();

      if (this.state === "half_open") {
        this.state = "closed";
        this.failureCount = 0;
      }

      return result;

    } catch (error) {
      this.failureCount++;
      this.lastFailureTime = Date.now();

      if (this.failureCount >= this.FAILURE_THRESHOLD) {
        this.state = "open";
        await this.notifyCircuitOpen(agentId);
      }

      throw error;
    }
  }

  private async notifyCircuitOpen(agentId: string): Promise<void> {
    // Alert monitoring system
    console.error(`Circuit breaker OPEN for agent ${agentId}`);
    // Could send to monitoring service, Slack, etc.
  }
}
```

### 5.7 Multi-Agent Orchestration

**Purpose**: Multiple agents collaborating within a thread.

#### 5.7.1 Agent-to-Agent Communication Patterns

**Pattern 1: Sequential Delegation**

```typescript
// Agent A delegates to Agent B
async function agentA(state: State, runtime: Runtime): Promise<State> {
  // Agent A's processing
  const analysis = await analyzeInput(state.messages);

  // Delegate to specialist agent
  const delegateResult = await runtime.invoke({
    agent_id: "specialist_agent_b",
    input: {
      task: "deep_analysis",
      data: analysis
    }
  });

  return {
    messages: [
      ...state.messages,
      { role: "assistant", content: delegateResult.summary }
    ]
  };
}
```

**Pattern 2: Parallel Consultation**

```typescript
async function orchestratorAgent(state: State, runtime: Runtime): Promise<State> {
  // Consult multiple specialized agents in parallel
  const [legal, financial, technical] = await Promise.all([
    runtime.invoke({ agent_id: "legal_agent", input: state }),
    runtime.invoke({ agent_id: "financial_agent", input: state }),
    runtime.invoke({ agent_id: "technical_agent", input: state })
  ]);

  // Synthesize results
  const synthesis = await synthesize([legal, financial, technical]);

  return {
    messages: [...state.messages, { role: "assistant", content: synthesis }]
  };
}
```

**Pattern 3: Hierarchical Decision Tree**

```typescript
async function routingAgent(state: State, runtime: Runtime): Promise<State> {
  // Determine which specialist to route to
  const category = await classifyRequest(state.messages[-1]);

  const specialistMap = {
    "technical": "tech_support_agent",
    "billing": "billing_agent",
    "general": "general_assistant_agent"
  };

  const targetAgent = specialistMap[category];

  return await runtime.invoke({
    agent_id: targetAgent,
    input: state
  });
}
```

#### 5.7.2 Subgraph Delegation

LangGraph supports subgraphs natively:

```python
# Parent graph
from langgraph.graph import StateGraph

parent_builder = StateGraph(ParentState)

# Define child graph as subgraph
child_graph = build_child_graph()
parent_builder.add_node("specialist", child_graph)

# Route to subgraph
parent_builder.add_edge("router", "specialist")
parent_builder.add_edge("specialist", "synthesizer")
```

**API Representation**:

```typescript
// GET /assistants/{assistant_id}/subgraphs
{
  "subgraphs": [
    {
      "namespace": "specialist",
      "graph_id": "specialist_agent",
      "recurse": true
    }
  ]
}
```

### 5.8 Security and Access Control

**Purpose**: Ensure agents and documents are accessed appropriately.

#### 5.8.1 Per-Agent Authorization

```typescript
interface AgentAccessControl {
  // Check if user can invoke agent
  canInvoke(userId: string, agentId: string): Promise<boolean>;

  // Check if user can access agent's results
  canViewResults(userId: string, runId: string): Promise<boolean>;

  // Check if user can modify agent configuration
  canModifyAgent(userId: string, agentId: string): Promise<boolean>;
}

class RoleBasedAgentAuth implements AgentAccessControl {
  async canInvoke(userId: string, agentId: string): Promise<boolean> {
    const userRoles = await this.getUserRoles(userId);
    const agentRequiredRoles = await this.getAgentRequiredRoles(agentId);

    return userRoles.some(role => agentRequiredRoles.includes(role));
  }
}
```

**Agent Registration with Required Roles**:

```typescript
{
  "graph_id": "sensitive_data_agent",
  "metadata": {
    "required_roles": ["data_analyst", "admin"],
    "security_level": "high"
  }
}
```

**Invocation Check**:

```typescript
// Middleware
class AuthorizationMiddleware implements AgentMiddleware {
  async beforeInvoke(context: InvokeContext): Promise<InvokeContext> {
    const canInvoke = await accessControl.canInvoke(
      context.user_id,
      context.agent.graph_id
    );

    if (!canInvoke) {
      throw new UnauthorizedError(`User ${context.user_id} cannot invoke agent ${context.agent.graph_id}`);
    }

    return context;
  }
}
```

#### 5.8.2 Document Access Control

```typescript
interface DocumentAccessControl {
  // Check if user can read document
  canRead(userId: string, documentId: string): Promise<boolean>;

  // Check if user can upload to namespace
  canUpload(userId: string, namespace: string[]): Promise<boolean>;

  // Filter documents based on user permissions
  filterAccessible(userId: string, documents: Document[]): Promise<Document[]>;
}
```

**Store Namespace-Based Access**:

```typescript
// PUT /store/items with access control metadata
{
  "namespace": ["users", "user_123", "documents"],
  "key": "private_doc",
  "value": {
    "filename": "confidential.pdf",
    "content": "...",
    "access_control": {
      "owner": "user_123",
      "shared_with": ["user_456"],
      "visibility": "private"
    }
  }
}
```

**Agent Document Access Check**:

```typescript
async function agent_node(state, runtime: Runtime) {
  const docs = await runtime.store.asearch(
    ("users", state.user_id, "documents"),
    query=state["messages"][-1].content
  );

  // Filter by access control
  const accessible = await accessControl.filterAccessible(
    state.user_id,
    docs
  );

  // Use only accessible documents
}
```

#### 5.8.3 Input/Output Sanitization

```typescript
class SanitizationMiddleware implements AgentMiddleware {
  async beforeInvoke(context: InvokeContext): Promise<InvokeContext> {
    // Sanitize input
    context.input = {
      ...context.input,
      messages: context.input.messages.map(msg => ({
        ...msg,
        content: this.sanitizeInput(msg.content)
      }))
    };

    return context;
  }

  async afterInvoke(context, result): Promise<AgentResponse> {
    // Sanitize output
    result.messages = result.messages.map(msg => ({
      ...msg,
      content: this.sanitizeOutput(msg.content)
    }));

    return result;
  }

  private sanitizeInput(text: string): string {
    // Remove potential injection attacks
    return text
      .replace(/<script[^>]*>.*?<\/script>/gi, '')
      .replace(/javascript:/gi, '')
      .trim();
  }

  private sanitizeOutput(text: string): string {
    // Remove PII, sensitive tokens
    return text
      .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN_REDACTED]') // SSNs
      .replace(/\b\d{16}\b/g, '[CARD_REDACTED]'); // Credit cards
  }
}
```

---

## 6. Data Flow Diagrams

### 6.1 End-to-End Flow: User Request → Agent → Response

```
┌──────────────────────────────────────────────────────────────────┐
│  Client (LangGraph SDK)                                          │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   │ POST /threads/{thread_id}/runs
                   │ {
                   │   "assistant_id": "asst_123",
                   │   "input": {"messages": [...]},
                   │   "stream_mode": ["messages"]
                   │ }
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  API Layer (Fastify/Express)                                     │
│  • Validate request                                              │
│  • Authenticate user                                             │
│  • Route to Runs handler                                         │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Middleware Pipeline                                             │
│  1. Authorization check                                          │
│  2. Input validation                                             │
│  3. Rate limiting                                                │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Context Assembly Engine                                         │
│  ┌──────────────────────────────────────────────────────┐       │
│  │ 1. Fetch thread state                                │       │
│  │    GET /threads/{thread_id}/state                    │       │
│  │    → messages: [...history]                          │       │
│  │    → document_refs: ["doc1", "doc2"]                 │       │
│  └──────────────────────────────────────────────────────┘       │
│  ┌──────────────────────────────────────────────────────┐       │
│  │ 2. Resolve documents                                 │       │
│  │    POST /store/items/search                          │       │
│  │    namespace: ["threads", thread_id, "documents"]    │       │
│  │    → documents: [{content, metadata}, ...]           │       │
│  └──────────────────────────────────────────────────────┘       │
│  ┌──────────────────────────────────────────────────────┐       │
│  │ 3. Fetch attachments (if any)                        │       │
│  │    GET /store/items                                  │       │
│  └──────────────────────────────────────────────────────┘       │
│  ┌──────────────────────────────────────────────────────┐       │
│  │ 4. Merge into agent input                            │       │
│  │    {                                                 │       │
│  │      messages: [...history, ...new_input],           │       │
│  │      documents: [...existing, ...attachments],       │       │
│  │      metadata: {thread_id, run_id, user_id}          │       │
│  │    }                                                 │       │
│  └──────────────────────────────────────────────────────┘       │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Agent Registry                                                  │
│  • Lookup agent by assistant_id → graph_id                      │
│  • Get agent factory                                             │
│  • Load agent schemas                                            │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Agent Execution                                                 │
│  ┌──────────────────────────────────────────────────────┐       │
│  │ Custom Agent Implementation                          │       │
│  │ (LangGraph graph, class, or function)                │       │
│  │                                                      │       │
│  │ async function agent(input, config):                 │       │
│  │   // Access context                                  │       │
│  │   messages = input.messages                          │       │
│  │   documents = input.documents                        │       │
│  │                                                      │       │
│  │   // Process                                         │       │
│  │   analysis = await analyze(documents)                │       │
│  │   response = await generateResponse(messages, analysis)│     │
│  │                                                      │       │
│  │   // Return result                                   │       │
│  │   return {                                           │       │
│  │     messages: [response],                            │       │
│  │     state_updates: {...}                             │       │
│  │   }                                                  │       │
│  └──────────────────────────────────────────────────────┘       │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Post-Processing Middleware                                      │
│  1. Format response                                              │
│  2. Update thread state                                          │
│  3. Audit logging                                                │
│  4. Metrics recording                                            │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  State Update                                                    │
│  POST /threads/{thread_id}/state                                 │
│  {                                                               │
│    "values": {                                                   │
│      "messages": [...history, ...new_response],                  │
│      "documents": [...existing, ...new_docs],                    │
│      "custom_state": {...}                                       │
│    }                                                             │
│  }                                                               │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Response to Client                                              │
│  • If streaming: SSE events                                      │
│  • If complete: Run object with result                           │
└──────────────────────────────────────────────────────────────────┘
```

### 6.2 Document Flow: Upload → Store → Agent Context

```
┌──────────────────────────────────────────────────────────────────┐
│  User Uploads Document                                           │
│  POST /documents/upload (custom endpoint)                        │
│  multipart/form-data: file + metadata                            │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Document Processing Pipeline                                    │
│  ┌──────────────────────────────────────────────────────┐       │
│  │ 1. Generate document_id                              │       │
│  │    doc_id = uuid()                                   │       │
│  └──────────────────────────────────────────────────────┘       │
│  ┌──────────────────────────────────────────────────────┐       │
│  │ 2. Extract text                                      │       │
│  │    If PDF: use pdf-parse                             │       │
│  │    If DOCX: use mammoth                              │       │
│  │    → extracted_text                                  │       │
│  └──────────────────────────────────────────────────────┘       │
│  ┌──────────────────────────────────────────────────────┐       │
│  │ 3. Generate embeddings                               │       │
│  │    embeddings = await embed(extracted_text)          │       │
│  └──────────────────────────────────────────────────────┘       │
│  ┌──────────────────────────────────────────────────────┐       │
│  │ 4. Extract metadata                                  │       │
│  │    page_count, word_count, language, etc.            │       │
│  └──────────────────────────────────────────────────────┘       │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Store Document in Store API                                     │
│  PUT /store/items                                                │
│  {                                                               │
│    "namespace": ["threads", thread_id, "documents"],             │
│    "key": doc_id,                                                │
│    "value": {                                                    │
│      "filename": "report.pdf",                                   │
│      "mime_type": "application/pdf",                             │
│      "extracted_text": "...",                                    │
│      "metadata": {...},                                          │
│      "embeddings": [...]                                         │
│    },                                                            │
│    "index": true  // Enable vector search                        │
│  }                                                               │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Update Thread State with Document Reference                     │
│  POST /threads/{thread_id}/state                                 │
│  {                                                               │
│    "values": {                                                   │
│      "document_refs": [...existing, doc_id]                      │
│    }                                                             │
│  }                                                               │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Subsequent Agent Invocation                                     │
│  POST /threads/{thread_id}/runs                                  │
│  {                                                               │
│    "assistant_id": "asst_123",                                   │
│    "input": {                                                    │
│      "messages": [{"role": "user", "content": "Summarize report"}]│
│    }                                                             │
│  }                                                               │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Context Assembly                                                │
│  1. GET /threads/{thread_id}/state                               │
│     → document_refs: [doc_id, ...]                               │
│                                                                  │
│  2. POST /store/items/search                                     │
│     namespace: ["threads", thread_id, "documents"]               │
│     filter: {key: {$in: [doc_id, ...]}}                          │
│     → documents: [{content, metadata}, ...]                      │
│                                                                  │
│  3. Assemble agent input:                                        │
│     {                                                            │
│       messages: [...],                                           │
│       documents: [{id: doc_id, content: "...", metadata}, ...]   │
│     }                                                            │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Agent Processes Documents                                       │
│  • Reads document content                                        │
│  • Performs analysis                                             │
│  • Generates response                                            │
└──────────────────────────────────────────────────────────────────┘
```

### 6.3 Streaming Flow: Agent Output → SSE Events → Client

```
┌──────────────────────────────────────────────────────────────────┐
│  Client Initiates Streaming Run                                  │
│  POST /threads/{thread_id}/runs/stream                           │
│  {                                                               │
│    "assistant_id": "asst_123",                                   │
│    "input": {...},                                               │
│    "stream_mode": ["messages"]                                   │
│  }                                                               │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  API Establishes SSE Connection                                  │
│  • Set headers:                                                  │
│    Content-Type: text/event-stream                               │
│    Cache-Control: no-cache                                       │
│    Connection: keep-alive                                        │
│  • Keep connection open                                          │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Send Metadata Event                                             │
│  event: metadata                                                 │
│  data: {"run_id":"run_123","thread_id":"thread_456","timestamp":"..."}│
│                                                                  │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Context Assembly + Agent Invocation                             │
│  (Same as end-to-end flow)                                       │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Agent Execution with Streaming                                  │
│  ┌──────────────────────────────────────────────────────┐       │
│  │ async function* agent(input, config):                │       │
│  │   // LLM streaming                                   │       │
│  │   for await (const chunk of llm.stream(messages)):   │       │
│  │     yield {                                          │       │
│  │       type: "message_chunk",                         │       │
│  │       content: chunk.content                         │       │
│  │     }                                                │       │
│  └──────────────────────────────────────────────────────┘       │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   │ (Generator yields chunks)
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Streaming Response Handler                                      │
│  for await (const chunk of agentGenerator):                      │
│    sendSSE("messages", chunk)                                    │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  SSE Events Sent to Client                                       │
│                                                                  │
│  event: messages                                                 │
│  data: {"role":"assistant","content":"The "}                     │
│                                                                  │
│  event: messages                                                 │
│  data: {"role":"assistant","content":"document "}                │
│                                                                  │
│  event: messages                                                 │
│  data: {"role":"assistant","content":"shows "}                   │
│                                                                  │
│  event: messages                                                 │
│  data: {"role":"assistant","content":"that "}                    │
│                                                                  │
│  ...                                                             │
│                                                                  │
│  event: end                                                      │
│  data: {"status":"success"}                                      │
│                                                                  │
└──────────────────┬───────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  Client Receives and Displays                                    │
│  • EventSource or SDK decoder parses events                      │
│  • UI displays tokens in real-time                               │
│  • Connection closes on 'end' event                              │
└──────────────────────────────────────────────────────────────────┘
```

---

## 7. State Management Strategy

### 7.1 What Goes Where

| Data Type | Thread State | Store API | Run Input | Rationale |
|-----------|--------------|-----------|-----------|-----------|
| Conversation history | ✓ (messages) | ✗ | New msg | Tied to thread lifecycle, sequential |
| Document references | ✓ (doc_refs) | ✗ | ✗ | Lightweight pointers |
| Document content | ✗ | ✓ | ✗ | Large, searchable, shareable |
| User preferences | ✗ | ✓ (user ns) | ✗ | Cross-thread, persistent |
| Temporary attachments | ✗ | ✓ (temp ns) | Ref | Large, short-lived |
| Agent working state | ✓ (custom) | ✗ | ✗ | Execution context |
| Memories | ✗ | ✓ (memory ns) | ✗ | Cross-thread, searchable |
| Run-specific config | ✗ | ✗ | ✓ (config) | Per-invocation settings |

### 7.2 Conversation History Management

#### 7.2.1 Growth Pattern

```
Turn 1:  [sys, user, asst]                    → 3 messages
Turn 2:  [sys, user, asst, user, asst]        → 5 messages
Turn 3:  [sys, user, asst, user, asst, user, asst] → 7 messages
...
Turn N:  [sys, ...2N+1 messages]              → 2N+1 messages
```

**Problem**: Unbounded growth exceeds context windows.

#### 7.2.2 Truncation Strategies

**Strategy 1: Sliding Window (Last N Messages)**

```typescript
function truncateLastN(messages: Message[], n: number): Message[] {
  const system = messages.find(m => m.role === "system");
  const recent = messages.slice(-n);

  return system ? [system, ...recent.filter(m => m.role !== "system")] : recent;
}
```

**Strategy 2: Token-Based Truncation**

```typescript
function truncateByTokens(messages: Message[], maxTokens: number): Message[] {
  let tokens = 0;
  const result = [];

  // Keep system message
  const system = messages.find(m => m.role === "system");
  if (system) {
    result.push(system);
    tokens += estimateTokens(system.content);
  }

  // Add messages from most recent
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "system") continue;

    const msgTokens = estimateTokens(msg.content);
    if (tokens + msgTokens > maxTokens) break;

    result.unshift(msg);
    tokens += msgTokens;
  }

  return result;
}
```

**Strategy 3: Summarization**

```typescript
async function summarizeHistory(
  messages: Message[],
  keepRecent: number = 5
): Promise<Message[]> {

  const system = messages.find(m => m.role === "system");
  const recent = messages.slice(-keepRecent);
  const toSummarize = messages.slice(0, -keepRecent).filter(m => m.role !== "system");

  if (toSummarize.length === 0) return messages;

  // Summarize older messages
  const summary = await llm.summarize(toSummarize);

  return [
    system,
    { role: "system", content: `Previous conversation summary: ${summary}` },
    ...recent
  ].filter(Boolean);
}
```

#### 7.2.3 Configuration

```typescript
interface HistoryManagementConfig {
  strategy: "last_n" | "token_based" | "summarize";
  max_messages?: number;
  max_tokens?: number;
  keep_recent?: number;
  auto_summarize_threshold?: number;
}

// Per-assistant configuration
{
  "assistant_id": "asst_123",
  "config": {
    "history_management": {
      "strategy": "token_based",
      "max_tokens": 4000,
      "keep_recent": 10
    }
  }
}
```

### 7.3 Document Reference vs Embedding

**Reference Approach** (Recommended):

```typescript
// Thread state (small)
{
  "document_refs": ["doc_abc", "doc_xyz"]
}

// Store (large)
// ["threads", thread_id, "documents", doc_abc]
{
  "filename": "report.pdf",
  "extracted_text": "...",
  "embeddings": [...]
}
```

**Pros**:
- Thread state stays small
- Documents can be shared across threads
- Easy to update document content without touching thread state
- Store provides vector search

**Cons**:
- Requires two API calls (state + store)
- More complex to manage

**Embedded Approach**:

```typescript
// Thread state (large)
{
  "documents": [
    {
      "id": "doc_abc",
      "filename": "report.pdf",
      "content": "...",
      "embeddings": [...]
    }
  ]
}
```

**Pros**:
- Single API call
- Simple to manage

**Cons**:
- Thread state grows large
- Cannot share documents
- Limited search capabilities
- Harder to update

**Recommendation**: Use Reference Approach for production systems.

---

## 8. Agent Interface Contract

### 8.1 TypeScript Interface

```typescript
/**
 * Agent Interface
 * All custom agents must implement this interface
 */
interface Agent<TInput = AgentInput, TOutput = AgentResponse, TConfig = AgentConfig> {

  /**
   * Agent metadata
   */
  readonly metadata: AgentMetadata;

  /**
   * Invoke the agent with given input
   * @param input - The agent input (messages, documents, etc.)
   * @param config - Runtime configuration
   * @returns Agent response
   */
  invoke(input: TInput, config: TConfig): Promise<TOutput>;

  /**
   * Stream agent output
   * @param input - The agent input
   * @param config - Runtime configuration
   * @returns Async generator of output chunks
   */
  stream?(input: TInput, config: TConfig): AsyncGenerator<StreamChunk<TOutput>>;

  /**
   * Lifecycle: Initialize agent
   * Called once when agent is first loaded
   */
  init?(): Promise<void>;

  /**
   * Lifecycle: Cleanup resources
   * Called when agent is unloaded
   */
  cleanup?(): Promise<void>;

  /**
   * Health check
   * @returns Health status
   */
  healthCheck?(): Promise<HealthStatus>;
}
```

### 8.2 Input Schema

```typescript
/**
 * Standard agent input structure
 */
interface AgentInput {
  /**
   * Conversation messages (history + new input)
   */
  messages: ConversationMessage[];

  /**
   * Documents from thread state
   */
  existing_documents: Document[];

  /**
   * New attachments for this request
   */
  new_attachments: Document[];

  /**
   * Request metadata
   */
  request_metadata: {
    thread_id?: string;
    run_id: string;
    user_id?: string;
    timestamp: string;
  };

  /**
   * Agent-specific fields (validated by agent's input schema)
   */
  [key: string]: any;
}

interface ConversationMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  timestamp?: string;
  metadata?: Record<string, any>;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface Document {
  id: string;
  filename: string;
  mime_type: string;
  content: string;
  metadata: Record<string, any>;
}
```

### 8.3 Output Schema

```typescript
/**
 * Standard agent response structure
 */
interface AgentResponse {
  /**
   * Response messages to append to conversation
   */
  messages: ConversationMessage[];

  /**
   * State updates (merged into thread state)
   */
  state_updates?: Record<string, any>;

  /**
   * New documents produced by agent
   */
  new_documents?: DocumentMetadata[];

  /**
   * Execution status
   */
  status: "success" | "error" | "interrupted" | "waiting_for_input";

  /**
   * Error details (if status = "error")
   */
  error?: {
    type: string;
    message: string;
    code?: string;
  };

  /**
   * Interrupt details (if status = "interrupted")
   */
  interrupt?: {
    reason: string;
    data: any;
  };

  /**
   * Next steps (for multi-step workflows)
   */
  next_steps?: string[];

  /**
   * Metadata about execution
   */
  metadata?: {
    tokens_used?: number;
    tools_called?: string[];
    processing_time_ms?: number;
    model_used?: string;
    [key: string]: any;
  };
}
```

### 8.4 Configuration Schema

```typescript
/**
 * Agent configuration
 */
interface AgentConfig {
  /**
   * Standard LangGraph config
   */
  tags?: string[];
  recursion_limit?: number;

  /**
   * Configurable runtime parameters
   */
  configurable?: {
    /**
     * User ID for context
     */
    user_id?: string;

    /**
     * Agent-specific runtime config
     * Structure defined by agent's config schema
     */
    [key: string]: any;
  };

  /**
   * Timeout in milliseconds
   */
  timeout?: number;

  /**
   * Whether to enable streaming
   */
  stream?: boolean;
}
```

### 8.5 Example Implementation

```typescript
class DocumentAnalystAgent implements Agent {

  readonly metadata: AgentMetadata = {
    graph_id: "document_analyst",
    name: "Document Analysis Agent",
    description: "Analyzes documents and answers questions",
    version: "1.0.0",
    capabilities: ["document_analysis", "qa", "summarization"],
    supported_input_types: ["application/pdf", "text/plain"]
  };

  async init(): Promise<void> {
    // Initialize resources (model, connections, etc.)
    console.log("Document Analyst Agent initialized");
  }

  async invoke(input: AgentInput, config: AgentConfig): Promise<AgentResponse> {
    try {
      // Extract context
      const query = input.messages[input.messages.length - 1].content;
      const documents = [...input.existing_documents, ...input.new_attachments];

      // Process
      const analysis = await this.analyzeDocuments(documents, query);
      const response = await this.generateResponse(analysis, query);

      // Return
      return {
        messages: [
          {
            role: "assistant",
            content: response,
            timestamp: new Date().toISOString()
          }
        ],
        state_updates: {
          last_analysis: analysis
        },
        status: "success",
        metadata: {
          documents_analyzed: documents.length,
          processing_time_ms: 1234
        }
      };

    } catch (error) {
      return {
        messages: [],
        status: "error",
        error: {
          type: error.constructor.name,
          message: error.message
        }
      };
    }
  }

  async *stream(input: AgentInput, config: AgentConfig): AsyncGenerator<StreamChunk> {
    const query = input.messages[input.messages.length - 1].content;
    const documents = [...input.existing_documents, ...input.new_attachments];

    // Stream analysis progress
    yield { type: "progress", data: { step: "analyzing", percent: 25 } };
    const analysis = await this.analyzeDocuments(documents, query);

    yield { type: "progress", data: { step: "generating", percent: 50 } };

    // Stream response tokens
    for await (const token of this.streamResponse(analysis, query)) {
      yield {
        type: "message_chunk",
        data: {
          role: "assistant",
          content: token
        }
      };
    }
  }

  private async analyzeDocuments(documents: Document[], query: string): Promise<any> {
    // Implementation...
    return {};
  }

  private async generateResponse(analysis: any, query: string): Promise<string> {
    // Implementation...
    return "Response text";
  }

  private async *streamResponse(analysis: any, query: string): AsyncGenerator<string> {
    // Implementation...
    yield "Token ";
    yield "by ";
    yield "token";
  }

  async healthCheck(): Promise<HealthStatus> {
    return {
      status: "healthy",
      timestamp: new Date().toISOString()
    };
  }

  async cleanup(): Promise<void> {
    console.log("Document Analyst Agent cleaned up");
  }
}
```

---

## 9. Open Questions and Decisions

### 9.1 Architecture Decisions

**Q1: Should document content be stored in thread state or Store API?**

**Options**:
1. Thread state (simpler, everything in one place)
2. Store API (scalable, searchable, shareable)
3. Hybrid (refs in state, content in store)

**Recommendation**: Hybrid approach (refs in state, content in store)
- Thread state stays manageable size
- Documents can be shared across threads
- Vector search capabilities
- Separate lifecycle management

**Decision Required**: Confirm this approach with team.

---

**Q2: How should conversation history be truncated?**

**Options**:
1. Fixed window (last N messages)
2. Token-based (keep messages until token limit)
3. Summarization (compress older messages)
4. Per-assistant configuration

**Recommendation**: Token-based with per-assistant override
- More flexible than fixed window
- Respects model context limits
- Can be customized per agent type

**Decision Required**: Default max tokens value? (Suggest: 4000 for GPT-4)

---

**Q3: Should agents be registered statically (code) or dynamically (API)?**

**Options**:
1. Static: Agents defined in code, loaded at startup
2. Dynamic: Agents registered via API at runtime
3. Hybrid: Core agents static, custom agents dynamic

**Recommendation**: Hybrid
- Core platform agents compiled into server
- Custom agents registered via API
- Supports hot-reload for development

**Decision Required**: Security model for dynamic registration?

---

### 9.2 Implementation Decisions

**Q4: How to handle large document uploads?**

**Options**:
1. Inline in run input (base64)
2. Pre-upload to store, reference in run
3. Multipart upload with resumption
4. External storage (S3) with signed URLs

**Recommendation**: Pre-upload to store
- Keeps run requests small
- Supports progress tracking
- Can validate before agent invocation
- Aligns with Store API design

**Decision Required**: Maximum document size limit? (Suggest: 100MB)

---

**Q5: Should middleware be configurable per agent or global?**

**Options**:
1. Global middleware for all agents
2. Per-agent middleware configuration
3. Hybrid (global + per-agent)

**Recommendation**: Hybrid
- Global: Auth, rate limiting, audit logging
- Per-agent: Input validation, custom preprocessing

**Decision Required**: Middleware registration API design?

---

**Q6: How to handle agent timeouts?**

**Options**:
1. Fixed timeout for all agents
2. Per-agent timeout configuration
3. Streaming with heartbeat (no timeout)

**Recommendation**: Per-agent timeout with default
- Different agents have different execution times
- Document analysis may need minutes
- Chat agents need seconds

**Decision Required**: Default timeout? (Suggest: 30 seconds)

---

### 9.3 Feature Priorities

**Q7: Which features should be implemented first?**

**Phase 1 (MVP)**:
- Agent registry (static agents)
- Context assembly engine
- Basic document management (refs in state)
- Message streaming
- Single-agent invocation

**Phase 2 (Enhanced)**:
- Store API integration for documents
- Vector search for documents
- Middleware pipeline
- Agent health monitoring
- Per-agent configuration

**Phase 3 (Advanced)**:
- Multi-agent orchestration
- Dynamic agent registration
- Advanced security (RBAC)
- Circuit breakers
- A/B testing for agents

**Decision Required**: Confirm phase priorities?

---

**Q8: Should we support both LangGraph graphs and custom function agents?**

**Options**:
1. Only LangGraph graphs (consistent, well-defined)
2. Only custom functions (flexible, simple)
3. Both (maximum flexibility)

**Recommendation**: Both
- LangGraph graphs for complex workflows
- Custom functions for simple agents
- Unified interface hides implementation

**Decision Required**: How to detect agent type during registration?

---

### 9.4 Security and Compliance

**Q9: How to handle PII in documents and conversations?**

**Options**:
1. No automatic handling (user responsibility)
2. PII detection and redaction middleware
3. Encryption at rest
4. Separate storage for sensitive data

**Recommendation**: PII detection middleware + encryption
- Automatic detection of SSN, credit cards, etc.
- Optional redaction or encryption
- Audit trail for access

**Decision Required**: Which PII detection library? (Suggest: Presidio)

---

**Q10: Should agent responses be stored permanently?**

**Options**:
1. Store all responses indefinitely
2. TTL-based cleanup
3. User-controlled retention
4. No persistence (thread state only)

**Recommendation**: TTL-based with user override
- Default: 30 days
- Premium users: Extended retention
- Compliance mode: Configurable policies

**Decision Required**: Default TTL value?

---

## 10. Assumptions & Scope

### 10.1 Assumptions Made

| Assumption | Confidence | Impact if Wrong |
|------------|------------|-----------------|
| LangGraph SDK clients will use thread-based conversations | HIGH | Need to support stateless-only mode |
| Documents are primarily text-based (PDF, DOCX, TXT) | MEDIUM | Need additional processors for images, video |
| Agents can complete within 5 minutes | MEDIUM | Need long-running job queue |
| Vector search is required for document retrieval | MEDIUM | Can simplify to keyword search |
| Single-region deployment is sufficient | HIGH | Need multi-region store replication |
| Agents trust each other (no agent-to-agent auth) | LOW | Need agent identity and auth system |
| English is primary language | MEDIUM | Need i18n support for multilingual documents |
| Thread state < 10MB is acceptable | HIGH | Need more aggressive truncation |
| Store API supports 100K+ items per namespace | MEDIUM | Need namespace sharding strategy |
| SSE streaming is sufficient (no WebSocket needed) | HIGH | Need to add WebSocket support |

### 10.2 Scope Boundaries

**In Scope**:
- Custom agent registration and discovery
- Context assembly (history + documents + request)
- Document upload and storage via Store API
- Message streaming via SSE
- Thread-based state management
- Agent middleware pipeline
- Basic health monitoring

**Out of Scope** (for initial implementation):
- Real-time collaboration (multiple users in same thread)
- Agent marketplace (public agent sharing)
- Advanced analytics and reporting
- Agent training/fine-tuning
- Multi-modal agents (image/video/audio input)
- Agent versioning and A/B testing (Phase 2)
- Federated agent deployment
- Agent billing and usage tracking
- WebSocket streaming (SSE only)
- Agent-to-agent authentication (trust assumed)

### 10.3 Uncertainties & Gaps

**Uncertainty 1: LangGraph Store API Maturity**
- The Store API is relatively new (added late 2025)
- Production readiness unclear
- Vector search performance unknown at scale
- **Mitigation**: Prototype with InMemoryStore, plan for custom implementation

**Uncertainty 2: Streaming Reliability**
- SSE connections may drop on mobile/unstable networks
- Reconnection logic complexity
- **Mitigation**: Implement `stream_resumable` support with `last_event_id`

**Uncertainty 3: Multi-Agent Coordination**
- How to handle conflicts between agents
- State consistency during concurrent access
- **Mitigation**: Start with sequential invocation, add concurrency later

**Uncertainty 4: Document Processing Performance**
- Large PDF parsing can block event loop
- Embedding generation is slow
- **Mitigation**: Background processing queue, streaming upload

**Uncertainty 5: Cost Management**
- Token usage can accumulate quickly with large documents
- Store API pricing model unknown
- **Mitigation**: Implement token tracking, user quotas

### 10.4 Clarifying Questions for Follow-up

1. **Agent Registration**: Should agents be containerized for isolation, or run in-process?

2. **Document Retention**: How long should documents be retained in the Store? Are there compliance requirements?

3. **Rate Limiting**: What are the rate limits for agent invocations per user/tenant?

4. **Multi-Tenancy**: Is multi-tenant isolation required? How should namespaces be organized?

5. **Observability**: Which telemetry system should be used? (OpenTelemetry, LangSmith, custom?)

6. **Agent Development**: Will users develop agents, or only internal team? If users, what guardrails are needed?

7. **Fallback Behavior**: If primary agent fails, should there be fallback to simpler agent?

8. **Cost Attribution**: How to track and bill for agent usage (tokens, compute time)?

9. **Agent Discovery**: Should there be a UI for browsing and testing agents?

10. **Document Search**: Is full-text search sufficient, or is semantic/vector search required?

---

## 11. References

### Official Documentation

- [LangGraph Platform API Reference](https://docs.langchain.com/langgraph-platform/server-api-ref)
- [LangGraph SDK Python Reference](https://reference.langchain.com/python/langgraph-sdk/_sync/client)
- [Use Threads - LangChain Docs](https://docs.langchain.com/langsmith/use-threads)
- [Persistence - LangChain Docs](https://docs.langchain.com/oss/python/langgraph/persistence)
- [Store System | DeepWiki](https://deepwiki.com/langchain-ai/langgraph/4.3-store-system)
- [ThreadState Reference](https://reference.langchain.com/python/langgraph-sdk/schema/ThreadState)

### Multi-Agent Architecture

- [CrewAI vs LangGraph vs AutoGen | DataCamp](https://www.datacamp.com/tutorial/crewai-vs-langgraph-vs-autogen)
- [Multi-Agent Frameworks Explained for Enterprise AI Systems [2026]](https://www.adopt.ai/blog/multi-agent-frameworks)
- [LangGraph vs CrewAI vs AutoGen: Complete Guide for 2026 - DEV Community](https://dev.to/pockit_tools/langgraph-vs-crewai-vs-autogen-the-complete-multi-agent-ai-orchestration-guide-for-2026-2d63)
- [Patterns - Multi-agent Reference Architecture | Microsoft](https://microsoft.github.io/multi-agent-reference-architecture/docs/reference-architecture/Patterns.html)

### Agent Registry and Discovery

- [Register Agents to the Agent Registry | Microsoft Learn](https://learn.microsoft.com/en-us/entra/agent-id/identity-platform/publish-agents-to-registry)
- [A Survey of AI Agent Registry Solutions](https://arxiv.org/html/2508.03095v1)
- [Building an AI Agent Registry Server with FastAPI - DEV Community](https://dev.to/sreeni5018/building-an-ai-agent-registry-server-with-fastapi-enabling-seamless-agent-discovery-via-a2a-15dj)
- [Agent Discovery, Naming, and Resolution | Solo.io](https://www.solo.io/blog/agent-discovery-naming-and-resolution---the-missing-pieces-to-a2a)

### Middleware and Patterns

- [8 Middleware Layers Between Your Agent and Production | Medium](https://medium.com/@kumaran.isk/8-middleware-layers-between-your-agent-and-production-92c7880b4d08)
- [Agentic Design Patterns: The 2026 Guide](https://www.sitepoint.com/the-definitive-guide-to-agentic-design-patterns-in-2026/)
- [Unlocking Agent Control: LangChain Middleware | Medium](https://nayakpplaban.medium.com/unlocking-agent-control-a-beginners-guide-to-langchain-middleware-dbe438c896c2)
- [Middleware System | DeepWiki](https://deepwiki.com/microsoft/agent-framework/3.7-middleware-system)

### Streaming and SSE

- [Streaming AI Agents Responses with SSE | Medium](https://akanuragkumar.medium.com/streaming-ai-agents-responses-with-server-sent-events-sse-a-technical-case-study-f3ac855d0755)
- [Server-Sent Events: A Comprehensive Guide | Medium](https://medium.com/@moali314/server-sent-events-a-comprehensive-guide-e4b15d147576)
- [SSE Streaming | DeepWiki](https://deepwiki.com/agentailor/fullstack-langgraph-nextjs-agent/6.3-sse-streaming)
- [Server-Sent Events (SSE) - FastAPI](https://fastapi.tiangolo.com/tutorial/server-sent-events/)

### Document Management

- [Powering Long-Term Memory With LangGraph And MongoDB](https://www.mongodb.com/company/blog/product-release-announcements/powering-long-term-memory-for-agents-langgraph)
- [Managing Context History in Agentic Systems | Medium](https://medium.com/@thakur.rana/managing-context-history-in-agentic-systems-with-langgraph-3645610c43fe)

### Thread State and Persistence

- [Threads and State Management | DeepWiki](https://deepwiki.com/langchain-ai/langgraph/7.2-threads-and-state-management)
- [Mastering Persistence in LangGraph | Medium](https://medium.com/@vinodkrane/mastering-persistence-in-langgraph-checkpoints-threads-and-beyond-21e412aaed60)
- [Persistence in LangGraph — Deep Guide | Towards AI](https://pub.towardsai.net/persistence-in-langgraph-deep-practical-guide-36dc4c452c3b)

### Observability and Monitoring

- [Circuit Breaker Patterns in OpenTelemetry](https://oneuptime.com/blog/post/2026-02-06-circuit-breaker-opentelemetry-export-pipelines/view)
- [Monitor Circuit Breaker State Changes](https://oneuptime.com/blog/post/2026-02-06-monitor-circuit-breaker-state-changes-opentelemetry-metrics/view)
- [Best AI Observability Tools for Autonomous Agents in 2026](https://arize.com/blog/best-ai-observability-tools-for-autonomous-agents-in-2026/)
- [Observability Trends 2026 | IBM](https://www.ibm.com/think/insights/observability-trends)

### OpenAI Assistants API (Comparative Reference)

- [An In-Depth Guide to Threads in OpenAI Assistants API](https://dzone.com/articles/openai-assistants-api-threads-guide)
- [Assistants API deep dive | OpenAI](https://platform.openai.com/docs/assistants/deep-dive)
- [A practical guide to the OpenAI Threads API](https://www.eesel.ai/blog/openai-threads-api)

---

**Document Status**: Ready for review and implementation planning

**Next Steps**:
1. Review and approve architectural decisions
2. Answer open questions
3. Prioritize features by phase
4. Begin Phase 1 implementation
5. Prototype Context Assembly Engine
6. Implement Agent Registry (static agents)
7. Build document upload and Store integration
