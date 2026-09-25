# lg-agent-sdk-ts

A minimal TypeScript library that handles the agent protocol for [lg-api](../../README.md). Supports both **CLI** (stdin/stdout) and **HTTP** (API server) modes. You provide a handler function — it takes care of the rest.

## Prerequisites

- Node.js v18+
- TypeScript 5+
- `tsx` (optional — for running .ts files directly during development)

## Install

### Option 1: Local tarball

Build the SDK once, then install the tarball in any project:

```bash
# Build and pack (from the agent-template directory)
cd agents/agent-template
npm install
npm run build
npm pack                # produces lg-agent-sdk-1.0.0.tgz

# Install in your agent project
cd /path/to/your-agent
npm install /path/to/lg-agent-sdk-1.0.0.tgz
```

### Option 2: npm link (for development)

```bash
# Register the SDK globally
cd agents/agent-template
npm install
npm run build
npm link

# Link it into your agent project
cd /path/to/your-agent
npm link lg-agent-sdk
```

### Option 3: npm registry (when published)

```bash
npm install lg-agent-sdk
```

## Usage

The SDK exposes two runner functions that share the same `AgentHandler` signature, plus a streaming variant of the HTTP runner (since 1.1.0):

| Function | Mode | Transport |
|----------|------|-----------|
| `runAgent(handler)` | CLI | stdin/stdout JSON |
| `runAgentHttp(handler, options?)` | HTTP | POST endpoint returning JSON |
| `runAgentHttpStreaming(handler, options?)` | HTTP | Same endpoint; NDJSON progress stream when lg-api asks for it, otherwise the same JSON as `runAgentHttp` |

### CLI mode — `runAgent`

Create an entrypoint file in your project:

```ts
import { runAgent, type AgentRequest, type AgentResponse } from "lg-agent-sdk-ts";

runAgent(async (request: AgentRequest): Promise<AgentResponse> => {
  // request.messages  — conversation history
  // request.documents — optional attached documents
  // request.state     — state carried across runs in the same thread
  // request.metadata  — optional metadata from the caller

  return {
    thread_id: request.thread_id,
    run_id: request.run_id,
    messages: [{ role: "assistant", content: "Hello from my agent" }],
    state: { ...request.state, myKey: "computed value" },
  };
});
```

Then register it in `agent-registry.yaml`:

```yaml
# Development (tsx, no build step)
my-agent:
  command: npx
  args: ["tsx", "path/to/my-entrypoint.ts"]
  cwd: "."
  description: "My custom agent"
  timeout: 60000

# Production (pre-compiled)
my-agent:
  command: node
  args: ["path/to/dist/my-entrypoint.js"]
  cwd: "."
  description: "My custom agent"
  timeout: 60000
```

### HTTP mode — `runAgentHttp`

Swap `runAgent` for `runAgentHttp` — the handler stays the same:

```ts
import { runAgentHttp, type AgentRequest, type AgentResponse } from "lg-agent-sdk-ts";

runAgentHttp(async (request: AgentRequest): Promise<AgentResponse> => {
  return {
    thread_id: request.thread_id,
    run_id: request.run_id,
    messages: [{ role: "assistant", content: "Hello from my agent" }],
    state: { ...request.state, myKey: "computed value" },
  };
});
```

This starts an HTTP server with two endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/invoke` | Receives `AgentRequest` JSON, returns `AgentResponse` JSON |
| `GET` | `/health` | Returns `{ "status": "ok" }` |

#### Options

`runAgentHttp` accepts an optional second argument:

```ts
interface HttpRunnerOptions {
  port?: number;   // default: PORT env var or 4000
  host?: string;   // default: "0.0.0.0"
  path?: string;   // default: "/invoke"
}
```

```ts
runAgentHttp(handler, { port: 5000, path: "/run" });
```

#### agent-registry.yaml

Register as an `api` type agent:

```yaml
my-agent:
  type: api
  url: "http://localhost:4000/invoke"
  method: POST
  description: "My custom agent (HTTP)"
  timeout: 120000
```

The lg-api `ApiAgentConnector` sends a POST with the `AgentRequest` JSON body and expects an `AgentResponse` JSON response.

### Streaming HTTP mode — `runAgentHttpStreaming` (1.1.0+)

Use it when the agent should show progress (status lines) while a turn runs on lg-api `/runs/stream`. The handler gets a second argument, `emit`:

```ts
import { runAgentHttpStreaming, type AgentEmitter, type AgentRequest, type AgentResponse } from "lg-agent-sdk-ts";

runAgentHttpStreaming(async (request: AgentRequest, emit: AgentEmitter): Promise<AgentResponse> => {
  emit.progress({ type: "status", text: "Looking up your order…", stage: "validating_step" });
  const result = await doTheWork(request);            // your agent
  emit.progress({ type: "status", text: "Preparing the reply…" });
  return result;                                      // the final AgentResponse, as with runAgentHttp
});
```

Registration in `agent-registry.yaml` is the same as for `runAgentHttp` (`type: api`); no extra flag is needed. lg-api's `/runs/stream` is always live and asks every API agent for NDJSON:

```yaml
  my-agent-http:
    type: api
    url: "http://localhost:4000/invoke"
```

**It is opt-in per request, and the wait path is untouched.**

| lg-api path | Request `Accept` | What the runner sends |
|-------------|------------------|-----------------------|
| `/runs/wait`, background runs, older lg-api | not NDJSON | The plain JSON `AgentResponse`, byte for byte what `runAgentHttp` sends. Every `emit` call is a no-op, and `emit.streaming` is `false` |
| `/runs/stream` | `application/x-ndjson` | `200 application/x-ndjson`. Headers are flushed at once, then one JSON event per line |

The NDJSON events (`AgentWireEvent`):

```text
{"event":"progress","data":{...}}                     emit.progress(data); lg-api forwards it unchanged as SSE `custom`
{"event":"token","data":{"id","delta","source"}}      emit.token(delta, source?, id?)
{"event":"replace","data":{"id","content","reason"}}  emit.replace(content, reason?, id?)
{"event":"final","data":AgentResponse}                exactly once, last
{"event":"error","data":{"message"}}                  instead of `final` when the handler throws
```

When the handler returns, the runner reconciles the reply text for `emit.messageId`:
- If nothing was streamed, the whole reply goes out as one `token` with `source: "final"`.
- If the reply extends the streamed text, the missing suffix goes out with `source: "reconcile"`.
- Otherwise, a `replace` carries the final text.

On this path the runner also stamps `id = emit.messageId` on the reply message, so streamed chunks and the saved message share an id. lg-api types the final reply out word by word itself (`LG_API_TYPEWRITER`), so an agent that only calls `emit.progress` still gets a typed reply.

`emit.signal` is aborted only on the NDJSON path, and only if lg-api drops the upstream connection: on its agent timeout, or on an explicit run cancel. A browser disconnecting never aborts it, because lg-api keeps the run going and saves its result. On the JSON path (`/runs/wait`) it never aborts, so the handler always runs to completion, exactly as under `runAgentHttp`.

`runAgentHttpStreaming` returns the listening `http.Server`, so tests can close it.

## What it does

### `runAgent(handler)` — CLI mode

1. Redirects `console.log` to stderr (so library code that logs doesn't corrupt the stdout JSON)
2. Reads a JSON `AgentRequest` from **stdin**
3. Validates required fields (`thread_id`, `run_id`, `assistant_id`, `messages`)
4. Calls your `handler` function with the parsed request
5. Writes the returned `AgentResponse` as JSON to **stdout**
6. Exits with code 0 on success, 1 on error (with the error message on stderr)

### `runAgentHttp(handler, options?)` — HTTP mode

1. Starts an HTTP server on the configured port
2. On `POST /invoke`: parses the JSON body as `AgentRequest`, validates required fields, calls your `handler`, and returns the `AgentResponse` as JSON (200 on success, 500 on error)
3. On `GET /health`: returns `{ "status": "ok" }`
4. Returns 404 for all other routes

### `runAgentHttpStreaming(handler, options?)` — streaming HTTP mode

Same routes, options, validation and error responses as `runAgentHttp`. The one difference: when the request's `Accept` header contains `application/x-ndjson`, it answers with the NDJSON event stream described above instead of one JSON body.

## Types

```ts
interface AgentMessage {
  role: "user" | "assistant" | "system";
  content: string;
  response_metadata?: Record<string, unknown>;
}

interface AgentDocument {
  id: string;
  title?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

interface AgentRequest {
  thread_id: string;
  run_id: string;
  assistant_id: string;
  messages: AgentMessage[];
  documents?: AgentDocument[];
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface AgentResponse {
  thread_id: string;
  run_id: string;
  messages: AgentMessage[];
  state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// Streaming (1.1.0+)
type StreamingAgentHandler = (request: AgentRequest, emit: AgentEmitter) => Promise<AgentResponse>;

interface AgentEmitter {
  readonly streaming: boolean;   // false → every method is a no-op
  readonly messageId: string;    // id the reply carries on the NDJSON path
  readonly signal: AbortSignal;  // NDJSON only: aborted when lg-api drops the upstream connection
  progress(data: Record<string, unknown>): void;
  token(delta: string, source?: string, id?: string): void;
  replace(content: string, reason?: string, id?: string): void;
  streamedText(id?: string): string;
}

type AgentWireEvent =
  | { event: "progress"; data: Record<string, unknown> }
  | { event: "token"; data: { id: string; delta: string; source?: string } }
  | { event: "replace"; data: { id: string; content: string; reason?: string } }
  | { event: "final"; data: AgentResponse }
  | { event: "error"; data: { message: string } };
```

## Protocol contract

Your agent can be written in any language as long as it follows this contract:

| Requirement | Detail |
|-------------|--------|
| Input | Single JSON object on stdin |
| Output | Single JSON object on stdout |
| Errors | Write to stderr only, never stdout |
| Exit code | 0 = success, non-zero = failure |
| Required response fields | `thread_id`, `run_id`, `messages` (array) |
| Timeout | Configured per-agent in `agent-registry.yaml` |

This library implements the contract for TypeScript — for other languages, follow the same protocol.

## HTTP protocol contract

When using `runAgentHttp`, the agent acts as an HTTP server compatible with the lg-api `ApiAgentConnector`:

| Requirement | Detail |
|-------------|--------|
| Input | JSON `AgentRequest` body on `POST /invoke` |
| Output | JSON `AgentResponse` body (200) |
| Errors | JSON `{ "error": "message" }` (500) |
| Required response fields | `thread_id`, `run_id`, `messages` (array) |
| Health check | `GET /health` → `{ "status": "ok" }` |
| Timeout | Configured per-agent in `agent-registry.yaml` (enforced by lg-api via `AbortSignal`) |
