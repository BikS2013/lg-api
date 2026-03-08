# LG-API - curl Command Reference

**Base URL**: `http://localhost:8123`
**Auth Header**: `X-Api-Key: your-api-key-here` (required when `LG_API_AUTH_ENABLED=true`)

All examples use `$BASE` and `$KEY` variables. Set them first:

```bash
BASE=http://localhost:8123
KEY=your-api-key-here
```

---

## System

### Health Check

```bash
curl -s $BASE/ok
```

### Server Info

```bash
curl -s -H "X-Api-Key: $KEY" $BASE/info
```

### Swagger UI

Open in browser: `http://localhost:8123/docs`

---

## Assistants

### Create Assistant

```bash
curl -s -X POST $BASE/assistants \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "graph_id": "my-graph",
    "name": "My Assistant",
    "description": "A test assistant",
    "metadata": {"env": "dev"}
  }'
```

With custom ID and if_exists behavior:

```bash
curl -s -X POST $BASE/assistants \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "graph_id": "my-graph",
    "name": "My Assistant",
    "assistant_id": "550e8400-e29b-41d4-a716-446655440000",
    "if_exists": "do_nothing"
  }'
```

### Get Assistant

```bash
curl -s -H "X-Api-Key: $KEY" $BASE/assistants/{assistant_id}
```

### Update Assistant

```bash
curl -s -X PATCH $BASE/assistants/{assistant_id} \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "name": "Updated Name",
    "metadata": {"version": "2"}
  }'
```

### Delete Assistant

```bash
curl -s -X DELETE -H "X-Api-Key: $KEY" "$BASE/assistants/{assistant_id}?delete_threads=true"
```

### Search Assistants

```bash
curl -s -X POST $BASE/assistants/search \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "graph_id": "my-graph",
    "limit": 10,
    "offset": 0,
    "sort_by": "created_at",
    "sort_order": "desc"
  }'
```

Search with metadata filter:

```bash
curl -s -X POST $BASE/assistants/search \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "metadata": {"env": "dev"}
  }'
```

### Count Assistants

```bash
curl -s -X POST $BASE/assistants/count \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "graph_id": "my-graph"
  }'
```

### Get Graph Definition

```bash
curl -s -H "X-Api-Key: $KEY" "$BASE/assistants/{assistant_id}/graph?xray=true"
```

### Get Schemas

```bash
curl -s -H "X-Api-Key: $KEY" $BASE/assistants/{assistant_id}/schemas
```

### Get Subgraphs

```bash
curl -s -H "X-Api-Key: $KEY" "$BASE/assistants/{assistant_id}/subgraphs?recurse=true"
```

### List Versions

```bash
curl -s -X POST $BASE/assistants/{assistant_id}/versions \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{"limit": 10, "offset": 0}'
```

### Set Latest Version

```bash
curl -s -X POST $BASE/assistants/{assistant_id}/latest \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{"version": 1}'
```

---

## Threads

### Create Thread

```bash
curl -s -X POST $BASE/threads \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "metadata": {"user": "john"}
  }'
```

With custom ID:

```bash
curl -s -X POST $BASE/threads \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "thread_id": "660e8400-e29b-41d4-a716-446655440000",
    "if_exists": "do_nothing"
  }'
```

### Get Thread

```bash
curl -s -H "X-Api-Key: $KEY" $BASE/threads/{thread_id}
```

### Update Thread

```bash
curl -s -X PATCH $BASE/threads/{thread_id} \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "metadata": {"updated": true}
  }'
```

### Delete Thread

```bash
curl -s -X DELETE -H "X-Api-Key: $KEY" $BASE/threads/{thread_id}
```

### Search Threads

```bash
curl -s -X POST $BASE/threads/search \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "status": "idle",
    "limit": 20,
    "offset": 0,
    "sort_by": "created_at",
    "sort_order": "desc"
  }'
```

### Count Threads

```bash
curl -s -X POST $BASE/threads/count \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{"status": "idle"}'
```

### Copy Thread

```bash
curl -s -X POST $BASE/threads/{thread_id}/copy \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{}'
```

### Prune Threads

```bash
curl -s -X POST $BASE/threads/prune \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "thread_ids": ["{thread_id_1}", "{thread_id_2}"],
    "strategy": "delete"
  }'
```

### Get Thread State

```bash
curl -s -H "X-Api-Key: $KEY" $BASE/threads/{thread_id}/state
```

With subgraphs:

```bash
curl -s -H "X-Api-Key: $KEY" "$BASE/threads/{thread_id}/state?subgraphs=true"
```

### Update Thread State

```bash
curl -s -X POST $BASE/threads/{thread_id}/state \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "values": {"messages": [{"role": "user", "content": "hello"}]},
    "as_node": "input"
  }'
```

### Get Thread History

```bash
curl -s -X POST $BASE/threads/{thread_id}/history \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{"limit": 10}'
```

---

## Runs

### Create Stateful Run (on a thread)

```bash
curl -s -X POST $BASE/threads/{thread_id}/runs \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "assistant_id": "{assistant_id}",
    "input": {"messages": [{"role": "user", "content": "hello"}]},
    "metadata": {"source": "curl"}
  }'
```

### Create Stateless Run

```bash
curl -s -X POST $BASE/runs \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "assistant_id": "{assistant_id}",
    "input": {"messages": [{"role": "user", "content": "hello"}]}
  }'
```

### Stream Stateful Run (SSE)

```bash
curl -s -N -X POST $BASE/threads/{thread_id}/runs/stream \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "assistant_id": "{assistant_id}",
    "input": {"messages": [{"role": "user", "content": "hello"}]},
    "stream_mode": ["values"]
  }'
```

Multiple stream modes:

```bash
curl -s -N -X POST $BASE/threads/{thread_id}/runs/stream \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "assistant_id": "{assistant_id}",
    "input": {"messages": [{"role": "user", "content": "hello"}]},
    "stream_mode": ["values", "updates", "messages"]
  }'
```

### Stream Stateless Run (SSE)

```bash
curl -s -N -X POST $BASE/runs/stream \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "assistant_id": "{assistant_id}",
    "stream_mode": ["values"]
  }'
```

### Wait for Stateful Run

```bash
curl -s -X POST $BASE/threads/{thread_id}/runs/wait \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "assistant_id": "{assistant_id}",
    "input": {"messages": [{"role": "user", "content": "hello"}]}
  }'
```

### Wait for Stateless Run

```bash
curl -s -X POST $BASE/runs/wait \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "assistant_id": "{assistant_id}",
    "input": {"messages": [{"role": "user", "content": "hello"}]}
  }'
```

### Batch Create Runs

```bash
curl -s -X POST $BASE/runs/batch \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '[
    {"assistant_id": "{assistant_id}", "input": {"q": "first"}},
    {"assistant_id": "{assistant_id}", "input": {"q": "second"}}
  ]'
```

### List Runs for a Thread

```bash
curl -s -H "X-Api-Key: $KEY" "$BASE/threads/{thread_id}/runs?limit=10&offset=0"
```

Filter by status:

```bash
curl -s -H "X-Api-Key: $KEY" "$BASE/threads/{thread_id}/runs?status=success"
```

### Get a Specific Run

```bash
curl -s -H "X-Api-Key: $KEY" $BASE/threads/{thread_id}/runs/{run_id}
```

### Cancel a Run

```bash
curl -s -X POST $BASE/threads/{thread_id}/runs/{run_id}/cancel \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{"wait": false, "action": "interrupt"}'
```

### Bulk Cancel Runs

```bash
curl -s -X POST $BASE/runs/cancel \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "thread_id": "{thread_id}",
    "status": "pending",
    "action": "interrupt"
  }'
```

### Join Run (wait for completion)

```bash
curl -s -H "X-Api-Key: $KEY" $BASE/threads/{thread_id}/runs/{run_id}/join
```

### Join Run Stream (SSE)

```bash
curl -s -N -H "X-Api-Key: $KEY" "$BASE/threads/{thread_id}/runs/{run_id}/stream?stream_mode=values"
```

### Delete a Run

```bash
curl -s -X DELETE -H "X-Api-Key: $KEY" $BASE/threads/{thread_id}/runs/{run_id}
```

---

## Crons

### Create Stateful Cron (on a thread)

```bash
curl -s -X POST $BASE/threads/{thread_id}/runs/crons \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "assistant_id": "{assistant_id}",
    "schedule": "*/5 * * * *",
    "input": {"messages": [{"role": "user", "content": "periodic check"}]},
    "metadata": {"type": "scheduled"}
  }'
```

### Create Stateless Cron

```bash
curl -s -X POST $BASE/runs/crons \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "assistant_id": "{assistant_id}",
    "schedule": "0 * * * *",
    "enabled": true
  }'
```

### Update Cron

```bash
curl -s -X PATCH $BASE/runs/crons/{cron_id} \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "schedule": "0 */2 * * *",
    "enabled": false
  }'
```

### Delete Cron

```bash
curl -s -X DELETE -H "X-Api-Key: $KEY" $BASE/runs/crons/{cron_id}
```

### Search Crons

```bash
curl -s -X POST $BASE/runs/crons/search \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "assistant_id": "{assistant_id}",
    "enabled": true,
    "limit": 10
  }'
```

### Count Crons

```bash
curl -s -X POST $BASE/runs/crons/count \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "assistant_id": "{assistant_id}"
  }'
```

---

## Store

### Put Item (create or update)

```bash
curl -s -X PUT $BASE/store/items \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "namespace": ["users", "preferences"],
    "key": "theme",
    "value": {"color": "dark", "fontSize": 14}
  }'
```

With indexing and TTL:

```bash
curl -s -X PUT $BASE/store/items \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "namespace": ["cache", "responses"],
    "key": "query-123",
    "value": {"result": "cached response"},
    "index": true,
    "ttl": 3600
  }'
```

### Get Item

Namespace is passed as a JSON-encoded array string:

```bash
curl -s -H "X-Api-Key: $KEY" "$BASE/store/items?namespace=%5B%22users%22,%22preferences%22%5D&key=theme"
```

Or as a simple string (treated as single namespace component):

```bash
curl -s -H "X-Api-Key: $KEY" "$BASE/store/items?namespace=users&key=theme"
```

### Delete Item

```bash
curl -s -X DELETE $BASE/store/items \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "namespace": ["users", "preferences"],
    "key": "theme"
  }'
```

### Search Items

```bash
curl -s -X POST $BASE/store/items/search \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "namespace_prefix": ["users"],
    "query": "dark",
    "limit": 10,
    "offset": 0
  }'
```

With filter:

```bash
curl -s -X POST $BASE/store/items/search \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "namespace_prefix": ["users"],
    "filter": {"color": "dark"}
  }'
```

### List Namespaces

```bash
curl -s -X POST $BASE/store/namespaces \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{
    "prefix": ["users"],
    "max_depth": 3,
    "limit": 100
  }'
```

---

## Common Patterns

### Pagination

Search/list endpoints return pagination headers:

```bash
curl -s -D - -X POST $BASE/assistants/search \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{"limit": 5, "offset": 10}' 2>&1 | grep -i x-pagination
```

Response headers:
- `X-Pagination-Total`: Total matching items
- `X-Pagination-Offset`: Current offset
- `X-Pagination-Limit`: Current limit

### Authentication Error

```bash
# No key -> 401
curl -s $BASE/info

# Response: {"detail":"Provide a valid API key via the X-Api-Key header"}
```

### Validation Error (422)

```bash
# Missing required field
curl -s -X POST $BASE/assistants \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{}'

# Response: 422 with validation details
```

### Not Found (404)

```bash
curl -s -H "X-Api-Key: $KEY" $BASE/assistants/00000000-0000-0000-0000-000000000000

# Response: {"detail":"Assistant not found"}
```

---

## Full Workflow Example

A complete workflow creating an assistant, thread, and running it:

```bash
# 1. Create assistant
ASSISTANT=$(curl -s -X POST $BASE/assistants \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{"graph_id": "chatbot", "name": "Chat Bot"}')
ASSISTANT_ID=$(echo $ASSISTANT | python3 -c "import sys,json; print(json.load(sys.stdin)['assistant_id'])")
echo "Assistant: $ASSISTANT_ID"

# 2. Create thread
THREAD=$(curl -s -X POST $BASE/threads \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d '{"metadata": {"user": "demo"}}')
THREAD_ID=$(echo $THREAD | python3 -c "import sys,json; print(json.load(sys.stdin)['thread_id'])")
echo "Thread: $THREAD_ID"

# 3. Run with streaming
echo "--- Streaming ---"
curl -s -N -X POST $BASE/threads/$THREAD_ID/runs/stream \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $KEY" \
  -d "{
    \"assistant_id\": \"$ASSISTANT_ID\",
    \"input\": {\"messages\": [{\"role\": \"user\", \"content\": \"hello\"}]},
    \"stream_mode\": [\"values\"]
  }"

# 4. Check thread state
echo -e "\n--- Thread State ---"
curl -s -H "X-Api-Key: $KEY" $BASE/threads/$THREAD_ID/state

# 5. List runs
echo -e "\n--- Runs ---"
curl -s -H "X-Api-Key: $KEY" "$BASE/threads/$THREAD_ID/runs?limit=5"

# 6. Cleanup
curl -s -X DELETE -H "X-Api-Key: $KEY" $BASE/threads/$THREAD_ID
curl -s -X DELETE -H "X-Api-Key: $KEY" $BASE/assistants/$ASSISTANT_ID
echo -e "\nCleaned up."
```
