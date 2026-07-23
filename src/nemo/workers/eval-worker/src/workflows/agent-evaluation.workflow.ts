// AgentEvaluationWorkflow — single authoritative parent workflow (spec
// §6.2.1). Run modes (single, regression, A/B, repeats) are composition
// patterns driven from config-service: each variant / seed runs THIS
// workflow, not a bespoke parent. The body is split into three explicit
// phases that mirror Diagram 2:
//
//   Phase a — preflight + test-cases load + shard + per-case fan-out (`runCase`)
//   Phase b — aggregate + gate + (optional) baseline compare
//   Phase c — write results.json + stakeholder PDF to artifact store
//
// There is NO per-case child workflow. Each (case × variant × seed) tuple is
// processed by an inline `runCase()` helper inside this workflow's worker
// pool — its activities (invokeAgent, score*, invokeJudge, sendObservability
// Trace) appear directly in this workflow's event history, removing one
// layer of Temporal noise without losing per-activity retry/timeout dials.
//
// Per-case rows are not upserted to config-service. The parent accumulates
// returned `CaseRunSlot`s (small per-case state) and dumps them in Phase c
// via `writeResultsFile`, which reads each slot's capture.json from PVC and
// denormalizes a single results.json. Phase c calls `writeResultsFile` and
// `writeStakeholderReport` activities directly.
//
// Per-case Temporal payloads carry only `{caseRef, capturePath, …}`; the
// heavy customer-derived payload (agent response, retrieved chunks, tool
// I/O, traces) lives on PVC and never enters Temporal event history.

import {
  CancellationScope,
  CancelledFailure,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  log,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import type {
  AgentEvaluationWorkflowInput,
  AgentRuntimeOverrides,
  CaseRunSlot,
  EvalActivities,
  EvaluationDimension,
  EvaluationJob,
  EvaluationJobInput,
  EvaluationProgress,
  EvaluationResults,
  GoldenTestCase,
  PreflightOverrideIntent,
  PreflightSummary,
  ResolvedScorerToggles,
  TradeoffDecision,
  TriggeredGate,
  Verdict,
} from '../lib/evaluation';
import {
  DEFAULT_EVAL_CONCURRENCY,
  DEFAULT_STOP_GRACE_SECONDS,
  EVAL_TASK_QUEUE,
  EVALUATION_CANCEL_SIGNAL,
  EVALUATION_OVERRIDE_SIGNAL,
  EVALUATION_PREFLIGHT_QUERY,
  EVALUATION_PROGRESS_QUERY,
  EVALUATION_RESULTS_QUERY,
  EVALUATION_TRADEOFF_SIGNAL,
  resolveJudgeToggles,
  resolveScorerToggles,
} from '../lib/evaluation';
import { runCase, type RunCaseInput } from './run-case';

/**
 * Used when the high-level `strategy` resolves to `'llm_judge'` — the
 * parent forces every deterministic scorer off so `runCase` doesn't
 * dispatch any of them. Defined at module scope so the constant has
 * stable identity across replays.
 */
const ALL_SCORERS_OFF = {
  goldenAssertions: false,
  golden: false,
  suiteDeterministic: false,
  safetyClassifier: false,
} as const;

// ── Queries + signals ───────────────────────────────────────────────

export const evaluationProgressQuery = defineQuery<EvaluationProgress>(
  EVALUATION_PROGRESS_QUERY,
);
export const evaluationResultsQuery = defineQuery<
  EvaluationResults | undefined
>(EVALUATION_RESULTS_QUERY);
export const evaluationPreflightQuery = defineQuery<
  PreflightSummary | undefined
>(EVALUATION_PREFLIGHT_QUERY);

export const evaluationCancelSignal = defineSignal(EVALUATION_CANCEL_SIGNAL);
export const evaluationTradeoffSignal = defineSignal<[TradeoffDecision]>(
  EVALUATION_TRADEOFF_SIGNAL,
);
export const evaluationOverrideSignal = defineSignal<[PreflightOverrideIntent]>(
  EVALUATION_OVERRIDE_SIGNAL,
);

// ── Activity proxies ────────────────────────────────────────────────

const controlActivities = proxyActivities<EvalActivities>({
  taskQueue: EVAL_TASK_QUEUE,
  startToCloseTimeout: '2m',
  retry: {
    maximumAttempts: 3,
    initialInterval: '2s',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [
      'InvalidInputError',
      'NotFoundError',
      'ValidationError',
      'SchemaDrift',
    ],
  },
});

const {
  runPreflight,
  loadRunSnapshot,
  validateTestCases,
  aggregateMetrics,
  computeGates,
  compareToBaseline,
  findPreviousRun,
  updateJobStatus,
  updateJobResults,
  recordTradeoffDecision,
  writeAuditEvent,
  getEvaluationJob,
} = controlActivities;

// File-dump activities have a longer timeout + heartbeating because they may
// upload tens of MB to the artifact store for a 10k-case run.
const { writeResultsFile, writeStakeholderReport, buildCompareReport } =
  proxyActivities<EvalActivities>({
    taskQueue: EVAL_TASK_QUEUE,
    startToCloseTimeout: '10m',
    heartbeatTimeout: '2m',
    retry: {
      maximumAttempts: 2,
      initialInterval: '5s',
      backoffCoefficient: 2,
      nonRetryableErrorTypes: ['InvalidInputError', 'NotFoundError'],
    },
  });

// ── Workflow body ───────────────────────────────────────────────────

export async function AgentEvaluationWorkflow(
  workflowInput: AgentEvaluationWorkflowInput,
): Promise<EvaluationJob> {
  // Two-key entry — the snapshot itself is loaded from the persisted
  // EvaluationRun row inside `loadRunSnapshot` (the first activity below),
  // not embedded in the workflow input. Replays reuse the recorded
  // activity result, so a later PATCH against the live template/cases
  // cannot mutate the in-flight workflow's view of them.
  const { runId, projectId } = workflowInput;
  // Temporal's per-execution runId — distinct from our domain `runId`. Used as
  // a short suffix on derived workflow IDs so retries/replays get unique names.
  const { runId: temporalRunId } = workflowInfo();
  const runSuffix = temporalRunId.slice(0, 8);

  // Snapshot-derived state (populated by `loadRunSnapshot` below).
  // Definite-assignment assertions: every code path that reads these is
  // reached only after the first await inside the try block resolves.
  let input!: EvaluationJobInput;
  let allCases: GoldenTestCase[] = [];
  let evalId = '';
  let templateId = '';
  let jobFolderUri = '';
  let judgeToggles!: ReturnType<typeof resolveJudgeToggles>;
  let scorerToggles: ResolvedScorerToggles = ALL_SCORERS_OFF;
  let acceptedOverrides: Set<PreflightOverrideIntent> = new Set();

  // ── In-memory workflow state ──────────────────────────────────────
  let preflightSummary: PreflightSummary | undefined;
  let results: EvaluationResults | undefined;
  let tradeoffDecision: TradeoffDecision | undefined;

  let cancelRequested = false;
  let totalTuples = 0;
  let inFlightTuples = 0;
  let completedTuples = 0;
  let failedTuples = 0;
  const recentFailures: EvaluationProgress['recentFailures'] = [];

  /**
   * Per-case slots collected during Phase a fan-out, dumped in Phase c.
   *
   * Each slot is a small struct (caseRef + scorer outputs + numeric
   * metadata + capturePath). The full agent response / retrieved chunks /
   * tool I/O / trace live on PVC at
   * `<runDir>/cases/<caseId>/.../capture.json` and are read by
   * `writeResultsFile` at Phase c when assembling results.json. Slot size
   * is bounded (numeric metrics + small enums), so the practical dataset
   * ceiling is gated by PVC throughput rather than workflow memory.
   */
  const perCaseSlots: CaseRunSlot[] = [];

  let phase: EvaluationProgress['phase'] = 'preflight';
  let currentStatus: EvaluationJob['status'] = 'queued';

  // ── Handlers ──────────────────────────────────────────────────────
  setHandler(evaluationProgressQuery, buildProgress);
  setHandler(evaluationResultsQuery, () => results);
  setHandler(evaluationPreflightQuery, () => preflightSummary);

  setHandler(evaluationCancelSignal, () => {
    log.warn('evaluation.cancel received — draining', { runId });
    cancelRequested = true;
  });
  setHandler(evaluationTradeoffSignal, (decision) => {
    tradeoffDecision = decision;
  });
  setHandler(evaluationOverrideSignal, (intent) => {
    acceptedOverrides.add(intent);
  });

  try {
    // ═════════════════════════════════════════════════════════════════
    // Phase a — Load snapshot, preflight, shard, fan out per-case work
    // ═════════════════════════════════════════════════════════════════

    // 1. Pull the immutable template snapshot from the persisted
    //    EvaluationRun row and stage it under <runDir>/_input/ for audit.
    //    Cases are NOT in the row — `validateTestCases` reads them
    //    from the eval's own `testcases/` folder on the PVC.
    const snapshot = await loadRunSnapshot({ runId, projectId });
    input = snapshot.jobInput;
    evalId = snapshot.evalId;
    templateId = snapshot.templateId;
    jobFolderUri = snapshot.jobFolderUri;
    acceptedOverrides = new Set(input.overrideIntents ?? []);

    // 2. Validate the test-cases JSONL on the PVC. Schema errors,
    //    a missing file, or a content-hash mismatch surface as
    //    non-retryable ApplicationFailures here — the workflow's catch
    //    branch maps them to a `failed` finalize.
    const validated = await validateTestCases({
      projectId,
      evalId,
      runId,
      ...(snapshot.testCasesRef.filename !== undefined && {
        filename: snapshot.testCasesRef.filename,
      }),
    });
    allCases = validated.cases;

    // Resolve the high-level strategy and the deterministic-scorer toggle
    // matrix exactly once for the whole run so every per-case invocation
    // inherits the same configuration. Both resolvers are pure. When the
    // strategy is `'llm_judge'` the deterministic toggles are forced
    // all-off regardless of per-scorer overrides.
    judgeToggles = resolveJudgeToggles(input.evaluators);
    scorerToggles = judgeToggles.deterministicEnabled
      ? resolveScorerToggles(input.evaluators)
      : ALL_SCORERS_OFF;

    log.info('loaded run snapshot', {
      runId,
      projectId,
      evalId,
      jobFolderUri,
      caseCount: allCases.length,
    });

    await transitionStatus('queued', 'evaluation.started');
    preflightSummary = await runPreflight({ jobInput: input });

    if (isBlocked(preflightSummary)) {
      return finalize('failed', { reason: 'preflight_blocked' });
    }
    if (preflightSummary.summary === 'warnings') {
      const unmatched = collectUnmatchedWarnings(
        preflightSummary,
        acceptedOverrides,
      );
      if (unmatched.length > 0) {
        return finalize('failed', {
          reason: 'preflight_warnings_unacked',
          unmatched,
        });
      }
    }

    phase = 'loading';
    // Cases are already in `allCases` from `validateTestCases`
    // (above) — no further round-trip needed. Alias the variable
    // for the rest of Phase a so the downstream `shard` call reads
    // naturally.
    const cases = allCases;

    phase = 'sharding';
    const tuples = shard(cases, input);
    totalTuples = tuples.length;

    phase = 'running';
    await transitionStatus('running', 'evaluation.started');
    await fanOutCases(tuples, input);

    // ═════════════════════════════════════════════════════════════════
    // Phase b — Aggregate, gate, baseline compare
    // ═════════════════════════════════════════════════════════════════

    phase = 'aggregating';
    await transitionStatus('aggregating', 'evaluation.started');

    const dimensions = await aggregateMetrics({
      runId,
      suite: input.suite,
      scope: input.evaluationScope,
      sliceBy: ['category', 'difficulty', 'tags'],
      // Pass slots inline. Each slot carries `deterministicMetrics`
      // (small numeric) — safe to round-trip through Temporal event
      // history; the activity does NOT need to re-read capture files
      // from PVC for the headline aggregation.
      slots: perCaseSlots,
    });

    const coverage = {
      total: totalTuples,
      completed: completedTuples,
    };
    const infraFailureRate =
      totalTuples === 0
        ? 0
        : recentFailures.filter((f) => f.errorType === 'infra').length /
          totalTuples;

    const { triggeredGates, verdict } = await computeGates({
      runId,
      dimensions,
      jobInput: input,
      preflightSummary,
      tradeoffDecision,
      coverage,
      infraFailureRate,
      judgeCoverage: computeJudgeCoverage(input, completedTuples),
      runStopped: cancelRequested,
    });

    results = buildResults({
      verdict,
      triggeredGates,
      dimensions,
      coverage,
      infraFailureRate,
      input,
      cancelRequested,
      preflightNonPromotable: isNonPromotable(
        preflightSummary,
        acceptedOverrides,
      ),
      tradeoffDecision,
    });

    // Resolve the effective baseline. Item 7: "compare to the previous run"
    // is the common default — when the template doesn't pin
    // `regression.baselineRunId` (and doesn't supply inline expectations),
    // we look up the most recent prior successful run for this template.
    // The pinned path stays exactly as before; the new fall-through fires
    // only when there is genuinely no pin and no expectations.
    const pinnedBaselineRunId = input.regression?.baselineJobId;
    const inlineExpectations = input.regression?.expectations;
    let effectiveBaselineRunId: string | undefined = pinnedBaselineRunId;
    if (
      !effectiveBaselineRunId &&
      (inlineExpectations?.length ?? 0) === 0 &&
      templateId
    ) {
      try {
        const prev = await findPreviousRun({
          projectId,
          templateId,
          currentRunId: runId,
        });
        if (prev.runId) {
          effectiveBaselineRunId = prev.runId;
          log.info('compare: defaulted baseline to previous run', {
            templateId,
            previousRunId: prev.runId,
          });
        }
      } catch (err) {
        // findPreviousRun failures are non-fatal — compare just doesn't
        // run. The activity itself maps 404 → NotFoundError; anything else
        // is an HTTP / config issue we shouldn't block the run on.
        log.warn('findPreviousRun failed — skipping default-baseline lookup', {
          templateId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const hasEffectiveBaseline =
      !!effectiveBaselineRunId || (inlineExpectations?.length ?? 0) > 0;
    if (hasEffectiveBaseline) {
      // Resolve the baseline run (if any) before delegating to the pure
      // compare activity. Capturing the fetch error here keeps the diff
      // activity I/O-free and lets consumers see why a baseline was
      // missing — distinct from "no metrics overlapped".
      let baselineDimensions: EvaluationDimension[] | undefined;
      let baselineFetchError: string | undefined;
      if (effectiveBaselineRunId) {
        try {
          const baselineJob = await getEvaluationJob({
            runId: effectiveBaselineRunId,
            projectId,
          });
          baselineDimensions = baselineJob.results?.dimensions;
        } catch (err) {
          baselineFetchError =
            err instanceof Error ? err.message : String(err);
          log.warn('compareToBaseline: baseline fetch failed', {
            baselineJobId: effectiveBaselineRunId,
            error: baselineFetchError,
          });
        }
      }
      results.baselineComparison = await compareToBaseline({
        runId,
        dimensions,
        ...(effectiveBaselineRunId && {
          baselineJobId: effectiveBaselineRunId,
        }),
        ...(baselineDimensions && { baselineDimensions }),
        ...(inlineExpectations && { expectations: inlineExpectations }),
        ...(baselineFetchError && { baselineFetchError }),
      });
    }

    if (tradeoffDecision?.acknowledged) {
      await recordTradeoffDecision({
        runId,
        projectId,
        decision: tradeoffDecision,
        actor: tradeoffDecision.by ?? 'system',
      });
    }

    // Sanity: parent must have accumulated a per-case slot for every
    // tuple that didn't bubble up an infra failure. If counts diverge the
    // run is unsafe to publish — fail loudly so the operator can re-shard.
    const expectedSlots = totalTuples - failedTuples;
    if (perCaseSlots.length < expectedSlots) {
      log.error('per-case slot count mismatch — refusing to publish', {
        runId,
        expected: expectedSlots,
        actual: perCaseSlots.length,
      });
      return finalize('failed', {
        reason: 'per_case_slot_count_mismatch',
        expected: expectedSlots,
        actual: perCaseSlots.length,
      });
    }

    await updateJobResults({ runId, projectId, results });

    // ═════════════════════════════════════════════════════════════════
    // Phase c — Write results.json + stakeholder PDF to artifact store
    // ═════════════════════════════════════════════════════════════════

    // Phase c writes results.json + stakeholder report to the PVC at the
    // path computed from (projectId, evalId, runId). The URIs are NOT
    // PATCHed onto the EvaluationRun row — readers reconstruct the path
    // via runDirKey() instead. Failures here are non-fatal; we still
    // finalize the run.
    const dumpedArtifacts = await dumpArtifacts(
      input,
      results,
      perCaseSlots,
    );

    // Phase c — rich compare report (item 7). Runs ONLY when a baseline
    // was resolved (pinned via template OR defaulted to previous run via
    // `findPreviousRun` above) AND `results.json` was written
    // successfully — `buildCompareReport` reads both runs' `results.json`
    // from PVC, composes the report, and merges it into the current
    // run's `results.json` as a top-level `compareReport` field. There
    // is NO separate `compare_report.json`. Failures are non-fatal —
    // the run already has its numeric `baselineComparison` headline on
    // the `EvaluationRun.results` row from Phase b.
    if (
      effectiveBaselineRunId &&
      dumpedArtifacts.resultsFileUri !== undefined
    ) {
      try {
        // Note: pairwise judge is intentionally NOT wired here — it's an
        // expensive opt-in (one LLM call per case per rubric) that the
        // A/B compare path can request via `input.ab.pairwiseRubrics`
        // when that field lands. Regression compare emits the
        // deterministic panel only (comparability + metric deltas +
        // slice deltas + tradeoff). If the template explicitly opts in
        // via `input.ab.pairwiseRubrics`, we forward it here.
        await buildCompareReport({
          projectId,
          runIdA: runId,
          runIdB: effectiveBaselineRunId,
          comparabilityChecks: input.ab?.comparabilityChecks ?? [],
          ...(input.ab?.acknowledgedIssues && {
            acknowledgedIssues: input.ab.acknowledgedIssues,
          }),
        });
      } catch (err) {
        log.warn('buildCompareReport failed — skipping rich compare report', {
          runId,
          baselineRunId: effectiveBaselineRunId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return await finalize(statusFromVerdict(verdict, cancelRequested), {
      verdict,
      resultsFileUri: dumpedArtifacts.resultsFileUri,
      stakeholderReportUri: dumpedArtifacts.stakeholderReportUri,
    });
  } catch (err) {
    if (isCancellation(err) || err instanceof CancelledFailure) {
      cancelRequested = true;
      return finalize('cancelled', { reason: 'hard_cancel' });
    }
    log.error('AgentEvaluationWorkflow encountered unexpected error', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return finalize('failed', {
      reason: 'unhandled_error',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── Inner helpers (closures over workflow state) ──────────────────

  function buildProgress(): EvaluationProgress {
    const pct = totalTuples === 0 ? 0 : (completedTuples / totalTuples) * 100;
    return {
      status: currentStatus,
      phase,
      totalCases: totalTuples,
      completedCases: completedTuples,
      failedCases: failedTuples,
      inFlightCases: inFlightTuples,
      percentage: Math.round(pct * 100) / 100,
      judgeCoverage: computeJudgeCoverage(input, completedTuples),
      recentFailures: recentFailures.slice(-10),
    };
  }

  async function transitionStatus(
    next: EvaluationJob['status'],
    auditAction:
      | 'evaluation.started'
      | 'evaluation.stopped'
      | 'evaluation.completed'
      | 'evaluation.failed',
  ): Promise<void> {
    currentStatus = next;
    await updateJobStatus({
      runId,
      projectId,
      status: next,
      auditContext: { actor: `workflow:${runSuffix}`, reason: auditAction },
    });
  }

  async function finalize(
    finalStatus: EvaluationJob['status'],
    details: Record<string, unknown>,
  ): Promise<EvaluationJob> {
    const transitionAction =
      finalStatus === 'success'
        ? 'evaluation.completed'
        : finalStatus === 'cancelled'
          ? 'evaluation.stopped'
          : 'evaluation.failed';
    try {
      await transitionStatus(finalStatus, transitionAction);
      await writeAuditEvent({
        id: `audit-${runId}-${runSuffix}`,
        ts: new Date().toISOString(),
        actor: `workflow:${runSuffix}`,
        runId,
        projectId,
        action: transitionAction,
        details,
      });
    } catch (auditErr) {
      log.error('Final-status persistence failed (swallowed)', {
        runId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }
    phase =
      finalStatus === 'success'
        ? 'completed'
        : finalStatus === 'cancelled'
          ? 'stopped'
          : 'failed';
    try {
      return await getEvaluationJob({ runId, projectId });
    } catch {
      return minimalJobShell(runId, projectId, input, finalStatus, results, preflightSummary);
    }
  }

  async function fanOutCases(
    tuples: CaseTuple[],
    jobInput: EvaluationJobInput,
  ): Promise<void> {
    const concurrency = resolveConcurrency(jobInput);
    const grace = DEFAULT_STOP_GRACE_SECONDS * 1000;

    await CancellationScope.cancellable(async () => {
      const outerScope = CancellationScope.current();
      let nextIdx = 0;
      const worker = async (): Promise<void> => {
        while (true) {
          if (cancelRequested) return;
          const idx = nextIdx++;
          if (idx >= tuples.length) return;
          const tuple = tuples[idx];

          inFlightTuples++;
          try {
            const summary = await runCase(
              buildPerCaseInput(
                tuple,
                jobInput,
                evalId,
                scorerToggles,
                judgeToggles.rubrics,
              ),
            );
            // Parent collects the small per-case slot in workflow memory
            // for Phase c serialization (no per-case write to
            // config-service). The full capture lives on PVC and is read
            // by `writeResultsFile`.
            perCaseSlots.push(summary.slot);
            if (summary.status === 'COMPLETED') {
              completedTuples++;
            } else {
              failedTuples++;
              recentFailures.push({
                caseId: summary.caseId,
                model: summary.model,
                errorType: summary.errorType,
              });
            }
          } catch (err) {
            if (isCancellation(err) || err instanceof CancelledFailure) {
              throw err;
            }
            failedTuples++;
            recentFailures.push({
              caseId: tuple.case.id,
              model: tuple.model,
              errorType: 'infra',
              message: err instanceof Error ? err.message : String(err),
            });
          } finally {
            inFlightTuples--;
          }
        }
      };

      const poolSize = Math.max(1, Math.min(concurrency, tuples.length));
      const workers = Array.from({ length: poolSize }, () => worker());

      // Cancel-watcher runs in its own child scope so it can be torn
      // down on the happy path without leaving `condition()` dangling.
      // On soft cancel it waits up to `grace`; if in-flight work
      // doesn't drain in time it cancels `outerScope`, which propagates
      // CancelledFailure into the pending runCase activities so they
      // actually stop (the old code only polled `cancelRequested` at
      // the top of each worker iteration — a runCase already in flight
      // would never see the cancel and the workflow would return while
      // activities kept running).
      const watcherScope = new CancellationScope({
        cancellable: true,
        parent: outerScope,
      });
      const watcher = watcherScope
        .run(async () => {
          await condition(() => cancelRequested);
          log.warn('soft cancel detected — waiting for drain', {
            inFlight: inFlightTuples,
          });
          const drained = await Promise.race([
            condition(() => inFlightTuples === 0).then(() => true),
            sleep(grace).then(() => false),
          ]);
          if (!drained && inFlightTuples > 0) {
            log.warn('drain grace expired — cancelling in-flight activities', {
              inFlight: inFlightTuples,
            });
            outerScope.cancel();
          }
        })
        .catch((err) => {
          if (isCancellation(err) || err instanceof CancelledFailure) return;
          throw err;
        });

      try {
        await Promise.all(workers);
      } finally {
        // Workers settled (happy path or cancel-induced) — tear down
        // the watcher so neither its `condition` nor its `sleep` leaks.
        watcherScope.cancel();
        await watcher;
      }
    });
  }
}

// ── Phase c helpers ─────────────────────────────────────────────────

interface DumpedArtifacts {
  resultsFileUri?: string;
  stakeholderReportUri?: string;
}

async function dumpArtifacts(
  input: EvaluationJobInput,
  results: EvaluationResults,
  perCaseSlots: CaseRunSlot[],
): Promise<DumpedArtifacts> {
  // Both calls are independent — fan out to halve wall-clock time. Failures on
  // either side are non-fatal so a flaky report renderer never blocks results
  // file publication.
  const [resultsRes, reportRes] = await Promise.all([
    writeResultsFile({
      runId: input.runId,
      projectId: input.projectId,
      ...(input.evalId !== undefined ? { evalId: input.evalId } : {}),
      ...(input.evalName !== undefined ? { evalName: input.evalName } : {}),
      results,
      perCaseSlots,
      provenance: input.provenance,
    }).catch((err) => {
      log.warn('writeResultsFile failed', {
        runId: input.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }),
    writeStakeholderReport({
      runId: input.runId,
      projectId: input.projectId,
      ...(input.evalId !== undefined ? { evalId: input.evalId } : {}),
      ...(input.evalName !== undefined ? { evalName: input.evalName } : {}),
      results,
    }).catch((err) => {
      log.warn('writeStakeholderReport failed', {
        runId: input.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }),
  ]);

  return {
    resultsFileUri: resultsRes?.resultsFileUri,
    stakeholderReportUri: reportRes?.reportUri,
  };
}

// ── Pure helpers (outside the workflow closure) ─────────────────────

interface CaseTuple {
  case: GoldenTestCase;
  model: string;
  variantId?: string;
  overrides: AgentRuntimeOverrides;
  seed?: number;
}

/**
 * Variant + overrides axis for in-workflow fan-out.
 *
 * Priority order:
 *   1. **Pre-fanned-out caller**: the caller set `input.variantId` /
 *      `input.variantOverrides`. We respect their single-slot choice and
 *      don't fan out further on this axis.
 *   2. **`ab_compare` template**: `input.ab.variants[]` populated and no
 *      pre-fan-out (in-workflow pattern per
 *      EVAL_BACKEND_TEMPORAL_TECH_SPEC.md §4.5.10).
 *   3. **No variants at all**: a single slot. Used by `single` / `regression`
 *      / `repeats` modes.
 */
function variantAxis(
  input: EvaluationJobInput,
): Array<{ variantId?: string; overrides: AgentRuntimeOverrides }> {
  // (1) caller pre-fanned-out
  if (input.variantId !== undefined) {
    return [
      {
        variantId: input.variantId,
        overrides: input.variantOverrides ?? {},
      },
    ];
  }
  // (2) ab_compare template with variants — in-workflow fan-out
  if (input.ab?.variants && input.ab.variants.length > 0) {
    return input.ab.variants.map((v) => ({
      variantId: v.variantId,
      overrides: v.overrides ?? {},
    }));
  }
  // (3) no variants
  return [{ variantId: undefined, overrides: {} }];
}

function shard(
  cases: GoldenTestCase[],
  input: EvaluationJobInput,
): CaseTuple[] {
  const variants = variantAxis(input);
  const repeatSeeds =
    input.repeats?.seeds ??
    (input.repeats?.count
      ? Array.from({ length: input.repeats.count }, (_, i) => i)
      : undefined);

  // Per-case fan-out is `cases × variants` only. The agent ALWAYS runs
  // against its own configured model — the workflow does NOT override
  // it from the template.
  //
  // NOTE on `templateSnapshot.models[]`:
  //   This field is intentionally NOT wired into the agent fan-out
  //   today. It is reserved for a future "tuning" feature that will
  //   sweep the same case set across multiple candidate models for
  //   comparison (think hyper-parameter / model selection runs).
  //   Until that feature lands, the field is accepted on the wire but
  //   has no effect. Do NOT re-introduce a `for (const model of
  //   input.models)` loop here without the corresponding tuning
  //   composition driver — doing so silently changes the agent's
  //   model and breaks runs whose authors expected the agent's
  //   configured model.
  //
  // `CaseTuple.model` / `CaseRef.model` are kept as empty strings so
  // the existing telemetry shape (typed `string`) is preserved; no
  // `model` key is added to the overrides bag.
  const tuples: CaseTuple[] = [];
  for (const c of cases) {
    for (const variant of variants) {
      const mergedOverrides: AgentRuntimeOverrides = { ...variant.overrides };
      if (repeatSeeds) {
        for (const seed of repeatSeeds) {
          tuples.push({
            case: c,
            model: '',
            variantId: variant.variantId,
            overrides: mergedOverrides,
            seed,
          });
        }
      } else {
        tuples.push({
          case: c,
          model: '',
          variantId: variant.variantId,
          overrides: mergedOverrides,
        });
      }
    }
  }
  return tuples;
}

function buildPerCaseInput(
  tuple: CaseTuple,
  jobInput: EvaluationJobInput,
  evalId: string,
  scorerToggles: ResolvedScorerToggles,
  judgeRubricIds: string[],
): RunCaseInput {
  return {
    runId: jobInput.runId,
    projectId: jobInput.projectId,
    evalId,
    agentTeam: jobInput.agentTeam,
    ...(jobInput.agentId !== undefined ? { agentId: jobInput.agentId } : {}),
    case: tuple.case,
    overrides: tuple.overrides,
    ...(tuple.variantId !== undefined ? { variantId: tuple.variantId } : {}),
    model: tuple.model,
    ...(tuple.seed !== undefined ? { seed: tuple.seed } : {}),
    envelopeHash: jobInput.provenance.envelopeHash,
    jobInput,
    // For 'sample' judgeSamplingMode the activity layer computes the
    // actual sampling plan; we forward every resolved rubric id and let
    // it decide which to execute on a given case.
    judgeRubricIds,
    scorerToggles,
  };
}

function resolveConcurrency(input: EvaluationJobInput): number {
  return input.concurrency ?? DEFAULT_EVAL_CONCURRENCY;
}

function isBlocked(p: PreflightSummary): boolean {
  return p.summary === 'blocked';
}

function collectUnmatchedWarnings(
  p: PreflightSummary,
  accepted: Set<PreflightOverrideIntent>,
): string[] {
  const unmatched: string[] = [];
  for (const c of p.checks) {
    if (c.status !== 'warning') continue;
    const actions = c.warningActions ?? [];
    if (actions.length === 0) {
      unmatched.push(c.id);
      continue;
    }
    const satisfied = actions.some((a) => accepted.has(a.intent));
    if (!satisfied) unmatched.push(c.id);
  }
  return unmatched;
}

function isNonPromotable(
  p: PreflightSummary | undefined,
  accepted: Set<PreflightOverrideIntent>,
): boolean {
  if (!p) return false;
  return (
    p.summary === 'warnings' &&
    (accepted.has('continue_non_promotable') ||
      p.checks.some(
        (c) => c.status === 'warning' && c.impact === 'promotion_blocked',
      ))
  );
}

function computeJudgeCoverage(
  input: EvaluationJobInput,
  completed: number,
): { scored: number; target: number; pct: number } {
  // When the high-level strategy disables LLM-as-judge entirely, no
  // judge metrics are produced — coverage is trivially zero regardless of
  // the rubric list. Resolving the toggles here keeps this calculation
  // consistent with what the children actually emit.
  const { rubrics } = resolveJudgeToggles(input.evaluators);
  const perCase = rubrics.length;
  const target =
    input.evaluators.judgeSamplingMode === 'sample'
      ? (input.evaluators.judgeSampleSize ?? 0) * perCase
      : completed * perCase;
  const scored = completed * perCase;
  const pct = target === 0 ? 0 : Math.min(100, (scored / target) * 100);
  return { scored, target, pct: Math.round(pct * 100) / 100 };
}

function buildResults(args: {
  verdict: Verdict;
  triggeredGates: TriggeredGate[];
  dimensions: EvaluationResults['dimensions'];
  coverage: { total: number; completed: number };
  infraFailureRate: number;
  input: EvaluationJobInput;
  cancelRequested: boolean;
  preflightNonPromotable: boolean;
  tradeoffDecision?: TradeoffDecision;
}): EvaluationResults {
  const { coverage, input } = args;
  const pct =
    coverage.total === 0 ? 0 : (coverage.completed / coverage.total) * 100;
  // `qualityPct` is config-service's baseline-ranking signal — fraction of
  // cases that ran cleanly. Without it `setBaseline`'s sibling ranking
  // always falls through to 'not_set'.
  const completedFraction =
    coverage.total === 0 ? 0 : coverage.completed / coverage.total;
  const infraSurvival = Math.max(0, Math.min(1, 1 - args.infraFailureRate));
  const qualityPct =
    Math.round(
      Math.max(0, Math.min(100, 100 * completedFraction * infraSurvival)) * 100,
    ) / 100;
  return {
    verdict: args.verdict,
    triggeredGates: args.triggeredGates,
    dimensions: args.dimensions,
    coverage: {
      total: coverage.total,
      completed: coverage.completed,
      completedPct: Math.round(pct * 100) / 100,
    },
    infraFailureRate: args.infraFailureRate,
    judgeCoverage: computeJudgeCoverage(input, coverage.completed),
    preFlightNonPromotable: args.preflightNonPromotable,
    runStopped: args.cancelRequested,
    tradeoffDecision: args.tradeoffDecision,
    qualityPct,
  };
}

function statusFromVerdict(
  v: Verdict,
  cancelRequested: boolean,
): EvaluationJob['status'] {
  if (cancelRequested) return 'cancelled';
  if (v === 'blocked' || v === 'fail') return 'failed';
  return 'success';
}

function minimalJobShell(
  runId: string,
  projectId: string,
  input: EvaluationJobInput | undefined,
  status: EvaluationJob['status'],
  results: EvaluationResults | undefined,
  preflight: PreflightSummary | undefined,
): EvaluationJob {
  const now = new Date().toISOString();
  return {
    runId,
    status,
    // When loadRunSnapshot failed before `input` was populated, the
    // persisted row in config-service remains the source of truth — this
    // placeholder only keeps the workflow's return value type-valid for
    // the audit sink. `runId` and `projectId` are workflow arguments and
    // always defined.
    input: input ?? ({ runId, projectId } as EvaluationJobInput),
    preFlight: preflight,
    results,
    audit: [],
    createdAt: now,
    updatedAt: now,
  };
}
