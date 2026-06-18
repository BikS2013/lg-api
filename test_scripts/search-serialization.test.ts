/**
 * Guards the POST /threads/search response-serialization contract directly with
 * fast-json-stringify — the serializer Fastify actually uses at runtime.
 *
 * Why not the route tests: buildModuleApp()/createTestApp() override the
 * serializer with a JSON.stringify passthrough (to dodge $id conflicts), so a
 * required-field-missing bug serializes fine there and only 500s in production.
 * The original projected-row 500 ("created_at is required!") slipped through for
 * exactly that reason. This test compiles the real schema so that class of bug
 * fails in CI.
 */
import { describe, it, expect } from 'vitest';
import fjs from 'fast-json-stringify';
import { SearchThreadResultSchema, ThreadSchema } from '../src/schemas/thread.schema.js';

const UUID = '11111111-1111-1111-1111-111111111111';
const NOW = '2026-06-18T00:00:00.000Z';

describe('search response serialization', () => {
  const serializeSearch = fjs({ type: 'array', items: SearchThreadResultSchema as object });

  it('serializes a metadata-only row (the default projection)', () => {
    const out = serializeSearch([
      { thread_id: UUID, created_at: NOW, updated_at: NOW, metadata: { t: 'a' }, status: 'idle' },
    ]);
    expect(JSON.parse(out)[0].thread_id).toBe(UUID);
  });

  it('serializes a projected row that omits the metadata fields (select:["values"])', () => {
    // normalizeSelect always keeps thread_id; created_at/updated_at/metadata/status absent.
    expect(() => serializeSearch([{ thread_id: UUID, values: { step: 1 } }])).not.toThrow();
    const out = serializeSearch([{ thread_id: UUID, values: { step: 1 } }]);
    expect(JSON.parse(out)[0]).toEqual({ thread_id: UUID, values: { step: 1 } });
  });

  it('proves the guard has teeth: the full ThreadSchema REJECTS that projected row', () => {
    const serializeStrict = fjs({ type: 'array', items: ThreadSchema as object });
    expect(() => serializeStrict([{ thread_id: UUID, values: { step: 1 } }])).toThrow(/required/);
  });
});
