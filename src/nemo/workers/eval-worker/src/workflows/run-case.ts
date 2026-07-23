// Per-case orchestrator — two-phase capture + score, called inline from the
// parent AgentEvaluationWorkflow. This is NOT a child Temporal workflow; it is
// a plain async helper executed inside the parent workflow's VM. The activity
// proxies declared below register the per-case activities under the parent's
// event history (one row per activity, no child-workflow rows).
//
// Phase 1 (CAPTURE): single agent-service round-trip. All retrieval, tool
// fan-out, sub-agent dispatch, synthesis happens inside agent-service. The
// activity persists the full Phase-1 payload to PVC (capture.json) and
// returns only a `posix:///` path + a numeric headline so customer-derived
// data never enters Temporal event history.
//
// Phase 2 (SCORE): pure scorer fan-out over the Phase-1 capture file. NO
// further calls to agent-service; judge-only LLM traffic happens here for
// sampled cases. Each scorer/judge activity is given the capturePath and
// reads it from PVC.
//
// Per-case rows are not written to config-service. The returned
// `CaseRunSlot` (small per-case state, including `capturePath`) is
// accumulated by the parent in workflow memory; Phase c's
// `writeResultsFile` reads each slot's capture.json and denormalizes a
// single `results.json`.

import {
  ApplicationFailure,
  CancelledFailure,
  isCancellation,
  log,
  proxyActivities,
} from '@temporalio/workflow';
import type {
  AgentRuntimeOverrides,
  CaseRef,
  CaseRunSlot,
  CaseRunSummary,
  EvalActivities,
  EvaluationJobInput,
  GoldenAssertionReport,
  GoldenTestCase,
  InvokeAgentOutput,
  JudgeRubricOutput,
  FailureCategory,
  ResolvedScorerToggles,
  RootCause,
  SafetyClassifierOutput,
  ScoreGoldenOutput,
} from '../lib/evaluation';
import {
  DEFAULT_LLM_ACTIVITY_TIMEOUT,
  DEFAULT_LLM_RETRY_ATTEMPTS,
  EVAL_TASK_QUEUE,
} from '../lib/evaluation';

export interface RunCaseInput {
  runId: string;
  projectId: string;
  evalId: string;
  agentTeam: string;
  agentId?: string;
  case: GoldenTestCase;
  /** Post-merge overrides (job + variant). */
  overrides: AgentRuntimeOverrides;
  variantId?: string;
  model: string;
  seed?: number;
  envelopeHash: string;
  jobInput: EvaluationJobInput;
  /** Rubrics that should run for THIS case (already sampled by parent). */
  judgeRubricIds: string[];
  /**
   * Effective deterministic-scorer on/off matrix resolved once by the
   * parent workflow from `jobInput.evaluators.{goldenAvailable,scorers}`.
   * Resolving up front means runCase does not re-evaluate the rule per
   * case (and the resolution rule stays in a single shared module).
   */
  scorerToggles: ResolvedScorerToggles;
}

// ── Skipped-scorer placeholder shapes ───────────────────────────────
//
// When a deterministic scorer is gated off, runCase returns a typed
// empty/sentinel value instead of invoking the activity. This keeps the
// slot shape stable (aggregator + gate evaluator don't need a branch
// for "scorer didn't run") while ensuring zero Temporal events are emitted
// for the skipped activity.

/**
 * Used when `scorerToggles.goldenAssertions === false`. Mirrors the
 * "no assertions on this case" path that `scoreGoldenAssertions`
 * naturally produces today: empty arrays + `schemaValid=true`.
 */
const EMPTY_GOLDEN_ASSERTION_REPORT: GoldenAssertionReport = {
  final: {
    mustInclude: [],
    mustCite: [],
    forbidden: [],
    schemaValid: true,
    schemaErrors: [],
  },
  subAgents: [],
};

const SKIPPED_GOLDEN_OUTPUT: ScoreGoldenOutput = {
  notComputedReason: 'skipped_no_golden',
};

/**
 * Used when `scorerToggles.safetyClassifier === false`. Neutral values so
 * derivePass / classifyFailure remain branch-free.
 */
const EMPTY_SAFETY_OUTPUT: SafetyClassifierOutput = {
  unsafe: false,
  falseRefusal: false,
  boundaryAdherence: 1,
};

// ── Activity proxies ────────────────────────────────────────────────

const { invokeAgent } = proxyActivities<EvalActivities>({
  taskQueue: EVAL_TASK_QUEUE,
  startToCloseTimeout: DEFAULT_LLM_ACTIVITY_TIMEOUT,
  heartbeatTimeout: '1m',
  retry: {
    maximumAttempts: DEFAULT_LLM_RETRY_ATTEMPTS,
    initialInterval: '2s',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [
      'InvalidInputError',
      'ContentFilteredError',
      'AgentNotFoundError',
    ],
  },
});

const { invokeJudge } = proxyActivities<EvalActivities>({
  taskQueue: EVAL_TASK_QUEUE,
  startToCloseTimeout: '5m',
  retry: {
    maximumAttempts: DEFAULT_LLM_RETRY_ATTEMPTS,
    initialInterval: '2s',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['InvalidInputError'],
  },
});

const {
  scoreGoldenAssertions,
  scoreSuiteDeterministic,
  scoreGolden,
  scoreSafetyClassifier,
} = proxyActivities<EvalActivities>({
  taskQueue: EVAL_TASK_QUEUE,
  startToCloseTimeout: '1m',
  retry: { maximumAttempts: 2 },
});

const { sendObservabilityTrace } = proxyActivities<EvalActivities>({
  taskQueue: EVAL_TASK_QUEUE,
  startToCloseTimeout: '2m',
  retry: {
    maximumAttempts: 3,
    initialInterval: '2s',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['InvalidInputError', 'ValidationError'],
  },
});

// ── Per-case orchestrator ───────────────────────────────────────────

export async function runCase(input: RunCaseInput): Promise<CaseRunSummary> {
  const { case: testCase, model, seed, variantId, runId, scorerToggles } =
    input;
  const caseRef = buildCaseRef(input);

  log.info('runCase starting', {
    runId,
    caseId: testCase.id,
    model,
    variantId,
    seed,
    rubricCount: input.judgeRubricIds.length,
    scorerToggles,
  });

  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  // ── Phase 1 — CAPTURE (one agent-service call) ────────────────────
  let captureRef: InvokeAgentOutput;
  try {
    captureRef = await invokeAgent({
      caseRef,
      agentTeam: input.agentTeam,
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      envelopeHash: input.envelopeHash,
      overrides: withSeed(input.overrides, seed),
      input: {
        query: testCase.input.query,
        ...(testCase.input.attachments !== undefined
          ? { attachments: testCase.input.attachments }
          : {}),
        ...(testCase.input.context_hints !== undefined
          ? { context_hints: testCase.input.context_hints }
          : {}),
      },
    });
  } catch (err) {
    if (isCancellation(err) || err instanceof CancelledFailure) throw err;
    return buildFailedCaptureSummary(input, caseRef, err, startedAt, startMs);
  }

  const { capturePath } = captureRef;

  // Forward observability trace non-fatally; keep traceRef for drilldown.
  let traceRef: string | undefined;
  try {
    const { traceRef: ref } = await sendObservabilityTrace({
      caseRef,
      capturePath,
    });
    traceRef = ref;
  } catch (err) {
    if (isCancellation(err) || err instanceof CancelledFailure) throw err;
    log.warn('sendObservabilityTrace failed (non-fatal)', {
      caseId: testCase.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── Phase 2 — SCORE (pure, no agent-service calls) ────────────────
  //
  // Activities whose toggle is OFF are NOT invoked at all (zero Temporal
  // events for the skipped scorer); a typed empty value is substituted so
  // the downstream slot shape stays identical to the all-scorers-on
  // case. The remaining activities still run in parallel via Promise.all.
  const goldenAssertionsP: Promise<GoldenAssertionReport> = scorerToggles
    .goldenAssertions
    ? scoreGoldenAssertions({
        caseRef,
        capturePath,
        case: testCase,
      })
    : Promise.resolve(EMPTY_GOLDEN_ASSERTION_REPORT);

  const deterministicP: Promise<Record<string, number>> = scorerToggles
    .suiteDeterministic
    ? scoreSuiteDeterministic({
        caseRef,
        capturePath,
        suite: input.jobInput.suite,
        case: testCase,
      })
    : Promise.resolve({});

  // Defensive: cases coming from config-service may not carry the full
  // `evaluation.expected_response.final` block — the loose-shape
  // `reference` object is mapped into it by `normalizeCase` but only
  // when the GUI populated the expected fields. Treat missing pieces as
  // "skip golden scoring" so a partially-specified case doesn't crash
  // the whole run.
  const expectedFinal =
    testCase.evaluation?.expected_response?.final ?? undefined;
  const goldenP: Promise<ScoreGoldenOutput> =
    scorerToggles.golden && expectedFinal
      ? scoreGolden({
          caseRef,
          capturePath,
          ...(expectedFinal.reference_text !== undefined
            ? { expectedReferenceText: expectedFinal.reference_text }
            : {}),
          ...(expectedFinal.expected_answer !== undefined
            ? { expectedAnswer: expectedFinal.expected_answer }
            : {}),
        })
      : Promise.resolve(SKIPPED_GOLDEN_OUTPUT);

  const safetyP: Promise<SafetyClassifierOutput> = scorerToggles
    .safetyClassifier
    ? scoreSafetyClassifier({
        caseRef,
        capturePath,
        ...(testCase.evaluation.safety_expectation?.should_refuse !== undefined
          ? {
              expectedRefusal:
                testCase.evaluation.safety_expectation.should_refuse,
            }
          : {}),
        prompt: testCase.input.query,
      })
    : Promise.resolve(EMPTY_SAFETY_OUTPUT);

  const [goldenAssertions, deterministic, golden, safety] = await Promise.all([
    goldenAssertionsP,
    deterministicP,
    goldenP,
    safetyP,
  ]);

  // Judge fan-out — only for the rubrics the parent selected for this case.
  // Judge-row failures never abort the run (spec §7.5); they surface as
  // errored=true and are reflected in `judge_scoring_health` gate.
  const judgeRubrics: JudgeRubricOutput[] = await Promise.all(
    input.judgeRubricIds.map(async (rubricId) => {
      try {
        return await invokeJudge({
          caseRef,
          capturePath,
          rubricId,
          evaluatorModel: input.jobInput.evaluators.evaluatorModel ?? '',
          evaluatorVersion: input.jobInput.evaluators.evaluatorVersion ?? '',
          rubricPromptHash: rubricId, // resolved inside activity
          case: testCase,
          mode: 'pointwise',
        });
      } catch (err) {
        if (isCancellation(err) || err instanceof CancelledFailure) throw err;
        return {
          rubricId,
          judgeModelName: input.jobInput.evaluators.evaluatorModel ?? '',
          judgeVersion: input.jobInput.evaluators.evaluatorVersion ?? '',
          rubricPromptHash: rubricId,
          mode: 'pointwise' as const,
          errored: true,
          rationale: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  // Derive pass/fail from blocking assertions + pointwise judge thresholds.
  const passed = derivePass(goldenAssertions, judgeRubrics, safety);
  const { failureCategory, rootCause } = passed
    ? {}
    : classifyFailure(goldenAssertions, deterministic, safety);

  // Merge deterministic metrics with golden-lite + safety metrics. When a
  // scorer is gated OFF its metric keys are dropped from the record entirely
  // (rather than set to `null`) so the parent-side aggregator never sees an
  // ID for a metric the run can't produce.
  const deterministicMetrics: Record<string, number | null> = {
    ...deterministic,
  };
  if (scorerToggles.golden) {
    deterministicMetrics['correctness.em'] = golden.em ?? null;
    deterministicMetrics['correctness.bleu'] = golden.bleu ?? null;
    deterministicMetrics['correctness.rougeL'] = golden.rougeL ?? null;
    deterministicMetrics['correctness.tokenF1'] = golden.tokenF1 ?? null;
  }
  if (scorerToggles.safetyClassifier) {
    deterministicMetrics['safety.unsafe_rate'] = safety.unsafe ? 1 : 0;
    deterministicMetrics['safety.false_refusal_rate'] = safety.falseRefusal
      ? 1
      : 0;
    deterministicMetrics['safety.boundary'] = safety.boundaryAdherence;
  }

  // Per-case telemetry → deterministic metrics. These flow through
  // `aggregateMetrics` like any other scorer output and end up as the
  // `perf` + `cost` dimensions on the persisted EvaluationResults
  // (and thus in the config-service API response). Emitted on every
  // case regardless of suite — the existing `scorePerformanceCost`
  // path only runs for `suite=performance_cost`, so other suites were
  // missing Performance / Token usage entirely.
  const tel = captureRef.telemetry;
  if (typeof tel.e2eMs === 'number' && tel.e2eMs > 0) {
    deterministicMetrics['perf.e2e_ms'] = tel.e2eMs;
  }
  if (typeof tel.ttftMs === 'number') {
    deterministicMetrics['perf.ttft_ms'] = tel.ttftMs;
  }
  if (typeof tel.retrievalMs === 'number') {
    deterministicMetrics['perf.retrieval_ms'] = tel.retrievalMs;
  }
  if (typeof tel.inferMs === 'number') {
    deterministicMetrics['perf.infer_ms'] = tel.inferMs;
  }
  if (typeof tel.inputTokens === 'number') {
    deterministicMetrics['cost.input_tokens'] = tel.inputTokens;
  }
  if (typeof tel.outputTokens === 'number') {
    deterministicMetrics['cost.output_tokens'] = tel.outputTokens;
  }
  if (typeof tel.inputTokens === 'number' && typeof tel.outputTokens === 'number') {
    deterministicMetrics['cost.total_tokens'] = tel.inputTokens + tel.outputTokens;
  }
  if (typeof tel.estCostUsd === 'number') {
    deterministicMetrics['cost.est_usd'] = tel.estCostUsd;
  }

  // AI-judge rubric scores -> deterministicMetrics. Each successful
  // rubric output (score normalised to 0..100) gets a `judge.<rubric>`
  // entry so the parent-side aggregator emits a `judge` dimension
  // alongside `rag`, `correctness`, `safety`, etc. Errored / score-less
  // rubrics are skipped — judgeRubrics already drives the
  // `judge_scoring_health` gate separately.
  for (const r of judgeRubrics) {
    if (r.errored) continue;
    if (typeof r.score !== 'number') continue;
    const denom = typeof r.outOf === 'number' && r.outOf > 0 ? r.outOf : 1;
    // Normalise to 0..100 so judge metrics share the unit convention of
    // the deterministic scorers (e.g. correctness.em, safety.boundary).
    const normalised = (r.score / denom) * 100;
    deterministicMetrics[`judge.${r.rubricId}`] = normalised;
  }

  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - startMs;

  const slot: CaseRunSlot = {
    caseRef,
    status: 'COMPLETED',
    passed,
    startedAt,
    completedAt,
    durationMs,
    capturePath,
    telemetry: captureRef.telemetry,
    retrievalAnnotation: captureRef.retrievalAnnotation,
    resolvedRuntimeParams: captureRef.resolvedRuntimeParams,
    deterministicMetrics,
    goldenAssertions,
    judgeRubrics,
    ...(failureCategory !== undefined ? { failureCategory } : {}),
    ...(rootCause !== undefined ? { rootCause } : {}),
    ...(traceRef !== undefined ? { traceRef } : {}),
  };

  return {
    runId,
    caseId: testCase.id,
    ...(variantId !== undefined ? { variantId } : {}),
    model,
    ...(seed !== undefined ? { repeatSeed: seed } : {}),
    status: 'COMPLETED',
    passed,
    ...(failureCategory !== undefined ? { failureCategory } : {}),
    durationMs,
    ...(traceRef !== undefined ? { traceRef } : {}),
    slot,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function buildCaseRef(input: RunCaseInput): CaseRef {
  return {
    projectId: input.projectId,
    evalId: input.evalId,
    runId: input.runId,
    caseId: input.case.id,
    model: input.model,
    ...(input.variantId !== undefined ? { variantId: input.variantId } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
  };
}

function withSeed(
  overrides: AgentRuntimeOverrides,
  seed: number | undefined,
): AgentRuntimeOverrides {
  if (seed === undefined) return overrides;
  return { ...overrides, seed };
}

function buildFailedCaptureSummary(
  input: RunCaseInput,
  caseRef: CaseRef,
  err: unknown,
  startedAt: string,
  startMs: number,
): CaseRunSummary {
  const errorMessage = err instanceof Error ? err.message : String(err);
  const errorType = classifyErrorType(err);
  const { failureCategory, rootCause } = captureErrorToCategory(err);

  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - startMs;

  const slot: CaseRunSlot = {
    caseRef,
    status: 'FAILED',
    passed: false,
    startedAt,
    completedAt,
    durationMs,
    deterministicMetrics: {},
    judgeRubrics: [],
    error: errorMessage,
    errorType,
    ...(failureCategory !== undefined ? { failureCategory } : {}),
    ...(rootCause !== undefined ? { rootCause } : {}),
  };

  return {
    runId: input.runId,
    caseId: input.case.id,
    ...(input.variantId !== undefined ? { variantId: input.variantId } : {}),
    model: input.model,
    ...(input.seed !== undefined ? { repeatSeed: input.seed } : {}),
    status: 'FAILED',
    passed: false,
    errorType,
    ...(failureCategory !== undefined ? { failureCategory } : {}),
    durationMs,
    slot,
  };
}

/** Map ApplicationFailure type → {quality, infra} (spec §7.5). */
function classifyErrorType(err: unknown): 'quality' | 'infra' {
  if (err instanceof ApplicationFailure) {
    const t = err.type ?? '';
    if (
      t === 'ContentFilteredError' ||
      t === 'InvalidInputError' ||
      t === 'AgentNotFoundError'
    ) {
      return 'quality';
    }
  }
  return 'infra';
}

function captureErrorToCategory(err: unknown): {
  failureCategory?: FailureCategory;
  rootCause?: RootCause;
} {
  if (
    err instanceof ApplicationFailure &&
    err.type === 'ContentFilteredError'
  ) {
    return {
      failureCategory: 'safety',
      rootCause: 'safety_refusal_issue',
    };
  }
  return {};
}

/** Blocking-assertion-and-rubric pass/fail derivation. */
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

function classifyFailure(
  goldenAssertions: GoldenAssertionReport | undefined,
  deterministic: Record<string, number>,
  safety: { unsafe: boolean; falseRefusal: boolean },
): { failureCategory?: FailureCategory; rootCause?: RootCause } {
  if (safety.unsafe) {
    return {
      failureCategory: 'safety',
      rootCause: 'safety_refusal_issue',
    };
  }
  const final = goldenAssertions?.final;
  if (final && !final.schemaValid) {
    return {
      failureCategory: 'schema',
      rootCause: 'schema_violation',
    };
  }
  if ((deterministic['rag.groundedness'] ?? 1) < 0.5) {
    return {
      failureCategory: 'retrieval',
      rootCause: 'ungrounded_synthesis',
    };
  }
  if ((deterministic['tool.call_success'] ?? 1) < 0.5) {
    return {
      failureCategory: 'tool',
      rootCause: 'tool_misuse',
    };
  }
  return { failureCategory: 'judge_scoring' };
}
