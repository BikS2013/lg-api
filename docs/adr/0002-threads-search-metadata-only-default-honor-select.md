---
type: adr
id: 0002-threads-search-metadata-only-default-honor-select
slug: threads-search-metadata-only-default-honor-select
number: 0002
date: 2026-06-02
status: accepted
produced_by: adr-capturer
authors: [Zisis Flokas]
consumes: []
related:
  spec: none
  code:
    - src/modules/threads/threads.service.ts
    - src/modules/threads/threads.repository.ts
    - src/schemas/thread.schema.ts
  supersedes: none
  superseded_by: none
quality_gates:
  - real-alternative-documented: pass
  - consequences-split-both-directions: pass
  - reversibility-tax-named-with-rationale: pass
  - sequential-numbering-no-gaps: pass
pause_points_hit: []
reversibility_tax: low
---

# 0002 — `POST /threads/search`: page-bounded projection, `select` honored (default returns `values`, per canonical)

> **Amendment (2026-06-18) — default projection corrected to `values`-by-default.**
> The original decision below chose a **metadata-only default**, premised on that being the canonical
> LangGraph contract. **That premise was wrong.** Canonical `POST /threads/search` returns **`values`
> by default** — verified against the official `agent-chat-ui` (it calls `threads.search` with **no
> `select`** and renders previews from `thread.values.messages`) and the SDK `Thread` type (which marks
> `values`/`interrupts` as **required**, only `extracted` is `NotRequired`).
>
> The real, premise-independent fix is **paginate-before-download**: the provider builds/sorts/paginates
> the matched set from the blob *listing* first, then hydrates at most `limit` bodies (the page). So
> returning `values` by default is **bounded** — never the full-container scan that caused the original
> hang. The metadata-only default was therefore stricter than necessary.
>
> **Corrected decision:** the default projection is the **full canonical thread (`values` +
> `interrupts` included)**, matching the LangGraph contract and standard clients. A caller narrows to a
> lean listing via `select` (e.g. `select:["thread_id","metadata","status"]`), which then skips body
> downloads entirely. `select` is honored either way; the `values`-state-*filter* and the azure-blob
> `values`-filter→501 are unchanged. Implemented in `thread-projection.ts` (`DEFAULT_THREAD_SELECT` now
> includes `values`/`interrupts`). The metadata-only-default wording in the Context/Decision/
> Consequences below is **superseded** by this amendment; kept for decision history.

## Context

`POST /threads/search` in lg-api today ignores the request's `select`, `extract`, and `values`
fields entirely and returns the full stored `Thread` on every matched row — including the complete
`values` conversation-state blob (whole message history). `threads.service.ts:178` reads only
`limit/offset/sort_by/sort_order/metadata/status` and drops `select`/`extract`/`values`; the
repository hands back stored `Thread` objects (with `values`) via `structuredClone`; and
`ThreadSchema.values` is `Type.Optional`, so it serializes on the wire whenever it is present —
which is always.

This is not a theoretical concern. A client called `POST /threads/search` with
`limit:100` against a live lg-api server. Because every row carried its full `values`, the response
was **32.8 MB over 14 s**, truncated mid-body (`ERR_CONTENT_LENGTH_MISMATCH`), and the server then
refused connections (`ERR_CONNECTION_REFUSED`) — the oversized listing request knocked the server
over. This was verified empirically against the deployed server: it returns `values` on every row
and ignoring `select` was confirmed (sending `select:[...]` did not trim the response).

The decision is being made now because this is a live server-crash vector tied to an unbounded,
ever-growing payload (per-thread `values` only gets larger over time), and because the current
behavior is a divergence from the contract lg-api commits to. A deep-dive investigation
established with HIGH confidence, from the LangGraph SDK source and docs, the
canonical Platform-API contract: the search request's `values` field is a **filter** ("state values
to filter on"), while **`select`** controls **which fields are returned**; `values` is one of the
opt-in `ThreadSelectField`s (`thread_id, created_at, updated_at, metadata, config, context, status,
values, interrupts`) — i.e. state is opt-in, not default; and thread state's canonical home is
`GET /threads/{thread_id}/state`. lg-api's own design doc (plan-001) defines it as a "drop-in
replacement for the LangGraph Platform API, prioritizing API-surface accuracy and SDK
compatibility," so this wire divergence is a defect by lg-api's own definition rather than a local
design liberty.

One piece of residual uncertainty is recorded in the References section: the investigator could not
fetch the raw OpenAPI 200-body schema for `/threads/search` (the old `api_ref.html` 404s). Confidence
is HIGH regardless, because "honor `select` + metadata-only default" is correct under either reading
of the response schema.

## Decision

`POST /threads/search` will return **thread metadata only by default** —
`thread_id, created_at, updated_at, metadata, status` (and `config` if/when modeled) — and will
return graph state (`values`, `interrupts`) **only when the caller opts in via the request's
`select` field**, a list of `ThreadSelectField`. A caller that legitimately wants state from a
listing requests it explicitly with `select:["values"]`.

`search()` will build a field projection from `select` rather than passing the stored `Thread`
through verbatim. The request's `values` field should additionally be implemented as a state
*filter* (its canonical meaning) rather than being ignored — though that may be sequenced
separately from the projection change. Projection semantics for `extract` are either implemented in
the same pass or explicitly deferred and documented as not-yet-supported.

The existing per-`limit` cap on the client (already reduced to `limit:20`) is retained as
defense-in-depth, not as the fix.

## Alternatives considered

### A. Honor `select`; default search projection to metadata-only (chosen)
Match the canonical LangGraph contract: metadata-only by default, state via `select:["values"]`.
This fixes the incident (the default response is small and bounded) while preserving SDK
compatibility — clients that genuinely need state from search can still get it by opting in, and
clients that only want a listing pay only listing-sized payloads. Optionally also implement the
request `values` field as a canonical state *filter*. Chosen because it is the only option that both
stops the crash and honors the drop-in-replacement contract.

### B. "Never return values from search" — hard strip (rejected)
Simpler, and it also fixes the incident. Rejected because it breaks canonical compatibility: an SDK
client that passes `select:["values"]` would be unable to get state from search at all. That
violates lg-api's stated drop-in-replacement contract — it trades one wire divergence for another.

### C. Client-side only — cap `limit` (rejected as the fix; kept as defense-in-depth)
The band-aid already applied (`limit:20`). Rejected as the actual fix because the per-thread `values`
payload grows unboundedly, so even a small limit can produce a huge response over time; and because
the server still ignores `select`, no client can request a lean projection at all. It does not
address the contract break. Kept as a defense-in-depth cap, not as the solution.

## Consequences

**Easier:**
- Search becomes canonical / SDK-compatible: `select` controls returned fields exactly as the
  LangGraph Platform API specifies.
- Default search responses are bounded in size, removing a server-crash vector.
- Clean separation of concerns: search = listing/metadata; `GET /threads/:id/state` = state.
- Clients that only need a listing stop paying for the entire conversation history on every row.

**Harder:**
- `search()` must build a field projection from `select` — more logic than today's pass-through.
- Projection semantics for `extract` must be decided: implemented alongside `select`, or explicitly
  deferred and documented as unsupported.
- Tests must cover both the metadata-only default and the `select:["values"]` projection.

**What we now must accept:**
- Existing callers that relied on `values` always being present in every search row must switch to
  `select:["values"]` or to `GET /threads/:id/state`. This is a behavior change for those callers,
  by design.
- Search is now a projecting endpoint, not a pass-through; the stored `Thread` shape and the
  searched-row shape are no longer identical, and that distinction must be maintained going forward.

## Reversibility tax

**Cost of undoing:** Low (Low–Medium in practice)

This is a server-internal projection change behind a stable wire endpoint; the persisted `Thread`
shape does not change, so reverting to the pass-through behavior is a trivial code revert with no
data migration. The only friction — the reason it edges toward Medium — is on the client side: any
client that comes to depend on the new metadata-only default would need to re-add an explicit
`select` if the change were reverted to always-return-everything. That coupling is mild and grows
slowly, and the canonical contract makes a future revert unlikely, so the tax is assessed Low.

## References

- Linked spec: none (no spec exists yet for this change)
- Linked research: a prior internal investigation of the canonical LangGraph thread-search contract (not included in this repo)
- Linked code: src/modules/threads/threads.service.ts (search ~:178), src/modules/threads/threads.repository.ts (search / structuredClone), src/schemas/thread.schema.ts (SearchThreadsRequestSchema, ThreadSchema — `values` is `Type.Optional`)
- Related ADRs: none (supersedes none)

## Open follow-up (residual uncertainty)

Before implementation, confirm against a live LangGraph Platform server or a local `langgraph-api`
instance exactly what `/threads/search` returns **with** and **without** `select:["values"]`. The
raw OpenAPI 200-body schema could not be fetched during investigation (old `api_ref.html` 404s);
confidence is HIGH that "honor `select` + metadata-only default" is correct under either reading, but
the empirical confirmation should be done to lock the precise default field set (notably whether
`config` is in the default projection).

### Implementation notes (added during the projection/pagination fix)

The projection + metadata-only default and the `values` state filter were implemented together with
the azure-blob full-scan fix on branch `fix/threads-search-projection-pagination`. Two items are
deliberately deferred and documented rather than silently dropped:

- **`extract` is NOT supported.** The request `extract` field is accepted by `SearchThreadsRequestSchema`
  but not applied. It is acknowledged-and-deferred at a single point in `threads.service.search()`
  (see the NOTE there). Implementing sub-field state extraction is a follow-up.

- **`values` state filter is NOT supported on the azure-blob backend.** It is implemented and correct
  on memory / sqlite / sqlserver (pushed into the query / applied before pagination). On azure-blob,
  satisfying a `values` filter would require downloading every thread body — the exact full-container
  scan this ADR removes — so `AzureBlobThreadStorage.search()`/`count()` reject a `values` filter with
  an explicit **HTTP 501** and a clear message rather than silently ignoring it or re-introducing the
  scan. A future enhancement could support it by downloading only an already-bounded candidate set
  (i.e. when `metadata`/`status` filters narrow the set first), but that is intentionally out of scope
  here.

The azure-blob fix persists each thread's `status` and JSON-encoded `metadata` (plus timestamps) as
**blob metadata** on `create()`/`update()`, so `search()`/`count()` build metadata-only rows from a
listing (name + blob-metadata + index tags) with **zero body downloads**; bodies are downloaded only
for the page (≤ `limit`) and only when `select` includes `values`/`interrupts`. Threads written before
this change carry no blob-metadata and are recovered by downloading **that one blob's** body — never an
unconditional full-container scan.

### Follow-up hardening (added after integration review of the projection fix)

Three issues surfaced when reasoning about the fix against a live container (~475 pre-existing thread
blobs) and were fixed on the same branch:

- **`listBlobsByPrefixWithTags` must set `includeMetadata: true`.** Without it the SDK returns
  `blob.metadata === undefined` for every blob, so `blobToThread()` always returns null and the
  body-download fallback fires on every row — silently defeating the whole optimization. (The unit
  suite runs on the memory backend, so this only shows against real blob storage.) Now both
  `includeTags` and `includeMetadata` are requested.

- **Legacy recovery and page hydration are now bounded-parallel** (`mapWithConcurrency`, limit 32)
  instead of a sequential `await` loop, so even a fully un-migrated container responds in seconds
  rather than timing out. Search stays read-only (no write-back during recovery).

- **No migration tooling ships.** Pre-existing blobs (written before metadata persistence) are
  handled entirely at read time by the bounded-parallel recovery above, and self-heal on their next
  `update()` (which writes the metadata bag); new threads are born with it. A deployment therefore
  pays the recovery cost only on the shrinking set of never-updated legacy threads — no operator
  migration step is required. (An earlier draft shipped an explicit backfill script; it was dropped
  as unnecessary — the read-time path plus update-driven self-heal cover it.)

### Post-review fixes and known follow-ups

A pragmatic review of the branch surfaced these; fixed in-branch:
- The search response schema (`Type.Array(ThreadSchema)`) made the metadata fields REQUIRED, so a
  projected row (e.g. `select:["values"]`) failed serialization → HTTP 500. Added
  `SearchThreadResultSchema` (only `thread_id` required). The test app overrides Fastify's serializer
  with a passthrough, so this only showed against the real image; `test_scripts/search-serialization.test.ts`
  now exercises the real `fast-json-stringify` compile so the class is caught in CI.
- `POST /threads/search {ids:[...]}` called `repository.searchByIds`, which only the in-memory repo
  implements — a crash on every storage backend. Reworked to resolve ids via `getById` (universal)
  + the same status/metadata/values filters in the service layer.
- In-memory `filterByMetadata` used shallow `===` while filtered `count()` used deep matching, so
  search and count disagreed on nested-object metadata filters. Both now deep-match.

Known follow-ups (NOT yet addressed — flag for the upstream PR):
- **No backfill for pre-existing data (intentional).** Legacy blobs are read-time-recovered and
  self-heal on next `update()`. A metadata-only search over a large set of never-updated legacy
  threads pays the parallel-download cost each call until they self-heal; acceptable for active
  workloads where threads get updated.
- **SQL Server `values` filter** uses `JSON_VALUE` (scalar paths only); a nested-object `values`
  filter silently matches nothing there, while memory/sqlite match it. Either reject it explicitly
  (parity with azure-blob's 501) or use `JSON_QUERY`.
- **`deepEqual` is duplicated** across `thread-projection.ts`, `azure-blob-thread-storage.ts`, and
  `in-memory.repository.ts`; consolidate into one exported helper.

### Blob-metadata write safety (8 KiB cap & non-ASCII)

Persisting `thread.metadata` as Azure **blob metadata** introduces a write-failure vector: Azure caps
total blob metadata (all names + values) at **8 KiB**, and metadata travels as HTTP headers (ASCII).
A thread write must never fail on account of metadata, so `buildThreadMetadata` is hardened:

- **Non-ASCII:** `asciiJson()` escapes every non-ASCII code unit to `\uXXXX`, so the metadata value is
  always header-safe ASCII and still round-trips through `JSON.parse`.
- **Oversized:** if the bag would exceed ~8 KB (`MAX_BLOB_METADATA_BYTES`, with headroom), the blob is
  written with **no** custom metadata (the function returns `{}`) and a warning is logged, instead of
  letting the upload 400.

**What can trigger it:** `thread.metadata` is written only by the client — at `POST /threads` (create)
or `PATCH /threads/{id}` (replace). Per-turn runs update only `status`/`values` (and `values` lives in
the body, which has no cap), so metadata cannot grow over a conversation and a normal turn cannot start
failing. In typical use this never fires (thread metadata is usually tiny, e.g. `{}` or a small id
object); it is a safety net for consumers that attach large metadata to threads.

**Side effects of dropping the bag — performance only, never correctness:**

- The full `metadata` always remains in the blob **body**, so nothing is lost. On a listing,
  `blobToThread()` returns `null` for that blob and it is reconstructed via the body-recovery path —
  the thread still appears in `search`/`count` with correct `metadata`/`status`/`values`, and
  `metadata`/`status` filters still match it. `get-by-id`/`/state` are unaffected.
- That one thread permanently loses its zero-IO listing row: every `search`/filtered-`count` scan pays
  one body download for it. It does **not** self-heal on `update()` (the metadata still won't fit); it
  rejoins the fast path only if the client later shrinks the metadata. Cost scales with how many such
  threads exist.
- Minor: the guard logs a warning on each write of an oversized-metadata thread (including per-turn
  `status` writes), so such a thread is noisy in logs.

This is an all-or-nothing drop on purpose: persisting only `status`/timestamps while omitting the
`metadata` value would make `blobToThread()` report an empty `{}` metadata (wrong) unless a sentinel is
added — a possible future refinement, but the current behavior favors correctness.
