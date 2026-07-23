// Activity signatures used by workflows via `proxyActivities<EvalActivities>`.
// Real implementations live in server/apps/eval-worker/src/activities/. Typing
// them here keeps workflow files decoupled from the worker package so they
// bundle cleanly inside the Temporal sandbox (spec §7, §8.4).

import type { AgentRuntimeOverrides } from './runtime-overrides';
import type {
  ABVariantSpec,
  ComparabilityIssue,
  MetricComparison,
  SliceDelta,
  TradeoffView,
} from './ab-types';
import type {
  CaseRef,
  CaseRunArtifact,
  CaseRunSlot,
  GoldenAssertionReport,
  InvokeAgentTelemetryHeadline,
  JudgeRubricOutput,
} from './case-artifact';
import type { GoldenTestCase } from './golden-types';
import type {
  BaselineExpectation,
  EvaluationJob,
  EvaluationJobInput,
  EvaluationResults,
  EvaluationDimension,
  TriggeredGate,
  Verdict,
} from './job-types';
import type { PreflightSummary } from './preflight-types';
import type { ProvenanceEnvelope } from './provenance';
import type { AuditEvent } from './audit-types';

// ── invokeAgent (§7.5) ──────────────────────────────────────────────
//
// Per-case identity rides on `caseRef`; the user-authored
// query/attachments/context_hints stay inline (small, case-author
// content). The agent response payload is written to PVC and the
// activity returns only the path + a numeric headline so customer-derived
// data never enters Temporal event history.

export interface InvokeAgentInput {
  caseRef: CaseRef;
  agentTeam: string;
  agentId?: string;
  envelopeHash: string;
  overrides: AgentRuntimeOverrides;
  input: {
    query: string;
    attachments?: unknown[];
    context_hints?: string[];
  };
}

export interface InvokeAgentOutput {
  /** `posix:///` URI of `<caseDir>/capture.json` on PVC. */
  capturePath: string;
  /** Bounded numeric telemetry the parent surfaces in progress queries. */
  telemetry: InvokeAgentTelemetryHeadline;
  retrievalAnnotation: 'zero_hits' | 'truncated' | null;
  resolvedRuntimeParams: AgentRuntimeOverrides;
}

// ── Scoring (§7.3) ──────────────────────────────────────────────────
//
// Every scorer takes the per-case `caseRef` + `capturePath` instead of
// inlining the agent response / retrieved chunks / tool I/O / per-agent
// telemetry. The scorer activity reads the capture from PVC, calls the
// pure scoring core, and returns a small numeric/structural output. The
// `case: GoldenTestCase` argument stays inline (case bodies are bounded
// in size by the JSONL row schema).

export interface ScoreGoldenAssertionsInput {
  caseRef: CaseRef;
  capturePath: string;
  case: GoldenTestCase;
}

export interface ScoreSuiteDeterministicInput {
  caseRef: CaseRef;
  capturePath: string;
  suite: EvaluationJobInput['suite'];
  case: GoldenTestCase;
}

export interface ScoreGoldenInput {
  caseRef: CaseRef;
  capturePath: string;
  expectedReferenceText?: string;
  expectedAnswer?: string;
}

export interface ScoreGoldenOutput {
  em?: number;
  bleu?: number;
  rougeL?: number;
  tokenF1?: number;
  notComputedReason?: string;
}

export interface ScoreSafetyClassifierInput {
  caseRef: CaseRef;
  capturePath: string;
  expectedRefusal?: boolean;
  prompt: string;
}

export interface SafetyClassifierOutput {
  unsafe: boolean;
  falseRefusal: boolean;
  boundaryAdherence: number;
  refusalQuality?: number;
}

// ── Judge (§7.5) ────────────────────────────────────────────────────

export interface InvokeJudgeInput {
  caseRef: CaseRef;
  capturePath: string;
  rubricId: string;
  evaluatorModel: string;
  evaluatorVersion: string;
  rubricPromptHash: string;
  case: GoldenTestCase;
  mode: 'pointwise' | 'pairwise';
}

export interface InvokePairwiseJudgeInput {
  caseRef: CaseRef;
  /** Capture file for the A response. */
  capturePathA: string;
  /** Capture file for the B response. */
  capturePathB: string;
  rubricId: string;
  evaluatorModel: string;
  evaluatorVersion: string;
  case: GoldenTestCase;
}

// ── Preflight (§7.2) ────────────────────────────────────────────────

export interface RunPreflightInput {
  jobInput: EvaluationJobInput;
}

// ── Run snapshot (§7.1) ─────────────────────────────────────────────

export interface LoadRunSnapshotInput {
  runId: string;
  projectId: string;
}

/**
 * Output of `loadRunSnapshot`.
 *
 * Cases are NOT returned here — the workflow's next activity is
 * `validateTestCases`, which reads + validates the JSONL from the
 * eval's own `testcases/` folder on the PVC keyed by `(projectId, evalId)`.
 * Keeping cases off the snapshot output means no test-case content travels
 * through Temporal event history at all.
 */
export interface LoadRunSnapshotOutput {
  jobInput: EvaluationJobInput;
  /** `posix:///` URI of the staged input folder (`<runDir>/_input/`). */
  jobFolderUri: string;
  /** evalId derived from the template — used downstream when building artifact paths. */
  evalId: string;
  /**
   * Template id from the snapshotted template — used by the workflow to look
   * up the previous successful run for the same template when no baseline is
   * pinned (`findPreviousRun`).
   */
  templateId: string;
  /**
   * Test-cases reference resolved from the template's `cases` block.
   * The full path is computed as
   *   `projects/{projectId}/evaluations/{evalId}/testcases/{filename ?? 'cases.jsonl'}`
   * by `validateTestCases`; only the filename flows through here.
   */
  testCasesRef: {
    filename?: string;
  };
}

// ── Find previous run (compare default-baseline lookup) ─────────────

/**
 * Resolve the most recent prior successful run for `(projectId, templateId)`.
 *
 * Used by the eval workflow when the template doesn't pin a
 * `regression.baselineRunId` and doesn't supply inline `regression.expectations`.
 * The default behaviour for compare-against-baseline is "compare to the
 * previous run for this template"; this activity is the lookup helper.
 *
 * Returns the matching `runId` or `null` when this is the first successful
 * run for the template.
 */
export interface FindPreviousRunInput {
  projectId: string;
  templateId: string;
  /**
   * The current run's id — excluded from the result. Lets the workflow
   * call this even after its own row has been written, without picking
   * itself as a baseline.
   */
  currentRunId?: string;
}

export interface FindPreviousRunOutput {
  /** Most recent prior successful run id, or null if none. */
  runId: string | null;
}

// ── Test cases (§7.1.1) ─────────────────────────────────────────────

/**
 * Validate the eval's test-cases JSONL for a run.
 *
 * Reads the JSONL bytes from the PVC at the canonical path
 * `projects/{projectId}/evaluations/{evalId}/testcases/{filename ?? 'cases.jsonl'}`,
 * validates each row against the `GoldenTestCase` schema, and stages a
 * copy at `<runDir>/_input/cases.jsonl` for replay determinism.
 *
 * Test cases are owned by the evaluation template — NOT a project Dataset.
 * The activity reads from `(projectId, evalId)` directly; there is no
 * datasetId indirection.
 */
export interface ValidateTestCasesInput {
  projectId: string;
  evalId: string;
  runId: string;
  /** Override default `cases.jsonl` filename inside the eval's `testcases/` folder. */
  filename?: string;
}

export interface ValidateTestCasesOutput {
  cases: GoldenTestCase[];
  rowCount: number;
  /** `posix:///` URI of the source test-cases JSONL on the PVC. */
  testCasesUri: string;
  /** `posix:///` URI of the staged audit copy at `<runDir>/_input/cases.jsonl`. */
  inputCopyUri: string;
}

// ── Persistence (§7.4) ──────────────────────────────────────────────

export interface UpdateJobStatusInput {
  runId: string;
  projectId: string;
  status: EvaluationJob['status'];
  auditContext: {
    actor: string;
    reason?: string;
    details?: Record<string, unknown>;
  };
}

// ── Compare (§7.8) ──────────────────────────────────────────────────

export interface EnforceComparabilityInput {
  variants: ABVariantSpec[];
  comparabilityChecks: string[];
  acknowledgedIssues: string[];
  envelopes: ProvenanceEnvelope[];
}

export interface ComputeSliceDeltasInput {
  artifactsA: CaseRunArtifact[];
  artifactsB: CaseRunArtifact[];
  sliceBy: Array<'category' | 'difficulty' | 'tags'>;
}

export interface BuildCompareReportInput {
  /**
   * Project that owns both runs. Both the current run and the baseline
   * always live in the same project for regression compare; threaded
   * through so the activity can hit the project-scoped config-service
   * route when fetching each run's EvaluationJob.
   */
  projectId: string;
  /**
   * Current run id — owns the compare report. The activity reads this run's
   * `results.json` from the PVC, composes the report against `runIdB`, and
   * merges the report back into `<runIdA>/results.json` as a top-level
   * `compareReport` field. There is no separate `compare_report.json`
   * artifact (item 7 — compare folds into results.json).
   */
  runIdA: string;
  /** Baseline run id (defaulted to previous run, or pinned via template). */
  runIdB: string;
  comparabilityChecks: string[];
  acknowledgedIssues?: string[];
  pairwiseRubrics?: string[];
  evaluatorModel?: string;
  evaluatorVersion?: string;
}

/**
 * Output of `buildCompareReport`. Returns just the composed report; the
 * activity itself merges the report into `<runIdA>/results.json` so callers
 * don't have to chase a separate URI. Empty interface kept for forward-
 * compat in case we surface counters or warnings later.
 */
export interface BuildCompareReportOutput {
  /** Number of metric comparisons emitted (debug/observability only). */
  metricCount: number;
  /** Number of slice deltas emitted. */
  sliceCount: number;
  /** True when pairwise judging ran (a `pairwiseRubrics` set). */
  pairwiseRan: boolean;
}

// ── Artifact dump (§7.6) ────────────────────────────────────────────

export interface WriteResultsFileInput {
  runId: string;
  projectId: string;
  evalId?: string;
  evalName?: string;
  results: EvaluationResults;
  /**
   * Per-case slots accumulated by the parent workflow. Each slot carries
   * scorer outputs + numeric metadata + `capturePath`; the activity reads
   * each capture.json from PVC and denormalizes to a `CaseRunArtifact`
   * row in the on-disk `results.json`.
   */
  perCaseSlots: CaseRunSlot[];
  provenance: ProvenanceEnvelope;
}

export interface WriteResultsFileOutput {
  resultsFileUri: string;
}

export interface WriteStakeholderReportInput {
  runId: string;
  projectId: string;
  evalId?: string;
  results?: EvaluationResults;
  evalName?: string;
}

export interface WriteStakeholderReportOutput {
  /** URI of the rendered stakeholder report (markdown today; format-agnostic name). */
  reportUri: string;
}

// ── Promote-to-regression ─────────────────────────────────────────

export interface PromoteToRegressionInput {
  sourceRunId?: string;
  sourceCaseId?: string;
  sandboxInteractionId?: string;
  targetDatasetId: string;
  actor: string;
}

export interface PromoteToRegressionOutput {
  datasetId: string;
  datasetVersion: string;
  caseId: string;
}

// ── Full activity surface ───────────────────────────────────────────

export interface EvalActivities {
  // Preflight
  runPreflight(i: RunPreflightInput): Promise<PreflightSummary>;

  // Run snapshot (workflow entrypoint)
  loadRunSnapshot(i: LoadRunSnapshotInput): Promise<LoadRunSnapshotOutput>;

  // Test cases — validate the eval's test-cases JSONL on PVC + stage audit copy.
  validateTestCases(
    i: ValidateTestCasesInput,
  ): Promise<ValidateTestCasesOutput>;

  loadFailedCaseIds(i: {
    runId: string;
    projectId: string;
    errorType: 'quality' | 'infra';
  }): Promise<string[]>;

  /**
   * Compare default-baseline lookup. Returns the most recent prior
   * successful run for the same template (or `null`). The workflow uses
   * this to default `compareToBaseline`'s `baselineJobId` when neither
   * `template.regression.baselineRunId` nor `template.regression.expectations`
   * is set (item 7 — "compare to previous run" is the common default).
   */
  findPreviousRun(i: FindPreviousRunInput): Promise<FindPreviousRunOutput>;

  // Agent + judges
  invokeAgent(i: InvokeAgentInput): Promise<InvokeAgentOutput>;
  invokeJudge(i: InvokeJudgeInput): Promise<JudgeRubricOutput>;
  invokePairwiseJudge(i: InvokePairwiseJudgeInput): Promise<JudgeRubricOutput>;

  // Scoring
  scoreGoldenAssertions(
    i: ScoreGoldenAssertionsInput,
  ): Promise<GoldenAssertionReport>;
  scoreSuiteDeterministic(
    i: ScoreSuiteDeterministicInput,
  ): Promise<Record<string, number>>;
  scoreGolden(i: ScoreGoldenInput): Promise<ScoreGoldenOutput>;
  scoreSafetyClassifier(
    i: ScoreSafetyClassifierInput,
  ): Promise<SafetyClassifierOutput>;
  aggregateMetrics(i: {
    runId: string;
    suite: EvaluationJobInput['suite'];
    scope: EvaluationJobInput['evaluationScope'];
    sliceBy?: Array<'category' | 'difficulty' | 'tags'>;
    /**
     * Preferred input: small, in-memory per-case slots from the parent's
     * `perCaseSlots[]` accumulator. Each slot carries
     * `deterministicMetrics` (small numeric payload — safe to round-trip
     * through Temporal event history).
     */
    slots?: CaseRunSlot[];
    /**
     * Alternative input: full denormalized artifacts. Used by edge tests
     * that want to drive `aggregateMetrics` from a hand-built fixture
     * without going through `runCase`. `slots` wins when both are set.
     */
    artifacts?: CaseRunArtifact[];
  }): Promise<EvaluationDimension[]>;
  computeGates(i: {
    runId: string;
    dimensions: EvaluationDimension[];
    jobInput: EvaluationJobInput;
    preflightSummary?: PreflightSummary;
    tradeoffDecision?: EvaluationResults['tradeoffDecision'];
    coverage: { completed: number; total: number };
    infraFailureRate: number;
    judgeCoverage: { scored: number; target: number };
    runStopped: boolean;
  }): Promise<{ triggeredGates: TriggeredGate[]; verdict: Verdict }>;
  compareToBaseline(i: {
    runId: string;
    dimensions: EvaluationDimension[];
    /** Echoed onto the result. The workflow fetches the run itself. */
    baselineJobId?: string;
    /** Baseline-run headline dimensions, supplied by the workflow after fetch. */
    baselineDimensions?: EvaluationDimension[];
    /** Inline per-metric targets (alternative or supplement to a baseline run). */
    expectations?: BaselineExpectation[];
    /** Workflow-captured fetch error, echoed for consumer visibility. */
    baselineFetchError?: string;
  }): Promise<EvaluationResults['baselineComparison']>;

  // Persistence + audit
  updateJobStatus(i: UpdateJobStatusInput): Promise<void>;
  updateJobResults(i: {
    runId: string;
    projectId: string;
    results: EvaluationResults;
  }): Promise<void>;
  recordTradeoffDecision(i: {
    runId: string;
    projectId: string;
    decision: EvaluationResults['tradeoffDecision'];
    actor: string;
  }): Promise<void>;
  writeAuditEvent(i: AuditEvent & { projectId: string }): Promise<void>;
  sendObservabilityTrace(i: {
    caseRef: CaseRef;
    /** PVC URI of the capture file written by `invokeAgent`. */
    capturePath: string;
  }): Promise<{ traceRef: string }>;
  getEvaluationJob(i: { runId: string; projectId: string }): Promise<EvaluationJob>;
  loadEvaluationResults(i: {
    runIds: string[];
    projectId: string;
  }): Promise<EvaluationResults[]>;
  loadCaseArtifacts(i: {
    runId: string;
    projectId: string;
  }): Promise<CaseRunArtifact[]>;

  // Compare
  enforceComparability(
    i: EnforceComparabilityInput,
  ): Promise<ComparabilityIssue[]>;
  computeSliceDeltas(i: ComputeSliceDeltasInput): Promise<SliceDelta[]>;
  computeMetricComparisons(i: {
    dimensionsA: EvaluationDimension[];
    dimensionsB: EvaluationDimension[];
  }): Promise<MetricComparison[]>;
  buildTradeoffPanel(i: {
    resultsArray: EvaluationResults[];
  }): Promise<TradeoffView>;
  buildCompareReport(
    i: BuildCompareReportInput,
  ): Promise<BuildCompareReportOutput>;

  // Artifact / reports
  writeResultsFile(i: WriteResultsFileInput): Promise<WriteResultsFileOutput>;
  writeStakeholderReport(
    i: WriteStakeholderReportInput,
  ): Promise<WriteStakeholderReportOutput>;

  // Promote-to-regression
  promoteToRegression(
    i: PromoteToRegressionInput,
  ): Promise<PromoteToRegressionOutput>;
}
