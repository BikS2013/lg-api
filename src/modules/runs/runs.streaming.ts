/**
 * RunStreamEmitter - SSE event generation for run streaming.
 *
 * Opens the live SSE response of a streamed run (openSse), lets clients
 * rejoin a run's stream (joinLive), and keeps the replay-style helpers
 * (streamFromAgent — used by the join of a run that was never streamed — and
 * the stub events of streamRun).
 */

import { PassThrough, type Writable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import { StreamManager, StreamEvent, StreamSession } from '../../streaming/stream-manager.js';
import type { StreamMode } from '../../types/index.js';
import type { Run } from './runs.repository.js';
import type { StreamEvent as AgentStreamEvent } from '../../agents/types.js';
import { generateId } from '../../utils/uuid.util.js';
import { nowISO } from '../../utils/date.util.js';
import { DEFAULT_STREAM_CONFIG } from './stream-config.js';

/**
 * Small delay helper to simulate real-time streaming (50ms between events).
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Writer handed to the producer of a live run stream (RunsService.streamRun).
 * Events go to the run's StreamManager session, which buffers them for
 * Last-Event-ID replay and fans them out to every connection following the
 * run: the one that started it and any joiner.
 */
export interface SseWriter {
  emit(event: string, data: unknown): void;
  /** Close the session: every following connection ends its response. */
  close(): void;
  readonly closed: boolean;
  /** The connection that started the run is gone; the run carries on. */
  readonly detached: boolean;
  /** At least one connection is following the run live. */
  readonly hasSubscribers: boolean;
  /** Register the explicit cancellation of the run (see StreamSession.cancel). */
  onCancel(cancel: () => void): void;
}

/** Where a run's stream can be rejoined (`Location`) and what it is (`Content-Location`). */
export interface RunStreamLocation {
  location: string;
  contentLocation: string;
}

export function runStreamLocation(run: Pick<Run, 'run_id' | 'thread_id'>): RunStreamLocation {
  const contentLocation = run.thread_id
    ? `/threads/${run.thread_id}/runs/${run.run_id}`
    : `/runs/${run.run_id}`;
  return { location: `${contentLocation}/stream`, contentLocation };
}

/**
 * LangGraph join filter: no modes means everything; `metadata`, `error` and
 * `end` always pass; asking for `messages` or `messages-tuple` passes every
 * `messages*` event (as langgraph-api's Runs.Stream.join does).
 */
export function matchesStreamModes(event: string, modes: StreamMode[] | undefined): boolean {
  if (!modes || modes.length === 0) return true;
  if (event === 'metadata' || event === 'error' || event === 'end') return true;
  if ((modes as string[]).includes(event)) return true;
  return (modes.includes('messages') || modes.includes('messages-tuple')) && event.startsWith('messages');
}

export interface RunStreamEmitterOptions {
  /** Interval of the `: heartbeat` comment on live streams; 0 disables. */
  heartbeatMs?: number;
}

/** One live SSE response (the originating stream or a joiner). */
interface LiveConnection {
  write(event: StreamEvent): void;
  end(): void;
  /** The client went away before the response was ended. */
  readonly gone: boolean;
  onDisconnect(listener: () => void): void;
}

export class RunStreamEmitter {
  private readonly heartbeatMs: number;

  constructor(private streamManager: StreamManager, options: RunStreamEmitterOptions = {}) {
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_STREAM_CONFIG.heartbeatMs;
  }

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
    // Set SSE headers via Fastify so CORS plugin headers are included,
    // then send a PassThrough stream to keep the connection open.
    const contentLocation = run.thread_id
      ? `/threads/${run.thread_id}/runs/${run.run_id}`
      : `/runs/${run.run_id}`;
    const sseStream = new PassThrough();
    reply
      .code(200)
      .header('Content-Type', 'text/event-stream')
      .header('Cache-Control', 'no-cache')
      .header('Connection', 'keep-alive')
      .header('X-Accel-Buffering', 'no')
      .header('Content-Location', contentLocation)
      .send(sseStream);

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
        this.writeEvent(sseStream, event);
      }
      sseStream.end();
      return;
    }

    try {
      // 1. Emit metadata event
      await this.emit(sseStream, session, 'metadata', {
        run_id: run.run_id,
        thread_id: run.thread_id,
      });

      await delay(50);

      // 2. Emit mode-specific stub events
      for (const mode of streamModes) {
        await this.emitModeEvent(sseStream, session, mode, run);
        await delay(50);
      }

      // 3. Emit end event
      await this.emit(sseStream, session, 'end', null);
    } catch (error: unknown) {
      const message = error instanceof Error
        ? error.message
        : 'Unknown streaming error';
      await this.emit(sseStream, session, 'error', { message });
    } finally {
      this.streamManager.closeSession(run.run_id);
      sseStream.end();
    }
  }

  /**
   * Emit a mode-specific stub event based on the requested stream mode.
   */
  private async emitModeEvent(
    stream: Writable,
    session: StreamSession,
    mode: StreamMode,
    run: Run,
  ): Promise<void> {
    switch (mode) {
      case 'values':
        await this.emit(stream, session, 'values', {
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
        await this.emit(stream, session, 'updates', {
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
        await this.emit(stream, session, 'messages', [
          {
            type: 'AIMessageChunk',
            content: 'Stub message chunk.',
            id: generateId(),
          },
        ]);
        break;

      case 'messages-tuple':
        await this.emit(stream, session, 'messages/partial', [
          ['ai', { content: 'Stub tuple message.', id: generateId() }],
        ]);
        break;

      case 'events':
        await this.emit(stream, session, 'events', {
          event: 'on_chain_end',
          name: 'agent',
          run_id: run.run_id,
          data: { output: {} },
        });
        break;

      case 'debug':
        await this.emit(stream, session, 'debug', {
          type: 'task_result',
          timestamp: nowISO(),
          step: 1,
          payload: {},
        });
        break;

      case 'custom':
        await this.emit(stream, session, 'custom', {
          type: 'stub_custom_event',
          data: {},
        });
        break;

      case 'tasks':
        await this.emit(stream, session, 'tasks', {
          task_id: generateId(),
          name: 'agent',
          status: 'completed',
          result: {},
        });
        break;

      case 'checkpoints':
        await this.emit(stream, session, 'checkpoints', {
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
    stream: Writable,
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
    this.writeEvent(stream, streamEvent);
  }

  /**
   * Stream real agent events from an AsyncGenerator to the client via SSE.
   *
   * Sets SSE headers, creates a stream session, iterates over agent events,
   * buffers them for replay support, and writes them to the raw response.
   *
   * @param reply - The Fastify reply to write SSE events to
   * @param run - The run associated with this stream
   * @param agentStream - AsyncGenerator of StreamEvents from the agent executor
   */
  async streamFromAgent(
    reply: FastifyReply,
    run: Run,
    agentStream: AsyncGenerator<AgentStreamEvent>,
  ): Promise<void> {
    // Set SSE headers via Fastify so CORS plugin headers are included,
    // then send a PassThrough stream to keep the connection open.
    const contentLocation = run.thread_id
      ? `/threads/${run.thread_id}/runs/${run.run_id}`
      : `/runs/${run.run_id}`;
    const sseStream = new PassThrough();
    reply
      .code(200)
      .header('Content-Type', 'text/event-stream')
      .header('Cache-Control', 'no-cache')
      .header('Connection', 'keep-alive')
      .header('X-Accel-Buffering', 'no')
      .header('Content-Location', contentLocation)
      .send(sseStream);

    const session = this.streamManager.createSession(run.run_id, run.thread_id, []);

    try {
      for await (const agentEvent of agentStream) {
        session.lastEventId++;
        const streamEvent: StreamEvent = {
          event: agentEvent.event,
          data: JSON.stringify(agentEvent.data),
          id: String(session.lastEventId),
        };
        session.eventBuffer.push(streamEvent);
        this.writeEvent(sseStream, streamEvent);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown streaming error';
      session.lastEventId++;
      const errorEvent: StreamEvent = {
        event: 'error',
        data: JSON.stringify({ message }),
        id: String(session.lastEventId),
      };
      session.eventBuffer.push(errorEvent);
      this.writeEvent(sseStream, errorEvent);
    } finally {
      this.streamManager.closeSession(run.run_id);
      sseStream.end();
    }
  }

  /**
   * Open the SSE response of a live run immediately and hand back a writer,
   * so events reach the client while the agent is still running. The session
   * exists from the first byte, so a join can follow the run while it is live.
   *
   * The run's lifetime is NOT tied to this connection: if the client goes
   * away the connection only unsubscribes; events keep landing in the session
   * buffer for a Last-Event-ID rejoin.
   */
  openSse(reply: FastifyReply, run: Run, streamModes: StreamMode[]): SseWriter {
    const connection = this.openLiveResponse(reply, runStreamLocation(run));
    const session = this.streamManager.createSession(run.run_id, run.thread_id, streamModes);
    session.live = true;
    const unsubscribe = this.streamManager.subscribe(run.run_id, {
      onEvent: (event) => connection.write(event),
      onClose: () => connection.end(),
    });
    connection.onDisconnect(() => unsubscribe?.());

    return {
      emit: (event: string, data: unknown) => {
        this.streamManager.publish(run.run_id, event, JSON.stringify(data));
      },
      close: () => {
        if (!session.closed) this.streamManager.closeSession(run.run_id);
      },
      get closed() {
        return session.closed;
      },
      get detached() {
        return connection.gone;
      },
      get hasSubscribers() {
        return session.subscribers.size > 0;
      },
      onCancel: (cancel: () => void) => {
        session.cancel = cancel;
      },
    };
  }

  /**
   * Join the live stream of a run (`GET …/runs/:run_id/stream`).
   *
   * LangGraph semantics: with a `Last-Event-ID` the buffered events after it
   * are replayed first (`-1` replays everything); without one only new events
   * are sent. Either way the connection then follows the run until it
   * finishes. `streamModes` filters what is sent (matchesStreamModes);
   * `cancelOnDisconnect` cancels the run if this client goes away first.
   *
   * Returns false — and sends nothing — when there is nothing to follow or
   * replay: no session (never streamed, or its buffer expired), or a finished
   * run joined without a Last-Event-ID. The caller then answers from the
   * stored thread state.
   */
  joinLive(
    reply: FastifyReply,
    run: Run,
    options: { lastEventId?: string; streamModes?: StreamMode[]; cancelOnDisconnect?: boolean },
  ): boolean {
    const session = this.streamManager.getSession(run.run_id);
    if (!session) return false;
    if (session.closed && options.lastEventId === undefined) return false;

    const connection = this.openLiveResponse(reply, runStreamLocation(run));
    const pass = (event: StreamEvent) => matchesStreamModes(event.event, options.streamModes);

    // Replay and subscribe in the same tick: nothing can be published in
    // between, so the joiner sees every event exactly once.
    if (options.lastEventId !== undefined) {
      for (const event of this.streamManager.getEventsAfter(run.run_id, options.lastEventId)) {
        if (pass(event)) connection.write(event);
      }
    }
    const unsubscribe = this.streamManager.subscribe(run.run_id, {
      onEvent: (event) => {
        if (pass(event)) connection.write(event);
      },
      onClose: () => connection.end(),
    });
    if (!unsubscribe) {
      connection.end();
      return true;
    }
    connection.onDisconnect(() => {
      unsubscribe();
      if (options.cancelOnDisconnect && !session.closed) session.cancel?.();
    });
    return true;
  }

  /**
   * Send a short, already-complete stream (e.g. a finished run rebuilt from
   * stored state) with the same headers and framing as a live one.
   */
  sendEvents(reply: FastifyReply, run: Run, events: Array<{ event: string; data: unknown }>): void {
    const connection = this.openLiveResponse(reply, runStreamLocation(run));
    events.forEach((e, i) => {
      connection.write({ event: e.event, data: JSON.stringify(e.data), id: String(i + 1) });
    });
    connection.end();
  }

  /**
   * Start an SSE response: headers (incl. `Location` for SDK reconnects) are
   * flushed now, and a `: heartbeat` comment is written every heartbeatMs so
   * proxies with idle timeouts keep the connection open.
   */
  private openLiveResponse(reply: FastifyReply, location: RunStreamLocation): LiveConnection {
    const sseStream = new PassThrough();
    reply
      .code(200)
      .header('Content-Type', 'text/event-stream')
      .header('Cache-Control', 'no-cache')
      .header('Connection', 'keep-alive')
      .header('X-Accel-Buffering', 'no')
      .header('Location', location.location)
      .header('Content-Location', location.contentLocation)
      .send(sseStream);
    // Without an explicit flush Node holds the status line and headers until
    // the first body chunk.
    try {
      reply.raw.flushHeaders?.();
    } catch {
      // ignore
    }
    reply.raw.socket?.setNoDelay?.(true);

    let ended = false;
    let gone = false;
    const disconnectListeners: Array<() => void> = [];
    const heartbeat = this.heartbeatMs > 0
      ? setInterval(() => {
        if (!ended && !gone) sseStream.write(': heartbeat\n\n');
      }, this.heartbeatMs)
      : null;
    heartbeat?.unref?.();
    const stopHeartbeat = () => {
      if (heartbeat) clearInterval(heartbeat);
    };

    reply.raw.on('close', () => {
      stopHeartbeat();
      if (ended || gone) return;
      gone = true;
      // Release the response and its socket; the run itself is not affected.
      sseStream.destroy();
      reply.raw.destroy();
      for (const listener of disconnectListeners) listener();
    });

    return {
      write: (event: StreamEvent) => {
        if (!ended && !gone) this.writeEvent(sseStream, event);
      },
      end: () => {
        if (ended) return;
        ended = true;
        stopHeartbeat();
        sseStream.end();
      },
      get gone() {
        return gone;
      },
      onDisconnect: (listener: () => void) => {
        disconnectListeners.push(listener);
      },
    };
  }

  /**
   * Get the underlying StreamManager instance (for joinStream replay).
   */
  getStreamManager(): StreamManager {
    return this.streamManager;
  }

  /**
   * Write a single SSE event to the raw HTTP response in standard SSE format.
   */
  private writeEvent(stream: Writable, event: StreamEvent): void {
    stream.write(`event: ${event.event}\ndata: ${event.data}\nid: ${event.id}\n\n`);
  }
}
