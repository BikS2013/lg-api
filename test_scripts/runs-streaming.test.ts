/**
 * Runs Streaming (SSE) Tests
 *
 * Tests for Server-Sent Events streaming endpoints.
 * Verifies Content-Type headers and SSE event format.
 *
 * Uses a custom test app with shared ThreadsRepository so that
 * threads created in setup are visible to the runs service.
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

function createMockAssistantResolver(): AssistantResolver {
  return {
    resolve: async (id: string) => ({
      assistant_id: id, graph_id: 'test-graph', name: 'Test', description: null,
      config: {}, metadata: {}, version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }),
  } as unknown as AssistantResolver;
}

function createMockAgentExecutor(): AgentExecutor {
  return {
    execute: async (_graphId: string, request: any) => ({
      thread_id: request.thread_id, run_id: request.run_id,
      messages: [{ role: 'assistant', content: 'Mock agent response.' }],
    }),
    stream: async function* (_graphId: string, request: any) {
      yield { event: 'metadata', data: { run_id: request.run_id, thread_id: request.thread_id } };
      yield { event: 'values', data: { messages: [{ type: 'ai', content: 'Mock streamed response.' }] } };
      yield { event: 'end', data: null };
    },
  } as unknown as AgentExecutor;
}

let app: FastifyInstance;

async function buildStreamTestApp(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  instance.decorate('config', config);

  // Do NOT set serializerCompiler for streaming routes, as they write
  // directly to reply.raw. Only set it for JSON routes.
  await instance.register(errorHandlerPlugin);

  const sharedThreadsRepo = new ThreadsRepository();
  const runsRepo = new RunsRepository();
  const runsService = new RunsService(runsRepo, sharedThreadsRepo, createMockAgentExecutor(), createMockAssistantResolver(), new RequestComposer());
  const threadsService = new ThreadsService(sharedThreadsRepo);

  // Thread creation route
  instance.post('/threads', async (request, reply) => {
    const body = request.body as any;
    const thread = await threadsService.create(body ?? {});
    return reply.code(200).send(thread);
  });

  // Stateful stream
  instance.post('/threads/:thread_id/runs/stream', async (request, reply) => {
    const { thread_id } = request.params as { thread_id: string };
    await runsService.streamRun(thread_id, request.body as any, reply);
  });

  // Stateless stream
  instance.post('/runs/stream', async (request, reply) => {
    await runsService.streamRun(null, request.body as any, reply);
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

describe('Runs Streaming (SSE)', () => {
  beforeEach(async () => {
    app = await buildStreamTestApp();
  });

  // -------------------------------------------------------------------
  // POST /threads/:thread_id/runs/stream - Stateful stream
  // -------------------------------------------------------------------
  describe('POST /threads/:thread_id/runs/stream', () => {
    it('should return Content-Type: text/event-stream', async () => {
      const threadId = await createThread();
      const assistantId = randomUUID();

      const res = await app.inject({
        method: 'POST',
        url: `/threads/${threadId}/runs/stream`,
        payload: {
          assistant_id: assistantId,
          input: { messages: [{ role: 'user', content: 'stream test' }] },
        },
      });

      expect(res.headers['content-type']).toBe('text/event-stream');
    });

    it('should contain SSE formatted events with event: and data: lines', async () => {
      const threadId = await createThread();
      const assistantId = randomUUID();

      const res = await app.inject({
        method: 'POST',
        url: `/threads/${threadId}/runs/stream`,
        payload: {
          assistant_id: assistantId,
          stream_mode: ['values'],
        },
      });

      const body = res.payload;

      // Verify SSE format: lines starting with "event:", "data:", and "id:"
      expect(body).toContain('event: ');
      expect(body).toContain('data: ');
      expect(body).toContain('id: ');

      // Verify it contains metadata and end events
      expect(body).toContain('event: metadata');
      expect(body).toContain('event: end');
    });

    it('should emit values events when stream_mode is values', async () => {
      const threadId = await createThread();
      const assistantId = randomUUID();

      const res = await app.inject({
        method: 'POST',
        url: `/threads/${threadId}/runs/stream`,
        payload: {
          assistant_id: assistantId,
          stream_mode: ['values'],
        },
      });

      const body = res.payload;
      expect(body).toContain('event: values');
    });

    it('should emit SSE events when stream_mode is updates', async () => {
      const threadId = await createThread();
      const assistantId = randomUUID();

      const res = await app.inject({
        method: 'POST',
        url: `/threads/${threadId}/runs/stream`,
        payload: {
          assistant_id: assistantId,
          stream_mode: ['updates'],
        },
      });

      const body = res.payload;
      // Agent emits metadata, values, and end events regardless of stream_mode
      expect(body).toContain('event: metadata');
      expect(body).toContain('event: end');
    });

    it('should return 404 for non-existent thread', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/threads/${randomUUID()}/runs/stream`,
        payload: {
          assistant_id: randomUUID(),
        },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // POST /runs/stream - Stateless stream
  // -------------------------------------------------------------------
  describe('POST /runs/stream', () => {
    it('should return Content-Type: text/event-stream', async () => {
      const assistantId = randomUUID();

      const res = await app.inject({
        method: 'POST',
        url: '/runs/stream',
        payload: {
          assistant_id: assistantId,
          input: { messages: [{ role: 'user', content: 'stateless stream' }] },
        },
      });

      expect(res.headers['content-type']).toBe('text/event-stream');
    });

    it('should contain SSE formatted data for stateless stream', async () => {
      const assistantId = randomUUID();

      const res = await app.inject({
        method: 'POST',
        url: '/runs/stream',
        payload: {
          assistant_id: assistantId,
          stream_mode: ['values'],
        },
      });

      const body = res.payload;

      // Verify SSE event format: event: X\ndata: Y\nid: Z\n\n
      expect(body).toContain('event: metadata');
      expect(body).toContain('event: values');
      expect(body).toContain('event: end');
      expect(body).toContain('data: ');
      expect(body).toContain('id: ');

      // Verify the data lines contain valid JSON
      const dataLines = body
        .split('\n')
        .filter((line: string) => line.startsWith('data: '));
      expect(dataLines.length).toBeGreaterThanOrEqual(1);
      for (const line of dataLines) {
        const jsonStr = line.replace('data: ', '');
        expect(() => JSON.parse(jsonStr)).not.toThrow();
      }
    });

    it('should emit multiple mode events when multiple stream_modes are requested', async () => {
      const assistantId = randomUUID();

      const res = await app.inject({
        method: 'POST',
        url: '/runs/stream',
        payload: {
          assistant_id: assistantId,
          stream_mode: ['values', 'updates'],
        },
      });

      const body = res.payload;
      expect(body).toContain('event: values');
      expect(body).toContain('event: end');
    });
  });

  // -------------------------------------------------------------------
  // SSE event format verification
  // -------------------------------------------------------------------
  describe('SSE event format', () => {
    it('should follow event: X\\ndata: Y\\nid: Z\\n\\n pattern', async () => {
      const assistantId = randomUUID();

      const res = await app.inject({
        method: 'POST',
        url: '/runs/stream',
        payload: {
          assistant_id: assistantId,
          stream_mode: ['values'],
        },
      });

      const body = res.payload;
      const lines = body.split('\n');

      // Verify the pattern: event line, data line, id line, blank line
      let i = 0;
      let eventBlockFound = false;
      while (i < lines.length) {
        if (lines[i].startsWith('event: ')) {
          eventBlockFound = true;
          expect(lines[i + 1]).toMatch(/^data: .+/);
          expect(lines[i + 2]).toMatch(/^id: .+/);
          // After id line, there should be an empty line (separator)
          expect(lines[i + 3]).toBe('');
          i += 4;
        } else {
          i++;
        }
      }

      expect(eventBlockFound).toBe(true);
    });
  });
});
