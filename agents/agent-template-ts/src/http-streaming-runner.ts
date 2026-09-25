/**
 * Streaming variant of runAgentHttp, for lg-api `/runs/stream`.
 *
 * Same routes as runAgentHttp (POST <path>, GET /health). The difference is
 * the handler signature — `(request, emit)` — and the response framing:
 *
 *   - `Accept` contains `application/x-ndjson` (lg-api sends it only on the
 *     `/runs/stream` path) → 200 `application/x-ndjson`, headers flushed
 *     immediately, one AgentWireEvent per line:
 *       {"event":"progress","data":{...}}
 *       {"event":"token","data":{"id","delta","source"}}
 *       {"event":"replace","data":{"id","content","reason"}}
 *       {"event":"final","data":AgentResponse}      (exactly once, last)
 *       {"event":"error","data":{"message"}}        (instead of final)
 *   - anything else (`/runs/wait`, background runs, older lg-api builds) →
 *     the handler still runs, every emit method is a no-op, and the response
 *     is the plain JSON AgentResponse, byte-for-byte what runAgentHttp sends.
 *
 * Reconciliation (the runner's job, not the handler's): for the reply
 * message id handed to the handler as `emit.messageId`, the runner keeps the
 * concatenation of every token it sent. When the final AgentResponse arrives:
 *   - final content starts with the streamed text → the missing suffix is
 *     sent as one more token (source 'reconcile'), or the whole content if
 *     nothing was streamed (source 'final'), so concat(deltas) === content;
 *   - otherwise (a guard rejected the streamed text, a deterministic override
 *     replaced it, …) → a `replace` event carrying the final content.
 * On the NDJSON path the runner stamps `id = emit.messageId` on the final
 * assistant message so clients can correlate the streamed chunks with the
 * persisted message. The JSON path returns the handler's response untouched.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AgentMessage, AgentRequest, AgentResponse, AgentWireEvent } from './types.js';

/** What a streaming handler can send while it runs. */
export interface AgentEmitter {
  /** true when the caller asked for NDJSON; false → every method is a no-op. */
  readonly streaming: boolean;
  /** Id the reply message will carry in the final response (stream correlation). */
  readonly messageId: string;
  /**
   * NDJSON path only: aborted when the upstream (lg-api) connection closes
   * before the response is complete. lg-api closes it only on its agent
   * timeout or an explicit run cancel, never because a browser went away.
   * On the JSON path (`/runs/wait`) it never aborts, so the handler runs to
   * completion exactly as under runAgentHttp.
   */
  readonly signal: AbortSignal;
  /** Opaque progress payload; lg-api forwards it unchanged as a `custom` event. */
  progress(data: Record<string, unknown>): void;
  /** Text delta for message `id` (default: messageId). */
  token(delta: string, source?: string, id?: string): void;
  /** Drop the text streamed so far for `id` and substitute `content`. */
  replace(content: string, reason?: string, id?: string): void;
  /** Text streamed so far for `id` (default: messageId). */
  streamedText(id?: string): string;
}

export type StreamingAgentHandler = (
  request: AgentRequest,
  emit: AgentEmitter,
) => Promise<AgentResponse>;

export interface StreamingHttpRunnerOptions {
  port?: number;
  host?: string;
  path?: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function parseRequest(raw: string): AgentRequest {
  if (!raw.trim()) throw new Error('Empty request body. Expected a JSON AgentRequest.');
  let request: AgentRequest;
  try {
    request = JSON.parse(raw) as AgentRequest;
  } catch {
    throw new Error(`Failed to parse body as JSON: ${raw.substring(0, 200)}`);
  }
  if (!request.thread_id) throw new Error("Missing required field 'thread_id'.");
  if (!request.run_id) throw new Error("Missing required field 'run_id'.");
  if (!request.assistant_id) throw new Error("Missing required field 'assistant_id'.");
  if (!request.messages || request.messages.length === 0) {
    throw new Error("Missing or empty 'messages'.");
  }
  return request;
}

function wantsNdjson(req: IncomingMessage): boolean {
  const accept = String(req.headers['accept'] ?? '');
  return accept.includes('application/x-ndjson');
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function makeEmitter(
  streaming: boolean,
  write: (event: AgentWireEvent) => void,
  signal: AbortSignal,
): AgentEmitter & { reconcile(resp: AgentResponse): void } {
  const messageId = newId();
  const streamed = new Map<string, string>();
  return {
    streaming,
    messageId,
    signal,
    progress(data) {
      if (!streaming) return;
      write({ event: 'progress', data: { t: Date.now(), ...data } });
    },
    token(delta, source, id = messageId) {
      if (!streaming || !delta) return;
      streamed.set(id, (streamed.get(id) ?? '') + delta);
      write({ event: 'token', data: { id, delta, ...(source ? { source } : {}) } });
    },
    replace(content, reason, id = messageId) {
      if (!streaming) return;
      streamed.set(id, content);
      write({ event: 'replace', data: { id, content, ...(reason ? { reason } : {}) } });
    },
    streamedText(id = messageId) {
      return streamed.get(id) ?? '';
    },
    reconcile(resp) {
      if (!streaming) return;
      const reply = [...(resp.messages ?? [])]
        .reverse()
        .find((m: AgentMessage) => m.role === 'assistant') as (AgentMessage & { id?: string }) | undefined;
      if (!reply) return;
      reply.id = messageId;
      const finalText = String(reply.content ?? '');
      const sofar = streamed.get(messageId) ?? '';
      if (finalText.startsWith(sofar)) {
        const suffix = finalText.slice(sofar.length);
        if (suffix) this.token(suffix, sofar ? 'reconcile' : 'final');
      } else {
        this.replace(finalText, 'final_differs');
      }
    },
  };
}

/**
 * Start an HTTP server whose handler can stream progress to lg-api.
 * Register it in agent-registry.yaml exactly like a runAgentHttp agent
 * (`type: api`). Returns the listening server (e.g. to close it in tests).
 */
export function runAgentHttpStreaming(
  handler: StreamingAgentHandler,
  options?: StreamingHttpRunnerOptions,
): Server {
  const port = options?.port ?? parseInt(process.env.PORT ?? '4000', 10);
  const host = options?.host ?? '0.0.0.0';
  const invokePath = options?.path ?? '/invoke';

  const server = createServer({ noDelay: true }, async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (!(req.method === 'POST' && req.url === invokePath)) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const streaming = wantsNdjson(req);
    // Only the NDJSON path ties the signal to the upstream connection; the
    // JSON path keeps runAgentHttp's semantics (the handler always finishes).
    const abort = new AbortController();
    if (streaming) {
      res.on('close', () => {
        if (!res.writableEnded) abort.abort(new Error('upstream disconnected'));
      });
    }

    let request: AgentRequest;
    try {
      request = parseRequest(await readBody(req));
    } catch (err: unknown) {
      // 500, same as runAgentHttp.
      const message = err instanceof Error ? err.message : String(err);
      console.error('Agent error:', message);
      sendJson(res, 500, { error: message });
      return;
    }

    if (!streaming) {
      const emit = makeEmitter(false, () => {}, abort.signal);
      try {
        sendJson(res, 200, await handler(request, emit));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('Agent error:', message);
        sendJson(res, 500, { error: message });
      }
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const write = (event: AgentWireEvent) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(JSON.stringify(event) + '\n');
    };
    const emit = makeEmitter(true, write, abort.signal);
    try {
      const response = await handler(request, emit);
      emit.reconcile(response);
      write({ event: 'final', data: response });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Agent error:', message);
      write({ event: 'error', data: { message } });
    } finally {
      res.end();
    }
  });

  server.listen(port, host, () => {
    console.log(`Agent HTTP (streaming) server listening on http://${host}:${port}`);
    console.log(`  POST ${invokePath}  — agent endpoint (NDJSON when Accept: application/x-ndjson)`);
    console.log(`  GET  /health        — health check`);
  });
  return server;
}
