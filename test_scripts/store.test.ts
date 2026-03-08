/**
 * Store API Tests
 *
 * Tests for the store module endpoints including put, get, delete,
 * search, and list namespaces operations.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './test-helper.js';

const config = { port: 3000, host: '0.0.0.0', authEnabled: false, apiKey: '' };

let app: FastifyInstance;

describe('Store API', () => {
  beforeEach(async () => {
    app = await buildTestApp(config);
    await app.ready();
  });

  // -------------------------------------------------------------------
  // PUT /store/items - Create item
  // -------------------------------------------------------------------
  describe('PUT /store/items', () => {
    it('should create an item (200)', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/store/items',
        payload: {
          namespace: ['test', 'ns'],
          key: 'item-1',
          value: { name: 'Test Item', score: 42 },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty('namespace');
      expect(body.namespace).toEqual(['test', 'ns']);
      expect(body).toHaveProperty('key', 'item-1');
      expect(body).toHaveProperty('value');
      expect(body.value).toEqual({ name: 'Test Item', score: 42 });
      expect(body).toHaveProperty('created_at');
      expect(body).toHaveProperty('updated_at');
    });

    it('should update an existing item (200)', async () => {
      // Create
      await app.inject({
        method: 'PUT',
        url: '/store/items',
        payload: {
          namespace: ['test', 'update'],
          key: 'key-1',
          value: { version: 1 },
        },
      });

      // Update
      const res = await app.inject({
        method: 'PUT',
        url: '/store/items',
        payload: {
          namespace: ['test', 'update'],
          key: 'key-1',
          value: { version: 2 },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.value).toEqual({ version: 2 });
    });
  });

  // -------------------------------------------------------------------
  // GET /store/items - Get item
  // -------------------------------------------------------------------
  describe('GET /store/items', () => {
    it('should get an existing item by namespace and key', async () => {
      // Create an item first
      await app.inject({
        method: 'PUT',
        url: '/store/items',
        payload: {
          namespace: ['get', 'test'],
          key: 'my-key',
          value: { data: 'hello' },
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/store/items',
        query: {
          namespace: JSON.stringify(['get', 'test']),
          key: 'my-key',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty('namespace');
      expect(body.namespace).toEqual(['get', 'test']);
      expect(body).toHaveProperty('key', 'my-key');
      expect(body).toHaveProperty('value');
      expect(body.value).toEqual({ data: 'hello' });
    });

    it('should return 404 for non-existent item', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/store/items',
        query: {
          namespace: JSON.stringify(['nonexistent']),
          key: 'no-such-key',
        },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty('detail');
    });
  });

  // -------------------------------------------------------------------
  // DELETE /store/items - Delete item
  // -------------------------------------------------------------------
  describe('DELETE /store/items', () => {
    it('should delete an item (204)', async () => {
      // Create an item first
      await app.inject({
        method: 'PUT',
        url: '/store/items',
        payload: {
          namespace: ['delete', 'test'],
          key: 'del-key',
          value: { temp: true },
        },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: '/store/items',
        payload: {
          namespace: ['delete', 'test'],
          key: 'del-key',
        },
      });

      expect(res.statusCode).toBe(204);

      // Verify item is gone
      const getRes = await app.inject({
        method: 'GET',
        url: '/store/items',
        query: {
          namespace: JSON.stringify(['delete', 'test']),
          key: 'del-key',
        },
      });

      expect(getRes.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // POST /store/items/search - Search items
  // -------------------------------------------------------------------
  describe('POST /store/items/search', () => {
    it('should search items under a namespace prefix', async () => {
      // Create items
      await app.inject({
        method: 'PUT',
        url: '/store/items',
        payload: {
          namespace: ['search', 'ns'],
          key: 'item-a',
          value: { label: 'A' },
        },
      });
      await app.inject({
        method: 'PUT',
        url: '/store/items',
        payload: {
          namespace: ['search', 'ns'],
          key: 'item-b',
          value: { label: 'B' },
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/store/items/search',
        payload: {
          namespace_prefix: ['search', 'ns'],
          limit: 10,
          offset: 0,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(2);
      expect(body[0]).toHaveProperty('namespace');
      expect(body[0]).toHaveProperty('key');
      expect(body[0]).toHaveProperty('value');
    });

    it('should return empty array for non-matching namespace prefix', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/store/items/search',
        payload: {
          namespace_prefix: ['no', 'match'],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // POST /store/namespaces - List namespaces
  // -------------------------------------------------------------------
  describe('POST /store/namespaces', () => {
    it('should list namespaces', async () => {
      // Create an item to ensure at least one namespace exists
      await app.inject({
        method: 'PUT',
        url: '/store/items',
        payload: {
          namespace: ['list', 'ns', 'test'],
          key: 'key-1',
          value: { data: 1 },
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/store/namespaces',
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
    });

    it('should filter namespaces by prefix', async () => {
      // Create items in different namespaces
      await app.inject({
        method: 'PUT',
        url: '/store/items',
        payload: {
          namespace: ['prefix-filter', 'sub1'],
          key: 'k1',
          value: { x: 1 },
        },
      });
      await app.inject({
        method: 'PUT',
        url: '/store/items',
        payload: {
          namespace: ['prefix-filter', 'sub2'],
          key: 'k2',
          value: { x: 2 },
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/store/namespaces',
        payload: {
          prefix: ['prefix-filter'],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
      // Should include namespaces starting with ['prefix-filter']
      for (const ns of body) {
        expect(ns[0]).toBe('prefix-filter');
      }
    });
  });
});
