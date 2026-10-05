/**
 * Request body limit: the LG_API_BODY_LIMIT knob, and that an oversized body
 * is reported as 413 rather than masked as 500 by the error handler.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadBodyLimit, DEFAULT_BODY_LIMIT } from '../src/config/env.config.js';
import { buildTestApp } from './test-helper.js';

const config = { port: 3000, host: '0.0.0.0', authEnabled: false, apiKey: '' };

/** A JSON body of roughly `bytes` bytes. */
function bodyOfSize(bytes: number): string {
  return JSON.stringify({ metadata: { blob: 'a'.repeat(bytes) } });
}

describe('loadBodyLimit', () => {
  it('documented default: 8 MiB', () => {
    expect(loadBodyLimit({})).toBe(8 * 1024 * 1024);
    expect(loadBodyLimit({})).toBe(DEFAULT_BODY_LIMIT);
    expect(loadBodyLimit({ LG_API_BODY_LIMIT: '' })).toBe(DEFAULT_BODY_LIMIT);
  });

  it('reads the value in bytes', () => {
    expect(loadBodyLimit({ LG_API_BODY_LIMIT: '1048576' })).toBe(1048576);
    expect(loadBodyLimit({ LG_API_BODY_LIMIT: ' 2000 ' })).toBe(2000);
  });

  it('throws on an invalid value instead of guessing', () => {
    expect(() => loadBodyLimit({ LG_API_BODY_LIMIT: '0' })).toThrow(/LG_API_BODY_LIMIT/);
    expect(() => loadBodyLimit({ LG_API_BODY_LIMIT: '-1' })).toThrow(/LG_API_BODY_LIMIT/);
    expect(() => loadBodyLimit({ LG_API_BODY_LIMIT: '8mb' })).toThrow(/LG_API_BODY_LIMIT/);
    expect(() => loadBodyLimit({ LG_API_BODY_LIMIT: '1.5' })).toThrow(/LG_API_BODY_LIMIT/);
  });
});

describe('request body limit', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('accepts a body above Fastify\'s 1 MiB default under the 8 MiB default', async () => {
    app = await buildTestApp(config);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/threads',
      headers: { 'content-type': 'application/json' },
      payload: bodyOfSize(2 * 1024 * 1024),
    });

    expect(res.statusCode).toBe(200);
  });

  it('rejects a body over the limit with 413, not 500', async () => {
    app = await buildTestApp({ ...config, bodyLimit: 1024 });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/threads',
      headers: { 'content-type': 'application/json' },
      payload: bodyOfSize(4096),
    });

    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.payload).detail).toMatch(/body/i);
  });
});
