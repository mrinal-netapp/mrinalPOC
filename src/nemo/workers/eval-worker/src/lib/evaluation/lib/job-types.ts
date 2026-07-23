// Evaluation job input, state, results (spec §5.3.1, §5.5).

import type { AgentRuntimeOverrides } from './runtime-overrides';
import type { ABVariantSpec } from './ab-types';
import type { ProvenanceEnvelope } from './provenance';
import type {
  PreflightSummary,
  PreflightOverrideIntent,
} from './preflight-types';
import type { AuditEvent } from './audit-types';

export type EvaluationScope =
  | 'retrieval_only'
  | 'retrieval_plus_response'
  | 'full_agent_execution'
  | 'structured_output_compliance';

export type EvalSuite =
  | 'rag'
  | 'tool_using_agent'
  | 'safety_refusal'
  | 'structured_output'
  | 'performance_cost';

export type RunMode = 'single' | 'regression' | 'ab_compare';

export type GateLevel = 'info' | 'warning' | 'blocking';

export type Verdict = 'pass' | 'fail' | 'blocked';

/**
 * High-level evaluation strategy. Controls whether deterministic scorers,
 * LLM-as-judge rubrics, or both run for the evaluation.
 *
 *  - `deterministic`              — only deterministic scorers run; no LLM
 *                                   judge calls are made.
 *  - `llm_judge`                  — only LLM-as-judge rubrics run; all
 *                                   deterministic scorer activities are
 *                                   skipped (regardless of `scorers` overrides).
 *  - `deterministic_plus_llm_judge` — both run side-by-side; this is the
 *                                   richest (and most expensive) mode.
 *
 * Older spellings `'deterministic_only'` and `'deterministic_judge'` are
 * also accepted at the type-erased boundaries (DB rows, replayed workflow
 * inputs). The trigger normalizes them at start time and the resolvers in
 * `judge-toggles.ts` accept either spelling for replay safety.
 */
export type EvaluationStrategy =
  | 'deterministic'
  | 'llm_judge'
  | 'deterministic_plus_llm_judge';

// Canonical run status — must stay aligned with config-service's
// `EvaluationRunStatus` column enum on `models/EvaluationRun.ts`. The
// design docs use 'completed'/'stopped' colloquially but the stored
// values (and the values `finalize` writes) are 'success'/'cancelled'.
// `draft`/`archived` were typed but never written or read; removed to
// keep the contract honest.
export type EvaluationStatus =
  | 'queued'
  | 'running'
  | 'aggregating'
  | 'success'
  | 'failed'
  | 'cancelled';

export interface EvaluationJobInput {
  runId: string;
  evalName: string;
  projectId: string;
  /**
   * Stable identifier for the *logical* evaluation (groups multiple runs that
   * share a template). Path layout uses it as
   *   `projects/{projectId}/evaluations/{evalId}/runs/{runId}/...`
   * When omitted, the worker derives a slug from `evalName`.
   */
  evalId?: string;

  target: 'agent_version' | 'pre_generated';
  agentSnapshotId?: string;
  /** Resolved from template.agent.agentTeam by resolveTemplateRuntime. */
  agentTeam: string;
  /** Resolved from template.agent.agentId; empty → team-router route. */
  agentId?: string;
  evaluationScope: EvaluationScope;
  suite: EvalSuite;
  runMode: RunMode;

  /**
   * Test-case set — eval-owned, NOT a project Dataset. The JSONL bytes
   * live at `projects/{projectId}/evaluations/{evalId}/testcases/{filename ?? 'cases.jsonl'}`.
   * Only filename + runtime sampling/filter parameters travel through
   * Temporal here; the row content stays on PVC.
   */
  testCases: {
    schemaVersion: 'golden_test_v1' | 'flat_csv_legacy';
    /** Override default `cases.jsonl` filename inside the eval's `testcases/` folder. */
    filename?: string;
    columnMappings?: { id: string; query: string; expected?: string };
    sample: {
      mode: 'all' | 'fraction' | 'stratified';
      fraction?: number;
      stratifyBy?: Array<'category' | 'difficulty' | 'tags'>;
      seed?: number;
    };
    filter?: {
      category?: string[];
      difficulty?: string[];
      tags?: string[];
      includeLabelSuspect?: boolean;
      /** Used by the reshard composition driver to re-run a subset of cases. */
      caseIds?: string[];
    };
  };

  models: string[];

  evaluators: {
    strategy: EvaluationStrategy;
    rubricPreset: 'none' | 'rag' | 'safety' | 'custom';
    enabledRubric: string[];
    evaluatorModel?: string;
    evaluatorVersion?: string;
    judgeEvalMode: 'pointwise' | 'pairwise' | 'both';
    judgeSamplingMode: 'all' | 'sample';
    judgeSampleSize?: number;
    judgeStratifiedSlices: boolean;
    judgeGateWhenSampled: 'gating' | 'informational';

    /**
     * Whether the dataset carries golden ground-truth (expected_answer,
     * reference_text, must_include, expected_tool_use, etc.). When `false`,
     * the workflow skips the two golden-only deterministic scorer
     * activities (`scoreGoldenAssertions`, `scoreGolden`) by default and
     * only emits the reference-free metric set (see
     * `METRICS_REFERENCE_FREE` in `metrics-catalog.ts`).
     *
     * Defaults to `true` for backwards compatibility with templates that
     * existed before this flag.
     */
    goldenAvailable?: boolean;

    /**
     * Per-scorer override map. Any key set here wins over the default
     * derived from `goldenAvailable`. Use to opt back into a golden-only
     * scorer on a no-golden run (rare) or to opt out of a reference-free
     * scorer for cost reasons. See `resolveScorerToggles` for the full
     * resolution rule.
     */
    scorers?: {
      goldenAssertions?: boolean;
      golden?: boolean;
      suiteDeterministic?: boolean;
      safetyClassifier?: boolean;
    };
  };

  thresholds: {
    gates: Array<{ id: string; level: GateLevel; threshold: number }>;
    coverageMinPct: number;
    infraFailureMaxPct: number;
    safetyP0Threshold: number;
    minCompletedCases?: number;
  };

  /**
   * Regression mode inputs. Either / both fields may be set:
   *   - `baselineJobId` — compare against a prior run's `EvaluationResults`
   *   - `expectations` — compare against inline per-metric targets
   * When both are set, expectations override the prior-run value for any
   * metric id they specify (other metrics still come from the run).
   */
  regression?: {
    baselineJobId?: string;
    expectations?: BaselineExpectation[];
  };
  ab?: {
    variants: ABVariantSpec[];
    comparabilityChecks: string[];
    acknowledgedIssues?: string[];
  };
  repeats?: { count: number; seeds?: number[]; seedIndex?: number };

  provenance: ProvenanceEnvelope;
  overrideIntents?: PreflightOverrideIntent[];

  /** Set by the config-service A/B composition driver on each variant child. */
  parentAbId?: string;
  /**
   * Set by the A/B composition driver on each variant child so the child
   * (and its case-level artifacts) can be attributed back to a specific
   * `ABVariantSpec.variantId`.
   */
  variantId?: string;
  /** Per-variant override bundle when running as an A/B child. */
  variantOverrides?: AgentRuntimeOverrides;

  concurrency?: number;
  metadata?: Record<string, unknown>;
}

// ── Results ─────────────────────────────────────────────────────────

export interface TriggeredGate {
  id: string;
  level: GateLevel;
  status: 'passed' | 'failed' | 'warning';
  threshold: number | null;
  actual: number | null;
  message: string;
}

export interface MetricDistribution {
  p50?: number;
  p95?: number;
  p99?: number;
  histogram: Array<{ bucket: string; count: number }>;
}

export interface ConfusionMatrix {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface EvaluationDimension {
  id: string;
  label: string;
  headline: Record<string, number | null>;
  distribution?: Record<string, MetricDistribution>;
  confusion?: Record<string, ConfusionMatrix>;
  notComputedReason?: string;
}

export interface TradeoffDecision {
  acknowledged: boolean;
  by?: string;
  rationale?: string;
  decidedAt?: string;
}

/**
 * A predefined per-metric target. Optional alternative (or supplement) to
 * referencing a baseline run id — useful when there's no prior run to point
 * at but you know what "good" looks like for the headline metrics.
 *
 * `tolerancePct` is the threshold (in percent of the baseline value) above
 * which the resulting delta is flagged `significant`. Defaults to 5% to
 * match the heuristic used when baseline comes from a prior run.
 */
export interface BaselineExpectation {
  /** Headline metric id, e.g. `rag.groundedness`, `correctness.em`. */
  id: string;
  /** Expected baseline value the current run is compared against. */
  value: number;
  /**
   * Per-metric significance threshold, in percent of the baseline value.
   * E.g. `tolerancePct: 5` flags any delta whose `|deltaPercent| >= 5`.
   * Defaults to 5 when omitted.
   */
  tolerancePct?: number;
}

export interface BaselineComparison {
  /** Set when the baseline came from a prior run. Absent for expectations-only baselines. */
  baselineJobId?: string;
  /**
   * Set when the baseline-run fetch failed (e.g. row missing, transient
   * 5xx). Lets consumers tell "baseline lookup broke" apart from "no
   * metrics in common". Present only when `baselineJobId` was supplied
   * AND the lookup didn't succeed.
   */
  baselineFetchError?: string;
  metrics: Array<{
    id: string;
    delta: number;
    deltaPercent: number;
    significant: boolean;
    /** Where the baseline value for this metric came from. */
    source: 'run' | 'expectation';
  }>;
}

export interface EvaluationResults {
  verdict: Verdict;
  triggeredGates: TriggeredGate[];
  dimensions: EvaluationDimension[];
  coverage: { total: number; completed: number; completedPct: number };
  infraFailureRate: number;
  judgeCoverage: { scored: number; target: number; pct: number };
  preFlightNonPromotable: boolean;
  runStopped: boolean;
  baselineComparison?: BaselineComparison;
  tradeoffDecision?: TradeoffDecision;
  /**
   * Headline quality score 0..100 used by config-service's
   * `EvaluationService.setBaseline` to rank sibling runs when promoting a
   * new baseline. Derived from `coverage.completed / coverage.total` and
   * `(1 - infraFailureRate)` — i.e. "fraction of cases that ran cleanly".
   * Optional for forward-compat with older runs persisted before this
   * field landed; setBaseline treats `undefined` as 'not_set'.
   */
  qualityPct?: number;
}

export interface EvaluationJob {
  runId: string;
  status: EvaluationStatus;
  input: EvaluationJobInput;
  preFlight?: PreflightSummary;
  results?: EvaluationResults;

  /**
   * When this row is a child of an A/B / repeats composition driven by
   * config-service, points back at the parent EvaluationJob row.
   */
  parentRunId?: string;
  /** Variant id within an A/B run. */
  variantId?: string;

  audit: AuditEvent[];
  createdAt: string;
  updatedAt: string;
}

// ── Progress (exposed via Temporal query) ───────────────────────────

export interface EvaluationProgress {
  status: EvaluationStatus;
  phase:
    | 'preflight'
    | 'loading'
    | 'sharding'
    | 'running'
    | 'aggregating'
    | 'completed'
    | 'failed'
    | 'stopped';
  totalCases: number;
  completedCases: number;
  failedCases: number;
  inFlightCases: number;
  percentage: number;
  judgeCoverage?: { scored: number; target: number; pct: number };
  recentFailures: Array<{
    caseId: string;
    model: string;
    errorType?: 'quality' | 'infra';
    message?: string;
  }>;
}
