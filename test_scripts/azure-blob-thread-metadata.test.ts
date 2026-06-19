/**
 * Guards the invariant that a thread write can NEVER fail because of Azure's
 * 8 KiB blob-metadata cap or non-ASCII metadata content. buildThreadMetadata
 * must (a) emit ASCII-only values and (b) drop the whole bag when it would
 * exceed the cap (so the caller writes the blob with no metadata and search
 * recovers from the body).
 */
import { describe, it, expect } from 'vitest';
import {
  asciiJson,
  buildThreadMetadata,
} from '../src/storage/providers/azure-blob/azure-blob-thread-storage.js';

const base = {
  thread_id: '11111111-1111-1111-1111-111111111111',
  created_at: '2026-06-18T00:00:00.000Z',
  updated_at: '2026-06-18T00:00:00.000Z',
  status: 'idle' as const,
};

describe('asciiJson', () => {
  it('escapes non-ASCII to \\uXXXX and round-trips via JSON.parse', () => {
    const out = asciiJson({ name: 'Ζήσης', emoji: '🚀' });
    expect(out).toMatch(/^[\x00-\x7F]*$/); // pure ASCII
    expect(JSON.parse(out)).toEqual({ name: 'Ζήσης', emoji: '🚀' });
  });
  it('handles null/undefined as {}', () => {
    expect(asciiJson(undefined)).toBe('{}');
    expect(asciiJson(null)).toBe('{}');
  });
});

describe('buildThreadMetadata (write-safety guard)', () => {
  it('emits the full bag for small metadata', () => {
    const bag = buildThreadMetadata({ ...base, metadata: { agentId: 'x' } } as never);
    expect(bag.threadstatus).toBe('idle');
    expect(JSON.parse(bag.threadmetadata)).toEqual({ agentId: 'x' });
  });

  it('emits ASCII-only values even for non-ASCII metadata (no header rejection)', () => {
    const bag = buildThreadMetadata({ ...base, metadata: { who: 'Ζήσης' } } as never);
    expect(bag.threadmetadata).toMatch(/^[\x00-\x7F]*$/);
    expect(JSON.parse(bag.threadmetadata)).toEqual({ who: 'Ζήσης' });
  });

  it('DROPS the bag (returns {}) when metadata exceeds the 8 KiB cap — write cannot fail', () => {
    const huge = { blob: 'x'.repeat(9000) };
    const bag = buildThreadMetadata({ ...base, metadata: huge } as never);
    expect(bag).toEqual({}); // no metadata persisted -> upload succeeds, search recovers from body
  });

  it('keeps the bag right up to the cap and drops just over it', () => {
    const under = { k: 'a'.repeat(7000) };
    expect(Object.keys(buildThreadMetadata({ ...base, metadata: under } as never)).length)
      .toBeGreaterThan(0);
    const over = { k: 'a'.repeat(8100) };
    expect(buildThreadMetadata({ ...base, metadata: over } as never)).toEqual({});
  });
});
