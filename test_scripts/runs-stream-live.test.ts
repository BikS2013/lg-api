/**
 * Live `/runs/stream` (LangGraph stream API compatibility) and the guarantees
 * that the wait path is untouched.
 *
 * A scriptable executor stands in for the agent: each test decides what the
 * agent streams and when it finishes, so the tests can prove that events
 * reach the client BEFORE the agent is done, that a disconnect does not stop
 * the run, that a joiner follows the live run, and so on. Real HTTP (not
 * inject) is used so the streams are observed incrementally.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import errorHandlerPlugin from '../src/plugins/error-handler.plugin.js';
import { ThreadsRepository } from '../src/modules/threads/threads.repository.js';
import { ThreadsService } from '../src/modules/threads/threads.service.js';
import { RunsRepository } from '../src/modules/runs/runs.repository.js';
import { RunsService } from '../src/modules/runs/runs.service.js';
import { DEFAULT_STREAM_CONFIG, type StreamConfig } from '../src/modules/runs/stream-config.js';
import { RequestComposer } from '../src/agents/request-composer.js';
import type { AgentExecutor } from '../src/agents/agent-executor.js';
import type { AssistantResolver } from '../src/agents/assistant-resolver.js';
import type { AgentRequest, AgentResponse, AgentWireEvent } from '../src/agents/types.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const resolver = {
  resolve: async (id: string) => ({
    assistant_id: '6f1c1a52-7d0e-4c7b-9a57-2f8c3c1b9f10', graph_id: id, name: 'T', description: null,
    config: {}, metadata: {}, version: 1,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }),
} as unknown as AssistantResolver;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

type Script = (req: AgentRequest, signal?: AbortSignal) => AsyncGenerator<AgentWireEvent>;

function reply(req: AgentRequest, content = 'Hello there', extra: Record<string, unknown> = {}): AgentResponse {
  return {
    thread_id: req.thread_id,
    run_id: req.run_id,
    state: { step: 's2' },
    messages: [{ role: 'assistant', content, id: 'm1', ...extra } as AgentResponse['messages'][number]],
  };
}

interface Harness {
  app: FastifyInstance;
  base: string;
  threads: ThreadsRepository;
  runs: RunsRepository;
  executor: {
    execute: ReturnType<typeof vi.fn>;
    streamAgent?: ReturnType<typeof vi.fn>;
  };
}

let h: Harness;
let script: Script;

async function build(
  cfg: Partial<StreamConfig> = {},
  opts: { legacyExecutor?: boolean; defaults?: boolean } = {},
): Promise<Harness> {
  const executor: Harness['executor'] = {
    execute: vi.fn(async (_g: string, req: AgentRequest) => reply(req)),
  };
  if (!opts.legacyExecutor) {
    executor.streamAgent = vi.fn((_g: string, req: AgentRequest, signal?: AbortSignal) => script(req, signal));
  }
  // forceCloseConnections: an aborted fetch leaves undici holding a spare,
  // never-used socket that would otherwise delay app.close() by ~4 s.
  const app = Fastify({ logger: false, forceCloseConnections: true });
  app.decorate('config', { port: 0, host: '127.0.0.1', authEnabled: false, apiKey: '' });
  await app.register(errorHandlerPlugin);
  const threads = new ThreadsRepository();
  const runs = new RunsRepository();
  // Fast pacing and no heartbeat unless a test overrides them; `defaults`
  // uses the shipped config untouched.
  const service = new RunsService(runs, threads, executor as unknown as AgentExecutor, resolver, new RequestComposer(),
    opts.defaults ? DEFAULT_STREAM_CONFIG : {
      ...DEFAULT_STREAM_CONFIG,
      heartbeatMs: 0,
      typewriterChunkMs: 1,
      ...cfg,
    });
  const ts = new ThreadsService(threads);
  const modes = (q: Record<string, unknown>) =>
    q['stream_mode'] === undefined ? undefined : ([] as string[]).concat(q['stream_mode'] as string) as never;
  app.post('/threads', async (_q, r) => r.send(await ts.create({})));
  app.post('/threads/:thread_id/runs/stream', async (q, r) => {
    await service.streamRun((q.params as { thread_id: string }).thread_id, q.body as never, r);
  });
  app.post('/runs/stream', async (q, r) => {
    await service.streamRun(null, q.body as never, r);
  });
  app.post('/threads/:thread_id/runs/wait', async (q, r) =>
    r.send(await service.wait((q.params as { thread_id: string }).thread_id, q.body as never)));
  app.post('/threads/:thread_id/runs/:run_id/cancel', async (q, r) => {
    const p = q.params as { thread_id: string; run_id: string };
    await service.cancel(p.thread_id, p.run_id, {} as never);
    return r.code(204).send();
  });
  app.get('/threads/:thread_id/runs/:run_id', async (q, r) => {
    const p = q.params as { thread_id: string; run_id: string };
    return r.send(await service.get(p.thread_id, p.run_id));
  });
  app.get('/threads/:thread_id/runs/:run_id/stream', async (q, r) => {
    const p = q.params as { thread_id: string; run_id: string };
    const query = q.query as Record<string, unknown>;
    await service.joinStream(p.thread_id, p.run_id, r, modes(query),
      (query['last_event_id'] as string | undefined) ?? (q.headers['last-event-id'] as string | undefined),
      query['cancel_on_disconnect'] === 'true');
  });
  app.get('/runs/:run_id/stream', async (q, r) => {
    const query = q.query as Record<string, unknown>;
    await service.joinStream(null, (q.params as { run_id: string }).run_id, r, modes(query),
      q.headers['last-event-id'] as string | undefined, false);
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return { app, base, threads, runs, executor };
}

async function newThread(): Promise<string> {
  const res = await fetch(`${h.base}/threads`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return (await res.json()).thread_id;
}

interface SseEvent { event: string; data: any; id?: string }

/** Incremental SSE reader: `pump(until)` reads until the predicate holds or the stream ends. */
function reader(res: Response) {
  const r = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let done = false;
  const events: SseEvent[] = [];
  const comments: string[] = [];
  const pump = async (until: (e: SseEvent[]) => boolean = () => false) => {
    while (!done && !until(events)) {
      const chunk = await r.read();
      if (chunk.done) { done = true; break; }
      buf += dec.decode(chunk.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (block.startsWith(':')) { comments.push(block); continue; }
        const ev = /^event: (.*)$/m.exec(block)![1];
        const data = JSON.parse(/^data: (.*)$/m.exec(block)![1]);
        const id = /^id: (.*)$/m.exec(block)?.[1];
        events.push({ event: ev, data, id });
      }
    }
    return events;
  };
  return { events, comments, pump, get done() { return done; }, cancel: () => r.cancel() };
}

async function openStream(path: string, body: Record<string, unknown>, signal?: AbortSignal) {
  const res = await fetch(`${h.base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ assistant_id: 'demo', input: { messages: [{ role: 'user', content: 'hi' }] }, ...body }),
  });
  return { res, sse: reader(res) };
}

async function until(predicate: () => Promise<boolean> | boolean, ms = 3000) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const names = (e: SseEvent[]) => e.map((x) => x.event);

/** Agent that reports progress, streams "Hel", waits for `gate`, then finishes. */
function parkedAgent(gate: Promise<void>, opts: { fail?: boolean; final?: (req: AgentRequest) => AgentResponse } = {}): Script {
  return async function* (req) {
    yield { event: 'progress', data: { type: 'status', text: 'Checking…', stage: 'validating_step' } };
    yield { event: 'token', data: { id: 'm1', delta: 'Hel', source: 'ack' } };
    await gate;
    if (opts.fail) throw new Error('boom');
    yield { event: 'token', data: { id: 'm1', delta: 'lo there', source: 'ack' } };
    yield { event: 'final', data: opts.final ? opts.final(req) : reply(req, 'Hello there', { additional_kwargs: { components_to_render: { type: 'suggestions', data: ['a'] } } }) };
  };
}

beforeEach(() => {
  script = async function* (req) { yield { event: 'final', data: reply(req) }; };
});
afterEach(async () => {
  await h?.app.close();
});

// ---------------------------------------------------------------------------
// Wait path untouched
// ---------------------------------------------------------------------------

describe('/runs/wait is unchanged by the streaming work', () => {
  it('uses execute() only, never the streaming path, and returns the flat state values', async () => {
    h = await build();
    const tid = await newThread();
    const res = await fetch(`${h.base}/threads/${tid}/runs/wait`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assistant_id: 'demo', stream_mode: ['messages-tuple', 'custom'], input: { messages: [{ role: 'user', content: 'hi' }] } }),
    });
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('location')).toBeNull();
    const body = await res.json();
    expect(h.executor.execute).toHaveBeenCalledTimes(1);
    expect(h.executor.streamAgent).not.toHaveBeenCalled();
    expect(Object.keys(body).sort()).toEqual(['messages', 'step']);
    expect(body.messages.map((m: any) => [m.type, m.content])).toEqual([['human', 'hi'], ['ai', 'Hello there']]);
    const st = await h.threads.getState(tid);
    expect(st!.values).toEqual(body);
  });
});

// ---------------------------------------------------------------------------
// Live streaming, stream_mode, metadata
// ---------------------------------------------------------------------------

describe('live /runs/stream', () => {
  it('sends headers, metadata, custom progress and the first chunk while the agent is still running', async () => {
    h = await build();
    const gate = deferred();
    script = parkedAgent(gate.promise);
    const tid = await newThread();
    const { res, sse } = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: ['messages-tuple', 'custom'] });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await sse.pump((e) => e.some((x) => x.event === 'messages'));
    // The agent is parked: nothing final can have been sent yet.
    expect(names(sse.events)).toEqual(['metadata', 'custom', 'messages']);
    expect(sse.events[0].data).toMatchObject({ attempt: 1, thread_id: tid });
    expect(sse.events[0].data.run_id).toMatch(/^[0-9a-f-]{36}$/);
    // custom: the agent's payload, passed through unchanged.
    expect(sse.events[1].data).toEqual({ type: 'status', text: 'Checking…', stage: 'validating_step' });
    gate.resolve();
    await sse.pump();
    const deltas = sse.events.filter((e) => e.event === 'messages').map((e) => e.data[0].content).join('');
    expect(deltas).toBe('Hello there');
    expect(sse.events.at(-1)!.event).toBe('end');
  });

  it('accepts stream_mode as a string and defaults to values', async () => {
    h = await build();
    const tid = await newThread();
    let { sse } = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: 'updates' });
    await sse.pump();
    expect(names(sse.events)).toEqual(['metadata', 'updates', 'end']);
    ({ sse } = await openStream(`/threads/${tid}/runs/stream`, {}));
    await sse.pump();
    expect(names(sse.events)).toEqual(['metadata', 'values', 'values', 'end']);
  });

  it('emits only the requested modes', async () => {
    h = await build();
    script = parkedAgent(Promise.resolve());
    const tid = await newThread();
    const { sse } = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: ['values'] });
    await sse.pump();
    expect(names(sse.events)).toEqual(['metadata', 'values', 'values', 'end']);
  });

  it('initial values = prior state + the input, with the ids that get persisted', async () => {
    h = await build();
    const tid = await newThread();
    await (await openStream(`/threads/${tid}/runs/stream`, { stream_mode: ['values'] })).sse.pump();
    const { sse } = await openStream(`/threads/${tid}/runs/stream`, {
      stream_mode: ['values'], input: { messages: [{ role: 'user', content: 'second' }] },
    });
    await sse.pump();
    const [initial, final] = sse.events.filter((e) => e.event === 'values').map((e) => e.data);
    expect(initial.messages.map((m: any) => m.content)).toEqual(['hi', 'Hello there', 'second']);
    expect(initial.step).toBe('s2'); // prior state carried
    expect(final.messages.slice(0, 3)).toEqual(initial.messages);
    const st = await h.threads.getState(tid);
    expect(st!.values).toEqual(final);
  });

  it('fills messages-tuple metadata the LangGraph way and tags chunks respond', async () => {
    h = await build();
    const tid = await newThread();
    const { sse } = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: 'messages-tuple' });
    await sse.pump();
    const [chunk, meta] = sse.events.find((e) => e.event === 'messages')!.data;
    expect(chunk).toMatchObject({ type: 'AIMessageChunk', id: 'm1', tool_call_chunks: [], additional_kwargs: {} });
    expect(meta).toMatchObject({
      langgraph_step: 1,
      langgraph_node: 'respond',
      langgraph_triggers: ['branch:to:respond'],
      langgraph_path: ['__pregel_pull', 'respond'],
      tags: [],
      run_attempt: 1,
      assistant_id: '6f1c1a52-7d0e-4c7b-9a57-2f8c3c1b9f10',
      graph_id: 'demo',
      thread_id: tid,
    });
    expect(meta.langgraph_checkpoint_ns).toMatch(/^respond:/);
    expect(meta.checkpoint_ns).toBe(meta.langgraph_checkpoint_ns);
    expect(meta.run_id).toBe(sse.events[0].data.run_id);
  });

  it('messages mode: messages/metadata, accumulated AIMessageChunk partials, messages/complete', async () => {
    h = await build();
    script = parkedAgent(Promise.resolve());
    const tid = await newThread();
    const { sse } = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: ['messages', 'updates'] });
    await sse.pump();
    expect(sse.events.filter((e) => e.event === 'messages/metadata')).toHaveLength(1);
    const partials = sse.events.filter((e) => e.event === 'messages/partial').map((e) => e.data[0]);
    expect(partials.every((p) => p.type === 'AIMessageChunk')).toBe(true);
    expect(partials[0].content).toBe('Hel');
    expect(partials.at(-1)!.content).toBe('Hello there');
    expect(partials.at(-1)!.additional_kwargs.components_to_render.data).toEqual(['a']);
    const complete = sse.events.find((e) => e.event === 'messages/complete')!.data;
    expect(complete[0]).toMatchObject({ type: 'ai', content: 'Hello there', id: 'm1' });
    const updates = sse.events.find((e) => e.event === 'updates')!.data;
    expect(Object.keys(updates)).toEqual(['respond']);
    expect(updates.respond.step).toBe('s2');
  });

  it('an agent failure after the headers becomes an SSE error event; thread idle, nothing persisted', async () => {
    h = await build();
    const gate = deferred();
    script = parkedAgent(gate.promise, { fail: true });
    const tid = await newThread();
    const { sse } = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: ['values', 'custom'] });
    await sse.pump((e) => e.some((x) => x.event === 'custom'));
    gate.resolve();
    await sse.pump();
    const last = sse.events.at(-1)!;
    expect(last.event).toBe('error');
    expect(last.data).toMatchObject({ error: 'AgentError' });
    expect(last.data.message).toContain('boom');
    const t = await h.threads.getById(tid);
    expect(t!.status).toBe('idle');
    expect(((t!.values as any)?.messages ?? []).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Typed final reply
// ---------------------------------------------------------------------------

describe('typed final reply', () => {
  it('a legacy JSON agent (no streamAgent) gets its reply typed out, kwargs on the last chunk', async () => {
    h = await build({}, { legacyExecutor: true });
    h.executor.execute.mockImplementation(async (_g: string, req: AgentRequest) =>
      reply(req, 'One two three four', { additional_kwargs: { components_to_render: { type: 'chips' } } }));
    const tid = await newThread();
    const { sse } = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: ['messages-tuple', 'values'] });
    await sse.pump();
    const chunks = sse.events.filter((e) => e.event === 'messages').map((e) => e.data[0]);
    expect(chunks.map((c) => c.content)).toEqual(['One ', 'two ', 'three ', 'four']);
    expect(chunks.slice(0, -1).every((c) => Object.keys(c.additional_kwargs).length === 0)).toBe(true);
    expect(chunks.at(-1)!.additional_kwargs).toEqual({ components_to_render: { type: 'chips' } });
    const final = sse.events.filter((e) => e.event === 'values').at(-1)!.data;
    expect(chunks.map((c) => c.content).join('')).toBe(final.messages.at(-1).content);
    expect(chunks[0].id).toBe(final.messages.at(-1).id);
  });

  it('LG_API_TYPEWRITER off sends the held reconciliation token as one chunk', async () => {
    h = await build({ typewriter: false });
    script = async function* (req) {
      yield { event: 'token', data: { id: 'm1', delta: 'Hello there', source: 'final' } };
      yield { event: 'final', data: reply(req) };
    };
    const tid = await newThread();
    const { sse } = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: 'messages-tuple' });
    await sse.pump();
    expect(sse.events.filter((e) => e.event === 'messages').map((e) => e.data[0].content)).toEqual(['Hello there']);
  });

  it('a handoff reply goes out as one chunk carrying is_handoff and the full text', async () => {
    h = await build();
    script = async function* (req) {
      yield { event: 'final', data: reply(req, 'Connecting you to an agent now', { additional_kwargs: { is_handoff: true, handoff_type: 'human' } }) };
    };
    const tid = await newThread();
    const { sse } = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: 'messages-tuple' });
    await sse.pump();
    const chunks = sse.events.filter((e) => e.event === 'messages').map((e) => e.data[0]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ content: 'Connecting you to an agent now', additional_kwargs: { is_handoff: true } });
  });

  it('state is persisted and the run is success before the typing finishes', async () => {
    h = await build({ typewriterChunkMs: 60, typewriterMaxMs: 10_000 });
    script = async function* (req) { yield { event: 'final', data: reply(req, 'a b c d e f') }; };
    const tid = await newThread();
    const { sse } = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: 'messages-tuple' });
    await sse.pump((e) => e.filter((x) => x.event === 'messages').length === 1);
    const st = await h.threads.getState(tid);
    expect((st!.values as any).messages.at(-1).content).toBe('a b c d e f');
    const runId = sse.events[0].data.run_id;
    expect((await h.runs.getById(runId))!.status).toBe('success');
    await sse.pump();
  });
});

// ---------------------------------------------------------------------------
// Hardening: heartbeat, disconnect, end event, Location
// ---------------------------------------------------------------------------

describe('stream hardening', () => {
  it('writes a ": heartbeat" comment while the stream is open', async () => {
    h = await build({ heartbeatMs: 25 });
    const gate = deferred();
    script = parkedAgent(gate.promise);
    const tid = await newThread();
    const { sse } = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: 'custom' });
    await sse.pump((e) => e.length >= 2);
    await new Promise((r) => setTimeout(r, 120));
    gate.resolve();
    await sse.pump();
    expect(sse.comments.length).toBeGreaterThanOrEqual(2);
    expect(sse.comments.every((c) => c === ': heartbeat')).toBe(true);
  });

  it('heartbeat 0 disables it', async () => {
    h = await build({ heartbeatMs: 0 });
    const gate = deferred();
    script = parkedAgent(gate.promise);
    const tid = await newThread();
    const { sse } = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: 'custom' });
    await sse.pump((e) => e.length >= 2);
    await new Promise((r) => setTimeout(r, 60));
    gate.resolve();
    await sse.pump();
    expect(sse.comments).toEqual([]);
  });

  it('a client disconnect does not stop the run: it completes and is persisted', async () => {
    h = await build();
    const gate = deferred();
    let aborted = false;
    script = async function* (req, signal) {
      yield { event: 'progress', data: { type: 'status', text: 'Paying…' } };
      await gate.promise;
      aborted = signal?.aborted ?? false;
      yield { event: 'final', data: reply(req, 'Order placed') };
    };
    const tid = await newThread();
    const ctl = new AbortController();
    const { sse } = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: ['custom', 'messages-tuple'] }, ctl.signal);
    await sse.pump((e) => e.some((x) => x.event === 'custom'));
    const runId = sse.events[0].data.run_id;
    ctl.abort();
    await new Promise((r) => setTimeout(r, 50));
    gate.resolve();
    await until(async () => (await h.runs.getById(runId))!.status === 'success');
    expect(aborted).toBe(false);
    const st = await h.threads.getState(tid);
    expect((st!.values as any).messages.at(-1).content).toBe('Order placed');
    expect((await h.threads.getById(tid))!.status).toBe('idle');
  });

  it('LG_API_STREAM_END_EVENT=false closes the stream without event: end', async () => {
    h = await build({ endEvent: false });
    const tid = await newThread();
    const { sse } = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: ['values'] });
    await sse.pump();
    expect(sse.done).toBe(true);
    expect(names(sse.events)).toEqual(['metadata', 'values', 'values']);
  });

  it('sets Location (rejoin URL) and Content-Location, stateful and stateless', async () => {
    h = await build();
    const tid = await newThread();
    let { res, sse } = await openStream(`/threads/${tid}/runs/stream`, {});
    await sse.pump();
    const runId = sse.events[0].data.run_id;
    expect(res.headers.get('location')).toBe(`/threads/${tid}/runs/${runId}/stream`);
    expect(res.headers.get('content-location')).toBe(`/threads/${tid}/runs/${runId}`);
    ({ res, sse } = await openStream('/runs/stream', {}));
    await sse.pump();
    const statelessRun = sse.events[0].data.run_id;
    expect(res.headers.get('location')).toBe(`/runs/${statelessRun}/stream`);
    expect(res.headers.get('content-location')).toBe(`/runs/${statelessRun}`);
  });
});

// ---------------------------------------------------------------------------
// Rejoin
// ---------------------------------------------------------------------------

describe('rejoin GET …/runs/:run_id/stream', () => {
  async function startParked(modes: string[] = ['values', 'messages-tuple', 'custom']) {
    const gate = deferred();
    script = parkedAgent(gate.promise);
    const tid = await newThread();
    const first = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: modes });
    await first.sse.pump((e) => e.some((x) => x.event === 'messages'));
    return { gate, tid, runId: first.sse.events[0].data.run_id as string, first };
  }

  it('Last-Event-ID -1 replays everything, then follows the live run to the end', async () => {
    h = await build();
    const { gate, tid, runId, first } = await startParked();
    const res = await fetch(`${h.base}/threads/${tid}/runs/${runId}/stream`, { headers: { 'Last-Event-ID': '-1' } });
    expect(res.headers.get('location')).toBe(`/threads/${tid}/runs/${runId}/stream`);
    const join = reader(res);
    await join.pump((e) => e.length >= first.sse.events.length);
    expect(join.events).toEqual(first.sse.events);
    gate.resolve();
    await join.pump();
    await first.sse.pump();
    expect(join.events).toEqual(first.sse.events);
    expect(join.events.at(-1)!.event).toBe('end');
  });

  it('without Last-Event-ID only new events are sent (LangGraph semantics)', async () => {
    h = await build();
    const { gate, tid, runId, first } = await startParked();
    const join = reader(await fetch(`${h.base}/threads/${tid}/runs/${runId}/stream`));
    await new Promise((r) => setTimeout(r, 30));
    gate.resolve();
    await join.pump();
    await first.sse.pump();
    const seenBefore = first.sse.events.findIndex((e) => e.event === 'messages') + 1;
    expect(join.events).toEqual(first.sse.events.slice(seenBefore));
  });

  it('Last-Event-ID n resumes after event n; stream_mode filters the joiner', async () => {
    h = await build();
    const { gate, tid, runId, first } = await startParked();
    const join = reader(await fetch(`${h.base}/threads/${tid}/runs/${runId}/stream?stream_mode=values`, { headers: { 'Last-Event-ID': '1' } }));
    gate.resolve();
    await join.pump();
    await first.sse.pump();
    expect(names(join.events)).toEqual(['values', 'values', 'end']);
    expect(join.events[0].id).toBe('2');
  });

  it('after the run finished, a replay from -1 returns the buffered stream', async () => {
    h = await build();
    const { gate, tid, runId, first } = await startParked();
    gate.resolve();
    await first.sse.pump();
    const join = reader(await fetch(`${h.base}/threads/${tid}/runs/${runId}/stream`, { headers: { 'Last-Event-ID': '-1' } }));
    await join.pump();
    expect(join.events).toEqual(first.sse.events);
  });

  it('a finished streamed run joined without Last-Event-ID returns metadata + FULL stored values + end', async () => {
    h = await build();
    const tid = await newThread();
    const first = await openStream(`/threads/${tid}/runs/stream`, {});
    await first.sse.pump();
    const runId = first.sse.events[0].data.run_id;
    const res = await fetch(`${h.base}/threads/${tid}/runs/${runId}/stream`);
    expect(res.headers.get('location')).toBe(`/threads/${tid}/runs/${runId}/stream`);
    const join = reader(res);
    await join.pump();
    expect(names(join.events)).toEqual(['metadata', 'values', 'end']);
    expect(join.events[1].data.step).toBe('s2');
    expect(join.events[1].data.messages).toHaveLength(2);
  });

  it('cancel_on_disconnect=true cancels the run when the joiner leaves', async () => {
    h = await build();
    let sawAbort = false;
    script = async function* (req, signal) {
      yield { event: 'progress', data: { type: 'status' } };
      await new Promise<void>((resolve) => signal!.addEventListener('abort', () => { sawAbort = true; resolve(); }));
      throw new Error('aborted');
      yield { event: 'final', data: reply(req) };
    };
    const tid = await newThread();
    const first = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: 'custom' });
    await first.sse.pump((e) => e.some((x) => x.event === 'custom'));
    const runId = first.sse.events[0].data.run_id;
    const ctl = new AbortController();
    const res = await fetch(`${h.base}/threads/${tid}/runs/${runId}/stream?cancel_on_disconnect=true`, { signal: ctl.signal });
    expect(res.status).toBe(200);
    ctl.abort();
    await until(async () => (await h.runs.getById(runId))!.status === 'interrupted');
    expect(sawAbort).toBe(true);
    await first.sse.pump();
    expect(first.sse.events.at(-1)).toMatchObject({ event: 'error', data: { error: 'Cancelled' } });
  });

  it('a joiner leaving without cancel_on_disconnect does not affect the run', async () => {
    h = await build();
    const { gate, tid, runId, first } = await startParked();
    const ctl = new AbortController();
    await fetch(`${h.base}/threads/${tid}/runs/${runId}/stream`, { signal: ctl.signal });
    ctl.abort();
    await new Promise((r) => setTimeout(r, 30));
    gate.resolve();
    await first.sse.pump();
    expect(first.sse.events.at(-1)!.event).toBe('end');
    expect((await h.runs.getById(runId))!.status).toBe('success');
  });

  it('GET /runs/:run_id/stream follows a stateless run', async () => {
    h = await build();
    const gate = deferred();
    script = parkedAgent(gate.promise);
    const first = await openStream('/runs/stream', { stream_mode: ['values'] });
    await first.sse.pump((e) => e.length >= 2);
    const location = first.res.headers.get('location')!;
    const join = reader(await fetch(`${h.base}${location}`, { headers: { 'Last-Event-ID': '-1' } }));
    gate.resolve();
    await join.pump();
    await first.sse.pump();
    expect(join.events).toEqual(first.sse.events);
  });

  it('404 for an unknown run', async () => {
    h = await build();
    const tid = await newThread();
    const res = await fetch(`${h.base}/threads/${tid}/runs/00000000-0000-4000-8000-000000000000/stream`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Always live; the join of a run that was never streamed is unchanged
// ---------------------------------------------------------------------------

describe('always live', () => {
  it('the shipped defaults stream live: the agent is streamed, Location is set, chunks arrive', async () => {
    h = await build({}, { defaults: true });
    const tid = await newThread();
    const { res, sse } = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: ['messages-tuple', 'values'] });
    await sse.pump();
    expect(h.executor.streamAgent).toHaveBeenCalledTimes(1);
    expect(h.executor.execute).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe(`/threads/${tid}/runs/${sse.events[0].data.run_id}/stream`);
    expect(names(sse.events)).toContain('messages');
    expect(names(sse.events).at(-1)).toBe('end');
  });

  it('the join of a run that was never streamed is the pre-streaming one: {messages} only, no Location, replay-and-end', async () => {
    h = await build({}, { defaults: true });
    const tid = await newThread();
    await fetch(`${h.base}/threads/${tid}/runs/wait`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assistant_id: 'demo', input: { messages: [{ role: 'user', content: 'hi' }] } }),
    });
    const [run] = (await h.runs.listByThreadId(tid, { limit: 1, offset: 0 })).items;
    const runId = run.run_id;

    // No live session: metadata, values {messages} (not the full state), end.
    let res = await fetch(`${h.base}/threads/${tid}/runs/${runId}/stream?stream_mode=custom`);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-location')).toBe(`/threads/${tid}/runs/${runId}`);
    let join = reader(res);
    await join.pump();
    expect(names(join.events)).toEqual(['metadata', 'values', 'end']);
    expect(join.events[0].data).toEqual({ run_id: runId, thread_id: tid });
    expect(Object.keys(join.events[1].data)).toEqual(['messages']);
    const firstJoin = join.events;

    // That join left a replay buffer: Last-Event-ID replays after it, then ends at once.
    res = await fetch(`${h.base}/threads/${tid}/runs/${runId}/stream`, { headers: { 'Last-Event-ID': '1' } });
    expect(res.headers.get('location')).toBeNull();
    join = reader(res);
    await join.pump();
    expect(join.events).toEqual(firstJoin.slice(1));
  });
});

// ---------------------------------------------------------------------------
// Handoff delivery, cancellation, status after persistence (review fixes)
// ---------------------------------------------------------------------------

describe('live stream edge cases', () => {
  const handoffKw = { is_handoff: true, handoff_type: 'human' };

  it('typewriter off: an SDK handoff reply is one chunk carrying the text AND is_handoff', async () => {
    h = await build({ typewriter: false });
    script = async function* (req) {
      yield { event: 'token', data: { id: 'm1', delta: 'Connecting you now', source: 'final' } };
      yield { event: 'final', data: reply(req, 'Connecting you now', { additional_kwargs: handoffKw }) };
    };
    const tid = await newThread();
    const { sse } = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: 'messages-tuple' });
    await sse.pump();
    const chunks = sse.events.filter((e) => e.event === 'messages').map((e) => e.data[0]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ content: 'Connecting you now', additional_kwargs: handoffKw });
  });

  it('typewriter off: components_to_render ride on the reply chunk, not an extra empty one', async () => {
    h = await build({ typewriter: false });
    const kw = { components_to_render: { type: 'chips' } };
    script = async function* (req) {
      yield { event: 'token', data: { id: 'm1', delta: 'Pick one', source: 'final' } };
      yield { event: 'final', data: reply(req, 'Pick one', { additional_kwargs: kw }) };
    };
    const tid = await newThread();
    const { sse } = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: 'messages-tuple' });
    await sse.pump();
    const chunks = sse.events.filter((e) => e.event === 'messages').map((e) => e.data[0]);
    expect(chunks.map((c) => [c.content, c.additional_kwargs])).toEqual([['Pick one', kw]]);
  });

  it('a handoff after a live-streamed prefix: the flagged chunk carries the FULL handoff text', async () => {
    h = await build();
    script = async function* (req) {
      yield { event: 'token', data: { id: 'm1', delta: 'Connecting ', source: 'llm' } };
      yield { event: 'token', data: { id: 'm1', delta: 'you now', source: 'reconcile' } };
      yield { event: 'final', data: reply(req, 'Connecting you now', { additional_kwargs: handoffKw }) };
    };
    const tid = await newThread();
    const { sse } = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: ['messages-tuple', 'messages'] });
    await sse.pump();
    const flagged = sse.events
      .filter((e) => e.event === 'messages')
      .map((e) => e.data[0])
      .filter((c) => c.additional_kwargs.is_handoff);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].content).toBe('Connecting you now');
    const partial = sse.events.filter((e) => e.event === 'messages/partial').at(-1)!.data[0];
    expect(partial.content).toBe('Connecting you now');
  });

  it('POST …/cancel stops a live run: the agent call is aborted and the run stays interrupted', async () => {
    h = await build();
    let sawAbort = false;
    script = async function* (req, signal) {
      yield { event: 'progress', data: { type: 'status' } };
      await new Promise<void>((resolve) => signal!.addEventListener('abort', () => { sawAbort = true; resolve(); }));
      throw new Error('aborted');
      yield { event: 'final', data: reply(req) };
    };
    const tid = await newThread();
    const first = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: 'custom' });
    await first.sse.pump((e) => e.some((x) => x.event === 'custom'));
    const runId = first.sse.events[0].data.run_id;
    const res = await fetch(`${h.base}/threads/${tid}/runs/${runId}/cancel`, { method: 'POST' });
    expect(res.status).toBe(204);
    await first.sse.pump();
    expect(sawAbort).toBe(true);
    expect(first.sse.events.at(-1)).toMatchObject({ event: 'error', data: { error: 'Cancelled' } });
    expect((await h.runs.getById(runId))!.status).toBe('interrupted');
    expect((await h.threads.getState(tid))).toBeFalsy();
  });

  it('a cancel that lands after the turn is saved keeps the run interrupted (not overwritten by success)', async () => {
    h = await build();
    const tid = await newThread();
    const realUpdate = h.threads.addState.bind(h.threads);
    // Cancel the run from inside the persistence step, i.e. after the agent finished.
    vi.spyOn(h.threads, 'addState').mockImplementation(async (id, state) => {
      const [run] = (await h.runs.listByThreadId(tid, { limit: 1, offset: 0 })).items;
      await h.runs.update(run.run_id, { status: 'interrupted', updated_at: new Date().toISOString() });
      return realUpdate(id, state);
    });
    const { sse } = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: 'values' });
    await sse.pump();
    const runId = sse.events[0].data.run_id;
    expect((await h.runs.getById(runId))!.status).toBe('interrupted');
    expect((await h.threads.getById(tid))!.status).toBe('idle');
  });

  it('a status update failing after the turn is saved still releases the thread and retries success', async () => {
    h = await build();
    const tid = await newThread();
    const realUpdate = h.runs.update.bind(h.runs);
    let failed = false;
    vi.spyOn(h.runs, 'update').mockImplementation(async (id, patch) => {
      if (!failed && (patch as { status?: string }).status === 'success') {
        failed = true;
        throw new Error('blob write failed');
      }
      return realUpdate(id, patch);
    });
    const { sse } = await openStream(`/threads/${tid}/runs/stream`, { stream_mode: 'values' });
    await sse.pump();
    const runId = sse.events[0].data.run_id;
    expect(sse.events.at(-1)).toMatchObject({ event: 'error', data: { error: 'AgentError' } });
    expect((await h.runs.getById(runId))!.status).toBe('success');
    expect((await h.threads.getById(tid))!.status).toBe('idle');
    expect(((await h.threads.getState(tid))!.values as any).messages).toHaveLength(2);
  });
});
