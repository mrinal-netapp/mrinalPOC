import type { BaseListParams } from '@/api/api.types';

// -- Status enums --
//
// The persisted EvaluationRun.status column on config-service is the
// eval-worker's canonical EvaluationStatus enum (see
// `eval-worker/.../lib/evaluation/lib/job-types.ts`): `queued | running |
// aggregating | success | failed | cancelled`. The UI used to carry a
// parallel enum (`scoring`/`completed`/`stopped`) that never matched
// anything the API returned, so any row whose persisted status fell
// outside the parallel set crashed `EvalStatusCell` (STATUS_MAP lookup
// returned undefined, `visual.type` threw). The type below is the union
// of both schemes so existing call sites that compare against the
// legacy values keep compiling, while runs persisted with the canonical
// values render correctly.

export type EvalRunStatus =
  // Canonical worker / API values.
  | 'queued'
  | 'running'
  | 'aggregating'
  | 'success'
  | 'failed'
  | 'cancelled'
  // Legacy UI aliases — accepted in case any test fixture or older
  // upstream still emits them.
  | 'scoring'
  | 'completed'
  | 'stopped';

export type EvalLifecycleStatus = 'success' | 'completed' | 'running' | 'cancelled' | 'stopped';

/** Matches the backend `evaluators.strategy` enum exactly. */
export type EvalScoringStrategy = 'deterministic' | 'llm_judge' | 'both';

export type EvalSuite = 'rag' | 'safety' | 'tool_use' | 'custom';

export type EvalScope = 'full_agent_execution' | 'response_only' | 'retrieval_only';

export type RunMode = 'single' | 'regression' | 'ab_compare' | 'tuning_sweep' | 'repeats';

export type GatingProfile = 'dev' | 'staging' | 'release';

export type GateLevel = 'warning' | 'blocking' | 'informational';

export type SampleMode = 'all' | 'fraction' | 'stratified';

// -- Agent ref (matches EvaluationAgentBinding in the backend) --

export type AgentRef = {
  agentId?: string;
  agentTeam?: string;
  /** Version label, e.g. 'v2.4.1'. */
  agentVersion?: string;
};

// -- Evaluator config (nested aiJudge + deterministic shape from PR #42) --

export type AiJudgeConfig = {
  /** Judge model id(s); required when strategy !== 'deterministic'. */
  models: string[];
  /** Selected dimension keys from the rubric catalog (underscore_case). */
  dimensions: string[];
  evalMode?: 'pointwise' | 'pairwise';
  samplingMode?: 'all' | 'stratified' | 'fraction';
  stratifiedSlices?: boolean;
  gateWhenSampled?: 'informational' | 'blocking';
  goldenAvailable?: boolean;
};

export type DeterministicConfig = {
  /** Selected metric keys from the rubric catalog (underscore_case). */
  metrics: string[];
};

export type EvaluatorConfig = {
  strategy: EvalScoringStrategy;
  rubricPreset?: string;
  /** Present when strategy is 'llm_judge' or 'both'. */
  aiJudge?: AiJudgeConfig;
  /** Present when strategy is 'deterministic' or 'both'. */
  deterministic?: DeterministicConfig;
};

// -- Gate --

export type Gate = {
  id: string;
  level: GateLevel;
  threshold: number;
};

// -- Thresholds --

export type ThresholdConfig = {
  gatingProfile: GatingProfile;
  gates: Gate[];
  coverageMinPct: number;
  infraFailureMaxPct: number;
  safetyP0Threshold: number;
  minCompletedCases: number;
};

// -- Cases config --

export type CaseSampleConfig = {
  mode: SampleMode;
  fraction?: number;
  stratifyBy?: string;
};

export type CasesConfig = {
  schemaVersion?: string;
  source?: EvalTestCaseSource;
  sample?: CaseSampleConfig;
  /**
   * Storage filename for the test-cases blob on the eval-worker PVC.
   *
   * Set when the operator uploads a file from the UI: the file is PUT
   * directly to S3 at
   * `projects/{projectId}/evaluations/{slug(evalName)}/testcases/{filename}`
   * and the eval-worker resolves the parser by extension (`.csv` → flat
   * 3-column, anything else → golden JSONL).
   */
  filename?: string;
};

// -- EvaluationTemplate --

export type EvaluationTemplate = {
  templateId: string;
  projectId: string;
  evalName: string;
  description?: string;
  labels?: string[];
  owner?: string;
  createdBy?: string;
  lastModifiedBy?: string;
  target: 'agent_version';
  agent: AgentRef;
  /** Judge model ids (top-level for forward-compat; also in evaluators.aiJudge.models). */
  models: string[];
  evaluationScope: EvalScope;
  suite: EvalSuite;
  evaluators: EvaluatorConfig;
  thresholds?: ThresholdConfig;
  cases?: CasesConfig;
  runMode: RunMode;
  regression?: { baselineRunId: string };
  concurrency?: number;
  createdAt?: string;
  updatedAt?: string;
};

// -- TestCase --

export type Attachment = {
  uri: string;
  mimeType: string;
};

export type Citation = {
  text: string;
  source: string;
};

export type ToolCallExpectation = {
  toolName: string;
  args?: Record<string, unknown>;
};

export type GoldenAssertion = {
  metric: string;
  operator: string;
  value: number;
};

export type TestCase = {
  caseId: string;
  templateId: string;
  category?: string;
  input: {
    query: string;
    attachments?: Attachment[];
    contextHints?: string[];
  };
  reference?: {
    response?: string;
    citations?: Citation[];
    expectedToolCalls?: ToolCallExpectation[];
  };
  expectedAssertions?: GoldenAssertion[];
  metadata?: Record<string, unknown>;
};

// -- AuditEvent (matches backend EvaluationAuditEvent) --

export type AuditEvent = {
  at: string;
  actor?: string;
  type: string;
  message?: string;
  data?: Record<string, unknown>;
  // Legacy aliases kept for existing UI components that read these fields
  eventId?: string;
  runId?: string;
  timestamp?: string;
  action?: string;
};

// -- EvaluationResults (mirrors eval-worker's `EvaluationResults` in
//    `src/nemo/workers/eval-worker/src/lib/evaluation/lib/job-types.ts`).
//    This is the canonical wire shape persisted by the worker via
//    `updateJobResults` and returned verbatim by config-service's
//    `GET /api/v1/projects/{pid}/evaluations/{tid}/runs/{runId}`.
//    The UI used to carry a parallel flat-shape type — `domainMetrics`,
//    `testCaseCoveragePct`, `gateOutcome`, etc. — that never matched the
//    persisted payload, so every run appeared empty. The adapter
//    helpers below project this shape into the small derived bag the
//    metric-section components still consume. -- 2026-06-21 fix. --

export type EvaluationVerdict = 'pass' | 'fail' | 'blocked';

export type EvaluationGateLevel = 'info' | 'warning' | 'blocking';

export type EvaluationGateStatus = 'passed' | 'failed' | 'warning';

export type EvaluationTriggeredGate = {
  id: string;
  level: EvaluationGateLevel;
  status: EvaluationGateStatus;
  threshold: number | null;
  actual: number | null;
  message: string;
};

export type EvaluationDimension = {
  id: string;
  label: string;
  /** Headline metric id -> numeric value (or null when not computed). */
  headline: Record<string, number | null>;
  notComputedReason?: string;
};

export type EvaluationResults = {
  verdict: EvaluationVerdict;
  triggeredGates: EvaluationTriggeredGate[];
  dimensions: EvaluationDimension[];
  coverage: { total: number; completed: number; completedPct: number };
  /** Fraction (0..1) — multiply by 100 for a percentage. */
  infraFailureRate: number;
  judgeCoverage: { scored: number; target: number; pct: number };
  preFlightNonPromotable: boolean;
  runStopped: boolean;
  qualityPct?: number;
};

export type PerCaseJudgeRubric = {
  rubricId: string;
  judgeModelName?: string;
  judgeVersion?: string;
  rubricPromptHash?: string;
  mode?: string;
  score?: number;
  errored?: boolean;
  rationale?: string;
};

export type PerCaseTelemetry = {
  e2eMs?: number;
  inputTokens?: number;
  outputTokens?: number;
};

export type PerCaseArtifact = {
  runId?: string;
  caseId: string;
  model?: string;
  status?: string;
  passed?: boolean;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  response?: string;
  error?: string;
  errorType?: string;
  deterministicMetrics?: Record<string, number>;
  judgeRubrics?: PerCaseJudgeRubric[];
  telemetry?: PerCaseTelemetry;
  capturePath?: string;
  traceRef?: string;
};

/** Full `results.json` artifact written by the eval worker to S3. */
export type EvaluationResultsFile = {
  runId?: string;
  generatedAt?: string;
  results?: EvaluationResults;
  perCaseArtifacts: PerCaseArtifact[];
  provenance?: Record<string, unknown>;
};

/**
 * Flatten the per-dimension headline maps into the single map the
 * metric-section components consume. Null values (metric not computed)
 * are dropped so callers can rely on `Object.keys(...).length > 0` as a
 * "has any metric" check.
 */
export function extractDomainMetrics(
  results: EvaluationResults | undefined,
): Record<string, number> {
  if (!results) return {};
  const out: Record<string, number> = {};
  for (const dim of results.dimensions ?? []) {
    for (const [key, value] of Object.entries(dim.headline ?? {})) {
      if (typeof value === 'number') out[key] = value;
    }
  }
  return out;
}

/**
 * Compress the array of triggered gates into the boolean/list shape the
 * metric-section gate card displays. A gate is "failed" only when its
 * level is `blocking` and its status is `failed` — warning-level fails
 * don't gate verdict so they shouldn't gate the UI either.
 */
export function extractGateOutcome(
  results: EvaluationResults | undefined,
): { passed: boolean; failedGates: string[] } | null {
  if (!results || !Array.isArray(results.triggeredGates)) return null;
  const failed = results.triggeredGates.filter(
    (g) => g.level === 'blocking' && g.status === 'failed',
  );
  return {
    passed: results.verdict === 'pass',
    failedGates: failed.map((g) => g.id),
  };
}

// -- Provenance --

export type RunProvenance = {
  triggeredAt: string;
  agentRef: {
    projectId: string;
    agentId?: string;
    agentTeam?: string;
    agentVersion?: string;
  };
  models: string[];
  rubricIds: string[];
};

// -- EvaluationRun --

export type EvaluationBaselineStatus =
  | 'not_set'
  | 'current_baseline'
  | 'above_baseline'
  | 'below_baseline';

export type EvaluationRun = {
  runId: string;
  templateId: string;
  name: string;
  workflowId?: string;
  projectId: string;
  status: EvalRunStatus;
  baselineStatus: EvaluationBaselineStatus;
  trigger?: {
    actor: string;
    reason?: string;
    triggeredAt: string;
  };
  provenance?: RunProvenance;
  templateSnapshot?: EvaluationTemplate;
  casesSnapshot?: TestCase[];
  results?: EvaluationResults;
  artifacts?: {
    resultsFileUri?: string;
  };
  audit?: AuditEvent[];
  startTime?: string;
  endTime?: string;
  createdAt?: string;
  updatedAt?: string;
};

// -- RunOptions (POST trigger body) --

export type RunOptions = {
  runId?: string;
  actor?: string;
  reason?: string;
  overrides?: {
    concurrency?: number;
    sampleOverride?: {
      mode: 'all' | 'fraction';
      fraction?: number;
    };
  };
};

// -- List item — backend EvaluationTemplateListItem shape --

export type EvalListItem = EvaluationTemplate & {
  latestRunStatus?: EvalRunStatus | null;
  runCount: number;
  lastRunUpdatedAt?: string | null;
};

// -- List query params --

export type EvalListParams = BaseListParams & {
  runMode?: RunMode;
  suite?: EvalSuite;
  status?: string;
};

// -- Validation response --

export type CaseValidationResponse = {
  errors: Array<{ index?: number; caseId?: string; message: string }>;
  warnings: Array<{ index?: number; caseId?: string; message: string }>;
  count?: number;
};

// -- Template create/update requests --

// projectId is path-scoped (assigned by the backend from the URL), so it is not
// part of the request body. Audit fields (owner, createdBy, lastModifiedBy) are
// server-managed and rejected by the backend validator, so they are omitted too.
export type EvalTemplateCreateRequest = Omit<
  EvaluationTemplate,
  'templateId' | 'projectId' | 'createdAt' | 'updatedAt' | 'owner' | 'createdBy' | 'lastModifiedBy'
>;

export type EvalTemplateUpdateRequest = Partial<EvalTemplateCreateRequest>;

// -- Test-case source (matches backend cases.source enum) --

export type EvalTestCaseSource = 'skip' | 'upload' | 'generate';

export type EvalDatasetColumnMapping = {
  id: string;
  query: string;
  expected?: string;
};
