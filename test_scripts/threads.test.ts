/**
 * Integration tests for the Threads API module.
 *
 * Uses Fastify's inject() method — no real HTTP server is started.
 * Auth is disabled via the test AppConfig.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { AppConfig } from '../src/config/env.config.js';
import errorHandlerPlugin from '../src/plugins/error-handler.plugin.js';
import threadsRoutes from '../src/modules/threads/threads.routes.js';
import { randomUUID } from 'node:crypto';

const TEST_CONFIG: AppConfig = {
  port: 3000,
  host: '0.0.0.0',
  authEnabled: false,
  apiKey: '',
};

let app: FastifyInstance;

async function createTestApp(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  instance.decorate('config', TEST_CONFIG);

  // Bypass response serialization to avoid duplicate $id conflicts in
  // schemas that embed CheckpointSchema multiple times.
  instance.setSerializerCompiler(() => {
    return (data) => JSON.stringify(data);
  });

  await instance.register(errorHandlerPlugin);
  await instance.register(threadsRoutes);
  await instance.ready();
  return instance;
}

/** Helper: create a thread and return parsed body */
async function createThread(
  appInstance: FastifyInstance,
  overrides: Record<string, unknown> = {}
) {
  const payload = { ...overrides };
  const res = await appInstance.inject({
    method: 'POST',
    url: '/threads',
    headers: { 'content-type': 'application/json' },
    payload,
  });
  return { res, body: JSON.parse(res.body) };
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('Threads API', () => {
  beforeEach(async () => {
    app = await createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  // -------------------------------------------------------------------------
  // POST /threads
  // -------------------------------------------------------------------------
  describe('POST /threads', () => {
    it('should create a thread and return 200 with expected shape', async () => {
      const { res, body } = await createThread(app);

      expect(res.statusCode).toBe(200);
      expect(body).toHaveProperty('thread_id');
      expect(body).toHaveProperty('created_at');
      expect(body).toHaveProperty('updated_at');
      expect(body).toHaveProperty('metadata');
      expect(body).toHaveProperty('status', 'idle');
    });

    it('should create with a custom thread_id', async () => {
      const customId = randomUUID();
      const { res, body } = await createThread(app, { thread_id: customId });

      expect(res.statusCode).toBe(200);
      expect(body.thread_id).toBe(customId);
    });
  });

  // -------------------------------------------------------------------------
  // GET /threads/:thread_id
  // -------------------------------------------------------------------------
  describe('GET /threads/:thread_id', () => {
    it('should return 200 for an existing thread', async () => {
      const { body: created } = await createThread(app);

      const res = await app.inject({
        method: 'GET',
        url: `/threads/${created.thread_id}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.thread_id).toBe(created.thread_id);
      expect(body.status).toBe('idle');
    });

    it('should return 404 for a non-existent thread', async () => {
      const fakeId = randomUUID();
      const res = await app.inject({
        method: 'GET',
        url: `/threads/${fakeId}`,
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('detail');
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /threads/:thread_id
  // -------------------------------------------------------------------------
  describe('PATCH /threads/:thread_id', () => {
    it('should update metadata of an existing thread', async () => {
      const { body: created } = await createThread(app);

      const res = await app.inject({
        method: 'PATCH',
        url: `/threads/${created.thread_id}`,
        headers: { 'content-type': 'application/json' },
        payload: { metadata: { env: 'staging' } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.metadata).toEqual({ env: 'staging' });
      expect(body.thread_id).toBe(created.thread_id);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /threads/:thread_id
  // -------------------------------------------------------------------------
  describe('DELETE /threads/:thread_id', () => {
    it('should delete an existing thread and return 204', async () => {
      const { body: created } = await createThread(app);

      const res = await app.inject({
        method: 'DELETE',
        url: `/threads/${created.thread_id}`,
      });

      expect(res.statusCode).toBe(204);

      // Verify it is gone
      const getRes = await app.inject({
        method: 'GET',
        url: `/threads/${created.thread_id}`,
      });
      expect(getRes.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // POST /threads/search
  // -------------------------------------------------------------------------
  describe('POST /threads/search', () => {
    it('should return all threads when body is empty', async () => {
      await createThread(app, { metadata: { tag: 'a' } });
      await createThread(app, { metadata: { tag: 'b' } });

      const res = await app.inject({
        method: 'POST',
        url: '/threads/search',
        headers: { 'content-type': 'application/json' },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(2);

      // Pagination headers
      expect(res.headers['x-pagination-total']).toBeDefined();
      expect(res.headers['x-pagination-offset']).toBeDefined();
      expect(res.headers['x-pagination-limit']).toBeDefined();
    });

    it('should filter by status', async () => {
      // All newly created threads are "idle"
      await createThread(app);

      const res = await app.inject({
        method: 'POST',
        url: '/threads/search',
        headers: { 'content-type': 'application/json' },
        payload: { status: 'idle' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
      body.forEach((t: any) => {
        expect(t.status).toBe('idle');
      });
    });
  });

  // -------------------------------------------------------------------------
  // POST /threads/count
  // -------------------------------------------------------------------------
  describe('POST /threads/count', () => {
    it('should count all threads', async () => {
      await createThread(app);
      await createThread(app);

      const res = await app.inject({
        method: 'POST',
        url: '/threads/count',
        headers: { 'content-type': 'application/json' },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const count = JSON.parse(res.body);
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThanOrEqual(2);
    });
  });

  // -------------------------------------------------------------------------
  // POST /threads/:thread_id/copy
  // -------------------------------------------------------------------------
  describe('POST /threads/:thread_id/copy', () => {
    it('should copy an existing thread to a new thread_id', async () => {
      const { body: original } = await createThread(app, {
        metadata: { origin: 'copy-test' },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/threads/${original.thread_id}/copy`,
        headers: { 'content-type': 'application/json' },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('thread_id');
      expect(body.thread_id).not.toBe(original.thread_id);
      expect(body.metadata).toEqual(original.metadata);
    });
  });

  // -------------------------------------------------------------------------
  // GET /threads/:thread_id/state
  // -------------------------------------------------------------------------
  describe('GET /threads/:thread_id/state', () => {
    it('should return a dummy state for a new thread', async () => {
      const { body: created } = await createThread(app);

      const res = await app.inject({
        method: 'GET',
        url: `/threads/${created.thread_id}/state`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('values');
      expect(body).toHaveProperty('next');
      expect(body).toHaveProperty('checkpoint');
      expect(body).toHaveProperty('metadata');
      expect(body).toHaveProperty('created_at');
      expect(body).toHaveProperty('tasks');
      expect(Array.isArray(body.next)).toBe(true);
      expect(Array.isArray(body.tasks)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // POST /threads/:thread_id/state
  // -------------------------------------------------------------------------
  describe('POST /threads/:thread_id/state', () => {
    it('should update state and return checkpoint info', async () => {
      const { body: created } = await createThread(app);

      const res = await app.inject({
        method: 'POST',
        url: `/threads/${created.thread_id}/state`,
        headers: { 'content-type': 'application/json' },
        payload: { values: { messages: ['hello'] } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('checkpoint');
      expect(body.checkpoint).toHaveProperty('thread_id', created.thread_id);
      expect(body.checkpoint).toHaveProperty('checkpoint_id');
      expect(body.checkpoint).toHaveProperty('checkpoint_ns');
    });
  });

  // -------------------------------------------------------------------------
  // POST /threads/:thread_id/history
  // -------------------------------------------------------------------------
  describe('POST /threads/:thread_id/history', () => {
    it('should return history array for an existing thread', async () => {
      const { body: created } = await createThread(app);

      // Add a state entry first
      await app.inject({
        method: 'POST',
        url: `/threads/${created.thread_id}/state`,
        headers: { 'content-type': 'application/json' },
        payload: { values: { step: 1 } },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/threads/${created.thread_id}/history`,
        headers: { 'content-type': 'application/json' },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);

      // Pagination headers
      expect(res.headers['x-pagination-total']).toBeDefined();
      expect(res.headers['x-pagination-limit']).toBeDefined();

      // Each entry should have ThreadState shape
      const entry = body[0];
      expect(entry).toHaveProperty('values');
      expect(entry).toHaveProperty('checkpoint');
      expect(entry).toHaveProperty('created_at');
    });
  });
});
