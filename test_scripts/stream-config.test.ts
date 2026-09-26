/**
 * Stream plumbing units: the `/runs/stream` environment knobs, the
 * StreamManager live fan-out, the join filter, the route registration of
 * the stateless rejoin endpoint, and that a leftover registry `streaming` key
 * is ignored.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { loadStreamConfig, DEFAULT_STREAM_CONFIG } from '../src/modules/runs/stream-config.js';
import { StreamManager, type StreamEvent } from '../src/streaming/stream-manager.js';
import { matchesStreamModes, runStreamLocation } from '../src/modules/runs/runs.streaming.js';
import { buildTestApp } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('loadStreamConfig', () => {
  it('documented defaults: heartbeat 5 s, end event on, typewriter on', () => {
    expect(loadStreamConfig({})).toEqual({
      heartbeatMs: 5000, endEvent: true, typewriter: true, typewriterChunkMs: 22, typewriterMaxMs: 1400,
    });
    expect(loadStreamConfig({})).toEqual(DEFAULT_STREAM_CONFIG);
  });

  it('reads every knob', () => {
    expect(loadStreamConfig({
      LG_API_STREAM_HEARTBEAT_MS: '0',
      LG_API_STREAM_END_EVENT: 'false',
      LG_API_TYPEWRITER: 'off',
      LG_API_TYPEWRITER_CHUNK_MS: '10',
      LG_API_TYPEWRITER_MAX_MS: '500',
    })).toEqual({ heartbeatMs: 0, endEvent: false, typewriter: false, typewriterChunkMs: 10, typewriterMaxMs: 500 });
    expect(loadStreamConfig({ LG_API_TYPEWRITER: 'on' }).typewriter).toBe(true);
    expect(loadStreamConfig({ LG_API_TYPEWRITER: 'FALSE' }).typewriter).toBe(false);
  });

  it('throws on an invalid value instead of guessing', () => {
    expect(() => loadStreamConfig({ LG_API_STREAM_END_EVENT: 'yes' })).toThrow(/LG_API_STREAM_END_EVENT/);
    expect(() => loadStreamConfig({ LG_API_STREAM_HEARTBEAT_MS: '-1' })).toThrow(/LG_API_STREAM_HEARTBEAT_MS/);
    expect(() => loadStreamConfig({ LG_API_TYPEWRITER_MAX_MS: 'abc' })).toThrow(/LG_API_TYPEWRITER_MAX_MS/);
    expect(() => loadStreamConfig({ LG_API_TYPEWRITER: 'maybe' })).toThrow(/LG_API_TYPEWRITER/);
  });
});

describe('StreamManager live fan-out', () => {
  it('publishes with sequential ids, buffers, delivers to subscribers, notifies close', () => {
    const sm = new StreamManager();
    sm.createSession('r', null, ['values']);
    const got: StreamEvent[] = [];
    let closed = 0;
    const unsubscribe = sm.subscribe('r', { onEvent: (e) => got.push(e), onClose: () => closed++ })!;
    sm.publish('r', 'metadata', '{}');
    sm.publish('r', 'values', '{"a":1}');
    expect(got.map((e) => e.id)).toEqual(['1', '2']);
    unsubscribe();
    sm.publish('r', 'end', 'null');
    expect(got).toHaveLength(2);
    expect(sm.getEventsAfter('r', '-1')).toHaveLength(3);
    expect(sm.getEventsAfter('r', '2').map((e) => e.event)).toEqual(['end']);
    expect(sm.getEventsAfter('r', 'not-a-number')).toHaveLength(0); // unchanged pre-streaming behaviour
    sm.subscribe('r', { onEvent: () => {}, onClose: () => closed++ });
    sm.closeSession('r');
    expect(closed).toBe(1);
    expect(sm.publish('r', 'late', '{}')).toBeNull();
    expect(sm.subscribe('r', { onEvent: () => {}, onClose: () => {} })).toBeNull();
  });
});

describe('join helpers', () => {
  it('matchesStreamModes follows langgraph-api\'s join filter', () => {
    expect(matchesStreamModes('custom', undefined)).toBe(true);
    expect(matchesStreamModes('custom', [])).toBe(true);
    expect(matchesStreamModes('custom', ['values'])).toBe(false);
    expect(matchesStreamModes('values', ['values'])).toBe(true);
    expect(matchesStreamModes('metadata', ['values'])).toBe(true);
    expect(matchesStreamModes('end', ['values'])).toBe(true);
    expect(matchesStreamModes('error', ['values'])).toBe(true);
    expect(matchesStreamModes('messages', ['messages-tuple'])).toBe(true);
    expect(matchesStreamModes('messages/partial', ['messages-tuple'])).toBe(true);
    expect(matchesStreamModes('messages', ['messages'])).toBe(true);
    expect(matchesStreamModes('messages/complete', ['values'])).toBe(false);
  });

  it('runStreamLocation gives LangGraph\'s Location / Content-Location', () => {
    expect(runStreamLocation({ run_id: 'r', thread_id: 't' })).toEqual({ location: '/threads/t/runs/r/stream', contentLocation: '/threads/t/runs/r' });
    expect(runStreamLocation({ run_id: 'r', thread_id: null })).toEqual({ location: '/runs/r/stream', contentLocation: '/runs/r' });
  });
});

describe('route registration (full app)', () => {
  let app: FastifyInstance;
  afterAll(async () => { await app?.close(); });

  it('GET /runs/:run_id/stream exists (404 for an unknown run, 422 for a bad id)', async () => {
    app = await buildTestApp({ port: 0, host: '127.0.0.1', authEnabled: false, apiKey: '' });
    let res = await app.inject({ method: 'GET', url: '/runs/00000000-0000-4000-8000-000000000000/stream' });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'GET', url: '/runs/not-a-uuid/stream' });
    expect(res.statusCode).toBe(422);
  });

  it('join routes accept the LangGraph SDK\'s cancel_on_disconnect=0/1 (runs.joinStream sends it on every join)', async () => {
    app ??= await buildTestApp({ port: 0, host: '127.0.0.1', authEnabled: false, apiKey: '' });
    const run = '00000000-0000-4000-8000-000000000000';
    for (const v of ['0', '1', 'true', 'false']) {
      // 404 (unknown run) means the querystring passed validation.
      let res = await app.inject({ method: 'GET', url: `/runs/${run}/stream?cancel_on_disconnect=${v}&stream_mode=values&stream_mode=custom` });
      expect(res.statusCode, `stateless ${v}`).toBe(404);
      res = await app.inject({ method: 'GET', url: `/threads/${run}/runs/${run}/stream?cancel_on_disconnect=${v}` });
      expect(res.statusCode, `threaded ${v}`).toBe(404);
    }
    const res = await app.inject({ method: 'GET', url: `/runs/${run}/stream?cancel_on_disconnect=maybe` });
    expect(res.statusCode).toBe(422);
  });
});

describe('agent-registry: a leftover `streaming` key (removed opt-in flag)', () => {
  const saved = process.env['AGENT_REGISTRY_PATH'];
  afterAll(() => {
    if (saved === undefined) delete process.env['AGENT_REGISTRY_PATH'];
    else process.env['AGENT_REGISTRY_PATH'] = saved;
  });

  it('is ignored like any unknown key: the entry loads and its config shape is unchanged', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'lg-reg-')), 'agent-registry.yaml');
    writeFileSync(file, [
      'agents:',
      '  plain: { type: api, url: "http://x/invoke" }',
      '  flagged: { type: api, url: "http://x/invoke", streaming: true }',
      '  odd: { type: cli, command: node, streaming: "yes" }',
    ].join('\n'));
    process.env['AGENT_REGISTRY_PATH'] = file;
    const { AgentRegistry } = await import('../src/agents/agent-registry.js');
    const reg = new AgentRegistry();
    expect('streaming' in reg.getAgentConfig('flagged')!).toBe(false);
    expect('streaming' in reg.getAgentConfig('odd')!).toBe(false);
    expect(Object.keys(reg.getAgentConfig('flagged')!)).toEqual(Object.keys(reg.getAgentConfig('plain')!));
  });
});
