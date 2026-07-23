# Eval design — review feedback response

Per item: the suggestion, whether it is true, why, and what we did.
Implementation details live in code + git history; this doc captures the
design rationale.

Companion to `EVAL_ARCHITECTURE.md` (current) and
`EVAL_BACKEND_TEMPORAL_TECH_SPEC.md` (target).

## Tenet under review

> Clear separation between Control Plane (CP) and Data Plane (DP).
> Customer data must be handled entirely in DP and must never reach CP.

---

## 1. Customer data leaks into CP via Temporal payloads

**Suggestion.** Activities return full per-case results (response, retrieved
chunks, tool I/O) through Temporal, landing in Temporal's CP-side Postgres.

**True?** Yes — broader than stated.

**Why.** `invokeAgent` returned the full `AgentInvocationResult` to event
history; the inline `runCase` then passed the full `CaseRunArtifact` to the
parent in workflow memory. Every test-case input + LLM response + retrieved
chunks + tool I/O landed in CP storage.

**Our approach.** Activities exchange path-only payloads
(`{caseRef, capturePath}`). `invokeAgent` writes the full capture to PVC at
`<runDir>/cases/<caseId>/<variantId>/<model>/<seed>/capture.json`; all
downstream activities read from PVC. Temporal event history holds only the
bounded `{caseRef, capturePath, telemetry-headline, scorer-outputs}` shape.

**Status: done** (stage 4). See `capture-file.ts`, `posix-store.ts`, and
the per-case activity signatures in
`lib/evaluation/lib/activity-signatures.ts`.

---

## 2. Customer data leaks into CP via `config-service` artifacts

**Suggestion.** Job results stored back to `config-service` carry customer
data into CP and are a scaling concern (per-run raw results can be MB–GB).

**True?** Partially. Per-case raw artifacts already lived on PVC in arch
v3, not in `config-service`. But `EvaluationRun.casesSnapshot` (jsonb of
every test case) and `EvaluationRun.results.failedCases[].rationale` did
leak DP-derived text into CP.

**Our approach.** On `EvaluationRun`:

- Drop `casesSnapshot` (replaced by a dataset pointer + content hash;
  JSONL lives on PVC — see item 4).
- Drop `failedCases[]`. Failed-case detail moves to per-case
  `capture.json` on PVC.
- Drop `artifacts` jsonb. Cross-run reference becomes a path calculation
  via `runDirKey()`.
- Keep `EvaluationRun.results` as a *numeric-only summary facet*
  (coverage, infra-failure %, quality %, gate outcome, failure count).
  No DP content.

**Status: done** (stages 2 + 4). Schema drops landed in
`config-service/models/EvaluationRun.ts` and both OpenAPI specs.

---

## 3. Child workflow per test case

**Suggestion.** A child workflow per case is unnecessary and creates noise
in Temporal at 10k-case scale.

**True?** Yes.

**Our approach.** Single `AgentEvaluationWorkflow` iterating cases through
an inline `runCase` helper that calls plain activities. The per-activity
retry/timeout dials are preserved; the child-workflow rows go away.

**Status: done** (stage 3). `agent-test-case.workflow.ts` deleted; body
moved to `workflows/run-case.ts`.

---

## 4. `EvaluationTestCase` storage + GUI editor

**Suggestion.** Golden test cases are sensitive DP data; storing them in
`config-service` and editing in a custom GUI is unnecessary complexity and
a security concern. Users should provide a JSONL file; we validate at
workflow start.

**True?** Yes.

**Our approach.** Drop the `EvaluationTestCase` entity. The test-cases
JSONL is owned by the evaluation template and lives on PVC at
`projects/{p}/evaluations/{evalId}/testcases/{filename ?? 'cases.jsonl'}`.
`EvaluationTemplate.cases` collapses to
`{ schemaVersion, filename?, sample?, filter? }`. A `validateTestCases`
activity reads the JSONL, validates the schema, and stages a
byte-for-byte audit copy at `<runDir>/_input/cases.jsonl`. Replay
determinism comes from Temporal's activity-result cache. The GUI shows
a read-only list + "upload new version" control; no custom editor.

Uploads via eval-scoped routes:

```
PUT    /api/v1/projects/{p}/evaluation/agents/evaluations/{evalId}/testcases
GET    .../testcases
DELETE .../testcases
```

**Status: done.** `validateTestCases` activity, route handlers in
`evaluationAgentRoutes.ts`, JSONL parser at `lib/golden-jsonl.ts`.

---

## 5. Explain what an `EvaluationTemplate` contains

**Suggestion.** Add a section to the design doc explaining template fields.

**Our approach.** Added "What is an `EvaluationTemplate`?" to
`EVAL_ARCHITECTURE.md`, grouping fields into five concerns (identity,
target, dataset pointer, evaluators+thresholds, operational settings).

**Status: done** (doc only).

---

## 6. "Scoring" as a workflow state

**Suggestion.** Scoring is per-case and pipelined; not a workflow state.

**True?** Yes — the column was misnamed. Per-case scoring runs in parallel
with capture across cases via the parent's fan-out; the parent transitions
to a post-aggregation phase only after every case returns.

**Our approach.** Renamed status `scoring` → `aggregating` in
`EvaluationRunStatus`, `EvaluationProgress.phase`, both OpenAPI specs, and
the state-machine diagrams.

**Status: done.** `status` is a plain varchar — a one-time backfill
`UPDATE evaluation_runs SET status='aggregating' WHERE status='scoring'`
clears legacy rows.

---

## 7. `compares/` directory and comparison workflow

**Suggestion.** Unclear what `compares/` stores or whether a separate
comparison workflow is needed.

**True?** Yes — the trigger model and execution surface were undocumented.

**Why.** Compare is *not* a separate operation. Every regression-mode run
diffs its own `results.json` against an earlier run of the same template.
Three surface mistakes existed:

1. `compareToBaseline` only fired when the template had a pinned
   `regression.baselineRunId`. The common default — "compare to previous
   run" — was missing.
2. A misleading comment claimed `config-service` invokes
   `buildCompareReport` (impossible — `config-service` can't call worker
   activities).
3. Compare output was a separate `compare_report.json` under a
   cross-cutting `compares/{idA}_vs_{idB}/` directory. The report is
   owned by the current run; it should fold into that run's
   `results.json`.

**Our approach.**

- **Default baseline = previous run.** New `findPreviousRun` activity
  queries `evaluation_runs` for the most recent prior
  `status='completed'` for `(projectId, templateId)`; workflow falls back
  to it when no baseline is pinned.
- **Phase c composes the rich compare data** via `buildCompareReport`
  inside the same workflow. The activity reads the baseline run's
  `results.json` from PVC and merges the report back into the current
  run's `results.json` as a top-level `compareReport` field.
- **No `POST /compare-runs` endpoint.** Compare is anchored to a run
  executing end-to-end.

**Status: done.** `findPreviousRun` activity, Phase c wiring,
`buildCompareReport` purity, `compareDirKey()` retired.

---

## 8. Section 8 (gating) is unclear

**Suggestion.** Section 8 is a jumble of keywords. Expand it.

**Our approach.** Rewrote section 8 of
`EVAL_BACKEND_ARCHITECTURE_DIAGRAMS_V3.md`: problem statement, pre-flight
checks table, post-run gates (headline / suite-specific / health-policy),
verdict composition flowchart, override-signal table.

**Status: done** (doc only).

---

## Reviewer's "Strongly suggest" list

- PVC for results + reports — done.
- Cross-run reference via path convention, no config-service round-trip
  — done (`runDirKey()` is the source of truth).
- JSONL test-case file in DP, no GUI editor — done (item 4).
- File-based per-case payload (Redis or PVC) — done with PVC capture
  files (item 1). See appendix for why we chose PVC over Redis.

---

## Appendix: Why Redis was not adopted for capture storage

Item 1's reviewer suggestion mentioned Redis as the DP transport. Stage 4
landed PVC capture files instead. This appendix records the sizing +
comparison analysis so future revisitings have a baseline to argue
against.

### Baseline: 100-case A/B run

Captures are fanned out by `caseDirKey()` on
`(caseId, variantId, model, seed)` (`posix-store.ts:65-74`) — "100 tests
A/B" is 200 capture files; A/B + repeat-N=3 is 600. Workflow concurrency =
10 in-flight cases (`workflow-signals.ts:19`); captures accumulate until
`writeResultsFile` (`artifact.activities.ts:72-83`), so peak per-run
footprint equals the totals below regardless of parallelism.

Per-capture sizes from the `AgentInvocationResult` schema
(`case-artifact.ts:178-189`, ~4 B/token). The LLM response text itself is
one of the *smallest* components (~3 KB); the dominant bytes are
`retrievedChunks.content`, `raw` (provider payload), `trace`, and
(multi-agent) `perAgent[]` recursion. At the platform default KB config
(`CHUNK_SIZE=512` chars, k=10 — see `kb-processor/utils/config.py:199`)
`retrievedChunks.content` contributes ~5 KB per capture; `raw` and
`trace` then dominate. Custom KBs with `chunk_size=1000`+ or k=20 push
captures toward the Heavy-RAG row.

| Profile | Drivers | Per-capture |
|---|---|---|
| Typical RAG (default 512-char chunks, k=10) | response + 10 chunks + 1–2 tools + raw + trace | **~40 KB** |
| Heavy RAG (custom chunk_size=1000+, k=20) | larger chunks, deeper retrieval | ~150 KB |
| Multi-agent (3 sub-agents recursing, default chunks) | sub-agent shares + own chunks + tools each | **~125 KB** |

| Mode | Captures | Typical RAG @ 40 KB | Multi-agent @ 125 KB |
|---|---|---|---|
| A/B 2× | 200 | ~8 MB | ~25 MB |
| A/B + repeat-N=3 | 600 | ~24 MB | ~75 MB |

### PVC vs Redis at this scale

| Dimension | PVC / s3gateway | Redis |
|---|---|---|
| Cost — 100-case A/B (8 MB typical, ~25 MB multi-agent; up to ~100 MB at Heavy-RAG upper bound) | < $0.01/run on object storage | 8–40 MB resident RAM/run at defaults; Heavy-RAG / repeat-N=3 multi-agent still pushes a cache-class instance ($25–200/mo) at 5–10 concurrent runs |
| Per-key read latency | 5–20 ms | 0.5–8 ms (large keys block the single-threaded event loop) |
| `writeResultsFile` 200-read wall time | ~2 s (mitigable to ~0.2 s with `Promise.all`) | ~0.2 s |
| Audit durability for `_input/` | Native — versitygw is durable object storage | Would require shadow-writing to S3 |
| TTL vs Temporal workflow lifetime | N/A | Workflows can stall for hours; TTL race risks data loss |
| Cross-worker convention | Same s3gateway mount as dataset / kb / connector workers | Eval-worker would be the only blob-store user of Redis |
| Loss on Redis restart | N/A | Permanent — capture is the only copy |

Latency wins single-digit seconds against a multi-minute workflow — not
visible to users. Cost, durability, audit, and convention are decisive.

### How this differs from existing Redis usage

Two services do use Redis. Both follow the same pattern — eval captures
break every column:

| Aspect | connector-worker (Streams) | artifact-service (idempotency) | Eval captures (hypothetical) |
|---|---|---|---|
| Value size | ~200–500 B references | ~1 KB | **~40 KB – ~500 KB** opaque blob (default ~40 KB; multi-agent ~125 KB; Heavy-RAG upper bound ~500 KB) |
| Redis-specific primitive used | Yes — Streams, HINCRBY, Lists | No | **No** — pure GET/SET |
| Durable copy elsewhere? | Yes — actual files on object storage | Yes — artifact in DB | **No** |
| Acceptable loss on restart? | Yes — Temporal retries | Yes — duplicate write at worst | **No** |
| TTL matches lifecycle? | Yes — items deleted on ACK | Yes — TTL == dedup window | No — captures need to outlive workflow for audit |

The shared pattern: **small values + coordination semantics + acceptable
loss + Redis-specific primitives**. Captures match none. Adopting Redis
for captures would make eval-worker the first place in this codebase
where Redis is used as a blob store.

### Trim `results.json` to headlines + per-case scorer outputs

`results.json` was the larger artifact because `materializeArtifact()`
inlined every capture into each row — 8–25 MB for a 100-case A/B at
default KB config, ~75 MB for multi-agent + repeat-N=3, and up to the
original 110–325 MB at Heavy-RAG upper bounds. UI fetched the full body
per item 7; `JSON.stringify` peaked worker heap at ~2× the file size.

**Decision.** Strip heavy fields from `results.json`. Captures live on
PVC addressable by `capturePath`; duplicating them into the results body
partly defeats item 1's path-only contract.

- **Stays per row** (from slot + small capture-merge): `caseRef`,
  `response`, `status`, timing, `telemetry`, `deterministicMetrics`,
  `judgeRubrics[]`, `goldenAssertions`, failure metadata,
  `retrievalAnnotation`, `resolvedRuntimeParams`, `capturePath`.
- **No longer denormalized** (still on PVC via `capturePath`):
  `retrievedChunks`, `toolCalls`, `perAgent[]`, `rawProviderPayload`,
  `citations`. Required arrays default to `[]` so readers see a
  branch-free shape.

Sizes become shape-independent (multi-agent recursion is what's removed):

| Mode | Captures | `results.json` |
|---|---|---|
| A/B 2× | 200 | **~2 MB** |
| A/B + repeat-N=3 | 600 | ~6 MB |

**Status: done** (worker side). `materializeArtifact()` trimmed in
`artifact.activities.ts`; matching test in
`test/activities/artifact.activities.test.ts`. UI lazy-load follow-up
tracked separately.

### When to revisit

Revisit Redis for captures only if workloads shift to: 1,000+ captures
per run; sub-second UI drill-in across full results pages; or
`writeResultsFile` becoming a P99 hotspot beyond what `Promise.all`
batching mitigates. The narrow first Redis adoption — if needed — should
be **progress livestream state** (KB-scale counters polled by UI), not
capture storage.

### Adjacent gap: GC of `cases/`

The eval-worker has no cleanup hook for `cases/` after a run. Add an S3
lifecycle policy on `projects/*/evaluations/*/runs/*/cases/` (expire
30–90 days) — zero code change, preserves drill-in for the retention
window.
