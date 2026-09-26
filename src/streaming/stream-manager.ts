/**
 * StreamManager - SSE streaming session management.
 *
 * Manages active SSE stream sessions, buffering events for reconnection
 * support via Last-Event-ID, and fanning live events out to subscribers so a
 * client that joins a run mid-flight follows it until it finishes.
 */

import type { StreamMode } from '../types/index.js';

// --- StreamEvent ---
export interface StreamEvent {
  event: string;
  data: string; // JSON-serialized
  id: string;   // sequential numeric string
}

// --- StreamSession ---
export interface StreamSession {
  id: string;
  runId: string;
  threadId: string | null;
  streamModes: StreamMode[];
  eventBuffer: StreamEvent[];
  lastEventId: number;
  closed: boolean;
  /**
   * The session of a live `/runs/stream` run (RunStreamEmitter.openSse), as
   * opposed to the replay buffer of a join answered from stored state.
   */
  live?: boolean;
  /** Connections following the run live (the originating stream and any joiners). */
  subscribers: Set<StreamSubscriber>;
  /**
   * Explicit cancellation of the run behind the session (set by the producer).
   * Only invoked on request — e.g. a join with `cancel_on_disconnect=true` —
   * never because a subscriber went away.
   */
  cancel?: () => void;
}

// --- StreamSubscriber ---
export interface StreamSubscriber {
  onEvent(event: StreamEvent): void;
  /** The session closed: no more events will be published. */
  onClose(): void;
}

// --- StreamManager ---
export class StreamManager {
  private sessions: Map<string, StreamSession> = new Map();

  /**
   * Create a new stream session for a run.
   */
  createSession(
    runId: string,
    threadId: string | null,
    streamModes: StreamMode[],
  ): StreamSession {
    const session: StreamSession = {
      id: runId,
      runId,
      threadId,
      streamModes,
      eventBuffer: [],
      lastEventId: 0,
      closed: false,
      subscribers: new Set(),
    };
    this.sessions.set(runId, session);
    return session;
  }

  /**
   * Retrieve a session by run ID.
   */
  getSession(runId: string): StreamSession | null {
    return this.sessions.get(runId) ?? null;
  }

  /**
   * Append an event to a session: assign the next sequential id, buffer it
   * for Last-Event-ID replay and deliver it to every live subscriber.
   * Returns null when the session does not exist or is already closed.
   */
  publish(runId: string, event: string, data: string): StreamEvent | null {
    const session = this.sessions.get(runId);
    if (!session || session.closed) return null;
    session.lastEventId++;
    const streamEvent: StreamEvent = { event, data, id: String(session.lastEventId) };
    session.eventBuffer.push(streamEvent);
    for (const subscriber of [...session.subscribers]) {
      subscriber.onEvent(streamEvent);
    }
    return streamEvent;
  }

  /**
   * Follow a session live. Returns the unsubscribe function, or null when the
   * session does not exist or is already closed (nothing more will arrive).
   */
  subscribe(runId: string, subscriber: StreamSubscriber): (() => void) | null {
    const session = this.sessions.get(runId);
    if (!session || session.closed) return null;
    session.subscribers.add(subscriber);
    return () => {
      session.subscribers.delete(subscriber);
    };
  }

  /**
   * Mark a session as closed, notify live subscribers, and schedule cleanup
   * after 60 seconds.
   */
  closeSession(runId: string): void {
    const session = this.sessions.get(runId);
    if (session) {
      session.closed = true;
      const subscribers = [...session.subscribers];
      session.subscribers.clear();
      for (const subscriber of subscribers) {
        subscriber.onClose();
      }
      // Keep for replay; auto-cleanup after timeout
      setTimeout(() => this.sessions.delete(runId), 60_000);
    }
  }

  /**
   * Get all events after a given event ID (for reconnection replay).
   */
  getEventsAfter(runId: string, lastEventId: string): StreamEvent[] {
    const session = this.sessions.get(runId);
    if (!session) return [];
    const afterId = parseInt(lastEventId, 10);
    return session.eventBuffer.filter(
      (e) => parseInt(e.id, 10) > afterId,
    );
  }

  /**
   * Return a snapshot of all active (non-closed) sessions.
   */
  getActiveSessions(): Map<string, StreamSession> {
    const active = new Map<string, StreamSession>();
    for (const [key, session] of this.sessions) {
      if (!session.closed) {
        active.set(key, session);
      }
    }
    return active;
  }
}
