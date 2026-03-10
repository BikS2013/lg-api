# LangGraph Platform API - Conversation Flow Investigation

## Overview

This document provides a comprehensive investigation of the complete flow of API calls that occur during a conversation between a user and an agent through the LangGraph Platform API (also known as the LangGraph Server or Agent Server API).

The LangGraph Platform is a deployment and hosting infrastructure for LangGraph applications that provides a managed API server handling graph execution, state persistence, resource management, and client communication.

## Core Concepts

### Resources

The LangGraph Platform API provides structured endpoints for five main resources:

1. **Assistants** - Configured instances of a graph with specific parameters and metadata
2. **Threads** - Conversational sessions that accumulate outputs from multiple runs
3. **Runs** - Individual executions of a graph/assistant (stateful or stateless)
4. **Crons** - Scheduled periodic runs
5. **Store** - Persistent key-value storage for cross-thread long-term memory

### State Management

- LangGraph uses **checkpoint-based state management** with time-travel support
- Thread state accumulates messages and data across multiple runs
- Each run can add to or modify the thread's state
- State persists between runs, enabling multi-turn conversations

## API Authentication

For deployments to LangSmith, authentication is required via the `X-Api-Key` header:

```bash
curl --request POST \
  --url <DEPLOYMENT_URL>/threads \
  --header 'Content-Type: application/json' \
  --header 'X-Api-Key: <LANGSMITH_API_KEY>' \
  --data '{}'
```

For local deployments (e.g., http://localhost:8124), authentication may not be required.

## Conversation Flow Scenarios

### 1. Basic Synchronous Conversation

**Flow:** Create assistant → Create thread → Create run → Wait for result

#### Step 1: Create or Get Assistant

**Endpoint:** `POST /assistants`

**Purpose:** Create a configured instance of a graph, or retrieve an existing assistant

**Request Body:**
```json
{
  "graph_id": "agent",
  "assistant_id": "uuid-optional",
  "name": "My Assistant",
  "description": "Description of the assistant",
  "config": {
    "configurable": {}
  },
  "context": {
    "model_name": "openai"
  },
  "metadata": {},
  "if_exists": "do_nothing"
}
```

**Key Fields:**
- `graph_id` (required): The name of the deployed graph (defined in langgraph.json)
- `assistant_id` (optional): UUID for the assistant; auto-generated if not provided
- `config` (optional): Configuration matching the graph's schema
- `context` (optional): Static context added to the assistant
- `if_exists`: Either "raise" (error on duplicate) or "do_nothing" (return existing)

**Response:**
```json
{
  "assistant_id": "62e209ca-9154-432a-b9e9-2d75c7a9219b",
  "graph_id": "agent",
  "name": "My Assistant",
  "description": "Description of the assistant",
  "config": {},
  "context": {
    "model_name": "openai"
  },
  "metadata": {},
  "created_at": "2024-08-31T03:09:10.230718+00:00",
  "updated_at": "2024-08-31T03:09:10.230718+00:00",
  "version": 1
}
```

**Client Action:** Store the `assistant_id` for use in subsequent run requests.

**Alternative:** Instead of creating an assistant, you can list existing assistants:

```bash
POST /assistants/search
```

#### Step 2: Create Thread

**Endpoint:** `POST /threads`

**Purpose:** Create a new conversational session to store state across multiple runs

**Request Body:**
```json
{
  "thread_id": "uuid-optional",
  "metadata": {
    "user_id": "user123",
    "session_type": "chat"
  },
  "if_exists": "do_nothing",
  "ttl": {
    "seconds": 3600
  }
}
```

**Key Fields:**
- `thread_id` (optional): UUID for the thread; auto-generated if not provided
- `metadata` (optional): Arbitrary metadata for the thread
- `if_exists`: Either "raise" or "do_nothing"
- `ttl` (optional): Time-to-live configuration for auto-cleanup

**Response:**
```json
{
  "thread_id": "3c90c3cc-0d44-4b50-8888-8dd25736052a",
  "created_at": "2023-11-07T05:31:56Z",
  "updated_at": "2023-11-07T05:31:56Z",
  "metadata": {
    "user_id": "user123",
    "session_type": "chat"
  },
  "status": "idle",
  "values": {},
  "config": {}
}
```

**Key Response Fields:**
- `thread_id`: Unique identifier for this conversation session
- `status`: Current status (idle, busy, interrupted, error)
- `values`: Current state of the thread (initially empty)

**Client Action:** Store the `thread_id` for use in run requests.

#### Step 3: Create Run and Wait

**Endpoint:** `POST /threads/{thread_id}/runs/wait`

**Purpose:** Execute the assistant on the thread and wait for completion (synchronous)

**Request Body:**
```json
{
  "assistant_id": "62e209ca-9154-432a-b9e9-2d75c7a9219b",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": "What is the weather in LA?"
      }
    ]
  },
  "config": {
    "recursion_limit": 25,
    "configurable": {}
  },
  "metadata": {},
  "multitask_strategy": "reject"
}
```

**Key Fields:**
- `assistant_id` (required): The assistant to execute
- `input` (required): Input data for the graph (typically messages)
- `config` (optional): Runtime configuration overrides
- `metadata` (optional): Metadata for this run
- `multitask_strategy`: How to handle concurrent runs ("reject", "interrupt", "rollback", "enqueue")

**Response:**
```json
{
  "run_id": "run-uuid",
  "thread_id": "thread-uuid",
  "assistant_id": "assistant-uuid",
  "created_at": "2023-11-07T05:31:56Z",
  "updated_at": "2023-11-07T05:31:56Z",
  "status": "success",
  "metadata": {},
  "values": {
    "messages": [
      {
        "role": "user",
        "content": "What is the weather in LA?"
      },
      {
        "role": "assistant",
        "content": "The weather in Los Angeles is currently 72°F and sunny."
      }
    ]
  }
}
```

**Key Response Fields:**
- `run_id`: Unique identifier for this execution
- `status`: Final status (success, error, interrupted)
- `values`: Final state of the thread after the run

**Client Action:** Extract the assistant's response from `values.messages` and display to the user.

**SDK Example (Python):**
```python
from langgraph_sdk import get_client

client = get_client(url=DEPLOYMENT_URL, api_key=API_KEY)

# Get or create assistant
assistants = await client.assistants.search()
assistant = assistants[0]

# Create thread
thread = await client.threads.create()

# Run and wait
result = await client.runs.wait(
    thread_id=thread["thread_id"],
    assistant_id=assistant["assistant_id"],
    input={
        "messages": [
            {"role": "user", "content": "What is the weather in LA?"}
        ]
    }
)

# Extract response
assistant_message = result["values"]["messages"][-1]
print(assistant_message["content"])
```

**SDK Example (JavaScript):**
```javascript
import { Client } from "@langchain/langgraph-sdk";

const client = new Client({
  apiUrl: DEPLOYMENT_URL,
  apiKey: API_KEY
});

// Get or create assistant
const assistants = await client.assistants.search();
const assistant = assistants[0];

// Create thread
const thread = await client.threads.create();

// Run and wait
const result = await client.runs.wait(
  thread.thread_id,
  assistant.assistant_id,
  {
    input: {
      messages: [
        { role: "user", content: "What is the weather in LA?" }
      ]
    }
  }
);

// Extract response
const assistantMessage = result.values.messages[result.values.messages.length - 1];
console.log(assistantMessage.content);
```

---

### 2. Streaming Conversation

**Flow:** Create thread → Stream run → Receive SSE events

This is the most common pattern for real-time chat applications where you want to display responses as they're generated.

#### Step 1 & 2: Create Assistant and Thread

Same as in the synchronous flow above.

#### Step 3: Create Streaming Run

**Endpoint:** `POST /threads/{thread_id}/runs/stream`

**Purpose:** Execute the assistant and stream results in real-time via Server-Sent Events (SSE)

**Request Body:**
```json
{
  "assistant_id": "agent",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": "Tell me a joke about ice cream"
      }
    ]
  },
  "stream_mode": ["updates"],
  "stream_subgraphs": false,
  "config": {
    "recursion_limit": 25,
    "configurable": {}
  },
  "metadata": {},
  "multitask_strategy": "reject"
}
```

**Key Fields:**
- `stream_mode`: Array or string specifying what to stream (see Stream Modes below)
- `stream_subgraphs`: Whether to include outputs from subgraphs
- Other fields same as the wait endpoint

**Response:** Server-Sent Events stream

The response is an SSE stream with multiple events. Each event has this structure:

```
event: <event_type>
data: <json_data>

```

**SSE Event Sequence:**

1. **Metadata Event** (first event)
```
event: metadata
data: {"run_id": "1f02c2b3-3cef-68de-b720-eec2a4a8e920", "attempt": 1}
```

2. **Data Events** (one per graph node execution)
```
event: updates
data: {"refine_topic": {"topic": "ice cream and cats"}}

event: updates
data: {"generate_joke": {"joke": "This is a joke about ice cream and cats"}}
```

3. **End Event** (final event)
```
event: end
data: null
```

**Client Action:**
- Parse SSE stream
- Handle metadata event to get run_id
- Process data events to update UI in real-time
- Handle end event to finalize the response

**SDK Example (Python):**
```python
from langgraph_sdk import get_client

client = get_client(url=DEPLOYMENT_URL)

# Create thread
thread = await client.threads.create()

# Stream run
async for chunk in client.runs.stream(
    thread["thread_id"],
    "agent",  # assistant_id
    input={"messages": [{"role": "user", "content": "Tell me a joke"}]},
    stream_mode="updates"
):
    print(f"Event: {chunk.event}")
    print(f"Data: {chunk.data}")
```

**SDK Example (JavaScript):**
```javascript
import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: DEPLOYMENT_URL });

// Create thread
const thread = await client.threads.create();

// Stream run
const streamResponse = client.runs.stream(
  thread.thread_id,
  "agent",
  {
    input: {
      messages: [{ role: "user", content: "Tell me a joke" }]
    },
    streamMode: "updates"
  }
);

for await (const chunk of streamResponse) {
  console.log(`Event: ${chunk.event}`);
  console.log(`Data:`, chunk.data);
}
```

**cURL Example:**
```bash
curl --request POST \
  --url http://localhost:8124/threads/thread-uuid/runs/stream \
  --header 'Content-Type: application/json' \
  --data '{
    "assistant_id": "agent",
    "input": {
      "messages": [
        {"role": "user", "content": "Tell me a joke"}
      ]
    },
    "stream_mode": "updates"
  }'
```

---

### 3. Multi-Turn Conversation

**Flow:** Create thread once → Multiple streaming runs on same thread

For multi-turn conversations, you reuse the same thread across multiple runs. The thread accumulates state (messages, context) across all runs.

#### First Turn

Same as streaming conversation above:
1. Create thread
2. Stream run with initial user message

#### Subsequent Turns

**Endpoint:** `POST /threads/{thread_id}/runs/stream` (same endpoint, same thread_id)

**Request Body:**
```json
{
  "assistant_id": "agent",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": "Can you make it funnier?"
      }
    ]
  },
  "stream_mode": ["updates"]
}
```

**Key Points:**
- Use the **same thread_id** from the first turn
- Only send the **new user message** in input
- The thread already contains the previous messages from earlier runs
- The assistant has access to the full conversation history via the thread state

**How Thread State Works:**

After the first run, the thread state contains:
```json
{
  "values": {
    "messages": [
      {"role": "user", "content": "Tell me a joke"},
      {"role": "assistant", "content": "Why did the ice cream..."}
    ]
  }
}
```

When you send the second run with new input, LangGraph:
1. Loads the existing thread state (previous messages)
2. Appends the new input message to the state
3. Executes the graph with the combined context
4. Updates the thread state with the new response

After the second run, the thread state contains:
```json
{
  "values": {
    "messages": [
      {"role": "user", "content": "Tell me a joke"},
      {"role": "assistant", "content": "Why did the ice cream..."},
      {"role": "user", "content": "Can you make it funnier?"},
      {"role": "assistant", "content": "Even funnier version..."}
    ]
  }
}
```

**Client Pattern:**
```python
# First turn
thread = await client.threads.create()

async for chunk in client.runs.stream(
    thread["thread_id"],
    "agent",
    input={"messages": [{"role": "user", "content": "Tell me a joke"}]},
    stream_mode="updates"
):
    # Handle first response
    pass

# Second turn (reuse same thread_id)
async for chunk in client.runs.stream(
    thread["thread_id"],  # Same thread!
    "agent",
    input={"messages": [{"role": "user", "content": "Make it funnier"}]},
    stream_mode="updates"
):
    # Handle second response
    pass

# Third turn, fourth turn, etc. - all on same thread
```

**Inspecting Thread State:**

You can retrieve the current thread state at any time:

```bash
GET /threads/{thread_id}/state
```

Response:
```json
{
  "values": {
    "messages": [...]
  },
  "next": [],
  "checkpoint": {},
  "metadata": {}
}
```

---

### 4. Stateless Run (No Thread)

**Flow:** Create run without thread (single-shot, no state persistence)

For stateless operations where you don't need to maintain conversation history.

**Endpoint:** `POST /runs/stream` (no thread_id in path)

**Request Body:**
```json
{
  "assistant_id": "agent",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": "What is 2+2?"
      }
    ]
  },
  "stream_mode": ["values"]
}
```

**Key Points:**
- No thread_id required
- No state persistence
- Each run is independent
- Suitable for one-off queries

**SDK Example (Python):**
```python
# Stateless streaming run (no thread)
async for chunk in client.runs.stream(
    None,  # thread_id = None for stateless
    "agent",
    input={"messages": [{"role": "user", "content": "What is 2+2?"}]},
    stream_mode="values"
):
    print(chunk.data)
```

**SDK Example (JavaScript):**
```javascript
// Stateless streaming run (no thread)
const streamResponse = client.runs.stream(
  null,  // thread_id = null for stateless
  "agent",
  {
    input: {
      messages: [{ role: "user", content: "What is 2+2?" }]
    },
    streamMode: "values"
  }
);

for await (const chunk of streamResponse) {
  console.log(chunk.data);
}
```

**cURL Example:**
```bash
curl --request POST \
  --url http://localhost:8124/runs/stream \
  --header 'Content-Type: application/json' \
  --data '{
    "assistant_id": "agent",
    "input": {
      "messages": [
        {"role": "user", "content": "What is 2+2?"}
      ]
    },
    "stream_mode": "values"
  }'
```

---

### 5. Background Run with Polling

**Flow:** Create background run → Poll status → Join stream when needed

Useful for long-running operations where the client may disconnect and reconnect.

#### Step 1: Create Background Run

**Endpoint:** `POST /threads/{thread_id}/runs`

**Request Body:**
```json
{
  "assistant_id": "agent",
  "input": {
    "messages": [
      {"role": "user", "content": "Process this large dataset..."}
    ]
  },
  "metadata": {},
  "multitask_strategy": "enqueue",
  "on_disconnect": "continue"
}
```

**Key Fields:**
- `on_disconnect`: "continue" (run continues if client disconnects) or "cancel"

**Response:**
```json
{
  "run_id": "run-uuid",
  "thread_id": "thread-uuid",
  "assistant_id": "agent",
  "status": "pending",
  "created_at": "2023-11-07T05:31:56Z",
  "updated_at": "2023-11-07T05:31:56Z"
}
```

**Client Action:** Store the `run_id` for polling.

#### Step 2: Poll Run Status

**Endpoint:** `GET /threads/{thread_id}/runs/{run_id}`

**Response:**
```json
{
  "run_id": "run-uuid",
  "thread_id": "thread-uuid",
  "status": "running",
  "created_at": "2023-11-07T05:31:56Z",
  "updated_at": "2023-11-07T05:31:57Z"
}
```

**Status Values:**
- `pending`: Queued, not started yet
- `running`: Currently executing
- `success`: Completed successfully
- `error`: Failed with error
- `interrupted`: Paused for human-in-the-loop

**Client Action:** Poll periodically (e.g., every 2 seconds) until status is success/error.

#### Step 3: Join Active Stream (Optional)

**Endpoint:** `GET /threads/{thread_id}/runs/{run_id}/stream`

**Purpose:** Attach to an active run and receive SSE events from the current point onward

**Response:** SSE stream of events from the current execution point

**SDK Example:**
```python
# Join an active stream
async for chunk in client.runs.join_stream(
    thread_id="thread-uuid",
    run_id="run-uuid"
):
    print(chunk.data)
```

#### Step 4: Get Final Result

Once the run status is "success", retrieve the final state:

**Endpoint:** `GET /threads/{thread_id}/state`

**Response:**
```json
{
  "values": {
    "messages": [...],
    "result": "..."
  }
}
```

**Complete Flow Example:**
```python
# Start background run
run = await client.runs.create(
    thread_id=thread["thread_id"],
    assistant_id="agent",
    input={"messages": [{"role": "user", "content": "Long task"}]},
    on_disconnect="continue"
)

# Poll status
while True:
    run_status = await client.runs.get(
        thread_id=thread["thread_id"],
        run_id=run["run_id"]
    )
    if run_status["status"] in ["success", "error"]:
        break
    await asyncio.sleep(2)

# Get final result
final_state = await client.threads.get_state(thread["thread_id"])
print(final_state["values"])
```

---

## Stream Modes

LangGraph supports multiple streaming modes to control what data is streamed during execution:

| Mode | Description | Use Case |
|------|-------------|----------|
| `values` | Stream the **full graph state** after each super-step | When you need complete state visibility |
| `updates` | Stream **state updates** after each node execution | Most common for chat apps; shows incremental changes |
| `messages-tuple` | Stream **LLM tokens** and metadata in real-time | For token-by-token streaming (like ChatGPT) |
| `debug` | Stream **all execution details** including internal state | Debugging and development |
| `custom` | Stream **custom data** emitted from your graph nodes | Application-specific streaming |
| `events` | Stream **all events** including state and LLM events | Advanced use cases, LCEL migration |

### Stream Mode: `updates`

Streams the delta/changes to state after each node execution.

**Request:**
```json
{
  "stream_mode": "updates"
}
```

**SSE Events:**
```
event: metadata
data: {"run_id": "...", "attempt": 1}

event: updates
data: {"node_1": {"field": "value1"}}

event: updates
data: {"node_2": {"field": "value2"}}

event: end
data: null
```

**Example Output:**
```python
{'run_id': '1f02c2b3-...', 'attempt': 1}
{'refine_topic': {'topic': 'ice cream and cats'}}
{'generate_joke': {'joke': 'This is a joke about ice cream and cats'}}
```

### Stream Mode: `values`

Streams the complete graph state after each super-step.

**Request:**
```json
{
  "stream_mode": "values"
}
```

**Example Output:**
```python
{'topic': 'ice cream', 'joke': ''}
{'topic': 'ice cream and cats', 'joke': ''}
{'topic': 'ice cream and cats', 'joke': 'This is a joke about ice cream and cats'}
```

### Stream Mode: `messages-tuple`

Streams LLM tokens in real-time (useful for chat applications with typing indicators).

**Request:**
```json
{
  "stream_mode": "messages-tuple"
}
```

**SSE Events:**
```
event: messages/metadata
data: {"langgraph_node": "agent", "langgraph_triggers": [...]}

event: messages/partial
data: [{"id": "msg-1", "type": "AIMessageChunk", "content": "Hello"}]

event: messages/partial
data: [{"id": "msg-1", "type": "AIMessageChunk", "content": " there"}]

event: messages/complete
data: [{"id": "msg-1", "type": "AIMessage", "content": "Hello there"}]

event: end
data: null
```

**SDK Output:** Tuples of `(message_chunk, metadata)`

```python
async for chunk in client.runs.stream(
    thread_id,
    assistant_id,
    input={"messages": [{"role": "user", "content": "Hello"}]},
    stream_mode="messages-tuple"
):
    message_chunk, metadata = chunk.data
    print(message_chunk["content"])  # "Hello", " there", etc.
```

### Stream Mode: `debug`

Streams maximum information for debugging.

**Request:**
```json
{
  "stream_mode": "debug"
}
```

Includes full state, node execution details, timing information, etc.

### Multiple Stream Modes

You can stream multiple modes simultaneously:

**Request:**
```json
{
  "stream_mode": ["updates", "messages-tuple"]
}
```

**SDK Output:**
```python
async for chunk in client.runs.stream(
    thread_id,
    assistant_id,
    input={...},
    stream_mode=["updates", "messages-tuple"]
):
    mode = chunk.event  # "updates" or "messages-tuple"
    data = chunk.data
    print(f"Mode: {mode}, Data: {data}")
```

---

## SSE Event Format

Server-Sent Events (SSE) is the protocol used for streaming responses.

### SSE Protocol Basics

SSE uses plain text with specific formatting:

```
event: <event_type>
data: <json_string>

```

- Each event starts with `event:` followed by the event type
- Data follows on the next line with `data:` prefix
- Two newlines (`\n\n`) mark the end of an event

### LangGraph SSE Event Structure

Each chunk from the SDK has this structure:

```python
{
  "event": "<event_type>",  # The type of event
  "data": {...}             # JSON data for the event
}
```

### Common Event Types

1. **metadata** - First event with run information
```
event: metadata
data: {"run_id": "...", "attempt": 1, "thread_id": "..."}
```

2. **updates** - State update from a node (stream_mode="updates")
```
event: updates
data: {"node_name": {"state_field": "new_value"}}
```

3. **values** - Full state snapshot (stream_mode="values")
```
event: values
data: {"field1": "value1", "field2": "value2"}
```

4. **messages/metadata** - Metadata about message streaming (stream_mode="messages-tuple")
```
event: messages/metadata
data: {"langgraph_node": "agent_node"}
```

5. **messages/partial** - Partial LLM token (stream_mode="messages-tuple")
```
event: messages/partial
data: [{"content": "Hello", "type": "AIMessageChunk"}]
```

6. **messages/complete** - Complete message (stream_mode="messages-tuple")
```
event: messages/complete
data: [{"content": "Hello there!", "type": "AIMessage"}]
```

7. **end** - Final event marking completion
```
event: end
data: null
```

8. **error** - Error event (if execution fails)
```
event: error
data: {"error": "Error message", "stack": "..."}
```

### Event Sequence Example

For a typical streaming run with `stream_mode="updates"`:

```
1. event: metadata
   data: {"run_id": "abc-123", "attempt": 1}

2. event: updates
   data: {"prepare_node": {"status": "prepared"}}

3. event: updates
   data: {"llm_node": {"response": "Hello! How can I help?"}}

4. event: updates
   data: {"format_node": {"formatted": "..."}}

5. event: end
   data: null
```

---

## Thread State Accumulation

Understanding how thread state works is crucial for multi-turn conversations.

### Initial State

When a thread is created, it has empty state:

```json
{
  "values": {},
  "next": [],
  "checkpoint": {}
}
```

### After First Run

Input:
```json
{
  "messages": [
    {"role": "user", "content": "Hello"}
  ]
}
```

Thread state after run:
```json
{
  "values": {
    "messages": [
      {"role": "user", "content": "Hello"},
      {"role": "assistant", "content": "Hi! How can I help you?"}
    ]
  }
}
```

### After Second Run

Input (only new message):
```json
{
  "messages": [
    {"role": "user", "content": "What's the weather?"}
  ]
}
```

Thread state after run:
```json
{
  "values": {
    "messages": [
      {"role": "user", "content": "Hello"},
      {"role": "assistant", "content": "Hi! How can I help you?"},
      {"role": "user", "content": "What's the weather?"},
      {"role": "assistant", "content": "The weather is sunny..."}
    ]
  }
}
```

### State Reducer Behavior

LangGraph uses **state reducers** to determine how new state merges with existing state:

- **Messages field**: Typically uses an **append** reducer - new messages are appended to the list
- **Other fields**: May use **replace** or **custom** reducers

This is why you only send the new message in subsequent runs - LangGraph automatically appends it to the existing message history.

### Querying Thread State

At any point, you can query the thread state:

**Endpoint:** `GET /threads/{thread_id}/state`

**Response:**
```json
{
  "values": {
    "messages": [...],
    "custom_field": "..."
  },
  "next": ["node_name"],
  "checkpoint": {
    "thread_id": "...",
    "checkpoint_ns": "...",
    "checkpoint_id": "..."
  },
  "metadata": {},
  "created_at": "...",
  "parent_checkpoint": {...}
}
```

**SDK Example:**
```python
state = await client.threads.get_state(thread_id="thread-uuid")
messages = state["values"]["messages"]
print(f"Total messages: {len(messages)}")
```

### Modifying Thread State

You can also manually update thread state:

**Endpoint:** `POST /threads/{thread_id}/state`

**Request Body:**
```json
{
  "values": {
    "custom_field": "new_value"
  },
  "as_node": "node_name"
}
```

This allows you to inject state changes between runs.

---

## Store API - Cross-Thread Memory

The Store API provides persistent key-value storage that persists **across threads** and **across time**. This is used for long-term memory, user preferences, and shared knowledge.

### Store Namespaces

The Store is organized into namespaces with hierarchical keys:

```
["user", "user-123"]
["organization", "org-456"]
["global", "facts"]
```

### PUT Item

**Endpoint:** `PUT /store/items`

**Request Body:**
```json
{
  "namespace": ["user", "user-123"],
  "key": "preferences",
  "value": {
    "theme": "dark",
    "language": "en"
  }
}
```

### GET Item

**Endpoint:** `GET /store/items?namespace=user,user-123&key=preferences`

**Response:**
```json
{
  "namespace": ["user", "user-123"],
  "key": "preferences",
  "value": {
    "theme": "dark",
    "language": "en"
  },
  "created_at": "...",
  "updated_at": "..."
}
```

### Search Items

**Endpoint:** `POST /store/items/search`

**Request Body:**
```json
{
  "namespace_prefix": ["user"],
  "limit": 10,
  "offset": 0
}
```

Returns all items in namespaces starting with `["user"]`.

### Use Case: User Memory Across Conversations

```python
# Store user preferences (persists across threads)
await client.store.put(
    namespace=["user", user_id],
    key="preferences",
    value={"tone": "formal", "language": "en"}
)

# Later, in any thread for this user
preferences = await client.store.get(
    namespace=["user", user_id],
    key="preferences"
)

# Use preferences in run
await client.runs.stream(
    thread_id=new_thread_id,
    assistant_id="agent",
    input={
        "messages": [{"role": "user", "content": "Hello"}],
        "user_preferences": preferences["value"]
    }
)
```

**Key Distinction:**
- **Thread State**: Conversation-specific, temporary (unless persisted)
- **Store**: Cross-conversation, long-term, shared

---

## When to Use Each Run Type

### Use `POST /threads/{thread_id}/runs/stream` When:
- Building a chat application with real-time responses
- You need to display incremental updates to the user
- You want to show "typing" indicators
- The conversation has multiple turns (stateful)

### Use `POST /threads/{thread_id}/runs/wait` When:
- You need the complete result before proceeding
- Building synchronous APIs
- The result is small and fast to compute
- You don't need real-time updates

### Use `POST /runs/stream` (Stateless) When:
- Single-shot queries with no conversation history
- Each request is independent
- You don't need to track state across requests
- Example: translation, summarization, one-off questions

### Use `POST /threads/{thread_id}/runs` (Background) When:
- Long-running operations (minutes/hours)
- The client may disconnect and reconnect
- You need durable execution
- You want to queue multiple runs with `multitask_strategy="enqueue"`

### Use `POST /runs/batch` When:
- Processing multiple independent requests in parallel
- Bulk operations
- You need efficient batch processing

---

## Complete End-to-End Examples

### Example 1: Simple Chat Application Flow

```python
from langgraph_sdk import get_client

client = get_client(url="http://localhost:8124")

# 1. Initialize (once at app startup)
assistants = await client.assistants.search()
assistant_id = assistants[0]["assistant_id"]

# 2. Start new conversation
thread = await client.threads.create(
    metadata={"user_id": "user-123", "session": "chat-1"}
)
thread_id = thread["thread_id"]

# 3. First message
messages = []
async for chunk in client.runs.stream(
    thread_id,
    assistant_id,
    input={"messages": [{"role": "user", "content": "Hello!"}]},
    stream_mode="updates"
):
    if chunk.event == "updates":
        # Extract assistant message from the update
        for node_name, node_output in chunk.data.items():
            if "messages" in node_output:
                new_messages = node_output["messages"]
                messages.extend(new_messages)
                print(f"Assistant: {new_messages[-1]['content']}")

# 4. Second message (continue conversation)
async for chunk in client.runs.stream(
    thread_id,  # Same thread!
    assistant_id,
    input={"messages": [{"role": "user", "content": "Tell me a joke"}]},
    stream_mode="updates"
):
    if chunk.event == "updates":
        for node_name, node_output in chunk.data.items():
            if "messages" in node_output:
                new_messages = node_output["messages"]
                messages.extend(new_messages)
                print(f"Assistant: {new_messages[-1]['content']}")

# 5. Get full conversation history
state = await client.threads.get_state(thread_id)
all_messages = state["values"]["messages"]
print(f"Total messages: {len(all_messages)}")
```

### Example 2: Token-by-Token Streaming (ChatGPT-style)

```javascript
import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:8124" });

// Create thread
const thread = await client.threads.create();

// Stream with token-by-token output
let fullResponse = "";

const streamResponse = client.runs.stream(
  thread.thread_id,
  "agent",
  {
    input: {
      messages: [
        { role: "user", content: "Write a short story" }
      ]
    },
    streamMode: "messages-tuple"
  }
);

for await (const chunk of streamResponse) {
  if (chunk.event === "messages/partial") {
    // chunk.data is [message_chunk, metadata]
    const [messageChunk] = chunk.data;
    const token = messageChunk.content;

    // Display token immediately
    process.stdout.write(token);
    fullResponse += token;
  }

  if (chunk.event === "messages/complete") {
    console.log("\n--- Complete ---");
  }
}
```

### Example 3: Background Processing with Polling

```python
import asyncio
from langgraph_sdk import get_client

client = get_client(url="http://localhost:8124")

# Create thread and start long-running task
thread = await client.threads.create()

run = await client.runs.create(
    thread["thread_id"],
    "data_processor",
    input={"dataset_url": "https://example.com/large_dataset.csv"},
    multitask_strategy="enqueue",
    on_disconnect="continue"
)

print(f"Started run: {run['run_id']}")

# Poll status
while True:
    run_status = await client.runs.get(
        thread["thread_id"],
        run["run_id"]
    )

    status = run_status["status"]
    print(f"Status: {status}")

    if status == "success":
        # Get result
        state = await client.threads.get_state(thread["thread_id"])
        result = state["values"]["result"]
        print(f"Result: {result}")
        break
    elif status == "error":
        print(f"Error: {run_status.get('error')}")
        break
    elif status == "interrupted":
        print("Run interrupted, waiting for human input")
        # Handle human-in-the-loop
        break

    await asyncio.sleep(2)
```

### Example 4: User Context with Store API

```python
from langgraph_sdk import get_client

client = get_client(url="http://localhost:8124")

user_id = "user-456"

# Store user preferences (persists across all conversations)
await client.store.put(
    namespace=["user", user_id],
    key="profile",
    value={
        "name": "Alice",
        "tone": "friendly",
        "expertise_level": "beginner"
    }
)

# Start new conversation
thread = await client.threads.create(
    metadata={"user_id": user_id}
)

# Retrieve user context
user_profile = await client.store.get(
    namespace=["user", user_id],
    key="profile"
)

# Use context in run
async for chunk in client.runs.stream(
    thread["thread_id"],
    "personalized_agent",
    input={
        "messages": [{"role": "user", "content": "Explain quantum computing"}],
        "user_profile": user_profile["value"]
    },
    stream_mode="updates"
):
    print(chunk.data)
```

---

## Multitask Strategy

The `multitask_strategy` parameter controls how concurrent runs on the same thread are handled.

### Options

| Strategy | Behavior |
|----------|----------|
| `reject` | Reject the new run if another is active (returns error) |
| `interrupt` | Interrupt the active run and start the new one |
| `rollback` | Roll back the active run's changes and start the new one |
| `enqueue` | Queue the new run to execute after the active run completes |

### Use Cases

**`reject`** (Default):
```python
# Prevent concurrent runs - second run will fail
await client.runs.stream(
    thread_id,
    assistant_id,
    input={...},
    multitask_strategy="reject"
)
```

Use when you want strict single-run-at-a-time enforcement.

**`interrupt`**:
```python
# User sends new message while assistant is still responding
# Interrupt the current response and start over
await client.runs.stream(
    thread_id,
    assistant_id,
    input={"messages": [{"role": "user", "content": "Actually, never mind"}]},
    multitask_strategy="interrupt"
)
```

Use for chat applications where users can interrupt the assistant.

**`rollback`**:
```python
# Similar to interrupt but discards partial state changes
await client.runs.stream(
    thread_id,
    assistant_id,
    input={...},
    multitask_strategy="rollback"
)
```

Use when you want to ensure clean state (no partial updates).

**`enqueue`**:
```python
# Queue multiple tasks to run sequentially
await client.runs.create(
    thread_id,
    assistant_id,
    input={"task": "task1"},
    multitask_strategy="enqueue"
)

await client.runs.create(
    thread_id,
    assistant_id,
    input={"task": "task2"},
    multitask_strategy="enqueue"
)
# task2 will start after task1 completes
```

Use for background job queues on a thread.

---

## API Endpoint Summary

### Assistants

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/assistants` | Create assistant |
| GET | `/assistants/{assistant_id}` | Get assistant |
| PATCH | `/assistants/{assistant_id}` | Update assistant |
| DELETE | `/assistants/{assistant_id}` | Delete assistant |
| POST | `/assistants/search` | Search assistants |

### Threads

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/threads` | Create thread |
| GET | `/threads/{thread_id}` | Get thread |
| PATCH | `/threads/{thread_id}` | Update thread |
| DELETE | `/threads/{thread_id}` | Delete thread |
| POST | `/threads/search` | Search threads |
| GET | `/threads/{thread_id}/state` | Get thread state |
| POST | `/threads/{thread_id}/state` | Update thread state |
| POST | `/threads/{thread_id}/history` | Get state history |

### Runs (Stateful)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/threads/{thread_id}/runs` | Create background run |
| POST | `/threads/{thread_id}/runs/stream` | Create streaming run (SSE) |
| POST | `/threads/{thread_id}/runs/wait` | Create run and wait for result |
| GET | `/threads/{thread_id}/runs` | List runs for thread |
| GET | `/threads/{thread_id}/runs/{run_id}` | Get run details |
| GET | `/threads/{thread_id}/runs/{run_id}/stream` | Join active stream (SSE) |
| POST | `/threads/{thread_id}/runs/{run_id}/cancel` | Cancel run |
| DELETE | `/threads/{thread_id}/runs/{run_id}` | Delete run |

### Runs (Stateless)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/runs` | Create stateless background run |
| POST | `/runs/stream` | Create stateless streaming run (SSE) |
| POST | `/runs/wait` | Create stateless run and wait |
| POST | `/runs/batch` | Batch runs |

### Store

| Method | Endpoint | Purpose |
|--------|----------|---------|
| PUT | `/store/items` | Put/update item |
| GET | `/store/items` | Get item |
| DELETE | `/store/items` | Delete item |
| POST | `/store/items/search` | Search items |
| POST | `/store/namespaces` | List namespaces |

### System

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/ok` | Health check |
| GET | `/info` | Server info |

---

## Assumptions & Scope

### Assumptions Made

| Assumption | Confidence | Impact if Wrong |
|------------|------------|-----------------|
| The API structure described matches the official LangGraph Platform API as of 2026 | HIGH | Documentation would need updates if API has changed |
| SSE event format is consistent across all stream modes | HIGH | Event parsing logic would need adjustment |
| Thread state uses append reducer for messages field | HIGH | State accumulation behavior would differ |
| The Store API uses hierarchical namespaces as described | MEDIUM | Store organization patterns would change |
| Authentication via X-Api-Key header is standard for LangSmith deployments | HIGH | Auth implementation would differ |
| Multitask strategy options are complete and accurate | MEDIUM | Additional strategies may exist |

### What Was Excluded

- **Crons API**: Scheduled runs endpoints were not covered in detail
- **Advanced Features**: Human-in-the-loop flows, interrupts, time-travel debugging
- **A2A Protocol**: Agent-to-Agent communication endpoints
- **MCP Protocol**: Model Context Protocol endpoints
- **Subgraph Details**: How subgraph streaming works in depth
- **Error Handling**: Detailed error codes and error response formats
- **Rate Limiting**: API rate limits and throttling
- **Webhooks**: Webhook configuration for run completion notifications
- **Versioning**: Assistant version management and rollback
- **Deployment Details**: LangSmith deployment, langgraph.json configuration

### Confidence Levels

- **API Endpoints and Methods**: HIGH - Confirmed from official documentation
- **Request/Response Formats**: HIGH - Verified with code examples
- **SSE Event Sequence**: HIGH - Documented with examples
- **Stream Modes**: HIGH - Official documentation confirms all modes
- **Thread State Behavior**: HIGH - Consistent across sources
- **SDK Usage Patterns**: HIGH - Official SDK documentation
- **Store API Details**: MEDIUM - Less documentation available
- **Multitask Strategy Edge Cases**: MEDIUM - Limited examples for all scenarios

---

## Uncertainties & Gaps

### Areas Requiring Clarification

1. **Store API Limits**: What are the size limits for Store values? How many namespaces/keys are supported?

2. **Thread TTL Behavior**: Exact behavior when thread TTL expires - are runs canceled? Is cleanup immediate?

3. **Multitask Strategy Edge Cases**: What happens if you use `rollback` with subgraphs? How far back does it roll?

4. **SSE Reconnection**: How does SSE reconnection work if the connection drops mid-stream?

5. **Checkpoint Details**: How checkpoint versioning works for time-travel debugging

6. **Error Codes**: Complete list of error codes and their meanings

7. **Performance Limits**: Maximum message history size, maximum thread state size

8. **Webhook Format**: Exact format of webhook payloads for run completion

---

## Clarifying Questions for Follow-up

1. **Store API Usage**: How is the Store API typically used in production applications? Are there common patterns for organizing namespaces?

2. **Performance Best Practices**: What are the recommended practices for managing large conversation histories? When should threads be pruned?

3. **Error Recovery**: What's the recommended approach for handling SSE disconnections and resuming streams?

4. **Human-in-the-Loop**: How do the interrupt/resume flows work in detail? How does the client know when human input is needed?

5. **Subgraph Streaming**: When using `stream_subgraphs=true`, how do you distinguish parent graph events from subgraph events?

6. **Batch Processing**: What are the performance characteristics of `/runs/batch`? Is there a limit on batch size?

7. **State Pruning**: Are there built-in mechanisms for pruning old messages from thread state while preserving recent context?

8. **Version Migration**: How do you handle assistant version upgrades for existing threads? Do old threads continue using old versions?

9. **Cross-Thread Context**: Besides the Store API, are there other mechanisms for sharing context between threads?

10. **Resource Cleanup**: What's the recommended approach for cleaning up old threads, runs, and store items?

---

## Sources Collected

| # | Source | URL | Information Gathered |
|---|--------|-----|---------------------|
| 1 | LangGraph Python OSS Documentation | https://docs.langchain.com/oss/python/langgraph/local-server | Python SDK streaming examples, run methods |
| 2 | LangGraph JavaScript Documentation | https://langchain-ai.github.io/langgraphjs/cloud/how-tos/stream_values | JavaScript SDK client usage, stream modes |
| 3 | LangGraph Streaming API | https://docs.langchain.com/langgraph-platform/streaming | Comprehensive streaming documentation, stream modes |
| 4 | LangSmith Streaming API | https://docs.langchain.com/langsmith/streaming | Extended streaming examples, subgraphs |
| 5 | Agent Server API Reference | https://docs.langchain.com/langsmith/server-api-ref | API endpoint groups, authentication |
| 6 | Assistants API | https://docs.langchain.com/langsmith/agent-server-api/assistants | Assistant creation, request/response formats |
| 7 | Threads API | https://docs.langchain.com/langsmith/agent-server-api/threads | Thread creation, state management |
| 8 | Thread Runs API | https://docs.langchain.com/langsmith/agent-server-api/thread-runs | Run creation, status, multitask_strategy |
| 9 | Stateless Runs API | https://docs.langchain.com/langsmith/agent-server-api/stateless-runs | Stateless run patterns, request bodies |
| 10 | Manage Assistants | https://docs.langchain.com/langsmith/configuration-cloud | Assistant configuration, context fields |
| 11 | LangGraph Platform Overview | https://deepwiki.com/langchain-ai/langgraph/8-langgraph-platform | Platform architecture, core resources |
| 12 | Threads and State Management | https://deepwiki.com/langchain-ai/langgraph/7.2-threads-and-state-management | Thread state behavior, checkpoints |
| 13 | Streaming and Events | https://deepwiki.com/langchain-ai/langgraph/7.4-streaming-and-events | Event types, SSE protocol details |
| 14 | Enqueue Concurrent | https://docs.langchain.com/langsmith/enqueue-concurrent | Multitask strategy, concurrent runs |
| 15 | SSE Streaming Pattern | https://deepwiki.com/langchain-ai/langgraph-fullstack-python/2.3-sse-streaming | SSE event format, chunk structure |

### Recommended for Deep Reading

- **[LangGraph Streaming API](https://docs.langchain.com/langgraph-platform/streaming)**: Comprehensive guide to all streaming modes with examples
- **[Agent Server API Reference](https://docs.langchain.com/langsmith/server-api-ref)**: Complete API reference with all endpoints
- **[Threads and State Management](https://deepwiki.com/langchain-ai/langgraph/7.2-threads-and-state-management)**: Deep dive into thread state behavior
- **[LangGraph Platform Overview](https://deepwiki.com/langchain-ai/langgraph/8-langgraph-platform)**: Architectural overview of the platform

---

## Conclusion

The LangGraph Platform API provides a comprehensive REST interface for building conversational AI applications. The key patterns are:

1. **Streaming First**: Most applications use the `/runs/stream` endpoint for real-time responses
2. **Thread-Based State**: Multi-turn conversations are managed via threads that accumulate state
3. **Flexible Streaming**: Multiple stream modes support different use cases (updates, values, token streaming)
4. **SSE Protocol**: Server-Sent Events enable efficient real-time streaming
5. **Long-Term Memory**: The Store API provides cross-thread persistent storage

The API is designed to be both simple for basic use cases (create thread → stream run) and powerful for advanced scenarios (background runs, multitask strategies, human-in-the-loop).
