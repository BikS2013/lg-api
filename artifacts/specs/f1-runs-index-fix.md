---
type: spec
id: f1-runs-index-fix
slug: f1-runs-index-fix
date: 2026-05-28
status: draft
produced_by: spec-writer
consumes:
  - /Users/zisisflokas/projects/agents/lg-api/artifacts/research/2026-05-28-lg-api-azure-blob-multi-user-concurrency.md
related:
  adrs: []
  glossary: none
quality_gates:
  - non-goals-listed: pass
  - two-designs-sketched: pass
  - design-concept-one-sentence: pass
  - nfr-posture-addressed-in-design: pass
  - reversibility-boundaries-present: pass
  - open-questions-explicit: pass
  - adr-worthy-surfaced: pass
pause_points_hit: []
mode: full
---

# Tech Spec — Eliminate the `_index.json` Lost-Update Race in Azure Blob Run Storage (F1)

## Problem (restated)

The Azure Blob `AzureBlobRunStorage` provider maintains a single global blob, `_index.json` in the runs container, that maps every `run_id` → its blob path. Every `create()` reads it, mutates a JavaScript object in memory, and writes it back via `uploadJson` — no ETag, no lease, no retry, no coordination of any kind (`src/storage/providers/azure-blob/azure-blob-run-storage.ts:196–202`). The same shape is repeated by `removeFromIndex()` on `delete()` (lines 219–225). Two concurrent run creates anywhere in the deployment race on this blob: each downloads the same snapshot, each appends its own entry, and whichever PUT lands second silently overwrites the other's mapping. A clobbered entry makes the orphaned run unreachable by every API path that resolves it through `getById(runId)` — `GET`, `PATCH`, `cancel`, `delete`, `join`, and stream-rejoin all go through that single lookup (`runs.service.ts:245, 291, 354, 387, 726`). The blob also grows unboundedly with every run ever created, so the lost-update probability rises with traffic and with file size.

The user has asked for **"the cleanest yet minimal solution to address F1, propose alternatives and mark pros and cons."** That phrase is the design constraint of this spec: a fix that is correct, small, dependency-neutral, and easy to back out.

## Goals

- Eliminate the lost-update window on run creation (G1 — correctness, must).
- Preserve the `IRunStorage.getById(runId)` contract — callers in `runs.service.ts` look runs up by run_id alone, with no thread context (G2 — interface compatibility, must).
- Keep the public lg-api REST surface unchanged. No client SDK breakage (G3).
- Stay within Azure Blob primitives already exposed by `azure-blob-helpers.ts` (`uploadJson`, `uploadJsonWithEtag`, `downloadJson`, `buildTags`) plus `ContainerClient.findBlobsByTags` from the existing SDK dependency (G4 — no new infrastructure).
- Make the fix small enough to fit in a single PR with a focused test addition in `test_scripts/` (G5 — minimal diff).
- Provide an unambiguous migration story for any existing `_index.json` data in deployed environments (G6).

## Non-goals

- Not fixing F2 (thread-state history append lost-update). Separate spec, separate scope — the thread-state hot path is much larger and warrants its own design.
- Not fixing F3 (`Run.update()` ETag 412 surfacing as 500). The ETag is already there; the missing piece is caller-side retry, which is a different shape of change.
- Not fixing F4 (`Store.putItem()` last-writer-wins). Different entity, different blob.
- Not switching storage backends. The user's deployment is on Azure Blob and the system has SQLite / SQL Server providers as separate options for those who want a relational backend.
- Not adding Redis, Cosmos, Event Grid, ZooKeeper, or any new infrastructure dependency to coordinate writers.
- Not redesigning the `Run` blob layout (`{thread_id}/{run_id}.json` for stateful, `stateless/{run_id}.json` for stateless) — that path scheme is preserved.
- Not adding a project-wide migration framework. A one-off rebuild script for this single index is in scope; a generic migration runner is not.

## Background

`AzureBlobRunStorage` was implemented with a single global index blob because `getById(runId)` has no thread context. For stateful runs the canonical storage path is `{thread_id}/{run_id}.json` — the `thread_id` segment cannot be recovered from a `run_id` alone, so a runId-only lookup must consult *some* secondary structure. The first author chose the simplest available structure: one shared JSON object. That works for a single Node.js process under low contention; under any real concurrency, it breaks as described in F1 of the upstream investigation (`artifacts/research/2026-05-28-lg-api-azure-blob-multi-user-concurrency.md`).

Three constraints frame the redesign:

1. **The `IRunStorage` interface is fixed.** `getById(runId)` cannot grow a `threadId` argument without touching every caller and every other provider (`InMemory`, `SQLite`, `SQL Server`). That is out of scope for a minimal fix.
2. **`azure-blob-helpers.ts` already provides everything needed.** `uploadJson`, `downloadJson`, `buildTags`, `listBlobsByPrefix`, plus `ContainerClient.findBlobsByTags` from the Azure SDK. No new helper, no new dependency.
3. **The deployment is young.** Per the user's own framing, an existing `_index.json` either has a small number of entries (rebuild is trivial) or is acceptable to discard for ephemeral dev runs. A full historical rebuild is *possible* (by listing every blob and reading its `thread_id`) but should be optional, not mandatory.

Two prior attempts in the codebase are relevant. `uploadJsonWithEtag` was added precisely so that RMW writes could be conditional — but the `_index.json` paths were missed. And the runs already carry tags (`runId`, `threadId`, `status`, `assistantId`) at create time (`azure-blob-run-storage.ts:43–49`). The infrastructure to retire the global index is already in place; the spec is choosing *how* to retire it.

## Designs considered

Three alternatives are developed. A1 is the recommended approach; A2 is the deliberate-straw-man that the investigation sketch favoured (kept for contrast); A3 is the do-the-minimum patch that the user might choose if they want to defer the structural change.

### Design A1 — One-blob-per-run lookup (`_lookup/{run_id}.json`)

Replace the global `_index.json` with one tiny blob per run, written once at create time and never mutated. The blob lives at `_lookup/{run_id}.json` in the same runs container and contains a single field — the canonical run blob path:

```json
{ "path": "thread-abc/run-xyz.json" }
```

`getById(runId)` reads `_lookup/{run_id}.json`, gets the path, and downloads the actual run blob. `create()` writes the lookup blob once, in parallel with (or right after) the main run blob. `delete()` deletes the lookup blob alongside the run blob. No path mutates an existing blob; every write is a single-key, single-writer PUT.

**Code sketch — replace `updateIndex`, `removeFromIndex`, and `lookupIndex`:**

```ts
// New helper inside AzureBlobRunStorage.
private lookupBlobName(runId: string): string {
  return `_lookup/${runId}.json`;
}

// create() — after uploading the run blob, write the lookup pointer.
async create(runOrId: Run | string, maybeRun?: unknown): Promise<Run> {
  const run = resolveCreateArgs<Run>(runOrId, maybeRun);
  const blobName = this.buildBlobName(run);
  const tags = buildTags({
    runId: run.run_id,
    threadId: run.thread_id ?? 'stateless',
    status: run.status,
    assistantId: run.assistant_id,
  });
  await uploadJson(this.containerClient, blobName, run, tags);
  // Replaces updateIndex(): one tiny blob, single-writer, never mutated after create.
  await uploadJson(this.containerClient, this.lookupBlobName(run.run_id), { path: blobName });
  return run;
}

// Replaces lookupIndex() and the index-read inside getById/resolveBlobPath.
private async lookupBlobPath(runId: string): Promise<string | null> {
  const pointer = await downloadJson<{ path: string }>(
    this.containerClient,
    this.lookupBlobName(runId),
  );
  return pointer?.path ?? null;
}

async getById(runId: string): Promise<Run | null> {
  const blobPath = await this.lookupBlobPath(runId);
  if (blobPath) {
    const run = await downloadJson<Run>(this.containerClient, blobPath);
    if (run) return run;
  }
  // Fallback retained for resilience: deterministic stateless path.
  return downloadJson<Run>(this.containerClient, `stateless/${runId}.json`);
}

// delete() — remove the lookup blob alongside the run blob.
async delete(runId: string): Promise<boolean> {
  const blobPath = await this.resolveBlobPath(runId);
  if (!blobPath) return false;
  const result = await deleteBlob(this.containerClient, blobPath);
  if (result) {
    await deleteBlob(this.containerClient, this.lookupBlobName(runId));
  }
  return result;
}
```

`updateIndex` and `removeFromIndex` are deleted. `count()` (line 142) already filters out `_index.json` by name — the filter is changed to also exclude blobs under the `_lookup/` prefix (or simply scopes the listing to exclude that prefix), keeping its semantics identical.

**Pros:**
- **Eliminates the race outright.** Every write is to a unique blob name. No two writers ever touch the same key. Zero coordination needed.
- **Smallest behavioural change.** `getById` still reads a single small blob to find the path. Latency is comparable (one GET on a ~50-byte blob vs one GET on a growing `_index.json` that today is ~100 KB after a few thousand runs — A1 is actually *faster* at scale).
- **Smallest reasoning cost.** Each lookup blob is owned by exactly one run from cradle to grave. No shared state. No retries.
- **Bounded blob count growth, not bounded blob size growth.** Azure containers handle millions of small blobs without trouble; they do not handle multi-megabyte JSON objects rewritten on every write.
- **No new SDK feature needed.** Uses only `uploadJson` / `downloadJson` / `deleteBlob`, all already in `azure-blob-helpers.ts`.
- **Backout is trivial.** Delete the `_lookup/` prefix and the index-rebuild script; the old `updateIndex` code can be restored as-is from git.

**Cons:**
- **Two PUTs per `create()` instead of one.** Negligible cost (the lookup blob is ~50 bytes), but worth naming.
- **Lookup blob is a second point of inconsistency.** If the lookup PUT succeeds and the run PUT fails (or vice versa), there is an orphan in one direction. Mitigation: order the writes so that the run blob is written *first*, then the lookup. If the lookup write fails, the run blob still exists at its canonical path and a periodic rebuild script can re-create the lookup. The reverse failure mode (lookup written, run blob missing) only happens if the run PUT itself fails — in which case `create()` already throws before the lookup is written, so this asymmetry doesn't actually arise.
- **`delete()` becomes two operations.** A partial failure can leave a stale lookup blob pointing at a now-deleted run path. `getById` already handles this — it reads the path, attempts to download, and returns null on 404 — so the worst case is one extra failed GET. A periodic sweep can reap orphan lookup blobs by listing `_lookup/` and verifying each target exists.

**Migration story:** On first deploy of the fix, run a one-time rebuild script:

```
For each blob B in the runs container NOT under '_lookup/' and NOT named '_index.json':
  read B.run_id (it is encoded in the blob name and in the run JSON's `run_id` field)
  write _lookup/{run_id}.json = { "path": B.name }
Delete _index.json.
```

The script is idempotent and safe to run multiple times. It is also unnecessary in environments where lost runs are acceptable (dev / ephemeral) — in those, the fix can deploy with no migration and `getById` will simply return null for pre-existing stateful runs (which are equally null-prone today under the F1 race). The user's "young deployment" framing makes this option attractive.

**Reversibility Tax: Low.** Roll back by deleting the `_lookup/` prefix and restoring the previous `azure-blob-run-storage.ts`. The Run blobs themselves were never touched. No data is lost in either direction.

---

### Design A2 — Tag-based lookup via `findBlobsByTags`

No lookup blob at all. Runs are already tagged at create time with `{ runId, threadId, status, assistantId }` (`azure-blob-run-storage.ts:43–49`). `findBlobsByTags` lets the SDK do an index-side search across the entire container. `getById(runId)` becomes:

```ts
async getById(runId: string): Promise<Run | null> {
  // Azure findBlobsByTags supports a SQL-like filter syntax.
  const query = `"runId"='${runId}'`;
  for await (const match of this.containerClient.findBlobsByTags(query)) {
    return downloadJson<Run>(this.containerClient, match.name);
  }
  return null;
}
```

`updateIndex` and `removeFromIndex` are deleted entirely. `create()` simply writes the run blob with its existing tags; `delete()` simply deletes the run blob. There is no secondary structure to maintain.

**Pros:**
- **Even smaller diff than A1.** Three methods deleted (`updateIndex`, `removeFromIndex`, `lookupIndex`); `getById` and `resolveBlobPath` rewritten in a few lines. `create()` loses one line. `delete()` loses two lines.
- **Zero coordination, zero shared blobs, zero secondary structure.** No orphan-cleanup concerns.
- **One PUT per create, one DELETE per delete.** Strictly fewer Azure operations than today (and than A1).
- **Free tag-based search for other queries.** Once tags are the truth, list-by-status, list-by-assistant, etc. become server-side index queries instead of client-side filters in `count()` / `listByThreadId`.

**Cons (this is why A1 is preferred):**
- **Tag-index eventual consistency.** Azure documents the blob index as *eventually consistent* — a newly-written tag can take seconds to become searchable via `findBlobsByTags`. For an API where a client may create a run and immediately call `GET /runs/{run_id}` on it, this is a real correctness gap, not a paper one. The system would need a "freshly-written runs are temporarily unsearchable" fallback (e.g., a small in-process cache or a deterministic-path probe) — which re-introduces a secondary structure, just in memory.
- **Eventual consistency lag is opaque.** Azure does not document a hard bound. Production systems have observed seconds-to-tens-of-seconds in worst cases. That is incompatible with synchronous-feeling REST.
- **Tag-index is a *separately billed* feature** on some Azure storage account tiers and is *not enabled by default* on every storage account SKU. Some HNS-enabled (ADLS Gen2) storage accounts don't support blob index tags at all. Adopting tag-based lookup as the *only* path silently raises the deployment-target bar in a way that isn't visible in code review.
- **Throws away the index after migration is irreversible-ish.** Going back means re-introducing the lookup mechanism. Possible but more friction than A1's "restore old file" rollback.
- **Hides the index-update race instead of fixing it structurally** if the tag-index is later shown to be insufficient — the team would re-discover the need for a lookup mechanism under pressure.

**Migration story:** Tags are already being written today, so historical runs are already searchable. A one-time backfill is *not* needed in principle — but the eventual-consistency window means recently-created runs at the moment of cutover may briefly be invisible. Mitigation: deploy A2 only after a quiet window, or keep `_index.json` reads as a transitional fallback for ~24 hours.

**Reversibility Tax: Medium.** Rolling back means re-introducing `_index.json` *and* re-populating it from existing blobs. The data is recoverable (tags survive), but the operational migration is real.

---

### Design A3 — ETag-conditional `_index.json` with retry-on-412

Keep the global index. Add ETag protection on every read-modify-write. `updateIndex` and `removeFromIndex` use `downloadJsonWithEtag` + `uploadJsonWithEtag`, and wrap the call in a bounded retry loop on 412 (`isConflictError` is already exported from `azure-blob-helpers.ts:242`).

```ts
private async updateIndex(runId: string, blobPath: string): Promise<void> {
  const indexBlobName = '_index.json';
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await downloadJsonWithEtag<RunIndex>(this.containerClient, indexBlobName);
    const index: RunIndex = existing?.data ?? {};
    index[runId] = blobPath;
    try {
      if (existing) {
        await uploadJsonWithEtag(this.containerClient, indexBlobName, index, existing.etag);
      } else {
        // First-ever write: use ifNoneMatch:'*' equivalent via a regular upload race-tolerated by the retry loop.
        await uploadJson(this.containerClient, indexBlobName, index);
      }
      return;
    } catch (error: unknown) {
      if (!isConflictError(error)) throw error;
      // ETag mismatch — re-read and retry.
    }
  }
  throw new Error(`updateIndex: ETag retry exhausted for run ${runId}`);
}
```

`removeFromIndex` gets the same treatment.

**Pros:**
- **Smallest possible code change.** Two methods, ~15 lines each. No new blobs, no new paths, no migration.
- **Fully backwards compatible.** Existing `_index.json` data is preserved untouched.
- **No new failure mode.** Either the write succeeds (eventually) or throws after exhaustion — never silently loses data.

**Cons:**
- **Does not fix the unbounded-growth problem.** The blob still grows by one entry per run forever. After 100K runs the file is ~10 MB, and every create reads + writes the whole thing. Latency degrades visibly. The race is gone but the architecture is still bad.
- **Serializes every run create system-wide.** Under contention each writer retries up to 5 times. With N concurrent writers, expected attempts are O(N²) — the system thrashes under fan-out.
- **Punts the structural problem to the next person.** The team has to revisit this when the latency starts hurting. That's the cost of "patch, don't fix."
- **`updateIndex` "first ever write" branch is awkward.** The unconditional `uploadJson` fallback for the initial create is itself a small race window (two creates can both see "no index yet" and both `uploadJson`). Worked around by retrying when subsequent reads find a non-empty index, but it's a wart.

**Migration story:** None. Code change only.

**Reversibility Tax: Low.** Pure code change inside the provider. Revert the file to undo.

---

### Picked: Design A1

**Design Concept (one sentence):** *Replace the shared, mutable `_index.json` with one tiny immutable `_lookup/{run_id}.json` pointer blob per run — single-writer at create, single-reader at lookup, never mutated, never contended.*

**Why this, not A2:** Tag-index eventual consistency makes `findBlobsByTags` unsafe as the *only* runId-resolution path for a synchronous REST API. Even with the additional ergonomic wins of A2 (cleaner code, fewer PUTs), the read-after-write correctness gap is a regression relative to today's behaviour for the common "create run then immediately fetch it" sequence. A1 keeps strong read-after-write semantics by reading a blob that was just written, on a name that already exists.

**Why this, not A3:** A3 fixes the race but leaves the structural problem — a growing global JSON file that every create reads and rewrites — fully intact. The user asked for "cleanest yet minimal." A1 is minimally larger than A3 in lines of code but materially better in correctness and operational shape (bounded blob size, no serialization on writes, no retry storms). A3 is the right answer only if "minimal" is interpreted at its most extreme.

## Detailed design

### Interfaces / contracts (unchanged)

`IRunStorage` from `src/storage/interfaces.ts` lines 76–83 stays exactly as-is. Callers in `src/modules/runs/runs.service.ts` need no changes. The fix is fully contained inside `src/storage/providers/azure-blob/azure-blob-run-storage.ts`.

### Data shapes

A new blob namespace `_lookup/` in the runs container. Each blob:

```json
{ "path": "<canonical run blob path>" }
```

- `path` is one of:
  - `{thread_id}/{run_id}.json` for stateful runs
  - `stateless/{run_id}.json` for stateless runs
- Blob name: `_lookup/{run_id}.json`
- Lifecycle: written once at `create()`, deleted once at `delete()`, never mutated.
- Size: ~50 bytes.
- Tags: none required (this blob is name-addressed by `run_id`, so a tag-index lookup would be redundant).

### Module boundaries

Inside `AzureBlobRunStorage`:

- `updateIndex`, `lookupIndex`, `removeFromIndex` are deleted.
- Two new private helpers replace them: `lookupBlobName(runId)` returns the path of the lookup blob, and `lookupBlobPath(runId)` reads it and returns the pointer's `path` (or null).
- `create()`, `getById()`, `delete()`, `resolveBlobPath()`, and `count()` are updated as shown above. No other entity storage class is touched.
- `azure-blob-helpers.ts` is unchanged — A1 uses only existing helpers.

### What the spec deliberately doesn't say

- Loop variables, retry counts, log messages, error codes for "lookup blob missing": these are implementation choices for the patch PR.
- Whether the migration script lives at `scripts/azure-blob-rebuild-run-lookup.ts` or under `agents/skill-agent/` or elsewhere: implementation choice.
- Exact test assertions: the test layer is below the spec.

## NFR posture

| NFR | Target | How addressed |
|---|---|---|
| Correctness (G1) | Zero lost-update window on run create/delete in the Azure Blob provider, including under cross-thread / cross-user fan-out and across multiple Node.js replicas. | A1 eliminates shared mutable state — every write targets a unique blob name. There is no read-modify-write left to race. |
| Interface compatibility (G2) | `IRunStorage.getById(runId)` keeps its one-arg signature. No other storage provider is touched. Public REST surface unchanged. | The fix is fully scoped to `azure-blob-run-storage.ts`. |
| Minimal diff (G5, user's "cleanest yet minimal" framing) | One TypeScript file changed (~30 net lines), one optional one-off rebuild script, one new test file in `test_scripts/`. | Compare to A3 (~15 lines, less correct) and to A2 (~10 lines, but eventually-consistent). A1 sits at the right point on the size/correctness curve. |
| No new dependencies | Stay within the Azure SDK and `azure-blob-helpers.ts`. | A1 uses only `uploadJson`, `downloadJson`, `deleteBlob` — all already in the helpers module. |
| Performance | At least no worse than today; ideally better. | A1 is faster: `getById` reads a ~50-byte blob instead of a growing multi-KB `_index.json`. Today's index download grows with run count; A1's lookup blob is constant-size forever. `create()` does one extra small PUT — negligible. |
| Observability | The patch PR should add one log line per lookup miss (lookup blob not found) so operators can distinguish "no such run" from "stateless run, falling back to deterministic path." Existing log infrastructure is sufficient — no new pipeline. | Logged at debug level inside `lookupBlobPath` and `getById`. |
| Security | None new. The lookup blob carries no PII, no secrets — just a path string assembled from `thread_id` and `run_id`, both of which are server-generated UUIDs. Same access controls as the run blob. | Inherits the runs container's existing access policy. |
| Rollout | Flag-free, single-deploy. Existing deployments with non-empty `_index.json` should run the one-time rebuild script before or shortly after deploying the new code, so historical runs remain reachable. | See "Rollout / Migration plan" below. |
| Availability | No downtime. Old code path (read `_index.json` first, fall back to stateless deterministic path) can coexist with the new code path during a transition window if desired — see Migration. | Optional transitional dual-read documented in the migration plan. |

## Reversibility boundaries

| Decision | Reversibility tax | Mitigation / abstraction |
|---|---|---|
| Replace `_index.json` with `_lookup/{run_id}.json` per-run pointers (A1) | **Low.** Restore the previous `azure-blob-run-storage.ts` from git, delete blobs under `_lookup/`, optionally rebuild `_index.json` from the live run blobs. The Run blobs themselves are untouched in either direction. | The fix is one file; the migration is one script. Keep the script available in the repo for at least one release after deploy so rollback has a paired un-migration. |
| Discard the historical `_index.json` content on deploy | **Medium.** If the deployment has runs that *only* exist via index entries (i.e., orphaned by an F1 race in the past), discarding the index means those runs become permanently unreachable via API. But — and this is the load-bearing observation — those runs are *already* unreachable in any practical sense (no client knows their run_id, no list-API returns them; only by-id lookup would have surfaced them, and the index entry that would let by-id work is what we're discarding). Net effect on the API: zero. | The rebuild script (see Migration) walks the actual run blobs and reconstructs lookup pointers — it does not rely on `_index.json` content. The historical index is at most an audit artifact. |
| Adopting one-blob-per-run as a storage pattern in this provider | **Medium.** If we later decide the `_lookup/` prefix should hold richer metadata (status, timestamps), or should be replaced by tag-based search after Azure improves tag-index consistency, the migration is from a structure we own to a different structure we own — analogous in size to this very spec. The fact that the lookup blob is owned by the same module that consumes it (no external API exposes `_lookup/`) keeps the blast radius small. | The lookup blob has exactly one field (`path`). Adding fields later is forward-compatible. Migrating away is a one-pass list-and-delete. |
| Not fixing F2/F3/F4 in this spec | **Low.** They remain open with their own severities. F2 in particular is the next priority after F1. | Each is its own spec/patch. F1 is being addressed independently because it has the smallest blast radius for a fix and the highest "scale-blocker" effect on the system as a whole. |

The biggest reversibility commitment is **deleting `_index.json` itself** at the end of the migration. Up until that point the system can run in dual-read mode (read `_lookup/` first, fall back to `_index.json`). After the delete, going back to `_index.json` means rebuilding it from the live run blobs — possible but a real operational task. Recommend keeping `_index.json` in place but stop writing to it for one release cycle, then delete it in the *next* release. That makes the cutover Low-Tax instead of Medium.

## Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Lookup blob write succeeds but run blob write failed in a prior step | Very low (run blob is written first; failure of the first write throws before lookup is attempted) | Low (lookup orphan — `getById` returns null, same as today's "no entry" behaviour) | Order: run blob first, lookup second. Period sweep can reap orphans if desired (not required for correctness). |
| Lookup blob delete fails after run blob delete succeeds | Low (single delete, idempotent) | Low (stale lookup pointing at non-existent path; `getById` falls through to null via the existing 404 handling) | Existing `downloadJson` already returns null on 404. Optionally, retry the lookup delete once with idempotent semantics. |
| Migration script run on a deployment with thousands of runs is slow | Medium | Low (script is offline / async; doesn't block API) | Script processes blobs in batches with bounded parallelism. Documented as a one-time op in the migration runbook. |
| Operators forget to run the migration script | Medium | Medium (pre-existing stateful runs become unreachable by `getById`) | Mitigation 1: Include a startup check that logs a warning if `_index.json` exists AND `_lookup/` is empty. Mitigation 2: Document the migration step in `docs/design/project-design.md` and in the release notes for this change. |
| A future tag-based feature wants to use `_lookup/` as a tag-search target | Low | Low | Lookup blobs are unblock-and-untagged today. Tags can be added later non-breakingly. |
| Storage provider abstraction leaks (in-memory / SQLite versions need analogous changes) | Zero | — | Other providers don't have an index — they index in-process. Fix is scoped to Azure Blob only. |

## Open questions

1. **Should `_index.json` be deleted in the same release as the cutover, or one release later?** Recommended: one release later, to keep rollback Low-Tax for the full release cycle. Spec proposes this; final call sits with the implementer / reviewer.
2. **Should a periodic orphan-sweep job be added now, or only if orphans are observed?** Recommended: skip it now. Orphans (lookup with no run, or run with no lookup) have zero API impact in A1 — `getById` already handles missing targets via the existing 404 path. Add a sweep only if telemetry indicates real orphan accumulation.
3. **Migration script: where does it live and how is it invoked?** Recommended: `scripts/migrate-azure-blob-run-index.ts`, runnable as `npx tsx scripts/migrate-azure-blob-run-index.ts`. Reads storage-config.yaml, walks the runs container, writes lookup blobs. Idempotent. Final placement is an implementer choice.
4. **Do we want a feature flag (env var) to toggle between old `_index.json` behaviour and new `_lookup/` behaviour?** Recommended: no. The change is small enough that a clean cutover with the dual-read transitional window is simpler than maintaining two code paths behind a flag. If reviewers disagree, the flag is trivial to add.
5. **Is there any production deployment whose `_index.json` is so large that a rebuild would exceed reasonable script runtime?** User's own framing says the deployment is young — likely not. If telemetry shows >100K runs in any single deployment, the script needs a checkpoint/resume capability. Out of scope for this spec; defer to the patch.

## Extracted ADRs

This spec contains one decision that an outside reader would plausibly question six months from now: **why one-blob-per-run rather than tag-based search**, given the lg-api already invests in `buildTags` infrastructure. The rationale (tag-index eventual consistency invalidates read-after-write for a synchronous REST API) is non-obvious and load-bearing. Recommend capturing it as an ADR via `/adr` after this spec is accepted — the candidate ADR title is *"Azure Blob runId-lookup uses per-run pointer blobs, not tag-index search."*

No other decisions in this spec rise to ADR threshold. The choice to leave F2/F3/F4 out is governance-not-architecture; the migration ordering is operational-not-architectural; the lookup blob's payload shape is too small to be ADR-worthy.

**Action for the implementer: after merge of this spec's patch, run `/adr` once to capture the tag-vs-pointer decision. Do not let it stay implicit in the source comments.**

## Suggested next step

Run `/patch` (or `/split-work` if the migration script and the code change should be tracked as separate units of work) to translate this spec into the actual code change. The spec deliberately stops at "what should be true" — the implementation belongs in a patch PR.
