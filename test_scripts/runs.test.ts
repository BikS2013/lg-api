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
import { RequestComposer } from '../src/agents/request-composer.js';
import type { AgentExecutor } from '../src/agents/agent-executor.js';
import type { AssistantResolver } from '../src/agents/assistant-resolver.js';
import { randomUUID } from 'crypto';

const config = { port: 3000, host: '0.0.0.0', authEnabled: false, apiKey: '' };

/**
 * Mock AssistantResolver that returns a fake assistant echoing the requested ID.
 */
function createMockAssistantResolver(): AssistantResolver {
  return {
    resolve: async (assistantIdOrGraphId: string) => ({
      assistant_id: assistantIdOrGraphId,
      graph_id: 'test-graph',
      name: 'Test Assistant',
      description: null,
      config: {},
      metadata: {},
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  } as unknown as AssistantResolver;
}

/**
 * Mock AgentExecutor that returns a canned response without spawning agents.
 */
function createMockAgentExecutor(): AgentExecutor {
  return {
    execute: async (_graphId: string, request: any) => ({
      thread_id: request.thread_id,
      run_id: request.run_id,
      messages: [{ role: 'assistant', content: 'Mock agent response.' }],
    }),
    stream: async function* (_graphId: string, request: any) {
      yield { event: 'metadata', data: { run_id: request.run_id, thread_id: request.thread_id } };
      yield { event: 'values', data: { messages: [{ type: 'ai', content: 'Mock streamed response.' }] } };
      yield { event: 'end', data: null };
    },
  } as unknown as AgentExecutor;
}

/**
 * Mock AgentExecutor that echoes the request's state back as a full snapshot,
 * mirroring how the deployed payments-agent returns the whole turn.state. Lets
 * us assert the per-channel merge across the input-compose + persist sites.
 */
function createStateEchoAgentExecutor(): AgentExecutor {
  return {
    execute: async (_graphId: string, request: any) => ({
      thread_id: request.thread_id,
      run_id: request.run_id,
      messages: [{ role: 'assistant', content: 'ok' }],
      // The agent receives the (already-merged) state and returns it verbatim
      // as the full snapshot — exactly the payments-agent contract.
      ...(request.state ? { state: request.state } : {}),
    }),
    stream: async function* (_graphId: string, request: any) {
      yield { event: 'metadata', data: { run_id: request.run_id, thread_id: request.thread_id } };
      yield { event: 'end', data: null };
    },
  } as unknown as AgentExecutor;
}

let app: FastifyInstance;
let threadsService: ThreadsService;

/**
 * Build a test app with shared ThreadsRepository so that threads created
 * via the threads endpoint are visible to the runs service.
 */
async function buildRunsTestApp(
  agentExecutor: AgentExecutor = createMockAgentExecutor(),
): Promise<FastifyInstance> {
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
  const mockAgentExecutor = agentExecutor;
  const mockAssistantResolver = createMockAssistantResolver();
  const requestComposer = new RequestComposer();
  const runsService = new RunsService(runsRepo, sharedThreadsRepo, mockAgentExecutor, mockAssistantResolver, requestComposer);
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
    it('should return 409 when cancelling a completed run', async () => {
      const threadId = await createThread();
      const assistantId = randomUUID();

      const createRes = await app.inject({
        method: 'POST',
        url: `/threads/${threadId}/runs`,
        payload: { assistant_id: assistantId },
      });
      const created = JSON.parse(createRes.payload);

      // Wait for the background agent execution to complete
      await new Promise((r) => setTimeout(r, 200));

      const res = await app.inject({
        method: 'POST',
        url: `/threads/${threadId}/runs/${created.run_id}/cancel`,
        payload: {},
      });

      // Run completes almost instantly with mock agent, so cancel returns 409
      expect(res.statusCode).toBe(409);
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
      // LangGraph contract: /runs/wait returns graph state values at root.
      // No run_id / status / result envelope.
      expect(body).toHaveProperty('messages');
      expect(Array.isArray(body.messages)).toBe(true);
      expect(body).not.toHaveProperty('result');
      expect(body).not.toHaveProperty('run_id');
    });

    it('should return 404 for non-existent thread by default (matches real LangGraph)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/threads/${randomUUID()}/runs/wait`,
        payload: {
          assistant_id: randomUUID(),
          input: { messages: [{ role: 'user', content: 'hi' }] },
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it('should auto-create thread when if_not_exists=create', async () => {
      const threadId = randomUUID();

      const res = await app.inject({
        method: 'POST',
        url: `/threads/${threadId}/runs/wait`,
        payload: {
          assistant_id: randomUUID(),
          input: { messages: [{ role: 'user', content: 'hi' }] },
          if_not_exists: 'create',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      // /runs/wait returns state values at root — no thread_id / status keys.
      expect(body).toHaveProperty('messages');
      expect(Array.isArray(body.messages)).toBe(true);

      // Verify the thread was actually persisted in the shared repo
      const created = await threadsService.get(threadId);
      expect(created).toHaveProperty('thread_id', threadId);
    });
  });

  // -------------------------------------------------------------------
  // if_not_exists semantics on createStateful and streamRun
  // -------------------------------------------------------------------
  describe('if_not_exists semantics', () => {
    it('createStateful: returns 404 by default for non-existent thread', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/threads/${randomUUID()}/runs`,
        payload: { assistant_id: randomUUID() },
      });

      expect(res.statusCode).toBe(404);
    });

    it('createStateful: auto-creates thread when if_not_exists=create', async () => {
      const threadId = randomUUID();

      const res = await app.inject({
        method: 'POST',
        url: `/threads/${threadId}/runs`,
        payload: { assistant_id: randomUUID(), if_not_exists: 'create' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty('thread_id', threadId);

      const created = await threadsService.get(threadId);
      expect(created).toHaveProperty('thread_id', threadId);
    });

    it('streamRun: returns 404 by default for non-existent thread', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/threads/${randomUUID()}/runs/stream`,
        payload: { assistant_id: randomUUID() },
      });

      expect(res.statusCode).toBe(404);
    });

    it('streamRun: auto-creates thread when if_not_exists=create', async () => {
      const threadId = randomUUID();

      const res = await app.inject({
        method: 'POST',
        url: `/threads/${threadId}/runs/stream`,
        payload: { assistant_id: randomUUID(), if_not_exists: 'create' },
      });

      // SSE stream — 200 with text/event-stream content type
      expect(res.statusCode).toBe(200);

      const created = await threadsService.get(threadId);
      expect(created).toHaveProperty('thread_id', threadId);
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

  // -------------------------------------------------------------------
  // Per-channel state merge across the run path (the wipe-fix)
  // -------------------------------------------------------------------
  describe('thread state per-channel merge (flat canonical convention)', () => {
    beforeEach(async () => {
      // Use a state-echoing executor so the persisted state reflects the merge.
      app = await buildRunsTestApp(createStateEchoAgentExecutor());
    });

    it('persists a full snapshot returned by the agent at the top level of values', async () => {
      const threadId = await createThread();
      const fullState = { user_id: 'u1', organization_name: 'DEH', amount: 50 };

      const res = await app.inject({
        method: 'POST',
        url: `/threads/${threadId}/runs/wait`,
        payload: {
          assistant_id: randomUUID(),
          // Graph state = input keys other than messages/documents.
          input: { messages: [{ role: 'user', content: 'start' }], ...fullState },
        },
      });
      expect(res.statusCode).toBe(200);

      const state = await threadsService.getState(threadId);
      // State now lives flat in values (alongside messages), not under values.state.
      expect(state.values).toMatchObject(fullState);
      expect(state.values).not.toHaveProperty('state');
    });

    it('retains prior keys when a later turn sends only partial input keys', async () => {
      const threadId = await createThread();

      // Turn 1: seed the full state.
      await app.inject({
        method: 'POST',
        url: `/threads/${threadId}/runs/wait`,
        payload: {
          assistant_id: randomUUID(),
          input: {
            messages: [{ role: 'user', content: 'start' }],
            user_id: 'u1',
            organization_name: 'DEH',
            amount: 50,
          },
        },
      });

      // Turn 2: send only a partial state — must NOT wipe siblings.
      const res = await app.inject({
        method: 'POST',
        url: `/threads/${threadId}/runs/wait`,
        payload: {
          assistant_id: randomUUID(),
          input: {
            messages: [{ role: 'user', content: 'change amount' }],
            amount: 75,
          },
        },
      });
      expect(res.statusCode).toBe(200);

      const state = await threadsService.getState(threadId);
      expect(state.values).toMatchObject({
        user_id: 'u1',
        organization_name: 'DEH',
        amount: 75,
      });
    });
  });
});
