/**
 * StreamManager - SSE streaming session management.
 *
 * Manages active SSE stream sessions, buffering events for reconnection
 * support via Last-Event-ID.
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
   * Mark a session as closed and schedule cleanup after 60 seconds.
   */
  closeSession(runId: string): void {
    const session = this.sessions.get(runId);
    if (session) {
      session.closed = true;
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
