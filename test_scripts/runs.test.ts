/**
 * Runs API Tests
 *
 * Tests for the runs module endpoints including stateful runs,
 * stateless runs, batch creation, wait, cancel, and delete operations.
 *
 * Because the runs module uses its own ThreadsRepository instance (separate
 * from the threads routes' repository), we build a custom test app that
 * registers thread + run routes sharing the same ThreadsRepository.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import errorHandlerPlugin from '../src/plugins/error-handler.plugin.js';
import { ThreadsRepository } from '../src/modules/threads/threads.repository.js';
import { ThreadsService } from '../src/modules/threads/threads.service.js';
import { RunsRepository } from '../src/modules/runs/runs.repository.js';
import { RunsService } from '../src/modules/runs/runs.service.js';
import { randomUUID } from 'crypto';

const config = { port: 3000, host: '0.0.0.0', authEnabled: false, apiKey: '' };

let app: FastifyInstance;
let threadsService: ThreadsService;

/**
 * Build a test app with shared ThreadsRepository so that threads created
 * via the threads endpoint are visible to the runs service.
 */
async function buildRunsTestApp(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  instance.decorate('config', config);

  // Bypass response serialization to avoid $id conflicts
  instance.setSerializerCompiler(() => {
    return (data: any) => JSON.stringify(data);
  });

  await instance.register(errorHandlerPlugin);

  // Create shared repositories
  const sharedThreadsRepo = new ThreadsRepository();
  const runsRepo = new RunsRepository();
  const runsService = new RunsService(runsRepo, sharedThreadsRepo);
  threadsService = new ThreadsService(sharedThreadsRepo);

  // Register a minimal thread creation route using the shared repo
  instance.post('/threads', async (request, reply) => {
    const body = request.body as any;
    const thread = await threadsService.create(body ?? {});
    return reply.code(200).send(thread);
  });

  // Register all run routes manually using the shared services
  instance.post('/threads/:thread_id/runs', async (request, reply) => {
    const { thread_id } = request.params as { thread_id: string };
    const run = await runsService.createStateful(thread_id, request.body as any);
    return reply.code(200).send(run);
  });

  instance.post('/runs', async (request, reply) => {
    const run = await runsService.createStateless(request.body as any);
    return reply.code(200).send(run);
  });

  instance.post('/threads/:thread_id/runs/stream', async (request, reply) => {
    const { thread_id } = request.params as { thread_id: string };
    await runsService.streamRun(thread_id, request.body as any, reply);
  });

  instance.post('/runs/stream', async (request, reply) => {
    await runsService.streamRun(null, request.body as any, reply);
  });

  instance.post('/threads/:thread_id/runs/wait', async (request, reply) => {
    const { thread_id } = request.params as { thread_id: string };
    const result = await runsService.wait(thread_id, request.body as any);
    return reply.code(200).send(result);
  });

  instance.post('/runs/batch', async (request, reply) => {
    const runs = await runsService.createBatch(request.body as any[]);
    return reply.code(200).send(runs);
  });

  instance.get('/threads/:thread_id/runs', async (request, reply) => {
    const { thread_id } = request.params as { thread_id: string };
    const query = request.query as any;
    const result = await runsService.list(thread_id, query ?? {});
    return reply.code(200).send(result.items);
  });

  instance.get('/threads/:thread_id/runs/:run_id', async (request, reply) => {
    const { thread_id, run_id } = request.params as { thread_id: string; run_id: string };
    const run = await runsService.get(thread_id, run_id);
    return reply.code(200).send(run);
  });

  instance.post('/threads/:thread_id/runs/:run_id/cancel', async (request, reply) => {
    const { thread_id, run_id } = request.params as { thread_id: string; run_id: string };
    await runsService.cancel(thread_id, run_id, request.body as any ?? {});
    return reply.code(204).send();
  });

  instance.post('/runs/cancel', async (request, reply) => {
    await runsService.bulkCancel(request.body as any ?? {});
    return reply.code(204).send();
  });

  instance.delete('/threads/:thread_id/runs/:run_id', async (request, reply) => {
    const { thread_id, run_id } = request.params as { thread_id: string; run_id: string };
    await runsService.delete(thread_id, run_id);
    return reply.code(204).send();
  });

  await instance.ready();
  return instance;
}

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

describe('Runs API', () => {
  beforeEach(async () => {
    app = await buildRunsTestApp();
  });

  // -------------------------------------------------------------------
  // POST /threads/:thread_id/runs - Create stateful run
  // -------------------------------------------------------------------
  describe('POST /threads/:thread_id/runs', () => {
    it('should create a stateful run (200)', async () => {
      const threadId = await createThread();
      const assistantId = randomUUID();

      const res = await app.inject({
        method: 'POST',
        url: `/threads/${threadId}/runs`,
        payload: {
          assistant_id: assistantId,
          input: { messages: [{ role: 'user', content: 'hello' }] },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty('run_id');
      expect(body).toHaveProperty('thread_id', threadId);
      expect(body).toHaveProperty('assistant_id', assistantId);
      expect(body).toHaveProperty('status');
      expect(body).toHaveProperty('created_at');
      expect(body).toHaveProperty('updated_at');
      expect(body).toHaveProperty('metadata');
    });

    it('should return 404 for non-existent thread', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/threads/${randomUUID()}/runs`,
        payload: {
          assistant_id: randomUUID(),
        },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // GET /threads/:thread_id/runs - List runs
  // -------------------------------------------------------------------
  describe('GET /threads/:thread_id/runs', () => {
    it('should list runs for a thread', async () => {
      const threadId = await createThread();
      const assistantId = randomUUID();

      // Create a run first
      await app.inject({
        method: 'POST',
        url: `/threads/${threadId}/runs`,
        payload: { assistant_id: assistantId },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/threads/${threadId}/runs`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body[0]).toHaveProperty('run_id');
      expect(body[0]).toHaveProperty('thread_id', threadId);
    });

    it('should return empty array for thread with no runs', async () => {
      const threadId = await createThread();

      const res = await app.inject({
        method: 'GET',
        url: `/threads/${threadId}/runs`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // GET /threads/:thread_id/runs/:run_id - Get specific run
  // -------------------------------------------------------------------
  describe('GET /threads/:thread_id/runs/:run_id', () => {
    it('should get a specific run', async () => {
      const threadId = await createThread();
      const assistantId = randomUUID();

      const createRes = await app.inject({
        method: 'POST',
        url: `/threads/${threadId}/runs`,
        payload: { assistant_id: assistantId },
      });
      const created = JSON.parse(createRes.payload);

      const res = await app.inject({
        method: 'GET',
        url: `/threads/${threadId}/runs/${created.run_id}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty('run_id', created.run_id);
      expect(body).toHaveProperty('thread_id', threadId);
    });

    it('should return 404 for non-existent run', async () => {
      const threadId = await createThread();

      const res = await app.inject({
        method: 'GET',
        url: `/threads/${threadId}/runs/${randomUUID()}`,
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // POST /threads/:thread_id/runs/:run_id/cancel - Cancel run
  // -------------------------------------------------------------------
  describe('POST /threads/:thread_id/runs/:run_id/cancel', () => {
    it('should cancel a pending/running run (204)', async () => {
      const threadId = await createThread();
      const assistantId = randomUUID();

      const createRes = await app.inject({
        method: 'POST',
        url: `/threads/${threadId}/runs`,
        payload: { assistant_id: assistantId },
      });
      const created = JSON.parse(createRes.payload);

      const res = await app.inject({
        method: 'POST',
        url: `/threads/${threadId}/runs/${created.run_id}/cancel`,
        payload: {},
      });

      expect(res.statusCode).toBe(204);
    });

    it('should return 404 for non-existent run cancel', async () => {
      const threadId = await createThread();

      const res = await app.inject({
        method: 'POST',
        url: `/threads/${threadId}/runs/${randomUUID()}/cancel`,
        payload: {},
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // DELETE /threads/:thread_id/runs/:run_id - Delete run
  // -------------------------------------------------------------------
  describe('DELETE /threads/:thread_id/runs/:run_id', () => {
    it('should delete a run (204)', async () => {
      const threadId = await createThread();
      const assistantId = randomUUID();

      const createRes = await app.inject({
        method: 'POST',
        url: `/threads/${threadId}/runs`,
        payload: { assistant_id: assistantId },
      });
      const created = JSON.parse(createRes.payload);

      // Wait briefly for the run to complete
      await new Promise((resolve) => setTimeout(resolve, 200));

      const res = await app.inject({
        method: 'DELETE',
        url: `/threads/${threadId}/runs/${created.run_id}`,
      });

      expect(res.statusCode).toBe(204);
    });

    it('should return 404 when deleting non-existent run', async () => {
      const threadId = await createThread();

      const res = await app.inject({
        method: 'DELETE',
        url: `/threads/${threadId}/runs/${randomUUID()}`,
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // POST /runs - Create stateless run
  // -------------------------------------------------------------------
  describe('POST /runs', () => {
    it('should create a stateless run (200)', async () => {
      const assistantId = randomUUID();

      const res = await app.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          assistant_id: assistantId,
          input: { messages: [{ role: 'user', content: 'test' }] },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty('run_id');
      expect(body).toHaveProperty('thread_id', null);
      expect(body).toHaveProperty('assistant_id', assistantId);
      expect(body).toHaveProperty('status');
    });
  });

  // -------------------------------------------------------------------
  // POST /threads/:thread_id/runs/wait - Wait for run
  // -------------------------------------------------------------------
  describe('POST /threads/:thread_id/runs/wait', () => {
    it('should wait for a run and return completed result (200)', async () => {
      const threadId = await createThread();
      const assistantId = randomUUID();

      const res = await app.inject({
        method: 'POST',
        url: `/threads/${threadId}/runs/wait`,
        payload: {
          assistant_id: assistantId,
          input: { messages: [{ role: 'user', content: 'wait test' }] },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty('run_id');
      expect(body).toHaveProperty('thread_id', threadId);
      expect(body).toHaveProperty('status');
      expect(body).toHaveProperty('result');
      expect(body.result).toHaveProperty('messages');
      expect(Array.isArray(body.result.messages)).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // POST /runs/batch - Batch create runs
  // -------------------------------------------------------------------
  describe('POST /runs/batch', () => {
    it('should batch create multiple runs (200)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/runs/batch',
        payload: [
          { assistant_id: randomUUID() },
          { assistant_id: randomUUID() },
        ],
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(2);
      expect(body[0]).toHaveProperty('run_id');
      expect(body[1]).toHaveProperty('run_id');
      expect(body[0].run_id).not.toBe(body[1].run_id);
    });
  });

  // -------------------------------------------------------------------
  // POST /runs/cancel - Bulk cancel runs
  // -------------------------------------------------------------------
  describe('POST /runs/cancel', () => {
    it('should bulk cancel runs (204)', async () => {
      const threadId = await createThread();
      const assistantId = randomUUID();

      // Create a run
      const createRes = await app.inject({
        method: 'POST',
        url: `/threads/${threadId}/runs`,
        payload: { assistant_id: assistantId },
      });
      const created = JSON.parse(createRes.payload);

      const res = await app.inject({
        method: 'POST',
        url: '/runs/cancel',
        payload: {
          run_ids: [created.run_id],
        },
      });

      expect(res.statusCode).toBe(204);
    });

    it('should bulk cancel with empty payload (204)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/runs/cancel',
        payload: {},
      });

      expect(res.statusCode).toBe(204);
    });
  });
});
