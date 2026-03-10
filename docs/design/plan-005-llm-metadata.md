# Plan 005: LLM Invocation Metadata Capture and Storage

**Date:** 2026-03-11
**Request:** REQ-005
**Status:** Draft

---

## Objective

Extend the agent protocol so that CLI agents can return per-message LLM invocation metadata (model, token usage, finish reason, latency, provider). The lg-api must capture this metadata from the `AgentResponse` and persist it alongside each assistant message stored in the thread state.

---

## Implementation Units

Two independent units that can be developed and tested in parallel.

---

### Unit A: Passthrough Agent -- Capture and Return LLM Metadata

**Goal:** Modify the passthrough agent to extract LLM invocation metadata from the LangChain `AIMessage` response and include it in the `AgentResponse` output.

#### Files Changed

| File | Change |
|------|--------|
| `agents/passthrough/src/types.ts` | Add `LlmResponseMetadata` interface; add optional `response_metadata` field to `Message` |
| `agents/passthrough/src/agent.ts` | Measure latency around `model.invoke()`; extract `response_metadata` and `usage_metadata` from the LangChain `AIMessage`; populate `response_metadata` on the assistant message; accept `provider` as a new parameter |
| `agents/passthrough/src/index.ts` | Pass `llmConfig.provider` as third argument to `runAgent()` |

#### Design: `agents/passthrough/src/types.ts`

Add the following new interface and extend `Message`:

```typescript
/**
 * Metadata from a single LLM invocation, attached to the response message.
 */
export interface LlmResponseMetadata {
  /** The model identifier as reported by the provider (e.g., "gpt-4o", "claude-3-opus") */
  model?: string;

  /** Token usage breakdown */
  usage?: {
    /** Number of tokens in the prompt */
    prompt_tokens?: number;
    /** Number of tokens in the completion */
    completion_tokens?: number;
    /** Total tokens consumed (prompt + completion) */
    total_tokens?: number;
  };

  /** Why the model stopped generating (e.g., "stop", "length", "content_filter") */
  finish_reason?: string;

  /** Wall-clock latency of the LLM call in milliseconds */
  latency_ms?: number;

  /** The LLM provider that served the request (e.g., "azure-openai", "openai", "anthropic", "google") */
  provider?: string;

  /** Provider-specific response ID (e.g., OpenAI's response id) */
  provider_response_id?: string;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** LLM invocation metadata -- present only on assistant messages returned by agents */
  response_metadata?: LlmResponseMetadata;
}
```

#### Design: `agents/passthrough/src/agent.ts`

**Updated function signature:**

```typescript
export async function runAgent(
  model: BaseChatModel,
  request: AgentRequest,
  provider: string,
): Promise<AgentResponse>
```

**Implementation approach:**

1. Record `startTime = Date.now()` before calling `model.invoke()`.
2. Call `model.invoke(langChainMessages)` and capture the `AIMessage` result.
3. Record `endTime = Date.now()` after the call completes.
4. Extract metadata from the LangChain result using safe optional chaining, normalizing across providers:

```typescript
// Extract metadata from LangChain AIMessage
const responseMeta = result.response_metadata as Record<string, unknown> | undefined;
const usageMeta = result.usage_metadata as Record<string, unknown> | undefined;

const llmMetadata: LlmResponseMetadata = {
  model: (responseMeta?.['model_name'] ?? responseMeta?.['model']) as string | undefined,
  usage: usageMeta
    ? {
        prompt_tokens: (usageMeta['input_tokens'] as number | undefined),
        completion_tokens: (usageMeta['output_tokens'] as number | undefined),
        total_tokens: (usageMeta['total_tokens'] as number | undefined),
      }
    : undefined,
  finish_reason: (
    responseMeta?.['finish_reason'] ??
    responseMeta?.['stop_reason'] ??
    responseMeta?.['finishReason']
  ) as string | undefined,
  latency_ms: endTime - startTime,
  provider,
  provider_response_id: (responseMeta?.['id'] ?? responseMeta?.['system_fingerprint']) as string | undefined,
};
```

5. Attach `response_metadata: llmMetadata` to the assistant message in the returned `AgentResponse`.

**Provider metadata field mapping:**

| Field | Azure OpenAI / OpenAI | Anthropic | Google |
|-------|----------------------|-----------|--------|
| model | `response_metadata.model_name` or `.model` | `response_metadata.model` | `response_metadata.model` |
| finish_reason | `response_metadata.finish_reason` | `response_metadata.stop_reason` | `response_metadata.finishReason` |
| usage (prompt) | `usage_metadata.input_tokens` | `usage_metadata.input_tokens` | `usage_metadata.input_tokens` |
| usage (completion) | `usage_metadata.output_tokens` | `usage_metadata.output_tokens` | `usage_metadata.output_tokens` |
| usage (total) | `usage_metadata.total_tokens` | `usage_metadata.total_tokens` | `usage_metadata.total_tokens` |
| provider_response_id | `response_metadata.system_fingerprint` | `response_metadata.id` | N/A |

#### Design: `agents/passthrough/src/index.ts`

Change the `runAgent` call from:

```typescript
const response = await runAgent(model, request);
```

To:

```typescript
const response = await runAgent(model, request, llmConfig.provider);
```

---

### Unit B: lg-api Types and Service -- Receive and Store LLM Metadata

**Goal:** Extend the shared `AgentMessage` type with an optional `response_metadata` field, and update the runs service to persist this metadata in thread state.

#### Files Changed

| File | Change |
|------|--------|
| `src/agents/types.ts` | Add `LlmResponseMetadata` interface; add optional `response_metadata` field to `AgentMessage` |
| `src/modules/runs/runs.service.ts` | Update `updateThreadState()` and `wait()` to include `response_metadata` when mapping agent messages to stored messages |

#### Design: `src/agents/types.ts`

Add the following new interface before `AgentMessage`:

```typescript
/**
 * Metadata from a single LLM invocation, attached to the response message.
 */
export interface LlmResponseMetadata {
  /** The model identifier as reported by the provider */
  model?: string;

  /** Token usage breakdown */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };

  /** Why the model stopped generating */
  finish_reason?: string;

  /** Wall-clock latency of the LLM call in milliseconds */
  latency_ms?: number;

  /** The LLM provider that served the request */
  provider?: string;

  /** Provider-specific response ID */
  provider_response_id?: string;
}
```

Extend `AgentMessage`:

```typescript
export interface AgentMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** LLM invocation metadata -- present only on assistant messages returned by agents */
  response_metadata?: LlmResponseMetadata;
}
```

#### Design: `src/modules/runs/runs.service.ts`

**`updateThreadState()` method (line ~737):**

Change message mapping from:

```typescript
const responseMessages = agentResponse.messages.map((m) => ({
  type: m.role === 'assistant' ? 'ai' : m.role === 'user' ? 'human' : 'system',
  content: m.content,
}));
```

To:

```typescript
const responseMessages = agentResponse.messages.map((m) => ({
  type: m.role === 'assistant' ? 'ai' : m.role === 'user' ? 'human' : 'system',
  content: m.content,
  ...(m.response_metadata ? { response_metadata: m.response_metadata } : {}),
}));
```

**`wait()` method (line ~500):**

Change the result messages mapping from:

```typescript
messages: agentResponse.messages.map((m) => ({
  type: m.role === 'assistant' ? 'ai' : m.role === 'user' ? 'human' : 'system',
  content: m.content,
  id: generateId(),
})),
```

To:

```typescript
messages: agentResponse.messages.map((m) => ({
  type: m.role === 'assistant' ? 'ai' : m.role === 'user' ? 'human' : 'system',
  content: m.content,
  id: generateId(),
  ...(m.response_metadata ? { response_metadata: m.response_metadata } : {}),
})),
```

---

## Backward Compatibility

- `response_metadata` is **optional** on both `Message` (agent) and `AgentMessage` (lg-api). Agents that do not return metadata continue to work unchanged.
- The lg-api only includes `response_metadata` in stored messages when present (conditional spread).
- No schema validation changes needed for incoming agent responses -- the field passes through.
- Existing thread state data (messages without `response_metadata`) remains valid.
- The `AgentRequest` interface is unchanged.

---

## Data Flow

```
1. Passthrough Agent
   - Calls model.invoke(messages)
   - Extracts response_metadata + usage_metadata from AIMessage
   - Measures latency_ms (wall clock)
   - Attaches LlmResponseMetadata to the assistant Message
   - Returns AgentResponse with enriched messages on stdout

2. lg-api CliAgentConnector
   - Reads AgentResponse JSON from stdout (no changes needed)
   - response_metadata passes through as part of messages[]

3. lg-api RunsService.updateThreadState()
   - Maps agent messages to thread state messages
   - Includes response_metadata in stored message objects

4. lg-api RunsService.wait()
   - Maps agent messages to result messages
   - Includes response_metadata in result message objects

5. Thread State (persisted)
   - Each assistant message in values.messages[] optionally carries response_metadata
   - Accessible via GET /threads/:id/state and POST /threads/:id/history
```

---

## Example Stored Message (After)

```json
{
  "type": "ai",
  "content": "The answer is 42.",
  "response_metadata": {
    "model": "gpt-4o-2024-08-06",
    "usage": {
      "prompt_tokens": 25,
      "completion_tokens": 8,
      "total_tokens": 33
    },
    "finish_reason": "stop",
    "latency_ms": 1230,
    "provider": "azure-openai",
    "provider_response_id": "chatcmpl-abc123"
  }
}
```

---

## Testing Requirements

| Test | Type | Unit |
|------|------|------|
| `runAgent` populates `response_metadata` on assistant message (mock LangChain model) | Unit | A |
| `runAgent` measures `latency_ms` correctly | Unit | A |
| `runAgent` handles missing `usage_metadata` gracefully | Unit | A |
| `updateThreadState` preserves `response_metadata` when present | Unit | B |
| `updateThreadState` works correctly when `response_metadata` is absent | Unit | B |
| `wait()` includes `response_metadata` in result messages | Unit | B |
| End-to-end: `GET /threads/:id/state` returns messages with `response_metadata` | Integration | A+B |

---

## Non-Goals

- Aggregating metadata across runs (e.g., cumulative token usage per thread)
- Modifying the SSE streaming event format
- Adding metadata to user or system messages

---

## Revision History

| Date | Version | Description |
|------|---------|-------------|
| 2026-03-11 | 1.0 | Initial plan |
