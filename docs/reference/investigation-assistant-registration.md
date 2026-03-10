# LangGraph Platform Assistant Registration and Discovery

**Research Date:** 2026-03-10
**Purpose:** Understand how the official LangGraph Platform discovers, registers, and manages assistants to inform lg-api implementation decisions.

---

## Executive Summary

The official LangGraph Platform (now part of LangSmith Deployment) uses a **graph-centric, auto-registration model** for assistants:

1. **Graphs are defined in code and declared in `langgraph.json`**
2. **Default assistants are auto-created on deployment** (one per graph)
3. **Additional assistants can be created at runtime** via API or UI
4. **Assistants are persisted** (not recreated on restart when using persistent storage)
5. **Graph_id and assistant_id are distinct**: graph_id references the default assistant, assistant_id references a specific configuration

---

## 1. How Assistants Are Created

### 1.1 Relationship: Graph vs Assistant

**Core Concept:**
- A **graph** is the deployed code containing your agent's logic (defined in Python/TypeScript)
- An **assistant** is an instance of a graph with a specific configuration

**Key Quote from Documentation:**
> "In practice, an assistant is just an *instance* of a graph with a specific configuration. Therefore, multiple assistants can reference the same graph but can contain different configurations (e.g. prompts, models, tools)."

### 1.2 langgraph.json Configuration File

The `langgraph.json` file is the central configuration for a LangGraph application. It specifies:
- **dependencies**: Packages to install before loading graphs
- **graphs**: Which graphs will be available in the deployed application
- **env**: Path to environment file with secrets/config
- **python_version**: Python version requirement
- **dockerfile_lines**: Additional system dependencies

**Example Structure:**
```json
{
  "dependencies": ["langchain_openai", "./your_package"],
  "graphs": {
    "my_agent": "./your_package/your_file.py:agent",
    "chat_bot": "./your_package/chat.py:chat_graph",
    "summarizer": "./your_package/summarizer.py:summarizer"
  },
  "env": "./.env",
  "python_version": "3.11"
}
```

**Graph Declaration Format:**
- **Key**: Graph ID (e.g., `"my_agent"`) - used to reference the graph
- **Value**: Path to the graph in the format `"./path/to/file.py:variable_name"`
  - The path points to either a compiled graph or a function that creates a graph

**Graph in Code Example:**
```python
# your_package/agent.py
from langgraph.graph import StateGraph, MessagesState

def create_agent():
    builder = StateGraph(MessagesState)
    # ... add nodes, edges, etc.
    return builder.compile()

# Export the compiled graph
agent = create_agent()
```

### 1.3 Auto-Creation of Default Assistants

**When LangGraph Server Starts:**
1. Reads `langgraph.json` configuration
2. Loads each declared graph from the specified Python module path
3. **Automatically creates a default assistant for each graph**
4. Uses the graph's default configuration settings (empty config by default)

**Quote from Documentation:**
> "When you deploy a graph with LangSmith Deployment, Agent Server automatically creates a **default assistant** tied to that graph's default configuration."

**Multiple Graphs = Multiple Default Assistants:**
> "If your deployment defines multiple graphs in langgraph.json, each graph gets its own default assistant—one for each graph defined in your deployment."

**Example:**
```json
{
  "graphs": {
    "graph_id_1": "path_to_graph_id_1",  // default assistant created for graph_id_1
    "graph_id_2": "path_to_graph_id_2"   // default assistant created for graph_id_2
  }
}
```

---

## 2. Assistant Auto-Discovery and Auto-Registration

### 2.1 Discovery Mechanism

**On Server Startup:**
1. LangGraph CLI/Server reads `langgraph.json`
2. Discovers all graphs in the `graphs` object
3. Loads each graph by importing the Python module and accessing the exported variable
4. Creates default assistants automatically

**No Explicit "Registration" Step:**
- Simply declaring a graph in `langgraph.json` makes it available
- No separate registration API call needed for the default assistant

### 2.2 Persistence Behavior

**Are Assistants Persisted or Recreated?**

It depends on the storage backend:

**Development Environment:**
- The `langgraph dev` command uses in-memory storage
- Assistants (and all state) are **lost on restart**
- Data is partially persisted to local disk but temporary runtime is used

**Production Environment:**
- With PostgreSQL, DynamoDB, or other persistent checkpointers: **assistants persist across restarts**
- Agent Server maintains assistant configurations in its database
- Default assistants are only created once on initial deployment

**Quote from Documentation:**
> "With durable state, agent execution state persists automatically. If your server restarts mid-conversation or a long-running workflow gets interrupted, it picks up exactly where it left off without losing context."

**Storage Options:**
- **MemorySaver/InMemorySaver**: Data lost on restart
- **PostgresSaver**: Persists to PostgreSQL database
- **DynamoDB**: Persists to AWS DynamoDB
- **Redis**: Persists to Redis store

**Best Practice:**
> "For production, use a persistent store like PostgresStore or RedisStore."

### 2.3 Multiple Assistants per Graph

**Creating Additional Assistants:**

Yes, you can have multiple assistants pointing to the same graph_id with different configurations.

**Use Cases:**
- **User-level personalization**: Different prompts/models per user
- **Customer-specific configs**: Separate configurations per organization
- **Environment-specific**: Dev/staging/prod with different models
- **A/B testing**: Compare different prompts or parameter settings
- **Specialized variants**: Domain-specific versions of a general-purpose agent

**Example:**
```python
# Create multiple assistants for the same graph
client = get_client(url=DEPLOYMENT_URL)

# Assistant 1: Blog writer
blog_assistant = await client.assistants.create(
    "writer",  # graph_id
    context={"style": "blog", "model_name": "gpt-4"},
    name="Blog Writer"
)

# Assistant 2: Tweet writer
tweet_assistant = await client.assistants.create(
    "writer",  # same graph_id
    context={"style": "tweet", "model_name": "gpt-3.5-turbo"},
    name="Tweet Writer"
)
```

Both assistants use the "writer" graph but with different configurations.

---

## 3. The langgraph.json File

### 3.1 Complete Structure Reference

```json
{
  "dependencies": [
    "langchain_openai",
    "langchain_anthropic",
    "./your_package"
  ],
  "graphs": {
    "agent_1": "./package/agent.py:agent",
    "agent_2": "./package/chat.py:chat_graph"
  },
  "env": "./.env",
  "python_version": "3.11",
  "dockerfile_lines": [
    "RUN apt-get update && apt-get install -y graphviz"
  ]
}
```

### 3.2 Field Descriptions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `dependencies` | array | Yes | Python packages to install. Can include PyPI packages and local paths (e.g., `"."` for current directory) |
| `graphs` | object | Yes | Map of graph_id → path to graph. Format: `"./path/to/file.py:variable"` |
| `env` | string or object | No | Path to `.env` file or inline environment variables |
| `python_version` | string | No | Python version (e.g., `"3.11"`, `"3.10"`) |
| `dockerfile_lines` | array | No | Additional Dockerfile commands for system dependencies |

### 3.3 Environment Variable Substitution

The `env` field supports environment variable substitution with `${VAR_NAME}` syntax:

```json
{
  "env": {
    "OPENAI_API_KEY": "${OPENAI_API_KEY}",
    "DATABASE_URL": "${DATABASE_URL}"
  }
}
```

Or reference an external file:
```json
{
  "env": "./.env"
}
```

### 3.4 How This Translates to Available Assistants

**Graph Declaration → Assistant Creation Flow:**

```
langgraph.json:
{
  "graphs": {
    "my_agent": "./agent.py:agent"
  }
}

         ↓ (on deployment)

Agent Server:
- Loads ./agent.py:agent
- Creates default assistant with:
  - graph_id: "my_agent"
  - assistant_id: <random UUID>
  - config: {} (empty by default)
  - context: {}
  - name: "Untitled" (or derived from graph_id)

         ↓ (API becomes available)

Clients can:
- Use graph_id "my_agent" → uses default assistant
- Use assistant_id UUID → uses specific assistant
- Create new assistants → POST /assistants with graph_id="my_agent"
```

---

## 4. Assistant Lifecycle

### 4.1 Can Clients Create New Assistants at Runtime?

**Yes.** Assistants can be created via:

**API (Python SDK):**
```python
from langgraph_sdk import get_client

client = get_client(url=DEPLOYMENT_URL)

# Create new assistant
assistant = await client.assistants.create(
    "my_agent",  # graph_id
    context={"model_name": "gpt-4"},
    name="GPT-4 Assistant",
    metadata={"team": "engineering"}
)
```

**API (HTTP):**
```bash
POST /assistants
Content-Type: application/json

{
  "graph_id": "my_agent",
  "context": {"model_name": "gpt-4"},
  "name": "GPT-4 Assistant",
  "if_exists": "raise"
}
```

**UI:**
1. Navigate to deployment → Assistants tab
2. Click "+ New assistant"
3. Select graph, configure settings
4. Click "Create assistant"

### 4.2 Can Clients Modify Assistants via PATCH?

**Yes.** Assistants can be updated via `PATCH /assistants/{assistant_id}`:

**API Endpoint:**
```
PATCH /assistants/{assistant_id}
```

**Request Body:**
```json
{
  "graph_id": "my_agent",  // optional, can change graph
  "config": {},            // optional, update config
  "context": {},           // optional, update context
  "metadata": {},          // optional, merge with existing
  "name": "New Name",      // optional
  "description": "..."     // optional
}
```

**Important Behavior:**
- **Every PATCH creates a new version** of the assistant
- The new version is automatically set as active
- Must pass the **ENTIRE context** (not a partial update)
- All previous versions remain accessible

**Quote from Documentation:**
> "To edit the assistant, use the update method, which creates a new version of the assistant with the provided edits. **You must pass in the ENTIRE context**, as the update endpoint creates new versions completely from scratch and does not rely on previous versions."

**SDK Example:**
```python
# Update assistant (creates new version)
updated = await client.assistants.update(
    assistant_id="62e209ca-9154-432a-b9e9-2d75c7a9219b",
    context={
        "model_name": "gpt-4",
        "system_prompt": "You are a helpful assistant"
    }
)
```

### 4.3 What Happens When You Delete an Assistant?

**API Endpoint:**
```
DELETE /assistants/{assistant_id}
```

**Query Parameters:**
- `delete_threads` (boolean, default: false): If true, delete all threads with `metadata.assistant_id` matching this assistant

**Behavior:**
- **Deletes the assistant permanently**
- **All versions of the assistant are deleted** (no way to delete a single version)
- Associated threads can optionally be deleted
- Auth filters are applied (threads not visible to user are not deleted)

**Quote from Documentation:**
> "Deleting an assistant will delete ALL of its versions. There is currently no way to delete a single version, but by pointing your assistant to the correct version you can skip any versions that you don't wish to use."

**Can It Be Re-Created?**

Yes, you can create a new assistant with the same configuration after deletion. However:
- The new assistant will have a **different assistant_id** (new UUID)
- Version history is lost (starts from version 1)
- No special restrictions on re-creating deleted assistants

### 4.4 The `if_exists` Parameter

**Purpose:** Controls behavior when creating an assistant with a duplicate `assistant_id`.

**API Parameter:**
```json
{
  "assistant_id": "3c90c3cc-0d44-4b50-8888-8dd25736052a",
  "graph_id": "my_agent",
  "if_exists": "raise"  // or "do_nothing"
}
```

**Values:**
- `"raise"` (default): Raise an error if an assistant with the same ID already exists
- `"do_nothing"`: Return the existing assistant if one with the same ID already exists

**Use Case:**
Enables **idempotent assistant creation**. You can safely retry creation without duplicating assistants:

```python
# Safe to call multiple times
assistant = await client.assistants.create(
    "my_agent",
    assistant_id="known-id",
    if_exists="do_nothing"
)
```

---

## 5. Default Assistant Behavior

### 5.1 Auto-Creation on Deployment

**When Does It Happen?**
- On initial deployment of a graph (first time)
- When a new graph is added to `langgraph.json` and deployed
- **Not on every server restart** (with persistent storage)

**How Many Default Assistants?**
- **One per graph declared in langgraph.json**
- If you have 3 graphs, you get 3 default assistants

### 5.2 Default Assistant ID: Deterministic or Random?

**Finding:** Default assistant IDs are **random UUIDs**, not deterministically derived from graph_id.

**Evidence:**
- Documentation examples show UUIDs like `"62e209ca-9154-432a-b9e9-2d75c7a9219b"`
- No mention of deterministic ID generation
- The create endpoint allows specifying `assistant_id`, suggesting it's not automatically derived

**However:**
You can reference the default assistant by **graph_id directly**:

```python
# These are equivalent for the default assistant:
run = await client.runs.create("my_agent", ...)         # Uses default
run = await client.runs.create(assistant_uuid, ...)     # Uses specific
```

**Quote from Documentation:**
> "When invoking an assistant, you can specify either a graph ID (e.g., 'agent'): Uses the default assistant for that graph, or an assistant ID (UUID): Uses a specific assistant configuration."

### 5.3 Can the Default Assistant Be Deleted?

**Finding:** The documentation does not indicate any special protection for default assistants.

**Implications:**
- Default assistants can likely be deleted like any other assistant
- Deleting removes all versions
- After deletion, you could still use the graph_id in runs (unclear if a new default is auto-created)
- Best practice: Don't delete default assistants, create additional ones instead

**Alternative to Deletion:**
Use versioning to "deactivate" a configuration without deleting:
1. Create a new version with desired config
2. Set it as active
3. Previous versions remain available but unused

---

## 6. Graph and Assistant Relationship Diagrams

### 6.1 Deployment Architecture

```
┌─────────────────────────────────────────────┐
│           langgraph.json                    │
├─────────────────────────────────────────────┤
│ {                                           │
│   "graphs": {                               │
│     "agent": "./agent.py:agent",            │
│     "chat": "./chat.py:chat_graph"          │
│   }                                         │
│ }                                           │
└─────────────────────────────────────────────┘
                    ↓
            (deployment process)
                    ↓
┌─────────────────────────────────────────────┐
│          Agent Server / Registry            │
├─────────────────────────────────────────────┤
│                                             │
│  Graph: agent                               │
│    ├─ Default Assistant (UUID-1)            │
│    ├─ Custom Assistant A (UUID-2)           │
│    └─ Custom Assistant B (UUID-3)           │
│                                             │
│  Graph: chat                                │
│    ├─ Default Assistant (UUID-4)            │
│    └─ Custom Assistant C (UUID-5)           │
│                                             │
└─────────────────────────────────────────────┘
                    ↓
            (API endpoints available)
                    ↓
┌─────────────────────────────────────────────┐
│         Client API Calls                    │
├─────────────────────────────────────────────┤
│                                             │
│  POST /threads/t1/runs                      │
│    assistant_id: "agent"         → UUID-1   │
│    assistant_id: UUID-2          → UUID-2   │
│                                             │
│  POST /assistants                           │
│    graph_id: "agent"             → creates  │
│                                     UUID-6   │
└─────────────────────────────────────────────┘
```

### 6.2 Run Execution Flow

```
Run Execution: How Assistants Apply Configuration
──────────────────────────────────────────────────

 ┌─────────────┐      ┌──────────────┐      ┌─────────────┐
 │   Thread    │      │  Assistant   │      │    Graph    │
 │  (State)    │  +   │  (Config)    │  →   │   (Logic)   │
 └─────────────┘      └──────────────┘      └─────────────┘

  User A's          GPT-4, Blog Style        Writer Graph
  Conversation      System Prompt              (Code)
                         ↓
                    ┌─────────────────────┐
                    │   Run Execution     │
                    │   - Applies config  │
                    │   - Runs graph      │
                    │   - Returns result  │
                    └─────────────────────┘

Examples:
┌─────────────────────────────────────────────────────────┐
│ Run 1: Thread T1 + Assistant A1 → Writer with GPT-4    │
│ Run 2: Thread T2 + Assistant A1 → Same config, new user│
│ Run 3: Thread T1 + Assistant A2 → Same user, new config│
└─────────────────────────────────────────────────────────┘
```

---

## 7. API Examples

### 7.1 Creating an Assistant

**Python SDK:**
```python
from langgraph_sdk import get_client

client = get_client(url="http://localhost:8000")

# Create assistant with specific configuration
assistant = await client.assistants.create(
    "my_agent",  # graph_id
    context={"model_name": "openai"},
    name="OpenAI Assistant",
    metadata={"version": "1.0"}
)

print(f"Created assistant: {assistant['assistant_id']}")
# Output: Created assistant: 62e209ca-9154-432a-b9e9-2d75c7a9219b
```

**HTTP API:**
```bash
curl -X POST http://localhost:8000/assistants \
  -H "Content-Type: application/json" \
  -d '{
    "graph_id": "my_agent",
    "context": {"model_name": "openai"},
    "name": "OpenAI Assistant",
    "if_exists": "raise"
  }'
```

**Response:**
```json
{
  "assistant_id": "62e209ca-9154-432a-b9e9-2d75c7a9219b",
  "graph_id": "my_agent",
  "context": {"model_name": "openai"},
  "config": {},
  "name": "OpenAI Assistant",
  "metadata": {},
  "version": 1,
  "created_at": "2024-08-31T03:09:10.230718+00:00",
  "updated_at": "2024-08-31T03:09:10.230718+00:00"
}
```

### 7.2 Using an Assistant in a Run

**With assistant_id:**
```python
# Create run with specific assistant
async for event in client.runs.stream(
    assistant_id="62e209ca-9154-432a-b9e9-2d75c7a9219b",
    thread_id="thread-123",
    input={"messages": [{"role": "user", "content": "Hello"}]}
):
    print(event)
```

**With graph_id (uses default assistant):**
```python
# Uses default assistant for "my_agent" graph
async for event in client.runs.stream(
    assistant_id="my_agent",  # graph_id works here
    thread_id="thread-123",
    input={"messages": [{"role": "user", "content": "Hello"}]}
):
    print(event)
```

### 7.3 Updating an Assistant (Creating a Version)

**Python SDK:**
```python
# Update creates a new version
updated = await client.assistants.update(
    assistant_id="62e209ca-9154-432a-b9e9-2d75c7a9219b",
    context={
        "model_name": "openai",
        "system_prompt": "You are a helpful assistant"
    },
    name="OpenAI Assistant v2"
)

print(f"New version: {updated['version']}")
# Output: New version: 2
```

**HTTP API:**
```bash
curl -X PATCH http://localhost:8000/assistants/62e209ca-9154-432a-b9e9-2d75c7a9219b \
  -H "Content-Type: application/json" \
  -d '{
    "context": {
      "model_name": "openai",
      "system_prompt": "You are a helpful assistant"
    },
    "name": "OpenAI Assistant v2"
  }'
```

### 7.4 Rolling Back to a Previous Version

**Python SDK:**
```python
# Set version 1 as active
await client.assistants.set_latest(
    assistant_id="62e209ca-9154-432a-b9e9-2d75c7a9219b",
    version=1
)
```

After this, all runs using this assistant_id will use version 1's configuration.

### 7.5 Deleting an Assistant

**Python SDK:**
```python
# Delete assistant and all its versions
await client.assistants.delete(
    assistant_id="62e209ca-9154-432a-b9e9-2d75c7a9219b",
    delete_threads=False  # Don't delete associated threads
)
```

**HTTP API:**
```bash
curl -X DELETE "http://localhost:8000/assistants/62e209ca-9154-432a-b9e9-2d75c7a9219b?delete_threads=false"
```

---

## 8. Assumptions & Scope

### 8.1 Assumptions Made

| Assumption | Confidence | Impact if Wrong |
|------------|------------|-----------------|
| Default assistants use random UUIDs, not deterministic IDs | MEDIUM | Would change how we reference default assistants in lg-api |
| Assistants persist when using database storage (not recreated on restart) | HIGH | Would affect our storage layer implementation |
| Default assistants can be deleted without special restrictions | MEDIUM | Might need to add protection logic |
| The `if_exists` parameter only applies to POST /assistants with explicit `assistant_id` | HIGH | Would affect creation logic |
| Graph code must export a compiled graph or a function that returns one | HIGH | Would affect our agent registry design |

### 8.2 Uncertainties & Gaps

**1. Default Assistant ID Generation:**
- Is the default assistant_id stored in metadata/config somewhere?
- Can you query "give me the default assistant for graph X"?
- What happens if you delete the default assistant?

**2. Graph Loading:**
- Does Agent Server validate graph code before creating default assistants?
- What happens if graph code has errors—does deployment fail?
- Can you hot-reload graph code without restarting the server?

**3. Version Management:**
- Is there a maximum number of versions retained?
- Can you delete individual versions (documentation says no, but might change)?
- What happens to running executions when you change the active version?

**4. Persistence Details:**
- Where exactly are assistants stored (separate table from threads/runs)?
- What's the schema for assistant storage?
- Are context/config fields JSON blobs or structured?

### 8.3 Clarifying Questions for Follow-up

1. **Default Assistant Lifecycle:**
   - If we delete a default assistant, does Agent Server auto-recreate it?
   - Is there an API to explicitly get the default assistant_id for a graph_id?

2. **Graph Registry:**
   - Does Agent Server support dynamic graph registration (without editing langgraph.json)?
   - Can we have multiple versions of a graph itself (not just assistant configs)?

3. **Storage Schema:**
   - What's the exact database schema for assistants in PostgreSQL checkpointer?
   - Are graph_id references enforced at the database level?

4. **Runtime Behavior:**
   - If a graph_id is used in a run but doesn't exist, what error is returned?
   - Can you update a graph's code and have it affect existing assistants immediately?

5. **Multi-tenancy:**
   - How do auth filters work with assistants?
   - Can different users see different sets of assistants for the same graph?

---

## 9. References

### Official Documentation

1. [Assistants - Docs by LangChain](https://docs.langchain.com/langsmith/assistants)
   - Core assistants concepts, versioning, execution model

2. [Manage Assistants - Docs by LangChain](https://docs.langchain.com/langsmith/configuration-cloud)
   - Creating, updating, versioning assistants via SDK and UI

3. [Application Structure - Docs by LangChain](https://docs.langchain.com/oss/python/langgraph/application-structure)
   - langgraph.json structure, file organization, configuration reference

4. [Create Assistant - API Reference](https://docs.langchain.com/langsmith/agent-server-api/assistants/create-assistant)
   - POST /assistants endpoint, request/response schema, if_exists parameter

5. [Patch Assistant - API Reference](https://docs.langchain.com/langsmith/agent-server-api/assistants/patch-assistant)
   - PATCH /assistants/{assistant_id} endpoint, versioning behavior

6. [Delete Assistant - API Reference](https://docs.langchain.com/langsmith/agent-server-api/assistants/delete-assistant)
   - DELETE /assistants/{assistant_id} endpoint, delete_threads parameter

7. [Persistence - Docs by LangChain](https://docs.langchain.com/oss/python/langgraph/persistence)
   - Checkpointers, threads, state persistence across restarts

8. [LangGraph Platform API Reference](https://langchain-ai.github.io/langgraph/cloud/reference/api/api_ref.html)
   - Complete API reference (note: some URLs returned 404, docs moved to docs.langchain.com)

### SDK References

9. [langgraph-sdk · PyPI](https://pypi.org/project/langgraph-sdk/)
   - Python SDK for interacting with LangGraph Platform

10. [LangGraph Reference - Python](https://reference.langchain.com/python/langgraph/overview)
    - Python API reference for LangGraph library

### Community Resources

11. [Thread ID and Assistant IDs help - LangChain Forum](https://forum.langchain.com/t/thread-id-and-assistant-ids-help/646)
    - Community discussion on graph_id vs assistant_id usage

12. [How to create Assistants without using client side SDK? - GitHub Discussion](https://github.com/langchain-ai/langgraph/discussions/4404)
    - Discussion on assistant creation approaches

13. [LangGraph Explained (2026 Edition) - Medium](https://medium.com/@dewasheesh.rana/langgraph-explained-2026-edition-ea8f725abff3)
    - Current overview of LangGraph architecture and features

14. [LangGraph Persistence Guide (2025) - Fast.io](https://fast.io/resources/langgraph-persistence/)
    - Deep dive on persistence mechanisms

### Additional Resources

15. [Agent Server Changelog - Docs by LangChain](https://docs.langchain.com/langsmith/agent-server-changelog)
    - Version history and feature updates

16. [LangGraph Platform](https://www.langchain.com/langgraph-platform)
    - Marketing/overview page for LangGraph Platform

17. [How to build an AI Assistant with LangGraph and Next.js](https://auth0.com/blog/genai-tool-calling-build-agent-that-calls-calender-with-langgraph-nextjs/)
    - Practical tutorial showing assistant usage

18. [GitHub - langchain-ai/langgraph](https://github.com/langchain-ai/langgraph)
    - Official LangGraph repository

---

## 10. Implications for lg-api Implementation

### 10.1 Key Takeaways

1. **Auto-Registration Model:**
   - lg-api should support declaring graphs in a config file (agent-registry.yaml ✓)
   - On startup, auto-create default assistants for each registered graph
   - Store assistant → graph_id mapping persistently

2. **Graph ID Aliasing:**
   - Allow using graph_id in place of assistant_id in API calls
   - Resolve graph_id → default assistant_id internally
   - Keep backward compatibility with direct assistant_id usage

3. **Versioning:**
   - Every PATCH /assistants should create a new version
   - Track active version per assistant
   - Support rollback via POST /assistants/{id}/latest

4. **if_exists Parameter:**
   - Implement in POST /assistants
   - Support "raise" and "do_nothing" behaviors
   - Enable idempotent creation

5. **Storage Requirements:**
   - Assistants must persist across restarts (already supported via storage layer ✓)
   - Store: graph_id, config, context, metadata, version, timestamps
   - Support assistant deletion with optional thread cascade

6. **Default Assistant Behavior:**
   - Generate UUID for default assistants (not deterministic)
   - Allow deletion of default assistants
   - When graph_id used in run, lookup current default assistant

### 10.2 Recommended Changes to lg-api

**Current State:**
- ✅ agent-registry.yaml for graph declaration
- ✅ Storage layer with multiple backends
- ✅ Assistants CRUD operations
- ✅ graph_id field in assistant entity

**Gaps to Fill:**
1. **Auto-create default assistants on startup** (currently requires explicit POST /assistants)
2. **Graph ID aliasing** in run creation endpoints
3. **Assistant versioning** (currently no version tracking)
4. **if_exists parameter** in POST /assistants
5. **SET_LATEST version endpoint** (POST /assistants/{id}/latest)
6. **delete_threads parameter** in DELETE /assistants

**Priority Order:**
1. High: Auto-create default assistants from agent-registry.yaml
2. High: Graph ID aliasing in POST /threads/{id}/runs
3. Medium: Assistant versioning system
4. Medium: if_exists parameter
5. Low: Set latest version endpoint (can use PATCH for now)
6. Low: delete_threads cascade deletion

---

**End of Investigation**
