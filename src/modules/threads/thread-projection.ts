/**
 * Thread field projection — canonical `POST /threads/search` `select` semantics.
 *
 * The LangGraph Platform API treats `/threads/search` as a *projecting* endpoint:
 * `select` chooses which fields each returned row carries. State (`values`,
 * `interrupts`) is opt-in, not default — a listing pays only listing-sized
 * payloads unless the caller explicitly asks for state. See ADR-0002.
 *
 * This module is the single source of truth for that projection so every storage
 * provider (memory / sqlite / sqlserver / azure-blob) returns an identical row
 * shape for a given `select`. It is intentionally pure (no I/O) so it can be unit
 * tested and reused by the azure-blob layer to decide whether a body download is
 * even required.
 */

import type { Thread } from './threads.repository.js';

/**
 * Canonical `ThreadSelectField` set, per the LangGraph Platform API.
 * lg-api's Thread has no `config`/`context` today, so those are deliberately
 * omitted rather than invented (ADR-0002).
 */
export const THREAD_SELECT_FIELDS = [
  'thread_id',
  'created_at',
  'updated_at',
  'metadata',
  'status',
  'values',
  'interrupts',
] as const;

export type ThreadSelectField = (typeof THREAD_SELECT_FIELDS)[number];

/**
 * Default projection when `select` is absent/empty: the FULL canonical thread,
 * including state (`values`, `interrupts`). This matches the LangGraph Platform
 * contract — `POST /threads/search` returns `values` by default (the official
 * agent-chat-ui reads `thread.values.messages` from search results with no
 * `select`), and the SDK `Thread` type marks `values`/`interrupts` as required.
 * Clients that want a lean listing narrow it with `select` (e.g.
 * `select:["thread_id","metadata","status"]`), which then skips body downloads.
 *
 * NOTE this is safe only because the azure-blob provider paginates BEFORE
 * hydrating, so the default downloads at most `limit` bodies (the page), never
 * the whole container (ADR-0002).
 */
export const DEFAULT_THREAD_SELECT: ThreadSelectField[] = [
  'thread_id',
  'created_at',
  'updated_at',
  'metadata',
  'status',
  'values',
  'interrupts',
];

/** Fields whose presence in `select` requires the full thread body (state). */
const STATE_FIELDS: ThreadSelectField[] = ['values', 'interrupts'];

/**
 * Normalize a raw `select` array into the effective canonical field set.
 * Unknown field names are dropped (forward-compatible with SDK fields lg-api
 * does not model). Absent/empty `select` yields the full canonical default
 * (includes `values`/`interrupts`).
 */
export function normalizeSelect(select?: string[]): ThreadSelectField[] {
  if (!select || select.length === 0) {
    return [...DEFAULT_THREAD_SELECT];
  }
  const known = new Set<string>(THREAD_SELECT_FIELDS);
  const effective = select.filter((f): f is ThreadSelectField => known.has(f));
  // An all-unknown `select` still means "the caller asked for a projection";
  // fall back to the full default rather than returning empty rows.
  if (effective.length === 0) {
    return [...DEFAULT_THREAD_SELECT];
  }
  // `thread_id` is the resource identity — always returned regardless of `select`.
  // The response schema requires it, and a row without its id is meaningless to a
  // client (it cannot be correlated, fetched, or paged). select controls the
  // OPTIONAL fields layered on top of the identity.
  if (!effective.includes('thread_id')) {
    effective.unshift('thread_id');
  }
  return effective;
}

/**
 * Whether the effective projection requires state fields (`values`/`interrupts`).
 * Used by azure-blob to skip body downloads when only metadata is requested.
 */
export function selectIncludesState(select?: string[]): boolean {
  const effective = normalizeSelect(select);
  return STATE_FIELDS.some((f) => effective.includes(f));
}

/**
 * Project a thread down to the effective `select` field set. Returns a new object
 * carrying only the requested fields; state fields absent from `select` are
 * omitted entirely so they do not serialize on the wire.
 */
export function projectThread(thread: Thread, select?: string[]): Thread {
  const effective = normalizeSelect(select);
  const source = thread as unknown as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const field of effective) {
    if (field in source && source[field] !== undefined) {
      projected[field] = source[field];
    }
  }
  return projected as unknown as Thread;
}

/**
 * Canonical `values` state *filter*: a thread matches when, for every top-level
 * key in the filter, the thread's `values` carries a deep-equal value. Mirrors
 * the shallow-key, deep-value semantics the LangGraph SDK documents for the
 * search request's `values` field (state values to filter on).
 *
 * A thread with no `values` matches only an empty filter.
 */
export function matchesValuesFilter(
  values: Record<string, unknown> | undefined,
  filter: Record<string, unknown>,
): boolean {
  const v = values ?? {};
  return Object.entries(filter).every(([key, expected]) => deepEqual(v[key], expected));
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => deepEqual(aObj[k], bObj[k]));
}
