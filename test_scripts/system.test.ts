/**
 * System Endpoint Tests
 *
 * Tests for system-level endpoints: health check and server info.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './test-helper.js';

const config = { port: 3000, host: '0.0.0.0', authEnabled: false, apiKey: '' };

let app: FastifyInstance;

describe('System API', () => {
  beforeEach(async () => {
    app = await buildTestApp(config);
    await app.ready();
  });

  // -------------------------------------------------------------------
  // GET /ok - Health check
  // -------------------------------------------------------------------
  describe('GET /ok', () => {
    it('should return 200 with { ok: true }', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/ok',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toEqual({ ok: true });
    });

    it('should have content-type application/json', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/ok',
      });

      expect(res.headers['content-type']).toContain('application/json');
    });
  });

  // -------------------------------------------------------------------
  // GET /info - Server info
  // -------------------------------------------------------------------
  describe('GET /info', () => {
    it('should return 200 with server info', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/info',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty('version');
      expect(body).toHaveProperty('name');
      expect(body).toHaveProperty('capabilities');
    });

    it('should include version and name fields', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/info',
      });

      const body = JSON.parse(res.payload);
      expect(typeof body.version).toBe('string');
      expect(typeof body.name).toBe('string');
      expect(body.name).toBe('lg-api');
    });

    it('should include all expected capabilities', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/info',
      });

      const body = JSON.parse(res.payload);
      expect(body.capabilities).toHaveProperty('assistants');
      expect(body.capabilities).toHaveProperty('threads');
      expect(body.capabilities).toHaveProperty('runs');
      expect(body.capabilities).toHaveProperty('crons');
      expect(body.capabilities).toHaveProperty('store');
      expect(body.capabilities).toHaveProperty('streaming');

      // All capabilities should be booleans
      for (const [, value] of Object.entries(body.capabilities)) {
        expect(typeof value).toBe('boolean');
      }
    });

    it('should report all capabilities as true', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/info',
      });

      const body = JSON.parse(res.payload);
      expect(body.capabilities.assistants).toBe(true);
      expect(body.capabilities.threads).toBe(true);
      expect(body.capabilities.runs).toBe(true);
      expect(body.capabilities.crons).toBe(true);
      expect(body.capabilities.store).toBe(true);
      expect(body.capabilities.streaming).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // Non-existent endpoint
  // -------------------------------------------------------------------
  describe('Non-existent routes', () => {
    it('should return 404 for unknown routes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/nonexistent-route',
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
