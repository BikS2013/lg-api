/**
 * Crons API Tests
 *
 * Tests for the crons module endpoints including create, update,
 * delete, search, and count operations.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './test-helper.js';
import { randomUUID } from 'crypto';

const config = { port: 3000, host: '0.0.0.0', authEnabled: false, apiKey: '' };

let app: FastifyInstance;

async function createThread(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/threads',
    payload: { metadata: {} },
  });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.payload);
  return body.thread_id;
}

describe('Crons API', () => {
  beforeEach(async () => {
    app = await buildTestApp(config);
    await app.ready();
  });

  // -------------------------------------------------------------------
  // POST /runs/crons - Create stateless cron
  // -------------------------------------------------------------------
  describe('POST /runs/crons', () => {
    it('should create a stateless cron (201)', async () => {
      const assistantId = randomUUID();

      const res = await app.inject({
        method: 'POST',
        url: '/runs/crons',
        payload: {
          assistant_id: assistantId,
          schedule: '*/5 * * * *',
          metadata: { label: 'test-cron' },
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty('cron_id');
      expect(body).toHaveProperty('assistant_id', assistantId);
      expect(body).toHaveProperty('schedule', '*/5 * * * *');
      expect(body).toHaveProperty('thread_id', null);
      expect(body).toHaveProperty('created_at');
      expect(body).toHaveProperty('updated_at');
      expect(body).toHaveProperty('enabled', true);
      expect(body).toHaveProperty('metadata');
      expect(body.metadata).toEqual({ label: 'test-cron' });
    });
  });

  // -------------------------------------------------------------------
  // POST /threads/:thread_id/runs/crons - Create stateful cron
  // -------------------------------------------------------------------
  describe('POST /threads/:thread_id/runs/crons', () => {
    it('should create a stateful cron (201)', async () => {
      const threadId = await createThread();
      const assistantId = randomUUID();

      const res = await app.inject({
        method: 'POST',
        url: `/threads/${threadId}/runs/crons`,
        payload: {
          assistant_id: assistantId,
          schedule: '0 * * * *',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty('cron_id');
      expect(body).toHaveProperty('assistant_id', assistantId);
      expect(body).toHaveProperty('thread_id', threadId);
      expect(body).toHaveProperty('schedule', '0 * * * *');
      expect(body).toHaveProperty('enabled', true);
    });
  });

  // -------------------------------------------------------------------
  // PATCH /runs/crons/:cron_id - Update cron
  // -------------------------------------------------------------------
  describe('PATCH /runs/crons/:cron_id', () => {
    it('should update a cron (200)', async () => {
      const assistantId = randomUUID();

      // Create a cron first
      const createRes = await app.inject({
        method: 'POST',
        url: '/runs/crons',
        payload: {
          assistant_id: assistantId,
          schedule: '*/5 * * * *',
        },
      });
      const created = JSON.parse(createRes.payload);

      // Update the cron
      const res = await app.inject({
        method: 'PATCH',
        url: `/runs/crons/${created.cron_id}`,
        payload: {
          schedule: '*/10 * * * *',
          enabled: false,
          metadata: { updated: true },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty('cron_id', created.cron_id);
      expect(body).toHaveProperty('schedule', '*/10 * * * *');
      expect(body).toHaveProperty('enabled', false);
      expect(body.metadata).toEqual({ updated: true });
    });

    it('should return 404 for non-existent cron update', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/runs/crons/${randomUUID()}`,
        payload: {
          schedule: '*/10 * * * *',
        },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // DELETE /runs/crons/:cron_id - Delete cron
  // -------------------------------------------------------------------
  describe('DELETE /runs/crons/:cron_id', () => {
    it('should delete a cron (204)', async () => {
      const assistantId = randomUUID();

      // Create a cron first
      const createRes = await app.inject({
        method: 'POST',
        url: '/runs/crons',
        payload: {
          assistant_id: assistantId,
          schedule: '*/5 * * * *',
        },
      });
      const created = JSON.parse(createRes.payload);

      // Delete it
      const res = await app.inject({
        method: 'DELETE',
        url: `/runs/crons/${created.cron_id}`,
      });

      expect(res.statusCode).toBe(204);
    });

    it('should return 404 for non-existent cron delete', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/runs/crons/${randomUUID()}`,
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // POST /runs/crons/search - Search crons
  // -------------------------------------------------------------------
  describe('POST /runs/crons/search', () => {
    it('should search crons and return an array', async () => {
      const assistantId = randomUUID();

      // Create a cron
      await app.inject({
        method: 'POST',
        url: '/runs/crons',
        payload: {
          assistant_id: assistantId,
          schedule: '*/5 * * * *',
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/runs/crons/search',
        payload: {
          assistant_id: assistantId,
          limit: 10,
          offset: 0,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body[0]).toHaveProperty('cron_id');
      expect(body[0]).toHaveProperty('assistant_id', assistantId);
    });

    it('should return empty array when no crons match', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/runs/crons/search',
        payload: {
          assistant_id: randomUUID(),
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // POST /runs/crons/count - Count crons
  // -------------------------------------------------------------------
  describe('POST /runs/crons/count', () => {
    it('should count crons', async () => {
      const assistantId = randomUUID();

      // Create two crons
      await app.inject({
        method: 'POST',
        url: '/runs/crons',
        payload: { assistant_id: assistantId, schedule: '*/5 * * * *' },
      });
      await app.inject({
        method: 'POST',
        url: '/runs/crons',
        payload: { assistant_id: assistantId, schedule: '*/10 * * * *' },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/runs/crons/count',
        payload: {
          assistant_id: assistantId,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty('count');
      expect(body.count).toBeGreaterThanOrEqual(2);
    });

    it('should return zero count for non-matching filter', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/runs/crons/count',
        payload: {
          assistant_id: randomUUID(),
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty('count', 0);
    });
  });
});
