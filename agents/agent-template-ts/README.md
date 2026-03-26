# lg-agent-sdk-ts

A minimal TypeScript library that handles the stdin/stdout JSON protocol for [lg-api](../../README.md) CLI agents. You provide a handler function — it takes care of the rest.

## Prerequisites

- Node.js v18+
- TypeScript 5+
- `tsx` (for running .ts files directly)

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

Create an entrypoint file in your project:

```ts
import { runAgent, type AgentRequest, type AgentResponse } from "lg-agent-sdk";

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
my-agent:
  command: npx
  args: ["tsx", "path/to/my-entrypoint.ts"]
  cwd: "."
  description: "My custom agent"
  timeout: 60000
```

## What it does

`runAgent(handler)` is the entire API. It:

1. Redirects `console.log` to stderr (so library code that logs doesn't corrupt the stdout JSON)
2. Reads a JSON `AgentRequest` from **stdin**
3. Validates required fields (`thread_id`, `run_id`, `assistant_id`, `messages`)
4. Calls your `handler` function with the parsed request
5. Writes the returned `AgentResponse` as JSON to **stdout**
6. Exits with code 0 on success, 1 on error (with the error message on stderr)

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
