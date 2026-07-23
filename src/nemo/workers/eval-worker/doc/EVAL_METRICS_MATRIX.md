# Eval metrics matrix — what you get per configuration

A reference for which metrics land in `results.json` (per case) and which roll
up into the run-level `EvaluationResults` summary, broken out by the
configuration knobs on `EvaluationTemplate.evaluators` and `runMode`.

The exact metric IDs and aggregation rules are owned by:
- `src/lib/judge-prompts.ts` — built-in judge rubrics + sub-criteria
- `src/activities/scoring.activities.ts` — deterministic scorers + aggregation
- `src/lib/evaluation/lib/metrics-catalog.ts` — reference-free vs. golden-dependent

## 1. Configuration axes

| Axis | Field | Values | Effect |
|---|---|---|---|
| Strategy | `evaluators.strategy` | `deterministic`, `llm_judge`, `deterministic_plus_llm_judge` | Toggles deterministic scorers vs. LLM-judge rubrics |
| Golden availability | `evaluators.goldenAvailable` | `true` (default), `false` | When `false`, golden-dependent metrics are skipped and gating against them is rejected at trigger time |
| Per-scorer toggles | `evaluators.scorers.{goldenAssertions, golden, suiteDeterministic, safetyClassifier}` | `true`/`false` | Fine-grained override on top of `goldenAvailable` defaults |
| Suite | `suite` | `rag`, `tool_using_agent`, `safety_refusal`, `structured_output`, `performance_cost` | Decides which family of `deterministicMetrics` `scoreSuiteDeterministic` emits |
| Judge sampling | `evaluators.judgeSamplingMode` + `judgeSampleSize` | `all` / `sample` | Whether every case gets judged or just a subset |
| Judge gate when sampled | `evaluators.judgeGateWhenSampled` | `gating`, `informational` | Whether sampled judge scores can fail the run |
| Rubrics | `evaluators.enabledRubric[]` | rubric IDs | Which LLM-judge dimensions run per case |
| Run mode | `runMode` | `single`, `regression`, `ab_compare` | Adds baseline comparison or A/B compare report |
| Baseline (optional) | `regression.baselineRunId` and/or `regression.expectations` | run id and/or `Array<{id, value, tolerancePct?}>` | Both fields are optional. When either is set, `compareToBaseline` runs. If both are present, `expectations` override the prior-run value for any metric id they specify. Default tolerance for `significant` flag is 5%; per-expectation `tolerancePct` overrides it. Expectations are validated at trigger time (empty id, non-finite value, negative `tolerancePct`, duplicate ids all reject). |

## 2. Per-case capture (`CaseRunArtifact`) — what's present by strategy

Every per-case artifact carries the always-on fields below. Strategy + suite + golden availability decide what populates the scoring blocks.

| `CaseRunArtifact` field | `deterministic` | `llm_judge` | `deterministic_plus_llm_judge` |
|---|:---:|:---:|:---:|
| `response`, `citations`, `retrievedChunks`, `toolCalls`, `perAgent`, `telemetry`, `rawProviderPayload`, `resolvedRuntimeParams` | ✓ | ✓ | ✓ |
| `deterministicMetrics[*]` (suite-driven) | ✓ | — | ✓ |
| `goldenAssertions` (must_include/must_cite/forbidden/schema_valid + sub-agents) | ✓ (if `goldenAssertions` scorer on) | — | ✓ (if `goldenAssertions` scorer on) |
| `judgeRubrics[]` (per rubric: score, rationale, criteriaScores, rubricPromptHash, errored) | — | ✓ | ✓ |
| `failureCategory`, `rootCause` (derived from above) | ✓ | ✓ | ✓ |
| `passed`, `status`, `durationMs`, `error`, `errorType`, `traceRef`, `variantId`, `repeatSeed` | ✓ | ✓ | ✓ |

**Note:** `derivePass(goldenAssertions, judgeRubrics, safety)` is the per-case pass/fail combinator. Whichever of those three is populated in the active strategy is what feeds the pass decision.

## 3. `deterministicMetrics` IDs by suite

Emitted by `scoreSuiteDeterministic` only when the strategy includes deterministic scoring (`deterministic` or `deterministic_plus_llm_judge`). Each suite contributes a different subset.

| Metric ID | `rag` | `tool_using_agent` | `safety_refusal` | `structured_output` | `performance_cost` | Needs golden? |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `rag.groundedness` | ✓ | — | — | — | — | No |
| `rag.context_precision` | ✓ | — | — | — | — | Yes (`relevant_document_ids`) |
| `rag.context_recall` | ✓ | — | — | — | — | Yes |
| `rag.citation_alignment` | ✓ | — | — | — | — | Yes (`must_cite`) |
| `must_cite.coverage` | ✓ | — | — | — | — | Yes |
| `tool.call_success` | — | ✓ | — | — | — | No |
| `tool.selection_accuracy` | — | ✓ | — | — | — | Yes (`expected_tool_use`) |
| `tool.arg_validity` | — | ✓ | — | — | — | Yes |
| `tool.plan_accuracy` | — | ✓ | — | — | — | Yes (`expected_plan`) |
| `structured.schema_valid` | — | — | — | ✓ | — | No (needs `required_schema`) |
| `structured.format` | — | — | — | ✓ | — | No |
| `structured.contract` | — | — | — | ✓ | — | No |
| `perf.e2e_ms` | — | — | — | — | ✓ | No |
| `perf.ttft_ms` | — | — | — | — | ✓ | No |
| `perf.sla_e2e_compliance` | — | — | — | — | ✓ | No (needs `sla.maxE2eMs`) |
| `perf.sla_ttft_compliance` | — | — | — | — | ✓ | No |
| `cost.per_case_usd` | — | — | — | — | ✓ | No |
| `cost.budget_compliance` | — | — | — | — | ✓ | No (needs `budget.maxCostUsd`) |

The `safety_refusal` suite returns `{}` from `scoreSuiteDeterministic` — its metrics come from `scoreSafetyClassifier` instead (see §4).

## 4. Golden scorer + safety classifier metrics (independent of suite)

These run when the corresponding `evaluators.scorers.*` toggle is on (and `goldenAvailable=true` for golden-dependent items).

| Metric ID | Scorer activity | Needs golden? | Notes |
|---|---|:---:|---|
| `correctness.em` | `scoreGolden` | Yes (`expected_answer`) | exact-match 0/1 |
| `correctness.bleu` | `scoreGolden` | Yes | BLEU-1 with brevity penalty |
| `correctness.rougeL` | `scoreGolden` | Yes | ROUGE-L F1 |
| `correctness.tokenF1` | `scoreGolden` | Yes | unigram F1 |
| `safety.unsafe_rate` | `scoreSafetyClassifier` | Yes (`expectedRefusal`) | per-case 0/1 |
| `safety.false_refusal_rate` | `scoreSafetyClassifier` | Yes | per-case 0/1 |
| `safety.boundary` | `scoreSafetyClassifier` | Yes | per-case 0/1 |
| `safety.refusalQuality` | `scoreSafetyClassifier` | No | per-case 0/1 |

## 5. LLM-judge rubrics + sub-criteria

Each rubric in `evaluators.enabledRubric[]` produces one `JudgeRubricOutput` per case under `judgeRubrics[]`. The built-in catalog (`src/lib/judge-prompts.ts`) ships these with explicit sub-criteria:

| Rubric ID | Sub-criteria (`criteriaScores[*].name`) |
|---|---|
| `helpfulness` | `addresses_query`, `actionability`, `relevance` |
| `correctness` | `factual_accuracy`, `logical_consistency`, `hallucination_absence` |
| `completeness` | `coverage`, `depth`, `explicit_gaps` |
| `coherence` | `structure`, `clarity`, `flow` |
| `following_instructions` | `format_adherence`, `length_adherence`, `constraint_adherence` |
| `professional_style_tone` | `register_appropriate`, `brand_alignment`, `courtesy` |
| `faithfulness_groundedness` | `claim_support`, `no_fabrication`, `citation_use` |
| `safety_harmlessness` | `harm_avoidance`, `policy_compliance`, `inclusivity` |
| `refusal_quality` | `refusal_appropriateness`, `explanation_clarity`, `alternative_path` |

Unknown rubric IDs fall back to a generic prompt with no canonical sub-criteria — `criteriaScores` is omitted on those outputs.

Each `JudgeRubricOutput` carries:
- `rubricId`, `judgeModelName`, `judgeVersion`, `rubricPromptHash`
- `mode: 'pointwise' | 'pairwise'`
- `score` (0..1, clamped), `outOf: 1`, `rationale`, optional `criteriaScores[]`
- `winner: 'A'|'B'|'tie'` (pairwise only)
- `errored: boolean` (soft-fail on 4xx or malformed reply)

## 6. Run-level summary (`EvaluationResults`) by strategy

`aggregateMetrics` walks every `CaseRunArtifact.deterministicMetrics` and groups by dot-prefix into `EvaluationDimension[]`. Judge rubrics do not aggregate into headlines; they're tracked via `judgeCoverage` plus per-case data.

| `EvaluationResults` field | `deterministic` | `llm_judge` | `deterministic_plus_llm_judge` |
|---|:---:|:---:|:---:|
| `verdict` | ✓ | ✓ | ✓ |
| `triggeredGates[]` | ✓ | ✓ | ✓ |
| `dimensions[].headline` (mean per metric) | ✓ | empty | ✓ |
| `dimensions[].distribution` (p50/p95/p99 for `perf`/`cost`) | ✓ (when suite emits perf/cost) | — | ✓ |
| `coverage`, `infraFailureRate` | ✓ | ✓ | ✓ |
| `judgeCoverage` (`scored/target/pct`) | trivial (0/0/0) | ✓ | ✓ |
| `preFlightNonPromotable`, `runStopped` | ✓ | ✓ | ✓ |
| `baselineComparison?` (regression mode only) | ✓ (deterministic metrics only) | — (no headlines to diff) | ✓ |
| `tradeoffDecision?` (operator signal) | ✓ | ✓ | ✓ |

### Built-in gates that always fire (in `triggeredGates[]`)

Independent of strategy, computed by `computeGates`:

| Gate ID | Level | Source | Notes |
|---|---|---|---|
| `coverage` | blocking | `coverage.completed / total >= coverageMinPct` | Fails the verdict when under |
| `infra_failure_rate` | blocking | `infraFailureRate * 100 <= infraFailureMaxPct` | |
| `min_completed_cases` | blocking | `coverage.completed >= minCompletedCases` (default = `ceil(coverage.total * 0.5)`, i.e. 50% of the suite) | Explicit `minCompletedCases` value wins for hard floors |
| `judge_scoring_health` | warning | `(target - scored) / target <= 10%` | Only meaningful when judge is active |
| `preflight_policy` | warning | True when preflight summary had warnings | |
| `tradeoff_acknowledgment` | blocking (conditional) | Fires when `detectConflictingSignals(headline)` returns true and no `tradeoffDecision` | |

Plus every entry from `template.thresholds.gates[]` — each is matched against the flattened headline value with `isHigherBetter`/`isLowerBetter` semantics. **Sub-criteria scores from judges do not feed gates today** — gates run against deterministic headlines only.

## 7. Reference-free vs. golden-dependent — effect of `goldenAvailable`

When `goldenAvailable=false`:
- `scoreGolden` activity emits nothing (no `correctness.*` metrics).
- Suite-level golden-dependent metrics are dropped (see §3 column).
- `validateTemplate` at trigger time rejects gates referencing golden-only metrics (`startEvaluation` throws). Use `metrics-catalog.ts` `isReferenceFree`/`isGoldenDependent` to pick safe gates.

| Reference-free (always available) | Golden-dependent (needs `goldenAvailable=true`) |
|---|---|
| `perf.e2e_ms`, `perf.ttft_ms`, `perf.sla_e2e_compliance`, `perf.sla_ttft_compliance` | `correctness.em`, `correctness.bleu`, `correctness.rougeL`, `correctness.tokenF1` |
| `cost.per_case_usd`, `cost.budget_compliance` | `rag.context_precision`, `rag.context_recall`, `rag.citation_alignment` |
| `tool.call_success` | `must_cite.coverage` |
| `rag.groundedness` | `tool.selection_accuracy`, `tool.arg_validity`, `tool.plan_accuracy` |
| `safety.refusalQuality` | `safety.unsafe_rate`, `safety.false_refusal_rate`, `safety.boundary` |
| `structured.schema_valid`, `structured.format`, `structured.contract` | |

LLM-judge rubrics are reference-free in practice (the judge model decides), but `faithfulness_groundedness` only makes sense when retrieved chunks are present.

## 8. Run mode effects on persisted artifacts

| Field on `EvaluationJob.artifacts` | `single` | `regression` | `ab_compare` |
|---|:---:|:---:|:---:|
| `resultsFileUri` (`results.json`) | ✓ | ✓ | ✓ per variant run |
| `stakeholderReportUri` (markdown report — `stakeholder-report.md`) | ✓ | ✓ | ✓ |
| `results.json` `.compareReport` field | conditional | conditional | conditional |

The compare data — `comparabilityIssues[]`, `metricComparisons[]`,
`sliceDeltas[]`, `tradeoff`, optional `pairwise` — is no longer a
separate `compare_report.json` file under a cross-cutting
`compares/{idA}_vs_{idB}/` directory (item 7). It folds into the *current
run's* `results.json` as a top-level `compareReport` field. The field
is populated by `buildCompareReport` in Phase c whenever a baseline was
resolved:

- **single / regression**: populated when either
  `template.regression.baselineRunId` is pinned, or the workflow's
  `findPreviousRun` lookup resolved a prior successful run for the same
  template.
- **ab_compare**: populated on each variant's run as part of its Phase c.

`compareReport` body, per pair of runs (`runIdA` = current,
`runIdB` = baseline):
- `comparabilityIssues[]` (e.g. `envelope.diff`)
- `metricComparisons[]` — `{id, variantAValue, variantBValue, delta, deltaPercent, significant, pValue?}` for every metric in either headline
- `sliceDeltas[]` — pass-rate delta per `(category|difficulty|tags)` slice
- `tradeoff` — `{axes: [{metricId, variantA, variantB}], summary}` over a fixed key-metric list
- `pairwise?` — when `pairwiseRubrics[]` was set: per-case `JudgeRubricOutput[]` (mode='pairwise') with `winner` + `criteriaScores`, plus `aggregate: {winsA, winsB, ties, errored}`

Regression mode adds `EvaluationResults.baselineComparison`:
- `baselineJobId?` — set when the diff used a prior run; absent for expectations-only baselines
- `baselineFetchError?` — set when the workflow's `getEvaluationJob` call for `baselineJobId` failed (e.g. row deleted, transient 5xx). Lets consumers distinguish "lookup broke" from "no metrics overlapped".
- `metrics[]` — `{id, delta, deltaPercent, significant, source}` for each metric present in both current and baseline headlines.
  - `source: 'run' | 'expectation'` — which source supplied the baseline value for this metric, so audit/UI can show lineage at a glance.
  - `significant` defaults to `|deltaPercent| ≥ 5%` and can be overridden per metric via `expectations[].tolerancePct`.

**Baseline sources (one or both):**
1. **Prior run** (`template.regression.baselineRunId`): the workflow fetches that run's `EvaluationResults` via `getEvaluationJob` and passes its dimensions into the pure `compareToBaseline` activity. Promote a run via `POST /api/v1/projects/{pid}/evaluation/agents/runs/{runId}/baseline`.
2. **Predefined expectations** (`template.regression.expectations`): inline `[{id, value, tolerancePct?}]` array — useful when there's no prior run to point at. Each entry sets the baseline value for that metric id (and optionally a per-metric `tolerancePct` for the significance flag, in percent).
3. **Merged**: when both are set, the prior-run headline is loaded first, then expectations override per-metric. Metrics only in the run keep their run-derived values (`source: 'run'`); metrics with an expectation use the expectation (`source: 'expectation'`). The returned `baselineJobId` echoes the run id.

If the baseline run fetch fails (e.g. row missing), the workflow records `baselineFetchError` on the result and continues — expectations (if any) still produce a diff. With neither source resolvable, `metrics` comes back empty.

**Architecture note:** `compareToBaseline` is pure (no I/O). The workflow fetches the baseline run itself and threads the result in via `baselineDimensions`. This keeps the activity replay-safe and trivially testable.

## 9. Quick-reference matrix — given config, what do I see?

| Configuration | Per-case scoring fields populated | Headline metrics in `dimensions[]` | Extra artifacts |
|---|---|---|---|
| `strategy=deterministic`, `suite=rag`, `goldenAvailable=true` | `deterministicMetrics` (`rag.*`, `must_cite.coverage`), `goldenAssertions`, `correctness.*` if `golden` scorer on | `rag`, `must_cite`, `correctness` | — |
| `strategy=deterministic`, `suite=rag`, `goldenAvailable=false` | `deterministicMetrics` (`rag.groundedness` only), `goldenAssertions` (substring/regex/semantic only) | `rag` (`rag.groundedness` only) | — |
| `strategy=llm_judge`, `enabledRubric=[helpfulness, correctness]` | `judgeRubrics[]` with two entries per case, each with `criteriaScores` | `judgeCoverage` (no headline metrics) | — |
| `strategy=deterministic_plus_llm_judge`, `suite=rag` | All of `rag.*` + `judgeRubrics[]` | `rag` headlines + `judgeCoverage` | — |
| `runMode=regression`, `regression.baselineRunId=<id>` | (same as base strategy) | (same) + `baselineComparison` | — |
| `runMode=ab_compare`, `ab.variants[A,B]` | (same per variant) | (same per variant) | `compare_report.json` with metric deltas + (if `pairwiseRubrics`) per-case `winner` |
| `suite=performance_cost` | `perf.*`, `cost.*` only | `perf`, `cost` (with p50/p95/p99 distribution) | — |
| `suite=structured_output` | `structured.*` only | `structured` | — |
| `suite=safety_refusal` + `safetyClassifier` on | `safety.*` from `scoreSafetyClassifier` | `safety` | — |
| `judgeSamplingMode=sample`, `judgeSampleSize=20`, `judgeGateWhenSampled=informational` | `judgeRubrics[]` only on the sampled subset | `judgeCoverage.target=20` | — |

## 10. Where to read what — drill-down paths

| You want… | Read |
|---|---|
| Per-case BLEU/ROUGE/Token-F1 | `perCaseArtifacts[i].deterministicMetrics['correctness.*']` (in `results.json`) |
| Run-level mean BLEU | `EvaluationResults.dimensions[id=correctness].headline['correctness.bleu']` |
| p95 latency | `EvaluationResults.dimensions[id=perf].distribution['perf.e2e_ms'].p95` |
| Per-case judge rationale | `perCaseArtifacts[i].judgeRubrics[].rationale` |
| Per-case judge sub-criteria | `perCaseArtifacts[i].judgeRubrics[].criteriaScores` |
| Why a run failed | `EvaluationResults.triggeredGates[]` filtered to `status='failed'` |
| Regression delta on a metric | `EvaluationResults.baselineComparison.metrics[].{delta, deltaPercent, significant}` |
| Pairwise winner per case | `compare_report.json` → `pairwise.perCase[].rubrics[].winner` |
| Aggregate pairwise wins | `compare_report.json` → `pairwise.aggregate.{winsA, winsB, ties, errored}` |
| Slice deltas (e.g. by category) | `compare_report.json` → `sliceDeltas[]` |

## 11. Known caveats

- **Sub-criteria do not feed gates.** `criteriaScores` is captured per case but never aggregated into `dimensions[].headline`. Run-level gating only consults the deterministic headlines.
- **Baseline significance is still a percentage heuristic.** `baselineComparison.metrics[].significant` is `|deltaPercent| ≥ tolerance` (default 5%, or per-expectation override). A real paired-sample test would be a richer signal — TODO.
- **A/B compare report is composed by config-service.** The worker runs `buildCompareReport` as an activity, but it's invoked by config-service after both variant runs settle, not from inside the workflow. A worker-only `ab_compare` run produces per-variant `results.json` files but no `compare_report.json`.
- **`perf.p95_e2e_ms` / `cost.per_success_usd`** are referenced by gating heuristics in `computeGates`/`detectConflictingSignals` but the aggregator does not emit those keys. The percentiles live under `distribution['perf.e2e_ms'].p95`, not as top-level headline keys.
- **Judge sampling sub-criteria** — when `judgeSamplingMode='sample'`, the sub-criteria scores are only present on cases that were actually judged. Treat absence as "not sampled" rather than "scored zero".
