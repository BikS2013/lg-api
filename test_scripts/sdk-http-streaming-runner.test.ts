/**
 * lg-agent-sdk-ts `runAgentHttpStreaming` (agents/agent-template-ts).
 *
 * - Without `Accept: application/x-ndjson` the response is exactly what
 *   runAgentHttp sends (the `/runs/wait` path of lg-api never asks for NDJSON).
 * - With it, the handler's emits become NDJSON lines, the runner reconciles
 *   the final text and stamps the reply id, and failures become `error` lines.
 * - End to end, lg-api's ApiAgentConnector reads it incrementally.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { Server } from 'node:http';
import {
  runAgentHttpStreaming,
  type AgentEmitter,
  type AgentRequest,
  type AgentResponse,
  type StreamingAgentHandler,
} from '../agents/agent-template-ts/src/index.js';
import { ApiAgentConnector } from '../src/agents/connectors/api-connector.js';

let server: Server | null = null;
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

async function start(handler: StreamingAgentHandler): Promise<string> {
  server = runAgentHttpStreaming(handler, { port: 0, host: '127.0.0.1' });
  if (!server.listening) await new Promise<void>((r) => server!.once('listening', () => r()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const request: AgentRequest = { thread_id: 't', run_id: 'r', assistant_id: 'a', messages: [{ role: 'user', content: 'hi' }] };
const respond = (content: string, extra: Record<string, unknown> = {}): AgentResponse => ({
  thread_id: 't', run_id: 'r', state: { step: 's1' },
  messages: [{ role: 'assistant', content, ...extra } as AgentResponse['messages'][number]],
});

async function post(base: string, body: unknown, accept?: string) {
  return fetch(`${base}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(accept ? { accept } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const lines = async (res: Response) => (await res.text()).trim().split('\n').map((l) => JSON.parse(l));

describe('runAgentHttpStreaming — JSON path (runAgentHttp-compatible)', () => {
  it('returns the handler response as plain JSON, byte for byte, with every emit a no-op', async () => {
    let seen: AgentEmitter | null = null;
    const response = respond('Hello', { additional_kwargs: { components_to_render: { type: 'chips' } } });
    const base = await start(async (_req, emit) => {
      seen = emit;
      emit.progress({ type: 'status', text: 'x' });
      emit.token('Hel');
      return response;
    });
    const res = await post(base, request);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(text)));
    expect(text).toBe(JSON.stringify(response));
    expect(seen!.streaming).toBe(false);
    expect(seen!.streamedText()).toBe('');
    // The JSON path does not stamp an id on the reply.
    expect(JSON.parse(text).messages[0].id).toBeUndefined();
  });

  it('the handler keeps running after the caller disconnects (emit.signal never aborts on the JSON path)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    let resolveDone!: (aborted: boolean) => void;
    const done = new Promise<boolean>((r) => (resolveDone = r));
    const base = await start(async (_req, emit) => {
      entered();
      await gate;
      resolveDone(emit.signal.aborted);
      return respond('done');
    });
    const ctl = new AbortController();
    const res = fetch(`${base}/invoke`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: ctl.signal,
    }).catch(() => null);
    await started;
    ctl.abort();
    await res;
    await new Promise((r) => setTimeout(r, 30));
    release();
    expect(await done).toBe(false);
  });

  it('answers errors like runAgentHttp: 500 {error} for a bad request or a handler failure, 404 elsewhere', async () => {
    const base = await start(async () => { throw new Error('nope'); });
    let res = await post(base, '');
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Empty request body/);
    res = await post(base, request);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'nope' });
    res = await fetch(`${base}/other`);
    expect(res.status).toBe(404);
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: 'ok' });
  });
});

describe('runAgentHttpStreaming — NDJSON path', () => {
  it('streams progress, reconciles nothing-streamed text as one `final` token, stamps the reply id', async () => {
    let messageId = '';
    const base = await start(async (_req, emit) => {
      messageId = emit.messageId;
      expect(emit.streaming).toBe(true);
      emit.progress({ type: 'status', text: 'Checking…' });
      return respond('Hello there');
    });
    const res = await post(base, request, 'application/x-ndjson, application/json;q=0.9');
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const ev = await lines(res);
    expect(ev.map((e) => e.event)).toEqual(['progress', 'token', 'final']);
    expect(ev[0].data).toMatchObject({ type: 'status', text: 'Checking…' });
    expect(typeof ev[0].data.t).toBe('number');
    expect(ev[1].data).toEqual({ id: messageId, delta: 'Hello there', source: 'final' });
    expect(ev[2].data.messages[0]).toMatchObject({ id: messageId, content: 'Hello there' });
  });

  it('sends the missing suffix as a `reconcile` token when the final text extends the streamed text', async () => {
    const base = await start(async (_req, emit) => {
      emit.token('Hello', 'ack');
      return respond('Hello there');
    });
    const ev = await lines(await post(base, request, 'application/x-ndjson'));
    const tokens = ev.filter((e) => e.event === 'token').map((e) => [e.data.delta, e.data.source]);
    expect(tokens).toEqual([['Hello', 'ack'], [' there', 'reconcile']]);
  });

  it('sends a `replace` when the final text contradicts the streamed text', async () => {
    const base = await start(async (_req, emit) => {
      emit.token('Connecting you…', 'ack');
      return respond('Are you sure you want to cancel?');
    });
    const ev = await lines(await post(base, request, 'application/x-ndjson'));
    expect(ev.map((e) => e.event)).toEqual(['token', 'replace', 'final']);
    expect(ev[1].data).toMatchObject({ content: 'Are you sure you want to cancel?', reason: 'final_differs' });
  });

  it('turns a handler failure into an `error` line instead of `final`', async () => {
    const base = await start(async (_req, emit) => {
      emit.progress({ stage: 'a' });
      throw new Error('backend down');
    });
    const ev = await lines(await post(base, request, 'application/x-ndjson'));
    expect(ev.map((e) => e.event)).toEqual(['progress', 'error']);
    expect(ev[1].data).toEqual({ message: 'backend down' });
  });

  it('is read incrementally by lg-api\'s ApiAgentConnector (progress arrives before the handler returns)', async () => {
    let release!: () => void;
    const base = await start(async (_req, emit) => {
      emit.progress({ type: 'status', text: 'Paying…' });
      await new Promise<void>((r) => (release = r));
      return respond('Paid');
    });
    const it = new ApiAgentConnector().streamAgent(
      { type: 'api', url: `${base}/invoke`, method: 'POST', timeout: 5000 }, request as never);
    const first = await it.next();
    expect(first.value).toMatchObject({ event: 'progress', data: { text: 'Paying…' } });
    release();
    const rest: any[] = [];
    for await (const e of it) rest.push(e);
    expect(rest.map((e) => e.event)).toEqual(['token', 'final']);
    expect(rest[1].data.messages[0].content).toBe('Paid');
  });

  it('lg-api\'s execute() (the /runs/wait path) gets plain JSON from the same agent', async () => {
    const base = await start(async (_req, emit) => {
      emit.progress({ stage: 'ignored' });
      return respond('Paid');
    });
    const out = await new ApiAgentConnector().execute(
      { type: 'api', url: `${base}/invoke`, method: 'POST', timeout: 5000 }, request as never);
    expect(out).toEqual(respond('Paid'));
  });
});
