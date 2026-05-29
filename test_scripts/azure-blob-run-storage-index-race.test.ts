/**
 * F1 — Lost-update race on Azure Blob runs storage.
 *
 * Spec: artifacts/specs/f1-runs-index-fix.md
 * Investigation: artifacts/research/2026-05-28-lg-api-azure-blob-multi-user-concurrency.md
 *
 * These tests exercise the runId-to-blob lookup mechanism in AzureBlobRunStorage
 * under concurrent create() pressure. The historical implementation used a single
 * `_index.json` blob mutated via download-then-upload — two interleaved creates
 * silently dropped one entry. The fix is a clean cutover: every create writes a
 * unique `_lookup/{run_id}.json` pointer blob, so no two writers share a key,
 * and the legacy `_index.json` is neither read nor written.
 *
 * The fake ContainerClient below is the minimum needed to drive the real
 * AzureBlobRunStorage code path: upload, download, delete, and listBlobsFlat.
 * It does NOT model ETag concurrency — A1 deliberately avoids needing it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { ContainerClient } from '@azure/storage-blob';
import type { Run } from '../src/types/index.js';
import { AzureBlobRunStorage } from '../src/storage/providers/azure-blob/azure-blob-run-storage.js';

// ---------------------------------------------------------------------------
// Fake Azure Blob ContainerClient
// ---------------------------------------------------------------------------

interface FakeBlob {
  content: string;
  metadata?: Record<string, string>;
  tags?: Record<string, string>;
}

interface FakeContainer {
  blobs: Map<string, FakeBlob>;
  uploadCallsByName: Map<string, number>;
  /** Hooks that fire when a blob name is downloaded — used to interleave creates. */
  downloadHooks: Map<string, () => Promise<void>>;
}

function createFakeContainer(): FakeContainer {
  return {
    blobs: new Map(),
    uploadCallsByName: new Map(),
    downloadHooks: new Map(),
  };
}

interface FakeContainerClient {
  getBlockBlobClient(name: string): {
    upload(
      content: string,
      length: number,
      options?: {
        blobHTTPHeaders?: { blobContentType?: string };
        metadata?: Record<string, string>;
        tags?: Record<string, string>;
      },
    ): Promise<{ etag: string }>;
    download(offset: number): Promise<{
      readableStreamBody: AsyncIterable<Buffer> | null;
      etag: string;
    }>;
    delete(): Promise<void>;
  };
  listBlobsFlat(options?: { prefix?: string }): AsyncIterable<{ name: string }>;
}

function makeFakeContainerClient(container: FakeContainer): FakeContainerClient {
  return {
    getBlockBlobClient(name: string) {
      return {
        async upload(content, _length, options) {
          const count = (container.uploadCallsByName.get(name) ?? 0) + 1;
          container.uploadCallsByName.set(name, count);
          container.blobs.set(name, {
            content,
            metadata: options?.metadata,
            tags: options?.tags,
          });
          return { etag: `etag-${name}-${count}` };
        },
        async download(_offset) {
          // Fire test-injected hooks BEFORE returning, so the test can interleave
          // a second writer's upload between this reader's GET and PUT.
          const hook = container.downloadHooks.get(name);
          if (hook) {
            container.downloadHooks.delete(name); // one-shot
            await hook();
          }
          const blob = container.blobs.get(name);
          if (!blob) {
            // Simulate Azure 404 — the real SDK raises a RestError with statusCode 404.
            // azure-blob-helpers.ts catches via instanceof RestError, but the real
            // SDK's behaviour here is to throw. We mimic that with a small shape.
            const err = new Error('BlobNotFound') as Error & { statusCode: number };
            err.statusCode = 404;
            // azure-blob-helpers checks `error instanceof RestError`; we need to
            // pass that check. Lazily import the class to avoid coupling at top-level.
            const sdk = await import('@azure/storage-blob');
            const restErr = new sdk.RestError('BlobNotFound', { statusCode: 404 });
            throw restErr;
          }
          const buffer = Buffer.from(blob.content, 'utf-8');
          return {
            readableStreamBody: (async function* () {
              yield buffer;
            })(),
            etag: `etag-${name}`,
          };
        },
        async delete() {
          if (!container.blobs.has(name)) {
            const sdk = await import('@azure/storage-blob');
            throw new sdk.RestError('BlobNotFound', { statusCode: 404 });
          }
          container.blobs.delete(name);
        },
      };
    },
    async *listBlobsFlat(options?: { prefix?: string }) {
      const prefix = options?.prefix ?? '';
      for (const name of container.blobs.keys()) {
        if (name.startsWith(prefix)) {
          yield { name };
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return {
    run_id: overrides.run_id ?? crypto.randomUUID(),
    thread_id: overrides.thread_id ?? crypto.randomUUID(),
    assistant_id: overrides.assistant_id ?? crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    status: overrides.status ?? 'pending',
    metadata: overrides.metadata ?? {},
    ...overrides,
  };
}

let container: FakeContainer;
let storage: AzureBlobRunStorage;

beforeEach(() => {
  container = createFakeContainer();
  // The fake satisfies the subset of ContainerClient that AzureBlobRunStorage
  // actually uses (getBlockBlobClient + listBlobsFlat). Cast through `unknown`
  // so the structural surface is what gets type-checked at the call sites.
  const client = makeFakeContainerClient(container);
  storage = new AzureBlobRunStorage(client as unknown as ContainerClient);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AzureBlobRunStorage — F1 lost-update fix (A1 per-run lookup blobs)', () => {
  it('create() writes a _lookup/{run_id}.json pointer blob next to the run blob', async () => {
    const run = makeRun();
    await storage.create(run);

    const lookupBlob = container.blobs.get(`_lookup/${run.run_id}.json`);
    expect(lookupBlob).toBeDefined();
    const parsed = JSON.parse(lookupBlob!.content) as { path: string };
    expect(parsed.path).toBe(`${run.thread_id}/${run.run_id}.json`);
  });

  it('create() does NOT write to _index.json (A1 stops writing the global index)', async () => {
    const run = makeRun();
    await storage.create(run);
    expect(container.blobs.has('_index.json')).toBe(false);
    expect(container.uploadCallsByName.get('_index.json') ?? 0).toBe(0);
  });

  it('getById() reads through the per-run lookup blob', async () => {
    const run = makeRun();
    await storage.create(run);

    const fetched = await storage.getById(run.run_id);
    expect(fetched).not.toBeNull();
    expect(fetched!.run_id).toBe(run.run_id);
    expect(fetched!.thread_id).toBe(run.thread_id);
  });

  it('getById() does NOT read _index.json (clean cutover — no legacy fallback)', async () => {
    // Simulate a run created by the previous code: a run blob exists, and the
    // only pointer to it is the legacy _index.json. Under the clean cutover the
    // lookup must NOT consult _index.json, so the run is unreachable by id.
    const run = makeRun();
    const runBlobName = `${run.thread_id}/${run.run_id}.json`;
    container.blobs.set(runBlobName, { content: JSON.stringify(run) });
    container.blobs.set(
      '_index.json',
      { content: JSON.stringify({ [run.run_id]: runBlobName }) },
    );

    let indexRead = false;
    container.downloadHooks.set('_index.json', async () => {
      indexRead = true;
    });

    const fetched = await storage.getById(run.run_id);

    expect(indexRead).toBe(false);
    expect(fetched).toBeNull();
  });

  it('getById() returns null when no lookup blob exists', async () => {
    const fetched = await storage.getById(crypto.randomUUID());
    expect(fetched).toBeNull();
  });

  it('delete() removes both the run blob and its _lookup/ pointer', async () => {
    const run = makeRun();
    await storage.create(run);

    expect(container.blobs.has(`${run.thread_id}/${run.run_id}.json`)).toBe(true);
    expect(container.blobs.has(`_lookup/${run.run_id}.json`)).toBe(true);

    const deleted = await storage.delete(run.run_id);
    expect(deleted).toBe(true);
    expect(container.blobs.has(`${run.thread_id}/${run.run_id}.json`)).toBe(false);
    expect(container.blobs.has(`_lookup/${run.run_id}.json`)).toBe(false);
  });

  it('count() does not include _lookup/ or _index.json blobs in its result', async () => {
    // Create three runs the canonical way.
    await storage.create(makeRun());
    await storage.create(makeRun());
    await storage.create(makeRun());
    // And drop a synthetic legacy _index.json to make sure it's filtered too.
    container.blobs.set('_index.json', { content: '{}' });

    expect(await storage.count()).toBe(3);
  });

  it('count() (unfiltered) counts _lookup/ pointers — a run blob with no pointer is not counted', async () => {
    // Two runs created the canonical way (each gets a _lookup/ pointer).
    await storage.create(makeRun());
    await storage.create(makeRun());

    // Simulate a run from the previous code: a run blob exists but has NO pointer.
    // The old count() (enumerate-all-run-blobs) would have counted it as a 3rd
    // run; the pointer-based count must NOT — it is unreachable by id. This both
    // documents the semantic and proves count() resolves through the _lookup/ prefix.
    const orphan = makeRun();
    container.blobs.set(`${orphan.thread_id}/${orphan.run_id}.json`, {
      content: JSON.stringify(orphan),
    });

    expect(await storage.count()).toBe(2);
  });

  it('count() (filtered) downloads run blobs and applies the filter', async () => {
    await storage.create(makeRun({ status: 'pending' }));
    await storage.create(makeRun({ status: 'pending' }));
    await storage.create(makeRun({ status: 'success' }));

    expect(await storage.count({ status: 'success' })).toBe(1);
    expect(await storage.count({ status: 'pending' })).toBe(2);
  });

  it('survives the F1 race: two interleaved concurrent creates both remain reachable', async () => {
    // This is the load-bearing assertion. With the original updateIndex()
    // implementation (download -> mutate -> upload of a shared _index.json),
    // the two creates would interleave their RMW and the second writer would
    // clobber the first writer's entry. With A1, each writer writes its own
    // uniquely-named _lookup/{run_id}.json blob — no shared key, no race.

    const runA = makeRun();
    const runB = makeRun();

    // Kick both creates off in parallel and let the JavaScript microtask
    // scheduler interleave them however it likes.
    await Promise.all([storage.create(runA), storage.create(runB)]);

    // Both runs must be reachable via getById — the F1 symptom is exactly
    // that one of them silently disappears under the lost-update race.
    const fetchedA = await storage.getById(runA.run_id);
    const fetchedB = await storage.getById(runB.run_id);

    expect(fetchedA).not.toBeNull();
    expect(fetchedA!.run_id).toBe(runA.run_id);
    expect(fetchedB).not.toBeNull();
    expect(fetchedB!.run_id).toBe(runB.run_id);

    // And both lookup blobs must exist independently.
    expect(container.blobs.has(`_lookup/${runA.run_id}.json`)).toBe(true);
    expect(container.blobs.has(`_lookup/${runB.run_id}.json`)).toBe(true);
  });

  it('create() never reads or writes _index.json (structural witness for A1)', async () => {
    // The OLD code path's lost-update came from a download-modify-upload of
    // the shared _index.json blob inside create(). The structural change in
    // A1 is that create() must touch ONLY the run blob and the per-run
    // lookup pointer — never the global index. We assert that directly: a
    // download hook installed on _index.json that would fire iff create()
    // ever read it. Under A1 the hook must remain pristine after create().

    const runA = makeRun();
    let hookFired = false;
    container.downloadHooks.set('_index.json', async () => {
      hookFired = true;
    });

    await storage.create(runA);

    expect(hookFired).toBe(false);
    expect(container.blobs.has('_index.json')).toBe(false);
    expect(container.uploadCallsByName.get('_index.json') ?? 0).toBe(0);

    // And the run remains reachable via the new lookup blob.
    const fetched = await storage.getById(runA.run_id);
    expect(fetched).not.toBeNull();
    expect(fetched!.run_id).toBe(runA.run_id);
  });
});
