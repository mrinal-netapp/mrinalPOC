# AgentStudio — Offline Evaluation Architecture

## Overview

AgentStudio evaluates agent quality **offline** in a Temporal-based harness (`eval-worker`). It replays curated **golden test cases** against an agent, captures the output, and scores it in **two layers** — cheap **deterministic** scorers plus an **LLM-as-judge** — then aggregates across cases and applies **run-level gates** to produce a verdict.

This document is a learning guide to that architecture, with ASCII diagrams for each concept. It also includes an appendix on a related KB-ingestion correctness issue (incremental re-ingest duplicates) uncovered while tracing the retrieval → citation → eval data flow.

Key source files (in the AgentStudio monorepo):

| Area | Path |
|---|---|
| Per-case workflow + pass/fail | `src/nemo/workers/eval-worker/src/workflows/run-case.ts` |
| Deterministic scorers + aggregation + gates | `src/nemo/workers/eval-worker/src/activities/scoring.activities.ts` |
| LLM-judge rubric catalog | `src/nemo/workers/eval-worker/src/lib/judge-prompts.ts` |
| Golden test-case schema | `src/nemo/workers/eval-worker/src/lib/evaluation/lib/golden-types.ts` |
| Metrics matrix (reference) | `src/nemo/workers/eval-worker/doc/EVAL_METRICS_MATRIX.md` |
| Agent run + capture | `src/nemo/workers/eval-worker/src/activities/agent.activities.ts` |

---

## 1. End-to-end offline eval flow

```text
                        OFFLINE EVAL FLOW (eval-worker, Temporal)
                        =========================================

 ┌────────────────────────────────────────────────────────────────────────────┐
 │ GOLDEN DATASET  (JSONL, one GoldenTestCase per row)                          │
 │   input.query:            "How many days to return an item?"                 │
 │   evaluation:                                                                │
 │     retrieval_expectation.relevant_document_ids: ["<chunkId>"]  ← captured   │
 │     expected_response.final:                                                 │
 │        expected_answer: "You have 30 days…"     must_include: ["30 days"]    │
 │        must_cite: [returns.md]                  forbidden:    ["90 days"]    │
 └───────────────────────────────┬──────────────────────────────────────────────┘
                                  │ trigger (config-service → workflow-engine)
                                  ▼
                   ┌───────────────────────────────┐
                   │ agent-evaluation.workflow     │  fan-out: one run-case per row
                   └───────────────┬───────────────┘
                                   │
        ╔══════════════════════════▼═══════════════════════════════╗
        ║  PER-CASE: run-case workflow                              ║
        ║                                                           ║
        ║  (1) RUN AGENT on input.query                             ║
        ║        └─► CAPTURE artifact:                              ║
        ║              response, retrievedChunks[{id,source,text}], ║
        ║              citations(kbCitations), toolCalls, telemetry ║
        ║                          │                                ║
        ║        ┌─────────────────┴───────────────────┐           ║
        ║        ▼                                      ▼           ║
        ║  (2) DETERMINISTIC scorers            (3) LLM-JUDGE       ║
        ║      (cheap, exact)                      (semantic)       ║
        ║  ┌───────────────────────────┐   ┌────────────────────┐  ║
        ║  │ vs expected_answer:       │   │ correctness:       │  ║
        ║  │   correctness.em/bleu/    │   │  factual_accuracy  │  ║
        ║  │   rougeL/tokenF1          │   │  logical_consist.  │  ║
        ║  │                           │   │  hallucination_abs │  ║
        ║  │ vs retrievedChunks:       │   │                    │  ║
        ║  │   rag.groundedness        │   │ faithfulness_      │  ║
        ║  │   rag.context_precision   │   │  groundedness:     │  ║
        ║  │   rag.context_recall      │   │  claim_support     │  ║
        ║  │     (relevant_document_ids│   │  no_fabrication    │  ║
        ║  │      ∩ chunk.id)          │   │  citation_use      │  ║
        ║  │                           │   └─────────┬──────────┘  ║
        ║  │ goldenAssertions:         │             │             ║
        ║  │   must_include (sub/regex)│             │             ║
        ║  │   must_cite.coverage      │             │             ║
        ║  │   rag.citation_alignment  │             │             ║
        ║  │   forbidden (must NOT)    │             │             ║
        ║  └────────────┬──────────────┘             │             ║
        ║               └───────────────┬────────────┘             ║
        ║                               ▼                          ║
        ║  (4) derivePass(goldenAssertions, judgeRubrics, safety)  ║
        ║        → passed / failureCategory / rootCause            ║
        ║          e.g. rag.groundedness < 0.5                     ║
        ║               → 'retrieval' / 'ungrounded_synthesis'     ║
        ╚═══════════════════════════════╤═══════════════════════════╝
                                        │ per-case artifacts
                                        ▼
                   ┌───────────────────────────────────────┐
                   │ AGGREGATE  (aggregateMetrics)          │
                   │   dimensions[]: rag, correctness,      │
                   │   must_cite, perf, cost … (p50/p95)    │
                   │   coverage, judgeCoverage              │
                   └───────────────┬───────────────────────┘
                                   ▼
                   ┌───────────────────────────────────────┐
                   │ GATES  (template.thresholds.gates[])   │
                   │   headline vs threshold                │
                   │   (isHigherBetter / isLowerBetter)     │
                   │        │                               │
                   │        ▼                               │
                   │   VERDICT: pass / fail  → gate release │
                   └───────────────────────────────────────┘
```

---

## 2. Per-case scoring: two layers

Scoring a single case happens in two complementary layers. Deterministic scorers are cheap, reproducible, and lexical; the LLM judge is semantic but costs money and is non-deterministic.

```text
   DETERMINISTIC                          LLM-JUDGE
   ─────────────                          ─────────
   cheap, exact, reproducible             costs money, semantic, non-deterministic
   needs golden (expected_answer,         reference-free-ish (judge decides;
     relevant_document_ids)                 faithfulness needs chunks present)
   paraphrase-blind (lexical)             catches paraphrase / real support
   runs on every case                     often sampled (judgeSamplingMode)
        │                                       │
        └──────────► both feed derivePass ◄─────┘
   strategy = deterministic | llm_judge | deterministic_plus_llm_judge
```

The deterministic layer itself computes three groups of signals:

- **vs `expected_answer`** — lexical similarity to the golden answer: `correctness.em` (exact match), `correctness.bleu` (BLEU-1 + brevity penalty), `correctness.rougeL` (ROUGE-L F1), `correctness.tokenF1` (unigram F1). Golden-dependent; paraphrase-blind.
- **vs `retrievedChunks`** — retrieval + grounding quality: `rag.groundedness` (fraction of response tokens found in any chunk), `rag.context_precision` (`|retrieved ∩ relevant| / |retrieved|` — noise), `rag.context_recall` (`|retrieved ∩ relevant| / |relevant|` — completeness).
- **`goldenAssertions`** — targeted binary rules: `must_include` (patterns that must appear), `must_cite` → `must_cite.coverage` / `rag.citation_alignment` (required sources cited), `forbidden` (patterns that must NOT appear), `schemaValid` (structured output).

---

## 3. The two "families" of signals

Signals split by **role** (does it gate the per-case pass, or aggregate for run-level gates?), **not** by deterministic-vs-LLM. This is a common point of confusion.

```text
                    │ PER-CASE BLOCKING              │ RUN-LEVEL AGGREGATE
                    │ (binary veto in derivePass)    │ (mean → gates)
  ──────────────────┼────────────────────────────────┼──────────────────────────
   DETERMINISTIC    │ goldenAssertions:              │ correctness.em/bleu/
                    │   must_include, must_cite,     │   rougeL/tokenF1
                    │   forbidden, schemaValid       │ rag.groundedness
                    │ safety classifier              │ context_precision/recall
                    │        ── FAMILY 1 ──          │ tool.*, structured.*,
                    │                                │ perf.*, cost.*
                    │                                │        ── FAMILY 2 ──
  ──────────────────┼────────────────────────────────┼──────────────────────────
   LLM-JUDGE        │ judgeRubrics (0.5 veto)        │ (none today — judge rubrics
                    │        ── FAMILY 1 ──          │  don't aggregate into gates)
```

- **Family 1 = per-case-pass column** = deterministic binary assertions + safety **+** the LLM judge rubrics. A **mix** of deterministic and LLM.
- **Family 2 = run-level aggregate column** = all deterministic **numeric** metrics.
- **Everything in Family 2 is deterministic**, but **not everything deterministic is Family 2** — the binary golden assertions are deterministic yet live in Family 1.
- The bottom-right cell is essentially empty today: judge (LLM) scores do **not** aggregate into gate-able headlines.

---

## 4. `derivePass` — the per-case pass/fail combinator

`derivePass` is a **fail-fast AND**: a case passes only if every blocking check passes. Inputs are `goldenAssertions`, `judgeRubrics`, `safety` — the continuous numeric metrics are **not** inputs.

```ts
function derivePass(
  goldenAssertions: GoldenAssertionReport | undefined,
  judgeRubrics: JudgeRubricOutput[],
  safety: { unsafe: boolean; falseRefusal: boolean },
): boolean {
  if (safety.unsafe) return false;
  const final = goldenAssertions?.final;
  if (!final) return false;
  if (final.mustInclude.some((a) => !a.satisfied)) return false;
  if (final.mustCite.some((a) => a.required && !a.satisfied)) return false;
  if (final.forbidden.some((a) => a.violated)) return false;
  if (!final.schemaValid) return false;
  const failedJudge = judgeRubrics.some(
    (j) => !j.errored && typeof j.score === 'number' && j.score < 0.5,
  );
  if (failedJudge) return false;
  return true;
}
```

### Detailed mental model

```text
                        PER-CASE SCORING  →  RUN VERDICT   (run-case workflow)
                        ============================================================

  SCORER OUTPUTS FOR ONE CASE — split into TWO families by how they gate:

  FAMILY 1 — reliable binary/semantic signals        FAMILY 2 — noisy continuous metrics
  (trustworthy per single case)                       (only meaningful in aggregate)
  ┌───────────────────────────────────────┐          ┌──────────────────────────────────────┐
  │ safety            { unsafe }           │          │ correctness.em / bleu / rougeL /      │
  │ goldenAssertions  must_include         │          │   tokenF1                             │
  │                   must_cite (required) │          │ rag.groundedness                     │
  │                   forbidden            │          │ rag.context_precision / recall        │
  │                   schemaValid          │          │ tool.call_success                     │
  │ judgeRubrics[]    score (0..1)         │          │ perf.* / cost.*                       │
  └───────────────┬───────────────────────┘          └───────────────┬──────────────────────┘
                  │                                                   │
                  │ (inputs to derivePass)                            │  NOT inputs to derivePass
                  ▼                                                   │
  ╔══════════════════════════════════════════════════╗               │
  ║  derivePass(goldenAssertions, judgeRubrics,safety)║               │
  ║  FAIL-FAST  AND   (any one false ⇒ case FAILS)    ║               │
  ║                                                   ║               │
  ║   safety.unsafe? ───────────────── yes ─► FAIL    ║               │
  ║   no golden final report? ──────── yes ─► FAIL    ║               │
  ║   any must_include NOT satisfied? ─ yes ─► FAIL   ║               │
  ║   any required must_cite missing? ─ yes ─► FAIL   ║               │
  ║   any forbidden present? ───────── yes ─► FAIL    ║               │
  ║   !schemaValid? ────────────────── yes ─► FAIL    ║               │
  ║                                                   ║               │
  ║   judge veto:                                     ║               │
  ║     some rubric ( !errored            )           ║               │
  ║                 ( score is number     )           ║               │
  ║                 ( score < 0.5  ← hard )  ─ yes ─► FAIL             │
  ║        ▲ errored judge = SKIPPED (fail-open)      ║               │
  ║        ▲ same 0.5 bar for every rubric (AND)      ║               │
  ║                                                   ║               │
  ║   else ─────────────────────────────────► PASS    ║               │
  ╚════════════════════┬═══════════════════┬══════════╝               │
                       │                   │                          │
                    PASS = true         PASS = false                  │
                       │                   │                          │
                       │                   ▼                          ▼
                       │      ╔══════════════════════════════════════════════════╗
                       │      ║ classifyFailure(goldenAssertions, DETERMINISTIC,  ║
                       │      ║                 safety)   — DIAGNOSIS only        ║
                       │      ║ priority ladder, first match wins:                ║
                       │      ║   safety.unsafe        → safety / refusal_issue   ║
                       │      ║   !schemaValid         → schema / schema_violation║
                       │      ║   rag.groundedness<0.5 → retrieval /              ║
                       │      ║                          ungrounded_synthesis     ║
                       │      ║   tool.call_success<0.5→ tool / tool_misuse       ║
                       │      ║   else                 → judge_scoring            ║
                       │      ╚═══════════════════════┬══════════════════════════╝
                       │                              │ label may ≠ literal trigger
                       │                              │ (priority-ordered heuristic)
                       ▼                              ▼
                 ┌───────────────────────────────────────────────┐
                 │ CASE ARTIFACT                                 │
                 │  passed, failureCategory?, rootCause?,        │
                 │  deterministicMetrics{...}, judgeRubrics[...] │
                 └───────────────────────┬───────────────────────┘
                                         │  (all cases)
                                         ▼
                 ┌───────────────────────────────────────────────┐
                 │ AGGREGATE  (aggregateMetrics)                 │◄─── FAMILY 2 numbers
                 │  mean/p50/p95 per dimension: rag, correctness,│     averaged over cases
                 │  perf, cost … + coverage, judgeCoverage       │     (noise smooths out)
                 └───────────────────────┬───────────────────────┘
                                         ▼
                 ┌───────────────────────────────────────────────┐
                 │ RUN-LEVEL GATES  template.thresholds.gates[]  │
                 │  configurable per metric (higher/lower-better) │
                 │  e.g. mean rag.groundedness ≥ 0.7             │
                 │  + blocking: infra_failure_rate,              │
                 │    min_completed_cases; warning: judge health │
                 └───────────────────────┬───────────────────────┘
                                         ▼
                                   VERDICT: pass / fail
```

### Three key behaviors

1. **Numeric metrics do not gate per-case pass.** `correctness.em`, `rag.groundedness`, `context_precision/recall`, BLEU are computed but not inputs to `derivePass`. A single case's continuous score is noisy; it is only trustworthy in aggregate, so those gate at the run level instead.
2. **Judge errors fail-open.** `!j.errored` means a judge call that crashed (timeout, malformed JSON) is skipped, not counted as a quality failure. Infra flakiness must not masquerade as a regression; it is surfaced separately via `errorType: 'infra'` and the `judge_scoring_health` gate.
3. **Hard, uniform 0.5 judge threshold.** Every enabled rubric shares the same 0.5 bar and is AND-ed (any rubric < 0.5 vetoes). Not tunable per rubric.

---

## 5. `classifyFailure` — diagnosis, not decision

`classifyFailure` runs **only when a case already failed**. It walks a **priority ladder** and returns the first match to bucket the failure for triage dashboards.

```text
   if safety.unsafe                    → 'safety'    / 'safety_refusal_issue'
   if final && !schemaValid            → 'schema'    / 'schema_violation'
   if rag.groundedness < 0.5           → 'retrieval' / 'ungrounded_synthesis'
   if tool.call_success < 0.5          → 'tool'      / 'tool_misuse'
   else                                → 'judge_scoring'
```

Caveat: the label is a **priority-ordered heuristic**, not proof of the trigger. A case failed by a judge rubric (score 0.4) whose `rag.groundedness` also happens to be < 0.5 is labeled `retrieval / ungrounded_synthesis`, higher in the ladder — so the labeled root cause may not be the literal cause.

```text
   derivePass(...)  ──►  passed? ── true ──►  (no category)
                               │
                             false
                               │
                               ▼
                       classifyFailure(...)  ──► failureCategory + rootCause
                       (priority-ordered attribution for triage)
```

---

## 6. Two decision levels: per-case verdict vs run-level gates

There are **two pass/fail levels**, but only the second is literally called a "gate".

```text
   each case ──► derivePass ──► passed + deterministicMetrics{...}
                                      │
                 (all cases) ─────────┤
                                      ▼
                 AGGREGATE:  mean(metrics) → headlines
                             completed/total → coverage
                             infra errors → infraFailureRate
                                      │
                                      ▼
                 computeGates ──► threshold headlines + meta ──► RUN VERDICT
```

**Level 1 — per-case verdict (`derivePass`)**: decides `passed` for one case. Not a "gate". One case failing does not by itself fail the run.

**Level 2 — run-level gates (`computeGates`)**: decides the run `verdict` from aggregates.

| Gate | Level | Checks (aggregate) |
|---|---|---|
| `coverage` | blocking | % cases that completed ≥ min |
| `infra_failure_rate` | blocking | infra errors ≤ max |
| `min_completed_cases` | blocking | enough cases ran (default ≥ 50%) |
| `judge_scoring_health` | warning | judge coverage healthy |
| `preflight_policy` | warning | preflight warnings |
| `tradeoff_acknowledgment` | blocking (cond.) | conflicting signals unacked |
| every `template.thresholds.gates[]` | configurable | a **headline metric** vs threshold (higher/lower-better) |

`verdict = fail` if any **blocking** gate fails.

**The two levels are decoupled.** Run gates threshold aggregated metrics + execution health, **not** the count of cases that passed `derivePass` (note `coverage` counts cases that *ran to completion*, not that *passed*). So a run can:

- **fail** its gates while most cases passed (e.g. mean groundedness 0.62 < 0.7 gate), or
- **pass** its gates with several case failures (a few failures don't move the mean below threshold).

---

## 7. What aggregation (averaging) does

`aggregateMetrics` groups per-case metrics by dot-prefix and takes the **mean** as the headline; `perf`/`cost` also get percentiles.

```ts
for (const [metricId, values] of metricMap.entries()) {
  headline[metricId] = mean(values);
  if (prefix === 'perf' || prefix === 'cost') {
    const p50 = percentile(values, 0.5);
    const p95 = percentile(values, 0.95);
    const p99 = percentile(values, 0.99);
    // + headline[`${metricId}_p95`] etc.; cost also _max / _sum
  }
}
```

Key insight — **the mean of a 0/1 or ratio metric is a rate**:

| Per-case metric | Value | Mean over suite = |
|---|---|---|
| `correctness.em` | 0/1 | exact-match accuracy |
| `structured.schema_valid` | 0/1 | fraction with valid schema |
| `tool.call_success` | ratio | avg tool-success rate |
| `rag.context_precision/recall` | ratio | avg retrieval precision/recall |
| `rag.groundedness` | 0–1 | avg groundedness level |

Why average: (1) **noise reduction** — one case's token-overlap groundedness is noisy, the mean over hundreds is stable; (2) **comparability** — one number per metric per run enables regression/baseline diffs; (3) **gate-ability** — thresholds are meaningful on aggregates.

Caveats: the mean **hides the tail** (a few catastrophic hallucinations masked by many good answers — only `perf`/`cost` keep percentiles); it is a **macro-average** (each case weighted equally); only **completed** cases contribute (infra failures tracked via `infraFailureRate`).

---

## 8. Metrics & concepts reference

### Groundedness

Whether the answer is **supported by the retrieved context** — the measurable form of "did the model hallucinate." Distinct from:

- **Correctness** — true in the real world (external truth).
- **Context relevance** — are the retrieved chunks on-topic (retrieval quality).

An answer can be **grounded but wrong** (faithfully repeats a wrong source) or **correct but ungrounded** (right from parametric memory, not from context). Measured two ways:

- `rag.groundedness` — deterministic token overlap (Family 2; gates + diagnosis).
- `faithfulness_groundedness` — LLM-judge rubric (`claim_support`, `no_fabrication`, `citation_use`); per-case veto only, does not aggregate into gates.

### Judge rubrics

A **named quality dimension scored by an LLM-as-judge** via a prompt template. Each rubric = system prompt (dimension + 0–1 scale) + stable sub-criteria + strict JSON output contract `{score, rationale, criteria_scores[]}`. Built-ins:

| Rubric | Sub-criteria |
|---|---|
| `helpfulness` | addresses_query, actionability, relevance |
| `correctness` | factual_accuracy, logical_consistency, hallucination_absence |
| `completeness` | coverage, depth, explicit_gaps |
| `coherence` | structure, clarity, flow |
| `faithfulness_groundedness` | claim_support, no_fabrication, citation_use |
| `safety_harmlessness` | harm_avoidance, policy_compliance, inclusivity |
| `refusal_quality` | refusal_appropriateness, … |

Modes: **pointwise** (score one response) and **pairwise** (A vs B → winner, for A/B compare). Selected per run via `evaluators.enabledRubric[]`.

### Golden test-case schema (essentials)

```text
GoldenTestCase
  id, category, difficulty, tags
  input: { query, attachments?, context_hints? }
  evaluation:
    reference_context[]:        { id, uri?, title? }
    retrieval_expectation:      { relevant_document_ids[], min_relevant_k? }
    expected_tool_use:          { expected_tools[], forbidden_tools? }
    safety_expectation:         { should_refuse, forbidden_topics? }
    expected_response.final:
       expected_answer?         → correctness.em / bleu / rougeL / tokenF1
       reference_text?          → judge reference
       required_schema?         → structured.schema_valid
       must_include[]           → { pattern, match: substring|regex|semantic }
       must_cite[]              → { id, required }
       forbidden[]
```

Note: `match: "semantic"` is currently a **token-overlap ≥ 0.5 stub**, not embeddings.

### A worked example

```json
{
  "id": "kb-return-window-001",
  "input": { "query": "How many days do I have to return an item?" },
  "evaluation": {
    "reference_context": [{ "id": "policy-returns", "title": "Returns Policy", "uri": "kb://policies/returns.md" }],
    "retrieval_expectation": { "relevant_document_ids": ["<actual-chunk-id>"], "min_relevant_k": 1 },
    "expected_response": {
      "final": {
        "expected_answer": "You have 30 days to return an item.",
        "reference_text": "Our return window is 30 days from delivery.",
        "must_include": [{ "pattern": "30 days", "match": "substring", "p0": true }],
        "must_cite":     [{ "id": "policy-returns", "required": true }],
        "forbidden":     [{ "pattern": "90 days", "match": "substring" }]
      }
    }
  }
}
```

> **Authoring gotcha:** `relevant_document_ids` is matched against the retrieved chunk's `id` (`retrievedChunks.map(ch => ch.id)`). For unstructured content that id is a per-ingestion UUID, not a readable slug — so you must **capture the actual id** from a real retrieval run (or query LanceDB by `source`), and it is **not stable across re-ingestion**. Prefer keying labels on the stable `source` path or a content hash.

---

## 9. Design analysis

### What's right

1. **Gating granularity matches signal reliability.** Binary assertions gate per-case; noisy continuous metrics gate only in aggregate. Not failing a case on a 0.49 token-overlap is correct statistical thinking.
2. **Decision vs diagnosis separation** (`derivePass` vs `classifyFailure`) — single responsibility, testable, branch-free pass logic.
3. **Determinism where it gates.** Run-level gates threshold reproducible, cheap aggregates — ideal for CI/regression/promotion decisions.
4. **Fail-open on judge errors + coverage/infra guardrails.** Infra flakiness doesn't masquerade as a quality regression; `min_completed_cases` refuses to conclude from a half-failed run.
5. **Percentiles for perf/cost** — recognizes latency/cost are skewed and the tail matters.

### What's questionable

1. **Gates use the weaker groundedness.** `rag.groundedness` (token overlap) gates/diagnoses while the semantic `faithfulness_groundedness` rubric cannot feed gates. Token overlap is both false-positive and false-negative prone.
2. **Mean-only quality headlines hide the tail.** Only perf/cost get percentiles; a few catastrophic hallucinations get averaged away for quality metrics.
3. **Lossy failure attribution.** `classifyFailure` first-match can mislabel a judge-caused failure as `retrieval`.
4. **Blunt, uniform 0.5 judge threshold** — not per-rubric tunable; each added rubric silently tightens passing.
5. **Weak correctness metrics + silent `semantic` stub** — EM/BLEU/ROUGE are paraphrase-blind; the "semantic" assertion match is really token overlap, which can mislead authors.

### What to change

- Let **sampled judge-rubric means feed run-level gates** (gate on the semantic signal; keep deterministic as a cheap pre-filter).
- Add **tail stats for quality** (p5/min or "% below threshold").
- Make **failure attribution evidence-based / multi-label** rather than a priority guess.
- **Per-rubric configurable thresholds** instead of a global 0.5.
- Replace/rename the **`semantic` stub** (real embeddings or honest label).

### Verdict

The **architecture** is sound — two-tier role-based gating, decision/diagnosis separation, determinism and guardrails where it blocks releases. The **weakness is at the metric boundary**: it gates on cheap lexical proxies while the semantically accurate judge signals are computed but can't block, and quality is summarized by a tail-hiding mean. Several gaps are acknowledged in-code as "today / reserved for future" — a solid, shippable v1 with a clear path to v2.

---

## Appendix A — KB ingestion: incremental re-ingest duplicates

Uncovered while tracing retrieval → citation → eval. For **unstructured** content, `documentId` is a fresh `uuid4()` minted per ingestion (`data_sources/unstructured.py`), and `chunk_id = f"{doc_id}_{i}"`. Incremental mode is **append-only** (`lancedb_writer.py`: `lance_table.add(table)`), and change detection is **per file** via `last_modified` (`processor.py: compute_files_to_process`). So a **modified** file is re-chunked in full, re-embedded, and appended — while the old chunks are **not deleted**.

```text
                    INCREMENTAL + MODIFIED FILE  →  DUPLICATE CITATIONS
                    ====================================================

T0.  INITIAL INGEST (full mode)              report.pdf  (last_modified = 10:00)
     chunker:  doc_id = uuid4() = "A1"       chunk_id = "A1_0", "A1_1"
     LanceDB table  kb_vectors
     ┌───────────────────────────────────────────────────────────┐
     │ id      document_id   source        text                   │
     │ A1_0    A1            report.pdf     "revenue was 5M..."    │
     │ A1_1    A1            report.pdf     "...growth 12%"        │
     └───────────────────────────────────────────────────────────┘

T1.  FILE EDITED on the source              report.pdf  (last_modified = 11:30)

T2.  INCREMENTAL RE-INGEST
     diff: last_modified 11:30 > 10:00   ⇒  MODIFIED  ⇒  re-chunk + re-embed
     chunker:  doc_id = uuid4() = "B7"   ← NEW uuid (not "A1")
                          │  lance_table.add(...)   ← APPEND ONLY, no delete
                          ▼
     LanceDB table  kb_vectors
     ┌───────────────────────────────────────────────────────────┐
     │ id      document_id   source        text                   │
     │ A1_0    A1            report.pdf     "revenue was 5M..."    │ ◄── OLD copy
     │ A1_1    A1            report.pdf     "...growth 12%"        │ ◄── still here!
     │ B7_0    B7            report.pdf     "revenue was 6M..."    │ ◄── NEW copy
     │ B7_1    B7            report.pdf     "...growth 15%"        │ ◄── appended
     └───────────────────────────────────────────────────────────┘
        ▲ same source, TWO document_ids (A1, B7) coexist in ONE snapshot

T3.  QUERY  "what was revenue?"  → search returns BOTH generations:
             A1_0 (0.82) "revenue was 5M"   ← stale
             B7_0 (0.80) "revenue was 6M"   ← current

T4.  CITATION DEDUP  key = (knowledgeBaseId, documentId, chunkId)
        A1_0 → (kb, A1, A1_0) ┐
                              ├─ keys DIFFER ⇒ NOT merged
        B7_0 → (kb, B7, B7_0) ┘
     RESULT: both cited → duplicate + conflicting context to the LLM
```

The citation dedup key `(knowledgeBaseId, documentId, chunkId)` did its job (the rows are genuinely distinct); the root cause is **append-with-no-delete + fresh UUID**.

### When it happens

| Path | Old copy removed? | documentId changes? | Duplicate? |
|---|---|---|---|
| Full mode (default) | Yes — table overwritten | Yes (all new) | No |
| Incremental + brand-new file | N/A | N/A | No |
| Incremental + modified file | **No — appended** | Yes (new UUID) | **Yes** |

### Fix

```text
   TODAY  (append-only)                    FIX  (delete-by-source, then append)
   ────────────────────                    ───────────────────────────────────
   modified report.pdf                     modified report.pdf
          │                                DELETE WHERE source = 'report.pdf'
          ▼                                       ▼   (source/file_path is STABLE)
   add(new)  → A1 + B7                     add(new)  → only B7
   (old A1 stays → dup)                    (old A1 gone → no dup)

   Alt: document_id = sha256(file_path + content)  → idempotent upsert; dedup merges naturally
```

---

## Appendix B — `documentId` / `chunkId` lifecycle

```text
  INGESTION (kb-processor)                         RETRIEVAL (Rust)         AGENT
  ────────────────────────                         ────────────────        ─────
  data source  → Document(doc_id)                  SearchResult             KbCitation
    unstructured: doc_id = uuid4()   ┐             { id            }        { documentId }
    structured:   doc_id = row_{n}   │  chunker     { document_id  } ──────► { chunkId (internal) }
                                     └─► Chunk       { source       }        { source }
                                         chunk_id = f"{doc_id}_{i}"          { score }
                                         document_id = doc_id
                                            │ embedder → LanceDB columns
                                            ▼ (id, document_id, source, text, chunk_index, vector)
```

- **Unstructured** ids are UUID-derived and minted **per ingestion** → not stable across rebuilds; not human-guessable.
- **Structured** ids are `row_{n}` → deterministic and stable (given row order).
- The eval harness matches `relevant_document_ids` against the chunk `id`, so golden retrieval labels keyed on UUIDs **rot on re-ingestion** — prefer `source`/content-hash.
