# Custom Agent Integration with LangGraph API: Conceptual Framework

**Document Version:** 1.0
**Date:** 2026-03-09
**Status:** Research Complete
**Project:** lg-api

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [API Surface Mapping to Agent Operations](#2-api-surface-mapping-to-agent-operations)
3. [Request Composition for Custom Agents](#3-request-composition-for-custom-agents)
4. [Agent Response Format](#4-agent-response-format)
5. [Proposed Additional Features & Components](#5-proposed-additional-features--components)
6. [End-to-End Flow Examples](#6-end-to-end-flow-examples)
7. [API Fields Reference](#7-api-fields-reference)
8. [Open Questions & Decisions](#8-open-questions--decisions)
9. [Assumptions & Scope](#9-assumptions--scope)
10. [References](#10-references)

---

## 1. Architecture Overview

### 1.1 The Translation Layer Concept

The lg-api serves as an **intermediary translation layer** between LangGraph-compatible UIs and custom agent implementations. The core principle is protocol translation:

- **UI Side**: Speaks the LangGraph Platform API protocol (threads, runs, assistants, SSE streaming)
- **Agent Side**: Speaks whatever protocol the custom agent uses (REST, gRPC, function calls, message queues)
- **Translation Layer**: Bridges the two, mapping LangGraph concepts to agent operations

```
┌─────────────────────────────────────────────────────────────────┐
│                    LangGraph-Compatible UI                       │
│            (LangGraph Studio, agent-chat-ui, custom)             │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                    LangGraph API Protocol
                    (HTTP + SSE Streams)
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│                         lg-api Server                            │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │              LangGraph API Surface (50 endpoints)          │ │
│  │  Assistants │ Threads │ Runs │ Crons │ Store │ System     │ │
│  └──────────────────────────┬─────────────────────────────────┘ │
│                             │                                    │
│  ┌──────────────────────────▼─────────────────────────────────┐ │
│  │                  Translation Layer                          │ │
│  │                                                              │ │
│  │  • Request Composition    • Response Mapping                │ │
│  │  • History Assembly       • SSE Event Generation            │ │
│  │  • Document Resolution    • State Management                │ │
│  │  • Context Preparation    • Error Translation               │ │
│  └──────────────────────────┬─────────────────────────────────┘ │
└───────────────────────────────┼─────────────────────────────────┘
                                │
                    Agent Protocol (flexible)
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│                      Custom Agent Layer                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │   Agent A    │  │   Agent B    │  │   Agent C    │          │
│  │  (Research)  │  │   (Writer)   │  │  (Analyzer)  │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 Component Responsibilities

**UI Layer:**
- Initiates conversations via POST /threads
- Sends user messages via POST /threads/:id/runs/stream
- Receives SSE events with streaming responses
- Displays conversation history, typing indicators, tool calls
- Manages file uploads and attachments

**lg-api (Translation Layer):**
- **Maintains API contract**: Exposes all 50 LangGraph API endpoints
- **Maps assistants to agents**: Associates graph_id with custom agent implementations
- **Manages conversation state**: Stores thread state, checkpoint history
- **Composes agent requests**: Bundles history + documents + new input
- **Translates responses**: Converts agent output to SSE event streams
- **Handles documents**: Stores and retrieves conversation artifacts via Store API

**Agent Layer:**
- Receives structured requests with full context
- Performs reasoning, tool execution, data retrieval
- Returns structured responses with intermediate steps
- Remains stateless (state managed by lg-api)

### 1.3 Key Design Principles

1. **Stateless Agents**: Agents should not maintain conversation state. The lg-api provides full context with each request.

2. **Protocol Agnostic**: Agents can use any transport (HTTP, gRPC, direct function calls, message queues).

3. **Streaming First**: All agent interactions should support streaming for responsive UX.

4. **Document Aware**: Documents referenced in conversations must be accessible to agents without requiring document re-upload.

5. **Multi-Agent Ready**: The architecture must support agent handoff and multi-agent workflows.

---

## 2. API Surface Mapping to Agent Operations

### 2.1 Assistants → Agent Registry

**LangGraph Concept**: An assistant is a configured instance of a graph with specific settings (model, prompts, tools).

**Agent Mapping**: An assistant maps to a registered custom agent with its configuration.

#### Key Endpoint Mappings

| Endpoint | Agent Operation | Translation Layer Action |
|----------|-----------------|--------------------------|
| `POST /assistants` | Register agent configuration | Store agent metadata: agent type, connection details, capabilities, input schema |
| `GET /assistants/:id` | Retrieve agent config | Return stored agent configuration |
| `PATCH /assistants/:id` | Update agent config (new version) | Create new version with updated settings, increment version number |
| `DELETE /assistants/:id` | Deregister agent | Remove agent config, optionally clean up threads |
| `GET /assistants/:id/graph` | Get agent structure | Return agent's capability graph (nodes, edges, tools) |
| `GET /assistants/:id/schemas` | Get agent I/O schemas | Return JSON schemas for agent input/output/context |
| `POST /assistants/search` | Query available agents | Filter agents by metadata, capabilities |

#### Assistant Fields → Agent Configuration

```typescript
{
  "assistant_id": "uuid",           // Unique agent instance ID
  "graph_id": "research-agent",     // Agent type identifier (key for lookup)
  "config": {                       // Agent runtime configuration
    "model": "gpt-4",
    "temperature": 0.7,
    "max_iterations": 10
  },
  "context": {                      // Agent context/prompts
    "system_prompt": "You are a research assistant...",
    "tools_enabled": ["search", "calculator"]
  },
  "metadata": {                     // Agent metadata
    "category": "research",
    "capabilities": ["web_search", "document_analysis"]
  },
  "name": "Research Assistant",
  "description": "Agent for conducting research tasks"
}
```

**Implementation Requirement**: The translation layer needs an **Agent Registry** that:
- Maps `graph_id` → agent implementation (connection details, handler function)
- Stores agent capabilities and schemas
- Validates agent availability before assistant creation
- Manages agent versioning

### 2.2 Threads → Conversation Sessions

**LangGraph Concept**: A thread is a stateful conversation container with checkpoint history.

**Agent Mapping**: A thread represents a conversation session with accumulated context.

#### Key Endpoint Mappings

| Endpoint | Agent Operation | Translation Layer Action |
|----------|-----------------|--------------------------|
| `POST /threads` | Initialize conversation session | Create thread record, initialize empty state |
| `GET /threads/:id` | Retrieve conversation metadata | Return thread metadata, current status |
| `PATCH /threads/:id` | Update conversation metadata | Update metadata, TTL |
| `DELETE /threads/:id` | Destroy conversation session | Delete thread and all checkpoints |
| `GET /threads/:id/state` | Get current conversation state | Return latest checkpoint state |
| `POST /threads/:id/state` | Update conversation state | Manually inject state (for corrections, HITL) |
| `POST /threads/:id/history` | Get conversation history | Return checkpoint list (full state snapshots) |
| `POST /threads/:id/copy` | Fork conversation | Duplicate thread with full history for "what if" scenarios |

#### Thread State Structure

```typescript
{
  "thread_id": "uuid",
  "created_at": "2026-03-09T10:00:00Z",
  "updated_at": "2026-03-09T10:05:00Z",
  "status": "idle",                    // idle | busy | interrupted | error
  "metadata": {
    "user_id": "user123",
    "session_name": "Research on AI Safety"
  },
  "values": {                          // Current thread state
    "messages": [...],                 // Conversation history
    "context_variables": {...},        // Session-level variables
    "document_refs": [...]             // References to Store items
  }
}
```

**Thread Status Lifecycle**:
- `idle`: Thread created or run completed
- `busy`: Run in progress
- `interrupted`: Run paused (HITL, approval needed)
- `error`: Run failed

**Implementation Requirement**: The translation layer must:
- Maintain thread state across multiple runs
- Store checkpoint history for time-travel debugging
- Track document references used in the conversation
- Handle thread status transitions during runs

### 2.3 Runs → Agent Invocations

**LangGraph Concept**: A run is a single execution of a graph (stateful or stateless).

**Agent Mapping**: A run is a single invocation of an agent with full context.

This is the **CORE** interaction point where the UI sends user input and receives agent responses.

#### Key Endpoint Mappings

| Endpoint | Agent Operation | Translation Layer Action |
|----------|-----------------|--------------------------|
| `POST /threads/:id/runs/stream` | **Invoke agent (stateful)** | 1. Load thread state<br>2. Compose agent request<br>3. Stream agent response<br>4. Update thread state |
| `POST /runs/stream` | **Invoke agent (stateless)** | 1. Compose agent request (no history)<br>2. Stream agent response<br>3. No state update |
| `POST /threads/:id/runs` | Invoke agent (no stream) | Same as stream but buffer response |
| `GET /threads/:id/runs/:run_id/stream` | Resume/join streaming run | Reconnect to active run stream |
| `POST /threads/:id/runs/:run_id/cancel` | Cancel agent execution | Send cancellation signal to agent |
| `GET /threads/:id/runs` | List conversation runs | Return run history for thread |

#### Run Creation Request Fields

```typescript
{
  "assistant_id": "uuid",              // Which agent to invoke
  "input": {                           // User's new message
    "messages": [
      {"role": "user", "content": "Analyze this report"}
    ]
  },
  "stream_mode": ["values", "messages"], // What to stream
  "config": {                          // Runtime overrides
    "temperature": 0.5
  },
  "context": {                         // Additional context
    "task_priority": "high"
  },
  "metadata": {                        // Run metadata
    "source": "web_ui"
  }
}
```

**Critical Field: `input`**

The `input` field carries the **new user message**. In LangGraph, input typically contains:
- `messages`: Array of message objects (most common)
- Custom state fields (for specialized graphs)

#### Run Response Structure

```typescript
{
  "run_id": "uuid",
  "thread_id": "uuid",
  "assistant_id": "uuid",
  "status": "running",                 // pending | running | success | error | interrupted
  "created_at": "2026-03-09T10:05:00Z",
  "metadata": {...}
}
```

**Implementation Requirement**: The translation layer must:
- Compose full agent request from thread state + new input
- Invoke agent and stream response
- Parse agent response into SSE events
- Update thread state with agent output
- Handle agent errors gracefully

### 2.4 Store → Agent Memory / Document Storage

**LangGraph Concept**: The Store API provides long-term key-value storage with optional vector search, organized by namespaces.

**Agent Mapping**: The Store holds documents, artifacts, and conversation-related data that agents need to reference.

#### Key Endpoint Mappings

| Endpoint | Agent Operation | Translation Layer Action |
|----------|-----------------|--------------------------|
| `PUT /store/items` | Store document/artifact | Save item with namespace, key, value, optional TTL |
| `GET /store/items` | Retrieve document by key | Return item value |
| `POST /store/items/search` | Search documents | Query by namespace, filter, optional vector search |
| `DELETE /store/items` | Remove document | Delete item |
| `POST /store/namespaces` | List storage namespaces | Return namespace hierarchy |

#### Store Item Structure

```typescript
{
  "namespace": ["user123", "thread456", "documents"], // Hierarchical namespace
  "key": "report_2024.pdf",
  "value": {                           // Arbitrary JSON value
    "content": "...",                  // Full content or reference
    "content_type": "application/pdf",
    "size_bytes": 52428,
    "metadata": {
      "uploaded_at": "2026-03-09T10:00:00Z",
      "page_count": 15
    }
  },
  "created_at": "2026-03-09T10:00:00Z",
  "updated_at": "2026-03-09T10:00:00Z"
}
```

#### Namespace Design Patterns

**Per-User Storage**:
```
["user_<user_id>"]
```

**Per-Thread Storage**:
```
["user_<user_id>", "thread_<thread_id>"]
```

**Per-Agent Storage**:
```
["assistant_<assistant_id>", "knowledge_base"]
```

**Document Categories**:
```
["user_<user_id>", "thread_<thread_id>", "documents"]
["user_<user_id>", "thread_<thread_id>", "artifacts"]  // Agent-generated
["user_<user_id>", "thread_<thread_id>", "citations"]
```

**Implementation Requirement**: The translation layer must:
- Store uploaded documents in appropriate namespaces
- Include document references in agent requests
- Support document retrieval by agents during execution
- Handle document lifecycle (TTL, deletion)

---

## 3. Request Composition for Custom Agents

When the UI calls `POST /threads/:id/runs/stream`, the translation layer must compose a complete agent request containing:

1. **Conversation history so far**
2. **Documents used in the conversation**
3. **The new user request**
4. **Additional documents provided by the user**

### 3.1 Conversation History

**Source**: Thread state (`values.messages`) + checkpoint history

**Extraction**:
1. Load thread by `thread_id`
2. Retrieve `values.messages` from latest checkpoint
3. Format messages in agent's expected format

**Format Options**:
- OpenAI message format (most common)
- LangChain message format
- Custom agent format

**Example**:
```typescript
// From thread state
const threadState = await threadService.getState(thread_id);
const messages = threadState.values.messages || [];

// Format for agent
const conversationHistory = messages.map(msg => ({
  role: msg.role,           // "user" | "assistant" | "system"
  content: msg.content,
  timestamp: msg.timestamp,
  metadata: msg.metadata
}));
```

**Size Management**: For long conversations, the translation layer may need to:
- Truncate old messages (keep recent N)
- Summarize early conversation
- Use sliding window with message importance scoring

### 3.2 Documents Used in Conversation

**Source**: Thread state (`values.document_refs`) + Store API

**Extraction**:
1. Load thread state
2. Extract document reference array: `values.document_refs`
3. For each reference, retrieve from Store API
4. Bundle documents with agent request

**Document Reference Format**:
```typescript
// In thread state
{
  "document_refs": [
    {
      "namespace": ["user123", "thread456", "documents"],
      "key": "report.pdf",
      "added_at": "2026-03-09T10:00:00Z"
    }
  ]
}
```

**Retrieval**:
```typescript
const documents = await Promise.all(
  threadState.values.document_refs.map(ref =>
    storeService.getItem(ref.namespace, ref.key)
  )
);
```

**Considerations**:
- **Large files**: Send reference/URL instead of full content
- **Embeddings**: Pre-compute and store embeddings in Store
- **Chunking**: For RAG scenarios, chunk documents and store chunks
- **Access control**: Verify agent can access requested documents

### 3.3 The New User Request

**Source**: `input` field in run creation request

**Format**:
```typescript
{
  "input": {
    "messages": [
      {
        "role": "user",
        "content": "Analyze the revenue trends in the report"
      }
    ]
  }
}
```

**Extraction**: Direct mapping from request body.

### 3.4 Additional Documents Provided by User

**Challenge**: LangGraph API doesn't have native file upload support in run requests.

**Solution Options**:

#### Option A: Pre-upload to Store
1. User uploads file via `PUT /store/items` before creating run
2. Run request references Store item
3. Translation layer retrieves from Store

```typescript
// Step 1: Upload
PUT /store/items
{
  "namespace": ["user123", "thread456", "documents"],
  "key": "new_report.pdf",
  "value": { "content_base64": "..." }
}

// Step 2: Reference in run
POST /threads/thread456/runs/stream
{
  "input": {
    "messages": [
      {
        "role": "user",
        "content": "Analyze this report",
        "attachments": [
          {
            "type": "store_ref",
            "namespace": ["user123", "thread456", "documents"],
            "key": "new_report.pdf"
          }
        ]
      }
    ]
  }
}
```

#### Option B: Embed in Message Metadata
```typescript
{
  "input": {
    "messages": [
      {
        "role": "user",
        "content": "Analyze this report",
        "metadata": {
          "attachments": [
            {
              "filename": "report.pdf",
              "content_base64": "...",
              "content_type": "application/pdf"
            }
          ]
        }
      }
    ]
  }
}
```

Translation layer extracts attachments, stores in Store API, updates thread state.

#### Option C: Extended Endpoint
Create custom endpoint extension:
```
POST /threads/:id/runs/stream/multipart
Content-Type: multipart/form-data
```

### 3.5 Complete Agent Request Structure

After composition, the agent receives:

```typescript
{
  "request_id": "uuid",
  "assistant_id": "uuid",
  "thread_id": "uuid",
  "agent_config": {                    // From assistant.config
    "model": "gpt-4",
    "temperature": 0.7
  },
  "agent_context": {                   // From assistant.context
    "system_prompt": "You are a research assistant...",
    "tools": ["search", "calculator"]
  },
  "conversation_history": [            // From thread state
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."},
    ...
  ],
  "documents": [                       // From Store API
    {
      "key": "report.pdf",
      "content": "...",
      "metadata": {...}
    }
  ],
  "user_message": {                    // New input
    "role": "user",
    "content": "Analyze the revenue trends",
    "attachments": [...]
  },
  "runtime_config": {                  // From run request
    "stream_mode": ["values", "messages"]
  }
}
```

---

## 4. Agent Response Format

### 4.1 SSE Streaming Protocol

The translation layer converts agent responses into Server-Sent Events (SSE) for the UI.

**SSE Format**:
```
event: <event_type>
data: <json_payload>
id: <event_id>

```

**LangGraph SSE Event Types**:
- `metadata`: Run metadata (run_id, thread_id)
- `values`: Full state snapshot
- `updates`: State delta
- `messages`: LLM token stream
- `messages-tuple`: (message_chunk, metadata)
- `custom`: Custom data from agent
- `debug`: Debug information
- `end`: Stream completion
- `error`: Error information

### 4.2 Event Emission Sequence

**Typical Streaming Run**:

```
event: metadata
data: {"run_id": "123", "thread_id": "456"}
id: 1

event: messages
data: {"content": "I", "type": "AIMessageChunk"}
id: 2

event: messages
data: {"content": " will", "type": "AIMessageChunk"}
id: 3

event: messages
data: {"content": " analyze", "type": "AIMessageChunk"}
id: 4

...

event: values
data: {"messages": [...], "final_answer": "..."}
id: 50

event: end
data: null
id: 51
```

### 4.3 Agent Output → SSE Mapping

#### Agent Streaming Response Format

The agent should stream responses in a structured format:

```typescript
{
  "type": "token",
  "content": "I will analyze",
  "metadata": {
    "node": "agent_reasoning",
    "timestamp": "2026-03-09T10:05:01Z"
  }
}
```

**Translation**:
```typescript
// Agent output
{ type: "token", content: "I will analyze" }

// SSE event
event: messages
data: {"content": "I will analyze", "type": "AIMessageChunk"}
id: <sequence>
```

#### Tool Execution Reporting

Agent indicates tool usage:

```typescript
{
  "type": "tool_call",
  "tool": "web_search",
  "input": {"query": "AI safety research 2026"},
  "status": "running"
}
```

**Translation**:
```typescript
event: custom
data: {
  "type": "tool_call_start",
  "tool_name": "web_search",
  "tool_input": {"query": "AI safety research 2026"}
}
```

Then tool result:

```typescript
{
  "type": "tool_result",
  "tool": "web_search",
  "output": {"results": [...]}
}
```

**Translation**:
```typescript
event: custom
data: {
  "type": "tool_call_end",
  "tool_name": "web_search",
  "tool_output": {"results": [...]}
}
```

#### Final State Update

After agent completes:

```typescript
event: values
data: {
  "messages": [
    ...history,
    {"role": "assistant", "content": "Based on my analysis..."}
  ]
}

event: end
data: null
```

### 4.4 Handling Intermediate Steps

For multi-step agent reasoning:

```typescript
// Step 1: Planning
event: custom
data: {"type": "agent_step", "step": "planning", "content": "I will search for..."}

// Step 2: Tool call
event: custom
data: {"type": "tool_call_start", "tool": "search"}

// Step 3: Tool result
event: custom
data: {"type": "tool_call_end", "tool": "search", "result_summary": "Found 5 papers"}

// Step 4: Reasoning
event: custom
data: {"type": "agent_step", "step": "reasoning", "content": "Based on the papers..."}

// Step 5: Final answer
event: messages
data: {"content": "Here is my analysis...", "type": "AIMessage"}
```

### 4.5 Error Handling

Agent error:

```typescript
{
  "type": "error",
  "error_code": "TOOL_EXECUTION_FAILED",
  "message": "Web search API timeout",
  "recoverable": true
}
```

**Translation**:
```typescript
event: error
data: {
  "type": "error",
  "message": "Web search API timeout",
  "code": "TOOL_EXECUTION_FAILED"
}

event: end
data: null
```

Update run status to `error`, thread status to `error`.

---

## 5. Proposed Additional Features & Components

### 5.1 Agent Registry

**Purpose**: Central configuration for mapping graph_id to agent implementations.

**Schema**:
```typescript
{
  "graph_id": "research-agent",
  "agent_type": "http",               // http | grpc | function | queue
  "connection": {
    "url": "https://agent-server.example.com/invoke",
    "auth": { "type": "bearer", "token_env": "AGENT_TOKEN" }
  },
  "capabilities": {
    "streaming": true,
    "tools": ["web_search", "calculator", "code_exec"],
    "max_context_tokens": 32000
  },
  "schemas": {
    "input_schema": { "$ref": "#/definitions/ResearchInput" },
    "output_schema": { "$ref": "#/definitions/ResearchOutput" },
    "context_schema": { "$ref": "#/definitions/ResearchContext" }
  },
  "default_config": {
    "model": "gpt-4",
    "temperature": 0.7
  }
}
```

**Operations**:
- Register new agent type
- Update agent configuration
- Validate agent availability (health check)
- Version management

### 5.2 Document Management System

**Purpose**: Handle file uploads, processing, and retrieval within conversations.

**Components**:

**A. Upload Service**
- Accept multipart file uploads
- Validate file types and sizes
- Extract text/metadata
- Generate embeddings (for RAG)
- Store in Store API

**B. Processing Pipeline**
- PDF → text extraction
- Images → OCR, vision analysis
- Code files → syntax parsing
- Spreadsheets → structured data

**C. Retrieval Service**
- Fetch documents by reference
- Semantic search (vector similarity)
- Metadata filtering

**D. Lifecycle Management**
- TTL-based expiration
- Manual deletion
- Archival strategies

**API Extensions**:
```
POST /threads/:id/documents         - Upload document to thread
GET /threads/:id/documents          - List thread documents
DELETE /threads/:id/documents/:key  - Remove document
POST /threads/:id/documents/search  - Search thread documents
```

### 5.3 Tool Execution Reporting

**Purpose**: Surface agent tool calls to UI in real-time.

**Implementation**:
- Agent emits tool execution events
- Translation layer converts to SSE `custom` events
- UI displays tool call timeline

**Event Schema**:
```typescript
{
  "type": "tool_execution",
  "tool_name": "web_search",
  "status": "running" | "success" | "error",
  "input": {...},
  "output": {...},
  "duration_ms": 1234,
  "timestamp": "2026-03-09T10:05:02Z"
}
```

**UI Benefits**:
- Show "Searching the web..." indicators
- Display tool results inline
- Build trust through transparency

### 5.4 Conversation Branching

**Purpose**: Allow users to explore alternative conversation paths.

**Implementation**:
- Use `POST /threads/:id/copy` to fork thread
- UI presents "Try different approach" button
- Create new branch from specific checkpoint
- Display conversation tree

**Use Cases**:
- "What if I asked differently?"
- Compare agent responses with different parameters
- Recover from unwanted turns

### 5.5 Agent Handoff

**Purpose**: Transfer conversation from one agent to another mid-thread.

**Implementation**:

**A. Explicit Handoff** (user-initiated):
```typescript
POST /threads/:id/runs/stream
{
  "assistant_id": "new_agent_uuid",  // Different agent
  "input": {
    "messages": [
      {"role": "user", "content": "Continue with specialist agent"}
    ]
  }
}
```

**B. Agent-Initiated Handoff**:
Agent returns handoff signal:
```typescript
{
  "type": "handoff",
  "target_agent": "specialist-agent",
  "reason": "This requires domain expertise",
  "context_summary": "User wants detailed financial analysis"
}
```

Translation layer:
1. Updates thread metadata with handoff info
2. Loads specialist agent
3. Continues execution with new agent

**C. Multi-Agent Workflows**:
Use Crons or stateless runs to coordinate multiple agents:
```typescript
POST /runs
{
  "assistant_id": "coordinator-agent",
  "input": {
    "task": "Multi-agent research pipeline",
    "sub_agents": ["researcher", "analyzer", "writer"]
  }
}
```

### 5.6 Structured Output Support

**Purpose**: Return structured data (tables, forms, actions) alongside text.

**Agent Output**:
```typescript
{
  "type": "structured_output",
  "format": "table",
  "data": {
    "headers": ["Company", "Revenue", "Growth"],
    "rows": [
      ["Acme Inc", "$10M", "15%"],
      ["Beta Corp", "$8M", "22%"]
    ]
  }
}
```

**SSE Event**:
```typescript
event: custom
data: {
  "type": "structured_data",
  "format": "table",
  "data": {...}
}
```

**UI Rendering**:
- Tables → formatted tables
- Forms → interactive forms
- Actions → clickable buttons (e.g., "Schedule Meeting")

### 5.7 Typing Indicators

**Purpose**: Show "agent is thinking" status.

**Implementation**:
- Agent sends heartbeat events during processing
- Translation layer emits typing indicators

```typescript
event: custom
data: {"type": "typing", "status": "thinking"}
```

**UI**: Shows animated "..." indicator.

### 5.8 Rate Limiting & Quotas

**Purpose**: Control resource usage per user/agent.

**Implementation**:
- Track runs per user per time window
- Track token usage per assistant
- Return 429 (Too Many Requests) when exceeded

**Configuration**:
```typescript
{
  "rate_limits": {
    "runs_per_minute": 10,
    "runs_per_hour": 100,
    "tokens_per_day": 1000000
  },
  "quotas": {
    "max_threads_per_user": 50,
    "max_documents_per_thread": 20
  }
}
```

### 5.9 Multi-Turn Context Window Management

**Purpose**: Handle conversation history exceeding agent context limits.

**Strategies**:

**A. Truncation**: Keep recent N messages
**B. Summarization**: Summarize early conversation
**C. Importance Scoring**: Keep most relevant messages
**D. Hierarchical Context**: Summary + recent details

**Implementation**:
```typescript
function prepareContext(history, maxTokens) {
  if (tokenCount(history) <= maxTokens) return history;

  // Strategy: summarize + recent
  const summary = summarize(history.slice(0, -10));
  const recent = history.slice(-10);

  return [
    {role: "system", content: `Previous context: ${summary}`},
    ...recent
  ];
}
```

### 5.10 Human-in-the-Loop (HITL) Integration

**Purpose**: Pause agent execution for human approval.

**Implementation**:
- Agent requests approval
- Run status → `interrupted`
- Thread status → `interrupted`
- Store interrupt details in thread state

**Resume**:
```typescript
POST /threads/:id/runs/:run_id/resume
{
  "approval": "approved",
  "modifications": {...}
}
```

---

## 6. End-to-End Flow Examples

### 6.1 Scenario A: Simple Chat

**Flow**:

1. **User**: "What is LangGraph?"

2. **UI → lg-api**: `POST /threads`
```typescript
{
  "metadata": {"user_id": "user123"}
}
```

3. **lg-api Response**:
```typescript
{
  "thread_id": "thread-001",
  "status": "idle",
  "values": {"messages": []}
}
```

4. **UI → lg-api**: `POST /threads/thread-001/runs/stream`
```typescript
{
  "assistant_id": "assistant-qa",
  "input": {
    "messages": [{"role": "user", "content": "What is LangGraph?"}]
  },
  "stream_mode": ["messages", "values"]
}
```

5. **lg-api (Translation Layer)**:
   - Loads assistant config (graph_id: "qa-agent")
   - Loads thread state (empty history)
   - Composes agent request:
```typescript
{
  "conversation_history": [],
  "documents": [],
  "user_message": {"role": "user", "content": "What is LangGraph?"},
  "agent_config": {...}
}
```

6. **lg-api → Agent**: Invokes agent via HTTP

7. **Agent → lg-api**: Streams response
```typescript
{type: "token", content: "Lang"}
{type: "token", content: "Graph"}
{type: "token", content: " is"}
...
{type: "complete", final_content: "LangGraph is a framework..."}
```

8. **lg-api → UI**: Converts to SSE
```
event: metadata
data: {"run_id": "run-001", "thread_id": "thread-001"}

event: messages
data: {"content": "Lang", "type": "AIMessageChunk"}

event: messages
data: {"content": "Graph", "type": "AIMessageChunk"}

...

event: values
data: {"messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}

event: end
data: null
```

9. **lg-api**: Updates thread state
```typescript
{
  "thread_id": "thread-001",
  "status": "idle",
  "values": {
    "messages": [
      {"role": "user", "content": "What is LangGraph?"},
      {"role": "assistant", "content": "LangGraph is a framework..."}
    ]
  }
}
```

10. **UI**: Displays assistant response

### 6.2 Scenario B: Document-Augmented Chat

**Flow**:

1. **User**: Uploads `report.pdf`

2. **UI → lg-api**: `PUT /store/items`
```typescript
{
  "namespace": ["user123", "thread-002", "documents"],
  "key": "report.pdf",
  "value": {
    "content_base64": "...",
    "content_type": "application/pdf",
    "metadata": {"filename": "report.pdf", "size": 52428}
  }
}
```

3. **lg-api**: Processes document
   - Extracts text
   - Generates embeddings
   - Stores processed version

4. **User**: "Summarize the key findings in the report"

5. **UI → lg-api**: `POST /threads/thread-002/runs/stream`
```typescript
{
  "assistant_id": "assistant-research",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": "Summarize the key findings in the report",
        "attachments": [
          {
            "type": "store_ref",
            "namespace": ["user123", "thread-002", "documents"],
            "key": "report.pdf"
          }
        ]
      }
    ]
  }
}
```

6. **lg-api (Translation Layer)**:
   - Loads thread state
   - Retrieves `report.pdf` from Store
   - Composes agent request:
```typescript
{
  "conversation_history": [],
  "documents": [
    {
      "key": "report.pdf",
      "content": "...",          // Full text or chunks
      "metadata": {...}
    }
  ],
  "user_message": {
    "role": "user",
    "content": "Summarize the key findings in the report"
  }
}
```

7. **Agent**: Processes document
   - Reads content
   - Performs analysis
   - Generates summary

8. **Agent → lg-api**: Streams response
```typescript
{type: "custom", data: {type: "document_analysis", status: "reading"}}
{type: "custom", data: {type: "document_analysis", status: "analyzing", progress: 0.5}}
{type: "token", content: "The"}
{type: "token", content: " report"}
...
```

9. **lg-api → UI**: SSE events
```
event: custom
data: {"type": "document_analysis", "status": "reading"}

event: custom
data: {"type": "document_analysis", "status": "analyzing", "progress": 0.5}

event: messages
data: {"content": "The", "type": "AIMessageChunk"}

event: messages
data: {"content": " report", "type": "AIMessageChunk"}

...

event: values
data: {"messages": [...], "document_refs": [...]}

event: end
data: null
```

10. **lg-api**: Updates thread state
```typescript
{
  "values": {
    "messages": [...],
    "document_refs": [
      {
        "namespace": ["user123", "thread-002", "documents"],
        "key": "report.pdf",
        "used_in_run": "run-002"
      }
    ]
  }
}
```

### 6.3 Scenario C: Multi-Step Agent with Tool Calls

**Flow**:

1. **User**: "Find the latest AI research papers and summarize the top 3"

2. **UI → lg-api**: `POST /threads/thread-003/runs/stream`

3. **lg-api → Agent**: Sends request

4. **Agent**: Multi-step execution

   **Step 1: Planning**
   ```typescript
   {
     type: "custom",
     data: {
       type: "agent_step",
       step: "planning",
       content: "I will: 1) Search for papers, 2) Rank by relevance, 3) Summarize top 3"
     }
   }
   ```

   **Step 2: Tool Call - Search**
   ```typescript
   {
     type: "tool_call",
     tool: "web_search",
     input: {query: "latest AI research papers 2026"},
     status: "running"
   }
   ```

   **Step 3: Tool Result**
   ```typescript
   {
     type: "tool_result",
     tool: "web_search",
     output: {results: [/* 10 papers */]}
   }
   ```

   **Step 4: Tool Call - Rank**
   ```typescript
   {
     type: "tool_call",
     tool: "relevance_scorer",
     input: {papers: [...]},
     status: "running"
   }
   ```

   **Step 5: Tool Result**
   ```typescript
   {
     type: "tool_result",
     tool: "relevance_scorer",
     output: {top_3: [...]}
   }
   ```

   **Step 6: Generate Summary**
   ```typescript
   {type: "token", content: "Here"}
   {type: "token", content: " are"}
   {type: "token", content: " the"}
   ...
   ```

5. **lg-api → UI**: SSE stream
```
event: custom
data: {"type": "agent_step", "step": "planning", "content": "I will..."}

event: custom
data: {"type": "tool_call_start", "tool": "web_search", "input": {...}}

event: custom
data: {"type": "tool_call_end", "tool": "web_search", "result_count": 10}

event: custom
data: {"type": "tool_call_start", "tool": "relevance_scorer"}

event: custom
data: {"type": "tool_call_end", "tool": "relevance_scorer"}

event: messages
data: {"content": "Here", "type": "AIMessageChunk"}

event: messages
data: {"content": " are", "type": "AIMessageChunk"}

...

event: values
data: {"messages": [...]}

event: end
data: null
```

6. **UI**: Displays:
   - Planning step in expandable section
   - Tool call indicators: "🔍 Searching web..." → "✓ Found 10 results"
   - Tool call indicators: "📊 Ranking papers..." → "✓ Selected top 3"
   - Streaming summary text

---

## 7. API Fields Reference

### 7.1 Complete Mapping Table

| UI Action | LangGraph API Call | Key Fields | What Agent Receives | What Agent Returns |
|-----------|-------------------|------------|---------------------|-------------------|
| **Create assistant** | `POST /assistants` | `graph_id`, `config`, `context`, `name` | N/A (registration only) | N/A |
| **List assistants** | `POST /assistants/search` | `metadata`, `graph_id`, `limit`, `offset` | N/A | N/A |
| **Get assistant details** | `GET /assistants/:id` | `assistant_id` | N/A | N/A |
| **Create conversation** | `POST /threads` | `metadata`, `thread_id` (optional) | N/A (session init) | N/A |
| **Get conversation** | `GET /threads/:id` | `thread_id` | N/A | N/A |
| **Send message (streaming)** | `POST /threads/:id/runs/stream` | `assistant_id`, `input` (messages), `stream_mode` | `conversation_history[]`, `documents[]`, `user_message`, `agent_config` | Stream of tokens, tool calls, structured data |
| **Send message (buffered)** | `POST /threads/:id/runs` | Same as streaming | Same as streaming | Complete response (buffered) |
| **Send stateless message** | `POST /runs/stream` | `assistant_id`, `input`, `stream_mode` | `user_message`, `agent_config` (no history) | Stream of tokens |
| **Resume/join stream** | `GET /threads/:id/runs/:run_id/stream` | `thread_id`, `run_id`, `last_event_id` | N/A (reconnection) | Continue SSE stream |
| **Cancel run** | `POST /threads/:id/runs/:run_id/cancel` | `thread_id`, `run_id` | Cancellation signal | Acknowledgment |
| **Get run status** | `GET /threads/:id/runs/:run_id` | `thread_id`, `run_id` | N/A | Run status object |
| **List runs** | `GET /threads/:id/runs` | `thread_id`, `limit`, `offset` | N/A | Array of runs |
| **Upload document** | `PUT /store/items` | `namespace`, `key`, `value` | N/A (storage) | N/A |
| **Get document** | `GET /store/items?namespace=...&key=...` | `namespace`, `key` | N/A | Document value |
| **Search documents** | `POST /store/items/search` | `namespace_prefix`, `filter`, `query` | N/A | Matching documents |
| **Get thread state** | `GET /threads/:id/state` | `thread_id` | N/A | Current state snapshot |
| **Update thread state** | `POST /threads/:id/state` | `thread_id`, `values`, `as_node` | N/A (manual update) | Updated state |
| **Get state history** | `POST /threads/:id/history` | `thread_id`, `limit`, `before` | N/A | Array of checkpoints |
| **Fork conversation** | `POST /threads/:id/copy` | `thread_id` | N/A | New thread with copied history |

### 7.2 Agent Request Schema

```typescript
interface AgentRequest {
  // Identity
  request_id: string;              // Unique request ID
  assistant_id: string;            // Assistant invoking agent
  thread_id?: string;              // Thread (if stateful)
  run_id: string;                  // Run ID

  // Configuration
  agent_config: {                  // From assistant.config
    model?: string;
    temperature?: number;
    max_tokens?: number;
    [key: string]: any;
  };

  // Context
  agent_context: {                 // From assistant.context
    system_prompt?: string;
    tools?: string[];
    [key: string]: any;
  };

  // Conversation
  conversation_history: Message[]; // From thread state

  // Documents
  documents: Document[];           // From Store API

  // New Input
  user_message: Message;           // From run input

  // Runtime
  runtime_config: {                // From run request
    stream_mode?: StreamMode[];
    timeout_seconds?: number;
    [key: string]: any;
  };
}

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
  metadata?: Record<string, any>;
}

interface Document {
  namespace: string[];
  key: string;
  content: string | object;
  content_type?: string;
  metadata?: Record<string, any>;
}
```

### 7.3 Agent Response Schema

```typescript
interface AgentResponseChunk {
  type: "token" | "tool_call" | "tool_result" | "custom" | "complete" | "error";

  // For type: "token"
  content?: string;

  // For type: "tool_call"
  tool?: string;
  tool_input?: any;

  // For type: "tool_result"
  tool_output?: any;

  // For type: "custom"
  data?: any;

  // For type: "complete"
  final_content?: string;
  final_state?: any;

  // For type: "error"
  error_code?: string;
  error_message?: string;

  // Common
  metadata?: {
    node?: string;
    timestamp?: string;
    [key: string]: any;
  };
}
```

---

## 8. Open Questions & Decisions

### 8.1 Agent Discovery & Registration

**Question**: How should agents be registered and discovered?

**Options**:

**A. Static Configuration File**
- Agents defined in `config/agents.yaml`
- Loaded at server startup
- Pros: Simple, version controlled
- Cons: Requires restart for new agents

**B. Database-Backed Registry**
- Agents stored in database
- Admin API for registration
- Pros: Dynamic, no restart needed
- Cons: More complexity

**C. Service Discovery**
- Agents announce themselves (Consul, etcd)
- Automatic registration
- Pros: Cloud-native, scalable
- Cons: Infrastructure complexity

**Recommendation**: Start with static config (A), migrate to database (B) for production.

### 8.2 Agent Communication Protocol

**Question**: What transport protocol should be used between lg-api and agents?

**Options**:

**A. HTTP/REST**
- Standard, widely supported
- Request/response with streaming
- Pros: Simple, debugging friendly
- Cons: Not optimal for high-throughput

**B. gRPC**
- Efficient binary protocol
- Bi-directional streaming
- Pros: Performance, type safety
- Cons: More setup, debugging harder

**C. Message Queue**
- Async communication
- Decoupled architecture
- Pros: Scalability, fault tolerance
- Cons: Complexity, latency

**D. Direct Function Calls**
- In-process agents
- No network overhead
- Pros: Fastest, simplest for embedded agents
- Cons: Not scalable, single process

**Recommendation**: Support multiple protocols with adapters. Start with HTTP (A) and function calls (D).

### 8.3 Document Storage Strategy

**Question**: How should documents be stored and indexed?

**Options**:

**A. Store API (Key-Value)**
- Use existing Store API
- Store full documents as values
- Pros: Consistent with LangGraph API
- Cons: No advanced querying

**B. Document Database**
- MongoDB, CouchDB
- Rich querying capabilities
- Pros: Document-centric, flexible
- Cons: Additional infrastructure

**C. Object Storage + Metadata DB**
- S3/MinIO for files
- PostgreSQL for metadata
- Pros: Scalable, cost-effective
- Cons: Split storage

**D. Vector Database**
- Pinecone, Weaviate, Qdrant
- Semantic search built-in
- Pros: AI-native, similarity search
- Cons: Specialized, cost

**Recommendation**:
- Phase 1: Store API (A) for MVP
- Phase 2: Object storage + PostgreSQL (C) for scale
- Phase 3: Add vector DB (D) for semantic search

### 8.4 Conversation History Management

**Question**: Should conversation history be managed by lg-api or by each agent?

**Analysis**:

**Option A: lg-api Manages History**
- lg-api stores all messages in thread state
- Agents are stateless, receive full history
- Pros: Single source of truth, agents simpler, consistent across agents
- Cons: lg-api must handle context window limits

**Option B: Agents Manage History**
- lg-api passes new messages only
- Agents maintain their own history
- Pros: Agents control their memory, more flexible
- Cons: Inconsistent state, harder to fork threads

**Recommendation**: lg-api manages history (A). This aligns with LangGraph's checkpoint architecture and enables features like time-travel and thread copying.

### 8.5 Context Window Management

**Question**: How should the system handle conversations exceeding agent context limits?

**Strategies**:

**A. Truncation**: Drop oldest messages
**B. Summarization**: Summarize early conversation
**C. Retrieval-Augmented**: Store all messages, retrieve relevant ones
**D. Hierarchical**: Summary layers (recent + summary of older + summary of ancient)

**Recommendation**: Implement B (summarization) with configurable strategy per agent. Allow agents to specify context window in registry.

### 8.6 Streaming vs Buffered Responses

**Question**: Should all responses be streamed, or support both modes?

**Analysis**:
- UI benefits from streaming (perceived performance)
- Some agents may not support streaming
- Buffered mode simpler for simple agents

**Recommendation**: Support both, but encourage streaming. Non-streaming agents can be wrapped with adapter that buffers and emits as single chunk.

### 8.7 Multi-Tenancy

**Question**: How should multi-user/multi-tenant scenarios be handled?

**Considerations**:
- User isolation (threads, documents)
- Agent sharing vs per-user agents
- Rate limiting per user
- Data privacy

**Recommendation**:
- Use `metadata.user_id` for all resources
- Implement middleware for user context injection
- Store namespaces include user_id
- Per-user rate limits and quotas

### 8.8 Agent Versioning

**Question**: How to handle agent updates without breaking existing threads?

**Options**:

**A. Assistant Versioning**
- Each assistant update creates new version
- Threads continue with original version
- Pros: Stable, backward compatible
- Cons: Old versions must remain available

**B. Agent Migration**
- Update agent, migrate thread state
- Pros: Single version to maintain
- Cons: Risk of breaking threads

**Recommendation**: Use assistant versioning (A). Store version with each run, allow explicit upgrade.

### 8.9 Error Recovery

**Question**: How should the system recover from agent failures mid-stream?

**Strategies**:

**A. Retry**: Automatically retry failed runs
**B. Checkpoint Resume**: Resume from last successful step
**C. Fallback Agent**: Switch to backup agent
**D. Manual Intervention**: Mark as interrupted, require human action

**Recommendation**: Implement A (retry with exponential backoff) and D (manual intervention after retries exhausted). Store partial outputs in thread state.

### 8.10 Real-Time Collaboration

**Question**: Should multiple users be able to interact with the same thread simultaneously?

**Use Cases**:
- Team collaboration on research
- Agent handoff between team members
- Live demos

**Challenges**:
- Concurrent message sending
- State consistency
- SSE stream multiplexing

**Recommendation**: Not in MVP. Consider for future phase with WebSocket support for multi-user threads.

---

## 9. Assumptions & Scope

### 9.1 Assumptions Made

| Assumption | Confidence | Impact if Wrong |
|------------|------------|-----------------|
| Agents can respond within 30 seconds for most requests | MEDIUM | Need timeout handling and long-running job support |
| Document uploads < 100MB per file | HIGH | Need chunked upload and streaming processing |
| Conversation history < 50 messages typical | MEDIUM | Context window management more critical |
| Agents are HTTP-accessible services | MEDIUM | Need support for other protocols (gRPC, queue) |
| UI expects OpenAI-style message format | HIGH | Need format adapters for different UIs |
| Single agent per run (no mid-run handoff) | MEDIUM | Need agent coordination protocol |
| Documents stored as full content in Store | LOW | Need chunking and reference storage |
| All agents support streaming | LOW | Need buffered mode as fallback |
| Thread state < 10MB typical | MEDIUM | Need state compression or reference storage |
| English-only conversations | LOW | No impact, UTF-8 handles all languages |

### 9.2 Uncertainties & Gaps

**Uncertainty 1: Agent Response Format Standardization**
- **What's unclear**: No standard format for agent streaming responses
- **Why it matters**: Each agent type may emit different formats
- **Gap**: Need adapter layer or standardized agent output protocol

**Uncertainty 2: Document Processing Requirements**
- **What's unclear**: Level of document processing needed (OCR, embedding, chunking)
- **Why it matters**: Impacts agent capabilities and response quality
- **Gap**: Need document processing pipeline design

**Uncertainty 3: Multi-Agent Workflow Patterns**
- **What's unclear**: How complex multi-agent workflows should be orchestrated
- **Why it matters**: Impacts agent handoff, coordinator design
- **Gap**: Need workflow engine or coordination protocol

**Uncertainty 4: Authentication & Authorization**
- **What's unclear**: User authentication mechanism, permission model
- **Why it matters**: Security, multi-tenancy, data isolation
- **Gap**: Need auth strategy (JWT, OAuth, API keys)

**Uncertainty 5: Scale Requirements**
- **What's unclear**: Expected concurrent users, messages/sec, storage volume
- **Why it matters**: Architecture decisions (database, caching, queue)
- **Gap**: Need capacity planning and load testing

### 9.3 Clarifying Questions for Follow-up

**Architecture Questions**:
1. What is the expected scale (users, messages/day, concurrent runs)?
2. Should the system support real-time collaboration (multiple users per thread)?
3. Is agent-to-agent communication required within a single run?
4. Should the system support agent plugins/extensions?

**Document Handling Questions**:
5. What file types must be supported (PDF, images, code, spreadsheets)?
6. What level of document processing is needed (text extraction, OCR, embedding)?
7. Should documents be versioned (track edits)?
8. How long should documents be retained (TTL, archival)?

**Agent Integration Questions**:
9. What protocols must be supported (HTTP, gRPC, message queue, function calls)?
10. Should agents be auto-discovered or manually registered?
11. How should agent authentication/authorization work?
12. Should agents support hot-reloading (update without restart)?

**UI/UX Questions**:
13. Which UIs will integrate (LangGraph Studio, agent-chat-ui, custom)?
14. Should the system support voice input/output?
15. Should the system support rich media responses (images, videos, interactive components)?
16. What level of agent transparency is desired (show all tool calls, reasoning steps)?

**Operational Questions**:
17. What monitoring/observability requirements exist (logs, metrics, traces)?
18. What SLA targets (latency, uptime)?
19. Disaster recovery requirements (backup, restore)?
20. Compliance requirements (data retention, audit logs)?

---

## 10. References

### 10.1 Project Documentation

- [LangGraph API Concepts](/Users/giorgosmarinos/aiwork/agent-platform/lg-api/docs/reference/langgraph-api-concepts.md)
- [Project Design](/Users/giorgosmarinos/aiwork/agent-platform/lg-api/docs/design/project-design.md)
- [API Specification](/Users/giorgosmarinos/aiwork/agent-platform/lg-api/docs/reference/refined-request-langgraph-api-replacement.md)
- [Project README](/Users/giorgosmarinos/aiwork/agent-platform/lg-api/CLAUDE.md)

### 10.2 LangGraph Documentation

- [LangGraph Platform Overview](https://www.langchain.com/langgraph)
- [LangGraph Streaming](https://docs.langchain.com/oss/python/langgraph/streaming)
- [LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [Manage Assistants](https://docs.langchain.com/langsmith/configuration-cloud)
- [LangGraph Studio](https://docs.langchain.com/oss/python/langgraph/studio)
- [LangGraph API Reference](https://langchain-ai.github.io/langgraph/cloud/reference/api/api_ref.html)

### 10.3 LangGraph SDK & Integration

- [LangGraph SDK Python](https://reference.langchain.com/python/langgraph-sdk/)
- [LangGraph SDK PyPI](https://pypi.org/project/langgraph-sdk/)
- [agent-chat-ui (GitHub)](https://github.com/langchain-ai/agent-chat-ui)
- [Getting Started with assistant-ui](https://www.assistant-ui.com/docs/runtimes/langgraph)

### 10.4 Agent Architecture & Patterns

- [Build Custom RAG Agent with LangGraph](https://docs.langchain.com/oss/python/langgraph/agentic-rag)
- [Build ReAct AI Agents with LangGraph](https://medium.com/@tahirbalarabe2/build-react-ai-agents-with-langgraph-cb9d28cc6e20)
- [Building AI Agent Systems with LangGraph](https://medium.com/pythoneers/building-ai-agent-systems-with-langgraph-9d85537a6326)
- [LangGraph Multi-Agent Structures](https://langchain-opentutorial.gitbook.io/langchain-opentutorial/17-langgraph/02-structures/08-langgraph-multi-agent-structures-01)
- [LangGraph Handoffs](https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs)

### 10.5 Streaming & Events

- [LangSmith Streaming API](https://docs.langchain.com/langsmith/streaming)
- [Streaming and Events (DeepWiki)](https://deepwiki.com/langchain-ai/langgraph/7.4-streaming-and-events)
- [LangGraph Streaming 101: 5 Modes](https://dev.to/sreeni5018/langgraph-streaming-101-5-modes-to-build-responsive-ai-applications-4p3f)
- [Streaming AI Agent with FastAPI & LangGraph](https://dev.to/kasi_viswanath/streaming-ai-agent-with-fastapi-langgraph-2025-26-guide-1nkn)

### 10.6 Memory & Storage

- [LangGraph with MongoDB: Long-Term Memory](https://dev.to/mongodb/langgraph-with-mongodb-building-conversational-long-term-memory-for-intelligent-ai-agents-2pcn)
- [MongoDB Store for LangGraph](https://www.mongodb.com/company/blog/product-release-announcements/powering-long-term-memory-for-agents-langgraph)
- [LangGraph Storage API Reference](https://reference.langchain.com/python/langgraph/store/)
- [Building Agentic RAG Systems with LangGraph](https://rahulkolekar.com/building-agentic-rag-systems-with-langgraph/)

### 10.7 UI Integration Examples

- [LangServe + LangGraph Stack](https://medium.com/@gaddam.rahul.kumar/langserve-langgraph-a-powerful-agentic-ai-stack-for-full-stack-applications-98931581de2b)
- [Build UI for AI Agent (LangGraph + CopilotKit)](https://www.copilotkit.ai/blog/easily-build-a-ui-for-your-ai-agent-in-minutes-langgraph-copilotkit)
- [How to Build AI Assistant with LangGraph and Next.js](https://auth0.com/blog/genai-tool-calling-build-agent-that-calls-calender-with-langgraph-nextjs/)
- [Fullstack AI Agent with LangGraphJS and NestJS](https://dev.to/ialijr/how-to-build-a-fullstack-ai-agent-with-langgraphjs-and-nestjs-using-agent-initializr-127j)

### 10.8 Advanced Topics

- [Agent Handoffs: LangGraph vs OpenAI vs Google](https://www.arcade.dev/blog/agent-handoffs-langgraph-openai-google/)
- [LangGraph MCP Integration](https://latenode.com/blog/ai-frameworks-technical-infrastructure/langgraph-multi-agent-orchestration/langgraph-mcp-integration-complete-model-context-protocol-setup-guide-working-examples-2025)
- [Production-Grade Multi-Agent Communication](https://www.marktechpost.com/2026/03/01/how-to-design-a-production-grade-multi-agent-communication-system-using-langgraph-structured-message-bus-acp-logging-and-persistent-shared-state-architecture/)

---

**Document End**

*This research document provides a comprehensive conceptual framework for integrating custom agents with the LangGraph API. Implementation should proceed iteratively, starting with core request/response mapping (Sections 2-4), then adding enhanced features (Section 5) based on specific use cases and requirements.*
