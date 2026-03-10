# Refined Request: LLM Invocation Metadata Capture and Storage

## Request ID
REQ-005

## Date
2026-03-10

## Original Request
> "I want you to change the passthrough agent to return the LLM invocation metadata. The lg-api must capture these metadata and store them in the thread as response metadata in each message."

---

## Objective

Extend the agent protocol so that CLI agents can return per-message LLM invocation metadata (model, token usage, finish reason, latency, etc.). The lg-api must capture this metadata from the `AgentResponse` and persist it alongside each assistant message stored in the thread state.

---

## Scope

| Component | Change Type | Files |
|-----------|------------|-------|
| Passthrough agent | Modified | `agents/passthrough/src/agent.ts`, `agents/passthrough/src/types.ts` |
| lg-api shared types | Modified | `src/agents/types.ts` |
| lg-api runs service | Modified | `src/modules/runs/runs.service.ts` (specifically `updateThreadState` and `wait` methods) |

---

## Detailed Specification

### 1. LLM Metadata Fields

The following metadata fields must be captured from the LangChain `AIMessageChunk` / `AIMessage` response object. All fields are optional to accommodate varying LLM providers.

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
```

**Rationale for each field:**
- `model` -- Enables auditing which model version actually served the request (providers can route to different versions).
- `usage` -- Essential for cost tracking and quota management.
- `finish_reason` -- Indicates whether the response was complete or truncated.
- `latency_ms` -- Measured by the agent (start-to-finish of the LLM call), useful for performance monitoring.
- `provider` -- Disambiguates when the same model name exists across providers.
- `provider_response_id` -- Enables correlation with provider-side logs for debugging.

### 2. Agent Message Interface Changes

#### 2.1 Passthrough Agent Types (`agents/passthrough/src/types.ts`)

Add `LlmResponseMetadata` interface and extend `Message`:

```typescript
export interface LlmResponseMetadata {
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  finish_reason?: string;
  latency_ms?: number;
  provider?: string;
  provider_response_id?: string;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** LLM invocation metadata -- present only on assistant messages returned by agents */
  response_metadata?: LlmResponseMetadata;
}
```

#### 2.2 lg-api Shared Types (`src/agents/types.ts`)

Mirror the same changes in the shared `AgentMessage` interface:

```typescript
export interface LlmResponseMetadata {
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  finish_reason?: string;
  latency_ms?: number;
  provider?: string;
  provider_response_id?: string;
}

export interface AgentMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** LLM invocation metadata -- present only on assistant messages returned by agents */
  response_metadata?: LlmResponseMetadata;
}
```

### 3. Passthrough Agent Changes (`agents/passthrough/src/agent.ts`)

The `runAgent` function must:

1. Record `Date.now()` before invoking `model.invoke()`.
2. Record `Date.now()` after the invocation completes.
3. Extract metadata from the LangChain `AIMessage` result object:
   - `result.response_metadata?.model` or `result.response_metadata?.model_name` (varies by provider)
   - `result.response_metadata?.finish_reason` or `result.response_metadata?.stop_reason`
   - `result.usage_metadata?.input_tokens` (maps to `prompt_tokens`)
   - `result.usage_metadata?.output_tokens` (maps to `completion_tokens`)
   - `result.usage_metadata?.total_tokens`
   - `result.response_metadata?.id` (provider response ID)
4. Compute `latency_ms` as the difference between the two timestamps.
5. Populate the `response_metadata` field on the assistant message.
6. Set `provider` from the loaded `LlmConfig.provider` value -- this requires passing the provider string into `runAgent` or the config object.

**LangChain metadata extraction notes:**
- LangChain's `AIMessage` exposes `response_metadata` (a dict with provider-specific keys) and `usage_metadata` (a structured object with `input_tokens`, `output_tokens`, `total_tokens`).
- The field names vary by provider. The agent should use safe optional chaining and normalize into the `LlmResponseMetadata` shape.
- Azure OpenAI: `response_metadata.model`, `response_metadata.finish_reason`, `usage_metadata.*`
- OpenAI: Same as Azure OpenAI.
- Anthropic: `response_metadata.stop_reason` (maps to `finish_reason`), `response_metadata.model`, `response_metadata.id`, `usage_metadata.*`
- Google: `response_metadata.finishReason`, `usage_metadata.*`

**Updated function signature:**

```typescript
export async function runAgent(
  model: BaseChatModel,
  request: AgentRequest,
  provider: string,   // NEW: pass provider name for metadata
): Promise<AgentResponse>
```

The caller in `index.ts` must pass `llmConfig.provider` as the third argument.

### 4. lg-api Thread State Storage Changes (`src/modules/runs/runs.service.ts`)

#### 4.1 `updateThreadState` Method

Currently, response messages are mapped as:

```typescript
const responseMessages = agentResponse.messages.map((m) => ({
  type: m.role === 'assistant' ? 'ai' : m.role === 'user' ? 'human' : 'system',
  content: m.content,
}));
```

This must be extended to include `response_metadata` when present:

```typescript
const responseMessages = agentResponse.messages.map((m) => ({
  type: m.role === 'assistant' ? 'ai' : m.role === 'user' ? 'human' : 'system',
  content: m.content,
  ...(m.response_metadata ? { response_metadata: m.response_metadata } : {}),
}));
```

#### 4.2 `wait` Method

The `wait` method also maps response messages (around line 500-505). Apply the same pattern:

```typescript
messages: agentResponse.messages.map((m) => ({
  type: m.role === 'assistant' ? 'ai' : m.role === 'user' ? 'human' : 'system',
  content: m.content,
  id: generateId(),
  ...(m.response_metadata ? { response_metadata: m.response_metadata } : {}),
})),
```

### 5. Backward Compatibility

- The `response_metadata` field is **optional** on `AgentMessage` / `Message`. Agents that do not return metadata will continue to work unchanged.
- The lg-api only includes `response_metadata` in the stored message when it is present (spread with conditional).
- No schema validation changes are required for incoming agent responses -- the field is simply passed through if present.
- Existing thread state data (messages without `response_metadata`) remains valid.
- The `AgentRequest` interface is unchanged.

### 6. Data Flow Summary

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

4. Thread State (persisted)
   - Each assistant message in values.messages[] now optionally carries response_metadata
   - Accessible via GET /threads/:id/state and POST /threads/:id/history
```

### 7. Example Stored Message (After)

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

### 8. Testing Requirements

- **Unit test**: Verify that `runAgent` populates `response_metadata` on the assistant message by mocking a LangChain chat model that returns known `response_metadata` and `usage_metadata`.
- **Unit test**: Verify that `updateThreadState` preserves `response_metadata` when present on agent messages.
- **Unit test**: Verify that `updateThreadState` works correctly when `response_metadata` is absent (backward compatibility).
- **Integration test**: End-to-end test with the passthrough agent verifying that `GET /threads/:id/state` returns messages with `response_metadata` populated.

### 9. Non-Goals

- This request does **not** cover aggregating metadata across runs (e.g., cumulative token usage per thread).
- This request does **not** modify the SSE streaming event format -- metadata is only persisted in thread state, not streamed as a separate event.
- This request does **not** add metadata to user or system messages, only to assistant messages produced by the LLM.

---

## Implementation Order

1. Add `LlmResponseMetadata` interface to `agents/passthrough/src/types.ts` and extend `Message`.
2. Update `agents/passthrough/src/agent.ts` to extract metadata from the LangChain response and measure latency.
3. Update `agents/passthrough/src/index.ts` to pass provider to `runAgent`.
4. Add `LlmResponseMetadata` interface to `src/agents/types.ts` and extend `AgentMessage`.
5. Update `src/modules/runs/runs.service.ts` -- `updateThreadState` and `wait` methods.
6. Write tests.
7. Update `CLAUDE.md` tool documentation for passthrough agent (output format section).
