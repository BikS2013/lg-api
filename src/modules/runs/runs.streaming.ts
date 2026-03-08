/**
 * RunStreamEmitter - SSE event generation for run streaming.
 *
 * Generates and emits realistic stub SSE events for each supported
 * stream mode, writing directly to the raw HTTP response.
 */

import type { FastifyReply } from 'fastify';
import { StreamManager, StreamEvent, StreamSession } from '../../streaming/stream-manager.js';
import type { StreamMode } from '../../types/index.js';
import type { Run } from './runs.repository.js';
import { generateId } from '../../utils/uuid.util.js';
import { nowISO } from '../../utils/date.util.js';

/**
 * Small delay helper to simulate real-time streaming (50ms between events).
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RunStreamEmitter {
  constructor(private streamManager: StreamManager) {}

  /**
   * Stream SSE events for a run to the client.
   *
   * Sets SSE headers, emits metadata, mode-specific events, and an end event.
   * Writes directly to reply.raw (Node.js http.ServerResponse).
   */
  async streamRun(
    reply: FastifyReply,
    run: Run,
    streamModes: StreamMode[],
    lastEventId?: string,
  ): Promise<void> {
    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const session = this.streamManager.createSession(
      run.run_id,
      run.thread_id,
      streamModes,
    );

    // Handle reconnection: replay missed events
    if (lastEventId) {
      const missed = this.streamManager.getEventsAfter(
        run.run_id,
        lastEventId,
      );
      for (const event of missed) {
        this.writeEvent(reply, event);
      }
      reply.raw.end();
      return;
    }

    try {
      // 1. Emit metadata event
      await this.emit(reply, session, 'metadata', {
        run_id: run.run_id,
        thread_id: run.thread_id,
      });

      await delay(50);

      // 2. Emit mode-specific stub events
      for (const mode of streamModes) {
        await this.emitModeEvent(reply, session, mode, run);
        await delay(50);
      }

      // 3. Emit end event
      await this.emit(reply, session, 'end', null);
    } catch (error: unknown) {
      const message = error instanceof Error
        ? error.message
        : 'Unknown streaming error';
      await this.emit(reply, session, 'error', { message });
    } finally {
      this.streamManager.closeSession(run.run_id);
      reply.raw.end();
    }
  }

  /**
   * Emit a mode-specific stub event based on the requested stream mode.
   */
  private async emitModeEvent(
    reply: FastifyReply,
    session: StreamSession,
    mode: StreamMode,
    run: Run,
  ): Promise<void> {
    switch (mode) {
      case 'values':
        await this.emit(reply, session, 'values', {
          messages: [
            {
              type: 'ai',
              content: 'This is a stub response from the LG-API server.',
              id: generateId(),
            },
          ],
        });
        break;

      case 'updates':
        await this.emit(reply, session, 'updates', {
          agent: {
            messages: [
              {
                type: 'ai',
                content: 'Stub update from agent node.',
                id: generateId(),
              },
            ],
          },
        });
        break;

      case 'messages':
        await this.emit(reply, session, 'messages', [
          {
            type: 'AIMessageChunk',
            content: 'Stub message chunk.',
            id: generateId(),
          },
        ]);
        break;

      case 'messages-tuple':
        await this.emit(reply, session, 'messages/partial', [
          ['ai', { content: 'Stub tuple message.', id: generateId() }],
        ]);
        break;

      case 'events':
        await this.emit(reply, session, 'events', {
          event: 'on_chain_end',
          name: 'agent',
          run_id: run.run_id,
          data: { output: {} },
        });
        break;

      case 'debug':
        await this.emit(reply, session, 'debug', {
          type: 'task_result',
          timestamp: nowISO(),
          step: 1,
          payload: {},
        });
        break;

      case 'custom':
        await this.emit(reply, session, 'custom', {
          type: 'stub_custom_event',
          data: {},
        });
        break;

      case 'tasks':
        await this.emit(reply, session, 'tasks', {
          task_id: generateId(),
          name: 'agent',
          status: 'completed',
          result: {},
        });
        break;

      case 'checkpoints':
        await this.emit(reply, session, 'checkpoints', {
          thread_id: run.thread_id,
          checkpoint_ns: '',
          checkpoint_id: generateId(),
        });
        break;
    }
  }

  /**
   * Emit a single SSE event: buffer it in the session and write to the response.
   */
  private async emit(
    reply: FastifyReply,
    session: StreamSession,
    event: string,
    data: unknown,
  ): Promise<void> {
    session.lastEventId++;
    const streamEvent: StreamEvent = {
      event,
      data: JSON.stringify(data),
      id: String(session.lastEventId),
    };
    session.eventBuffer.push(streamEvent);
    this.writeEvent(reply, streamEvent);
  }

  /**
   * Write a single SSE event to the raw HTTP response in standard SSE format.
   */
  private writeEvent(reply: FastifyReply, event: StreamEvent): void {
    reply.raw.write(`event: ${event.event}\n`);
    reply.raw.write(`data: ${event.data}\n`);
    reply.raw.write(`id: ${event.id}\n`);
    reply.raw.write('\n');
  }
}
