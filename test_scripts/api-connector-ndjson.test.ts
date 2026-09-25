/**
 * ApiAgentConnector.streamAgent — NDJSON incremental read, legacy JSON
 * fallback, error mapping — and the guarantee that execute() (the
 * `/runs/wait` path) sends exactly the request it always has.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { ApiAgentConnector } from '../src/agents/connectors/api-connector.js';
import type { ApiAgentConfig } from '../src/agents/types.js';

let server: Server | null = null;
afterEach(() => new Promise<void>((r) => {
  if (!server) return r();
  server.closeAllConnections();
  server.close(() => r());
  server = null;
}));
function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  return new Promise((r) => {
    server = createServer(handler);
    server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server!.address() as { port: number }).port}/invoke`));
  });
}
const req = { thread_id: 't', run_id: 'r', assistant_id: 'a', messages: [{ role: 'user' as const, content: 'x' }] };
const final = { thread_id: 't', run_id: 'r', messages: [{ role: 'assistant', content: 'ok' }] };
const cfg = (url: string, extra: Partial<ApiAgentConfig> = {}): ApiAgentConfig =>
  ({ type: 'api', url, method: 'POST', timeout: 5000, ...extra }) as ApiAgentConfig;

async function drain(it: AsyncGenerator<unknown>) {
  const out: unknown[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('ApiAgentConnector.execute (wait path) is unchanged', () => {
  it('sends no Accept header and parses the JSON body, even from an NDJSON-capable agent', async () => {
    let headers: IncomingHttpHeaders = {};
    const url = await listen((q, s) => {
      headers = q.headers;
      // An NDJSON-capable agent answers JSON when NDJSON was not asked for.
      const ndjson = String(q.headers['accept'] ?? '').includes('application/x-ndjson');
      s.writeHead(200, { 'content-type': ndjson ? 'application/x-ndjson' : 'application/json' });
      s.end(JSON.stringify(final));
    });
    const out = await new ApiAgentConnector().execute(cfg(url), req);
    expect(out).toEqual(final);
    expect(String(headers['accept'] ?? '')).not.toContain('application/x-ndjson');
    expect(headers['content-type']).toBe('application/json');
  });
});

describe('ApiAgentConnector.streamAgent', () => {
  it('asks for NDJSON and yields lines as they arrive (split across chunks), final last', async () => {
    let gate!: () => void;
    let accept = '';
    const url = await listen(async (q, s) => {
      accept = String(q.headers['accept']);
      s.writeHead(200, { 'content-type': 'application/x-ndjson' });
      s.write('{"event":"progress","data":{"stage":"a"}}\n{"event":"tok');
      await new Promise<void>((r) => (gate = r));
      s.write('en","data":{"id":"m","delta":"o"}}\n');
      s.end(JSON.stringify({ event: 'final', data: final }) + '\n');
    });
    const it = new ApiAgentConnector().streamAgent(cfg(url), req);
    const first = await it.next();
    expect(accept).toBe('application/x-ndjson, application/json;q=0.9');
    expect(first.value).toEqual({ event: 'progress', data: { stage: 'a' } });
    gate();
    const rest = await drain(it);
    expect(rest.map((e: any) => e.event)).toEqual(['token', 'final']);
  });

  it('accepts a final line without a trailing newline', async () => {
    const url = await listen((_q, s) => {
      s.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
      s.end(JSON.stringify({ event: 'final', data: final }));
    });
    expect(await drain(new ApiAgentConnector().streamAgent(cfg(url), req))).toEqual([{ event: 'final', data: final }]);
  });

  it('falls back to a single final for a plain JSON (legacy) agent', async () => {
    const url = await listen((_q, s) => { s.writeHead(200, { 'content-type': 'application/json' }); s.end(JSON.stringify(final)); });
    expect(await drain(new ApiAgentConnector().streamAgent(cfg(url), req))).toEqual([{ event: 'final', data: final }]);
  });

  it('validates the legacy JSON body like execute()', async () => {
    const url = await listen((_q, s) => { s.writeHead(200, { 'content-type': 'application/json' }); s.end('{"messages":[]}'); });
    await expect(drain(new ApiAgentConnector().streamAgent(cfg(url), req))).rejects.toThrow(/missing required fields/);
  });

  it('rejects an NDJSON stream that ends without final', async () => {
    const url = await listen((_q, s) => { s.writeHead(200, { 'content-type': 'application/x-ndjson' }); s.end('{"event":"progress","data":{}}\n'); });
    await expect(drain(new ApiAgentConnector().streamAgent(cfg(url), req))).rejects.toThrow(/without a final event/);
  });

  it('rejects a malformed NDJSON line with a 502', async () => {
    const url = await listen((_q, s) => { s.writeHead(200, { 'content-type': 'application/x-ndjson' }); s.end('not json\n'); });
    await expect(drain(new ApiAgentConnector().streamAgent(cfg(url), req))).rejects.toMatchObject({ statusCode: 502 });
  });

  it('maps an HTTP error status to 502', async () => {
    const url = await listen((_q, s) => { s.writeHead(500, { 'content-type': 'application/json' }); s.end('{"error":"x"}'); });
    await expect(drain(new ApiAgentConnector().streamAgent(cfg(url), req))).rejects.toMatchObject({ statusCode: 502 });
  });

  it('the agent timeout covers the whole stream (504)', async () => {
    const url = await listen((_q, s) => {
      s.writeHead(200, { 'content-type': 'application/x-ndjson' });
      s.write('{"event":"progress","data":{}}\n'); // then hangs
    });
    await expect(drain(new ApiAgentConnector().streamAgent(cfg(url, { timeout: 150 }), req))).rejects.toMatchObject({ statusCode: 504 });
  });

  it('an explicit cancel signal aborts the call', async () => {
    const url = await listen((_q, s) => {
      s.writeHead(200, { 'content-type': 'application/x-ndjson' });
      s.write('{"event":"progress","data":{}}\n');
    });
    const ctl = new AbortController();
    const it = new ApiAgentConnector().streamAgent(cfg(url), req, ctl.signal);
    await it.next();
    ctl.abort();
    await expect(drain(it)).rejects.toThrow(/cancelled/);
  });
});
