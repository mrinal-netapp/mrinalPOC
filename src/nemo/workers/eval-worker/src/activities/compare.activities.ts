// Compare-report activity. The report is folded into the current run's
// `results.json` rather than written as a separate file.
//
// Phase c of `AgentEvaluationWorkflow` calls `buildCompareReport` AFTER
// `writeResultsFile` has staged the current run's `results.json` on the PVC.
// Both runs' `results.json` files exist at this point (the baseline's was
// written by its own prior run; the current run's by `writeResultsFile`
// moments earlier). The activity:
//
//   1. Reads BOTH `results.json` files from PVC.
//   2. Composes comparability issues + metric comparisons + slice deltas +
//      tradeoff panel + (optional) pairwise judge rounds into a single
//      `CompareReport`.
//   3. Merges the report back into `<currentRun>/results.json` as a top-level
//      `compareReport` field — there is NO separate `compare_report.json`
//      and NO `compares/{idA}_vs_{idB}/` directory. The compare data is
//      part of the same on-disk artifact as the rest of the run output, so
//      the GUI fetches one file to render headlines + per-case rows + diff
//      against the prior run.
//
// The activity is owned by the eval workflow — `config-service` does NOT
// invoke it directly (it can't call worker activities anyway).

import { ApplicationFailure, heartbeat } from '@temporalio/activity';
import { getServiceAccountToken } from '../lib/auth';
import { gotGet } from '../lib/got';
import { getLogger } from '../lib/logger';
import {
  posixUri,
  readObject,
  runDirKey,
  slugify,
  writeObject,
} from '../lib/posix-store';
import type {
  CaseRunArtifact,
  ComparabilityIssue,
  EvaluationJob,
  EvaluationResults,
  JudgeRubricOutput,
  MetricComparison,
  ProvenanceEnvelope,
  SliceDelta,
  TradeoffView,
} from '../lib/evaluation';
import {
  buildTradeoffPanel,
  computeMetricComparisons,
  computeSliceDeltas,
  enforceComparability,
} from './scoring.activities';
import { invokePairwiseJudge } from './judge.activities';

const logger = getLogger('server');

function configServiceUrl(): string {
  const url = process.env['CONFIG_SERVICE_URL'];
  if (!url) {
    throw ApplicationFailure.nonRetryable(
      'CONFIG_SERVICE_URL is not configured',
      'InvalidInputError',
    );
  }
  return url;
}

interface ResultsFileBody {
  runId: string;
  generatedAt?: string;
  results: EvaluationResults;
  perCaseArtifacts: CaseRunArtifact[];
  provenance: ProvenanceEnvelope;
  /**
   * Optional `CompareReport` produced by `buildCompareReport`. Populated
   * for the *current* run's body when compare ran (item 7 — compare folds
   * into results.json instead of a separate file). Older runs written
   * before this change do not have the field.
   */
  compareReport?: CompareReport;
}

export interface BuildCompareReportInput {
  /**
   * Project that owns both runs. The current run and the baseline are
   * always in the same project for regression compare; threaded through
   * so `fetchJob` can hit the project-scoped config-service route.
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
  /** When non-empty, runs pairwise judge per case per rubric. */
  pairwiseRubrics?: string[];
  evaluatorModel?: string;
  evaluatorVersion?: string;
}

export interface CompareReport {
  runIdA: string;
  runIdB: string;
  comparabilityIssues: ComparabilityIssue[];
  metricComparisons: MetricComparison[];
  sliceDeltas: SliceDelta[];
  tradeoff: TradeoffView;
  pairwise?: {
    perCase: Array<{ caseId: string; rubrics: JudgeRubricOutput[] }>;
    aggregate: {
      winsA: number;
      winsB: number;
      ties: number;
      errored: number;
    };
  };
}

/**
 * Output of `buildCompareReport`. The report itself is merged into
 * `<runIdA>/results.json` as a top-level `compareReport` field by this
 * activity — callers don't need a URI, just the bookkeeping fields below
 * for observability.
 */
export interface BuildCompareReportOutput {
  /** Number of metric comparisons emitted. */
  metricCount: number;
  /** Number of slice deltas emitted. */
  sliceCount: number;
  /** True when pairwise judging ran (a `pairwiseRubrics` set was supplied). */
  pairwiseRan: boolean;
  /** Echoed for logs/audit; mirrors `compareReport.{runIdA,runIdB}` on disk. */
  runIdA: string;
  runIdB: string;
}

export async function buildCompareReport(
  input: BuildCompareReportInput,
): Promise<BuildCompareReportOutput> {
  heartbeat({ phase: 'load-jobs' });
  const [jobA, jobB] = await Promise.all([
    fetchJob(input.projectId, input.runIdA),
    fetchJob(input.projectId, input.runIdB),
  ]);

  heartbeat({ phase: 'load-results-files' });
  const [bodyA, bodyB] = await Promise.all([
    fetchResultsFile(jobA),
    fetchResultsFile(jobB),
  ]);

  // 1. Comparability — synthesise pseudo-variant specs from the two job inputs.
  // `AgentRuntimeOverrides` doesn't carry a string index signature so cast to
  // the looser `Record<string, unknown>` shape `enforceComparability` accepts.
  const comparabilityIssues = await enforceComparability({
    variants: [
      {
        overrides: (jobA.input.variantOverrides ?? {}) as Record<
          string,
          unknown
        >,
      },
      {
        overrides: (jobB.input.variantOverrides ?? {}) as Record<
          string,
          unknown
        >,
      },
    ],
    comparabilityChecks: input.comparabilityChecks,
    acknowledgedIssues: input.acknowledgedIssues ?? [],
    envelopes: [bodyA.provenance, bodyB.provenance],
  });

  heartbeat({ phase: 'compute-comparisons' });

  // 2. Metric comparisons + slice deltas + tradeoff panel.
  const [metricComparisons, sliceDeltas, tradeoff] = await Promise.all([
    computeMetricComparisons({
      dimensionsA: bodyA.results.dimensions,
      dimensionsB: bodyB.results.dimensions,
    }),
    computeSliceDeltas({
      artifactsA: bodyA.perCaseArtifacts,
      artifactsB: bodyB.perCaseArtifacts,
      sliceBy: ['category', 'difficulty', 'tags'],
    }),
    buildTradeoffPanel({ resultsArray: [bodyA.results, bodyB.results] }),
  ]);

  // 3. Optional pairwise judge — pair responses by caseId.
  let pairwise: CompareReport['pairwise'] | undefined;
  if (input.pairwiseRubrics && input.pairwiseRubrics.length > 0) {
    heartbeat({ phase: 'pairwise-judge' });
    const evalIdA = jobA.input.evalId ?? slugify(jobA.input.evalName ?? '');
    const evalIdB = jobB.input.evalId ?? slugify(jobB.input.evalName ?? '');
    pairwise = await runPairwiseJudges({
      perCaseArtifactsA: bodyA.perCaseArtifacts,
      perCaseArtifactsB: bodyB.perCaseArtifacts,
      rubricIds: input.pairwiseRubrics,
      evaluatorModel: input.evaluatorModel ?? '',
      evaluatorVersion: input.evaluatorVersion ?? '',
      projectIdA: jobA.input.projectId,
      evalIdA,
      projectIdB: jobB.input.projectId,
      evalIdB,
    });
  }

  const report: CompareReport = {
    runIdA: input.runIdA,
    runIdB: input.runIdB,
    comparabilityIssues,
    metricComparisons,
    sliceDeltas,
    tradeoff,
    ...(pairwise !== undefined && { pairwise }),
  };

  heartbeat({ phase: 'merge-results' });
  // Merge the report into <runIdA>/results.json. We re-read the body we
  // just fetched + parsed (`bodyA`) and write the same body back with
  // `compareReport` set. Idempotent on retry.
  await mergeCompareIntoResultsFile(jobA, bodyA, report);

  return {
    runIdA: input.runIdA,
    runIdB: input.runIdB,
    metricCount: metricComparisons.length,
    sliceCount: sliceDeltas.length,
    pairwiseRan: pairwise !== undefined,
  };
}

// ── Internals ──────────────────────────────────────────────────────

async function fetchJob(
  projectId: string,
  runId: string,
): Promise<EvaluationJob> {
  // Project-scoped route, matching the rest of config-service.activities.ts.
  // The previous `${base}/evaluations/${runId}` form never existed on
  // config-service and silently 404'd on every compare.
  const base = configServiceUrl();
  const token = await getServiceAccountToken();
  const headers: Record<string, string> | undefined = token
    ? { authorization: `Bearer ${token}` }
    : undefined;
  const job = await gotGet<EvaluationJob>(
    `${base}/api/v1/projects/${encodeURIComponent(projectId)}/evaluation/agents/runs/${encodeURIComponent(runId)}`,
    headers ? { headers } : undefined,
  );
  if (!job) {
    throw ApplicationFailure.nonRetryable(
      `evaluation ${runId} not found`,
      'NotFoundError',
    );
  }
  return job;
}

/**
 * The results file lives at the deterministic path
 *   `projects/{projectId}/evaluations/{evalId}/runs/{runId}/results.json`
 * on the artifact store. The path is recomputed from the EvaluationJob
 * row each time — config-service does NOT carry the URI on the row.
 */
async function fetchResultsFile(job: EvaluationJob): Promise<ResultsFileBody> {
  const key = resultsFileKey(job);
  const uri = posixUri(key);
  try {
    const text = await readObject(key);
    return JSON.parse(text) as ResultsFileBody;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      throw ApplicationFailure.nonRetryable(
        `results.json at ${uri} not found`,
        'NotFoundError',
      );
    }
    logger.error(
      `fetchResultsFile failed for ${job.runId} (${uri}): ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function resultsFileKey(job: EvaluationJob): string {
  const evalId = job.input.evalId ?? slugify(job.input.evalName ?? '');
  return `${runDirKey({
    projectId: job.input.projectId,
    evalId,
    runId: job.runId,
  })}/results.json`;
}

/**
 * Merge the composed `CompareReport` into `<runIdA>/results.json` as a
 * top-level `compareReport` field. Item 7: compare data folds into the
 * run's own `results.json` instead of producing a separate
 * `compare_report.json` under a cross-cutting `compares/` directory.
 *
 * Idempotent on retry — overwrites the same key with the same body shape.
 * Maps filesystem permission/space errors to non-retryable
 * `PosixWriteError` so Temporal doesn't burn retries on a misconfigured
 * mount.
 */
async function mergeCompareIntoResultsFile(
  jobA: EvaluationJob,
  bodyA: ResultsFileBody,
  report: CompareReport,
): Promise<void> {
  const key = resultsFileKey(jobA);
  const merged: ResultsFileBody = {
    ...bodyA,
    compareReport: report,
  };
  const body = JSON.stringify(merged, null, 2);
  try {
    await writeObject(key, body);
  } catch (err) {
    logger.error(
      `mergeCompareIntoResultsFile failed (${posixUri(key)}): ${err instanceof Error ? err.message : String(err)}`,
    );
    const code = (err as { code?: string }).code;
    if (code && ['EACCES', 'EPERM', 'ENOSPC', 'ENOTDIR'].includes(code)) {
      throw ApplicationFailure.nonRetryable(
        `POSIX write failed (${code}) at ${key}: ${err instanceof Error ? err.message : String(err)}`,
        'PosixWriteError',
      );
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

async function runPairwiseJudges(args: {
  perCaseArtifactsA: CaseRunArtifact[];
  perCaseArtifactsB: CaseRunArtifact[];
  rubricIds: string[];
  evaluatorModel: string;
  evaluatorVersion: string;
  /**
   * Identity tuple sources for synthesising a per-pair `CaseRef` to pass
   * to the path-only `invokePairwiseJudge`. The artifact rows in
   * results.json carry only `caseId/runId/model` so projectId+evalId have
   * to be threaded in by the caller from the parent EvaluationJob.
   */
  projectIdA: string;
  evalIdA: string;
  projectIdB: string;
  evalIdB: string;
}): Promise<NonNullable<CompareReport['pairwise']>> {
  const bById = new Map(args.perCaseArtifactsB.map((a) => [a.caseId, a]));
  const pairs: Array<{
    caseId: string;
    a: CaseRunArtifact;
    b: CaseRunArtifact;
  }> = [];
  for (const a of args.perCaseArtifactsA) {
    const b = bById.get(a.caseId);
    if (!b) continue;
    // Every COMPLETED row carries a `capturePath`. Skip the pair if
    // either side never wrote a capture (e.g. an infra failure during
    // invokeAgent) — there's no way to judge without the response
    // payload on PVC.
    if (!a.capturePath || !b.capturePath) continue;
    pairs.push({ caseId: a.caseId, a, b });
  }

  const perCase = await Promise.all(
    pairs.map(async (p) => {
      const rubrics: JudgeRubricOutput[] = await Promise.all(
        args.rubricIds.map(async (rubricId): Promise<JudgeRubricOutput> => {
          try {
            return await invokePairwiseJudge({
              caseRef: {
                projectId: args.projectIdA,
                evalId: args.evalIdA,
                runId: p.a.runId,
                caseId: p.caseId,
                model: p.a.model,
                ...(p.a.variantId !== undefined
                  ? { variantId: p.a.variantId }
                  : {}),
                ...(p.a.repeatSeed !== undefined
                  ? { seed: p.a.repeatSeed }
                  : {}),
              },
              capturePathA: p.a.capturePath ?? '',
              capturePathB: p.b.capturePath ?? '',
              rubricId,
              evaluatorModel: args.evaluatorModel,
              evaluatorVersion: args.evaluatorVersion,
              case: { id: p.caseId } as never,
            });
          } catch (err) {
            return {
              rubricId,
              judgeModelName: args.evaluatorModel,
              judgeVersion: args.evaluatorVersion,
              rubricPromptHash: rubricId,
              mode: 'pairwise',
              errored: true,
              rationale: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );
      return { caseId: p.caseId, rubrics };
    }),
  );

  const aggregate = perCase.reduce(
    (acc, c) => {
      for (const r of c.rubrics) {
        if (r.errored) acc.errored++;
        else if (r.winner === 'A') acc.winsA++;
        else if (r.winner === 'B') acc.winsB++;
        else if (r.winner === 'tie') acc.ties++;
      }
      return acc;
    },
    { winsA: 0, winsB: 0, ties: 0, errored: 0 },
  );

  return { perCase, aggregate };
}
