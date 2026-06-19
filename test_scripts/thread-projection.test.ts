/**
 * Unit tests for the pure thread-projection helpers (ADR-0002).
 *
 * These cover the canonical `select` projection and the `values` state-filter
 * matcher without any storage backend, so the azure-blob row-assembly /
 * download-decision logic that builds on them is exercised in isolation.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_THREAD_SELECT,
  normalizeSelect,
  selectIncludesState,
  projectThread,
  matchesValuesFilter,
} from '../src/modules/threads/thread-projection.js';
import type { Thread } from '../src/modules/threads/threads.repository.js';

function makeThread(overrides: Partial<Thread> = {}): Thread {
  const now = new Date().toISOString();
  return {
    thread_id: '11111111-1111-1111-1111-111111111111',
    created_at: now,
    updated_at: now,
    metadata: { tenant: 'acme' },
    status: 'idle',
    values: { messages: [{ role: 'user', content: 'hi' }], step: 3 },
    interrupts: [],
    ...overrides,
  };
}

describe('thread-projection', () => {
  describe('normalizeSelect', () => {
    it('defaults to the full canonical set when select is absent', () => {
      expect(normalizeSelect()).toEqual(DEFAULT_THREAD_SELECT);
      expect(DEFAULT_THREAD_SELECT).toContain('values'); // canonical returns values by default
    });

    it('defaults to the full canonical set when select is empty', () => {
      expect(normalizeSelect([])).toEqual(DEFAULT_THREAD_SELECT);
    });

    it('keeps only canonical fields and drops unknown ones', () => {
      expect(normalizeSelect(['thread_id', 'values', 'bogus', 'config'])).toEqual([
        'thread_id',
        'values',
      ]);
    });

    it('falls back to metadata-only when select names only unknown fields', () => {
      expect(normalizeSelect(['config', 'context'])).toEqual(DEFAULT_THREAD_SELECT);
    });

    it('always includes thread_id even when select omits it (identity is required)', () => {
      expect(normalizeSelect(['values', 'status'])).toEqual(['thread_id', 'values', 'status']);
      expect(normalizeSelect(['values'])).toEqual(['thread_id', 'values']);
    });
  });

  describe('selectIncludesState', () => {
    it('is true for the default (full) projection', () => {
      expect(selectIncludesState()).toBe(true);
      expect(selectIncludesState([])).toBe(true);
    });

    it('is false only when select narrows to metadata fields (no values/interrupts)', () => {
      expect(selectIncludesState(['thread_id', 'metadata', 'status'])).toBe(false);
    });

    it('is true when values or interrupts are requested', () => {
      expect(selectIncludesState(['values'])).toBe(true);
      expect(selectIncludesState(['metadata', 'interrupts'])).toBe(true);
    });
  });

  describe('projectThread', () => {
    it('returns the full thread by default (includes values — canonical contract)', () => {
      const projected = projectThread(makeThread());
      expect(projected).toHaveProperty('thread_id');
      expect(projected).toHaveProperty('metadata');
      expect(projected).toHaveProperty('status');
      expect(projected).toHaveProperty('values');
      expect(projected.values).toEqual({ messages: [{ role: 'user', content: 'hi' }], step: 3 });
    });

    it('narrows to metadata-only when select excludes state', () => {
      const projected = projectThread(makeThread(), [
        'thread_id',
        'created_at',
        'updated_at',
        'metadata',
        'status',
      ]);
      expect(projected).not.toHaveProperty('values');
      expect(projected).not.toHaveProperty('interrupts');
    });

    it('includes values only when select names it', () => {
      const projected = projectThread(makeThread(), ['thread_id', 'values']);
      expect(projected).toHaveProperty('values');
      expect(projected.values).toEqual({ messages: [{ role: 'user', content: 'hi' }], step: 3 });
      expect(projected).not.toHaveProperty('metadata');
      expect(projected).not.toHaveProperty('status');
    });

    it('omits a selected field that is undefined on the thread', () => {
      const projected = projectThread(makeThread({ values: undefined }), ['thread_id', 'values']);
      expect(projected).not.toHaveProperty('values');
    });

    it('still carries thread_id when select omits it (avoids unserializable rows)', () => {
      const projected = projectThread(makeThread(), ['values']);
      expect(projected.thread_id).toBe('11111111-1111-1111-1111-111111111111');
      expect(projected).toHaveProperty('values');
    });
  });

  describe('matchesValuesFilter', () => {
    it('matches when every filter key deep-equals the thread state', () => {
      expect(matchesValuesFilter({ step: 3, lang: 'en' }, { step: 3 })).toBe(true);
      expect(matchesValuesFilter({ nested: { a: 1 } }, { nested: { a: 1 } })).toBe(true);
    });

    it('does not match when a filter value differs', () => {
      expect(matchesValuesFilter({ step: 3 }, { step: 4 })).toBe(false);
      expect(matchesValuesFilter({ nested: { a: 1 } }, { nested: { a: 2 } })).toBe(false);
    });

    it('treats missing values as matching only an empty filter', () => {
      expect(matchesValuesFilter(undefined, {})).toBe(true);
      expect(matchesValuesFilter(undefined, { step: 1 })).toBe(false);
    });
  });
});
