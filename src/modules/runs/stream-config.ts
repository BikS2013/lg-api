/**
 * Stream configuration — environment knobs that tune the live `/runs/stream`
 * and the run-stream join endpoints. None of them is read by `/runs/wait`,
 * background runs (`POST /threads/:id/runs`, `POST /runs`) or the thread
 * endpoints.
 *
 * Every variable is optional and has a documented default (a deliberate,
 * documented exception to the "no fallback values" rule — see
 * Issues - Pending Items.md, LG-STREAM-CONFIG-DEFAULTS): making them required
 * would force every existing deployment to change its environment. An
 * invalid value is never silently replaced — it throws when RunsService is
 * constructed, i.e. at server start.
 *
 *   LG_API_STREAM_HEARTBEAT_MS    integer >= 0  (default 5000)
 *       interval of the `: heartbeat` SSE comment on an open stream; 0 disables.
 *   LG_API_STREAM_END_EVENT       true | false  (default true)
 *       send the trailing `event: end` before closing (LG-STREAM-END-EVENT);
 *       false closes the stream the way LangGraph does.
 *   LG_API_TYPEWRITER             on | off | true | false  (default on)
 *       type a reply that arrived whole out word by word on `messages` /
 *       `messages-tuple`; off sends it as one chunk.
 *   LG_API_TYPEWRITER_CHUNK_MS    integer >= 0  (default 22)
 *       delay between typed chunks.
 *   LG_API_TYPEWRITER_MAX_MS      integer >= 0  (default 1400)
 *       cap on the total typing time of one reply.
 */

export interface StreamConfig {
  heartbeatMs: number;
  endEvent: boolean;
  typewriter: boolean;
  typewriterChunkMs: number;
  typewriterMaxMs: number;
}

export const DEFAULT_STREAM_CONFIG: Readonly<StreamConfig> = Object.freeze({
  heartbeatMs: 5000,
  endEvent: true,
  typewriter: true,
  typewriterChunkMs: 22,
  typewriterMaxMs: 1400,
});

type Env = Record<string, string | undefined>;

function readBoolean(env: Env, name: string, fallback: boolean, extra: Record<string, boolean> = {}): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const accepted: Record<string, boolean> = { true: true, false: false, ...extra };
  const value = accepted[raw.trim().toLowerCase()];
  if (value === undefined) {
    throw new Error(
      `Invalid value for ${name}: "${raw}". Must be one of: ${Object.keys(accepted).join(', ')}.`,
    );
  }
  return value;
}

function readMillis(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid value for ${name}: "${raw}". Must be an integer >= 0 (milliseconds).`);
  }
  return value;
}

export function loadStreamConfig(env: Env = process.env): StreamConfig {
  return {
    heartbeatMs: readMillis(env, 'LG_API_STREAM_HEARTBEAT_MS', DEFAULT_STREAM_CONFIG.heartbeatMs),
    endEvent: readBoolean(env, 'LG_API_STREAM_END_EVENT', DEFAULT_STREAM_CONFIG.endEvent),
    typewriter: readBoolean(env, 'LG_API_TYPEWRITER', DEFAULT_STREAM_CONFIG.typewriter, { on: true, off: false }),
    typewriterChunkMs: readMillis(env, 'LG_API_TYPEWRITER_CHUNK_MS', DEFAULT_STREAM_CONFIG.typewriterChunkMs),
    typewriterMaxMs: readMillis(env, 'LG_API_TYPEWRITER_MAX_MS', DEFAULT_STREAM_CONFIG.typewriterMaxMs),
  };
}
