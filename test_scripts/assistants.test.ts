/**
 * Integration tests for the Assistants API module.
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
import assistantsRoutes from '../src/modules/assistants/assistants.routes.js';
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
  await instance.register(errorHandlerPlugin);
  await instance.register(assistantsRoutes);
  await instance.ready();
  return instance;
}

/** Helper: create an assistant and return parsed body */
async function createAssistant(
  appInstance: FastifyInstance,
  overrides: Record<string, unknown> = {}
) {
  const payload = { graph_id: 'test-graph', ...overrides };
  const res = await appInstance.inject({
    method: 'POST',
    url: '/assistants',
    headers: { 'content-type': 'application/json' },
    payload,
  });
  return { res, body: JSON.parse(res.body) };
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('Assistants API', () => {
  beforeEach(async () => {
    app = await createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  // -------------------------------------------------------------------------
  // POST /assistants
  // -------------------------------------------------------------------------
  describe('POST /assistants', () => {
    it('should create an assistant and return 200 with expected shape', async () => {
      const { res, body } = await createAssistant(app);

      expect(res.statusCode).toBe(200);
      expect(body).toHaveProperty('assistant_id');
      expect(body).toHaveProperty('graph_id', 'test-graph');
      expect(body).toHaveProperty('config');
      expect(body).toHaveProperty('created_at');
      expect(body).toHaveProperty('updated_at');
      expect(body).toHaveProperty('metadata');
      expect(body).toHaveProperty('version', 1);
      expect(body).toHaveProperty('name');
      expect(body).toHaveProperty('description');
    });

    it('should create with a custom assistant_id', async () => {
      const customId = randomUUID();
      const { res, body } = await createAssistant(app, {
        assistant_id: customId,
      });

      expect(res.statusCode).toBe(200);
      expect(body.assistant_id).toBe(customId);
    });

    it('should return existing assistant with if_exists=do_nothing', async () => {
      const customId = randomUUID();
      // First creation
      const { body: first } = await createAssistant(app, {
        assistant_id: customId,
      });

      // Second creation with do_nothing
      const { res, body: second } = await createAssistant(app, {
        assistant_id: customId,
        if_exists: 'do_nothing',
      });

      expect(res.statusCode).toBe(200);
      expect(second.assistant_id).toBe(customId);
      expect(second.version).toBe(first.version);
      expect(second.created_at).toBe(first.created_at);
    });

    it('should return 409 with if_exists=raise for duplicate', async () => {
      const customId = randomUUID();
      await createAssistant(app, { assistant_id: customId });

      const { res } = await createAssistant(app, {
        assistant_id: customId,
        if_exists: 'raise',
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('detail');
    });
  });

  // -------------------------------------------------------------------------
  // GET /assistants/:assistant_id
  // -------------------------------------------------------------------------
  describe('GET /assistants/:assistant_id', () => {
    it('should return 200 for an existing assistant', async () => {
      const { body: created } = await createAssistant(app);

      const res = await app.inject({
        method: 'GET',
        url: `/assistants/${created.assistant_id}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.assistant_id).toBe(created.assistant_id);
      expect(body.graph_id).toBe('test-graph');
    });

    it('should return 404 for a non-existent assistant', async () => {
      const fakeId = randomUUID();
      const res = await app.inject({
        method: 'GET',
        url: `/assistants/${fakeId}`,
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('detail');
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /assistants/:assistant_id
  // -------------------------------------------------------------------------
  describe('PATCH /assistants/:assistant_id', () => {
    it('should update an assistant and increment version', async () => {
      const { body: created } = await createAssistant(app);

      const res = await app.inject({
        method: 'PATCH',
        url: `/assistants/${created.assistant_id}`,
        headers: { 'content-type': 'application/json' },
        payload: { name: 'updated-name', metadata: { env: 'test' } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.name).toBe('updated-name');
      expect(body.version).toBe(created.version + 1);
      expect(body.metadata).toEqual({ env: 'test' });
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /assistants/:assistant_id
  // -------------------------------------------------------------------------
  describe('DELETE /assistants/:assistant_id', () => {
    it('should delete an existing assistant and return 204', async () => {
      const { body: created } = await createAssistant(app);

      const res = await app.inject({
        method: 'DELETE',
        url: `/assistants/${created.assistant_id}`,
      });

      expect(res.statusCode).toBe(204);

      // Verify it is gone
      const getRes = await app.inject({
        method: 'GET',
        url: `/assistants/${created.assistant_id}`,
      });
      expect(getRes.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // POST /assistants/search
  // -------------------------------------------------------------------------
  describe('POST /assistants/search', () => {
    it('should return all assistants when body is empty', async () => {
      await createAssistant(app, { graph_id: 'g1' });
      await createAssistant(app, { graph_id: 'g2' });

      const res = await app.inject({
        method: 'POST',
        url: '/assistants/search',
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

    it('should filter by graph_id', async () => {
      await createAssistant(app, { graph_id: 'alpha' });
      await createAssistant(app, { graph_id: 'beta' });

      const res = await app.inject({
        method: 'POST',
        url: '/assistants/search',
        headers: { 'content-type': 'application/json' },
        payload: { graph_id: 'alpha' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.length).toBe(1);
      expect(body[0].graph_id).toBe('alpha');
    });
  });

  // -------------------------------------------------------------------------
  // POST /assistants/count
  // -------------------------------------------------------------------------
  describe('POST /assistants/count', () => {
    it('should count all assistants', async () => {
      await createAssistant(app, { graph_id: 'cnt1' });
      await createAssistant(app, { graph_id: 'cnt2' });

      const res = await app.inject({
        method: 'POST',
        url: '/assistants/count',
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
  // GET /assistants/:assistant_id/graph
  // -------------------------------------------------------------------------
  describe('GET /assistants/:assistant_id/graph', () => {
    it('should return graph JSON for an existing assistant', async () => {
      const { body: created } = await createAssistant(app);

      const res = await app.inject({
        method: 'GET',
        url: `/assistants/${created.assistant_id}/graph`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('nodes');
      expect(body).toHaveProperty('edges');
      expect(Array.isArray(body.nodes)).toBe(true);
      expect(Array.isArray(body.edges)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // GET /assistants/:assistant_id/schemas
  // -------------------------------------------------------------------------
  describe('GET /assistants/:assistant_id/schemas', () => {
    it('should return schemas JSON for an existing assistant', async () => {
      const { body: created } = await createAssistant(app);

      const res = await app.inject({
        method: 'GET',
        url: `/assistants/${created.assistant_id}/schemas`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('graph_id', 'test-graph');
      expect(body).toHaveProperty('input_schema');
      expect(body).toHaveProperty('output_schema');
      expect(body).toHaveProperty('state_schema');
      expect(body).toHaveProperty('config_schema');
    });
  });

  // -------------------------------------------------------------------------
  // GET /assistants/:assistant_id/subgraphs
  // -------------------------------------------------------------------------
  describe('GET /assistants/:assistant_id/subgraphs', () => {
    it('should return an object (empty stub) for an existing assistant', async () => {
      const { body: created } = await createAssistant(app);

      const res = await app.inject({
        method: 'GET',
        url: `/assistants/${created.assistant_id}/subgraphs`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(typeof body).toBe('object');
    });
  });

  // -------------------------------------------------------------------------
  // POST /assistants/:assistant_id/versions
  // -------------------------------------------------------------------------
  describe('POST /assistants/:assistant_id/versions', () => {
    it('should list versions of an assistant', async () => {
      const { body: created } = await createAssistant(app);

      // Update once to create version 2
      await app.inject({
        method: 'PATCH',
        url: `/assistants/${created.assistant_id}`,
        headers: { 'content-type': 'application/json' },
        payload: { name: 'v2-name' },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/assistants/${created.assistant_id}/versions`,
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
  });

  // -------------------------------------------------------------------------
  // POST /assistants/:assistant_id/latest
  // -------------------------------------------------------------------------
  describe('POST /assistants/:assistant_id/latest', () => {
    it('should set the latest version of an assistant', async () => {
      const { body: created } = await createAssistant(app);

      // Update to create version 2
      await app.inject({
        method: 'PATCH',
        url: `/assistants/${created.assistant_id}`,
        headers: { 'content-type': 'application/json' },
        payload: { name: 'v2-name' },
      });

      // Restore version 1
      const res = await app.inject({
        method: 'POST',
        url: `/assistants/${created.assistant_id}/latest`,
        headers: { 'content-type': 'application/json' },
        payload: { version: 1 },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('assistant_id', created.assistant_id);
      expect(body).toHaveProperty('version');
    });
  });
});
