import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../src/storage/providers/azure-blob/azure-blob-helpers.js';

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    const items = [30, 10, 20, 0, 5];
    const out = await mapWithConcurrency(items, 2, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      return n * 2;
    });
    expect(out).toEqual([60, 20, 40, 0, 10]);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapWithConcurrency(items, 4, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('handles an empty list', async () => {
    const out = await mapWithConcurrency([], 8, async (x) => x);
    expect(out).toEqual([]);
  });

  it('runs all items even when more than the limit', async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const out = await mapWithConcurrency(items, 8, async (n) => n + 1);
    expect(out).toHaveLength(50);
    expect(out[0]).toBe(1);
    expect(out[49]).toBe(50);
  });
});
