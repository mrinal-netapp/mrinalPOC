// Persistence + read-back activities (spec §7.1, §7.4). All I/O goes through
// config-service over HTTP (§8.2 endpoint list). Retries are handled by the
// workflow's activity retry policy; this file focuses on shaping requests and
// mapping 4xx/5xx to the right ApplicationFailure types.

import { ApplicationFailure } from '@temporalio/activity';
import {
  gotGet,
  gotPatch,
  gotPost,
  isHTTPError,
} from '../lib/got';
import { getAuthHeaders } from '../lib/auth';
import { getLogger } from '../lib/logger';
import {
  inputDirKey,
  posixUri,
  slugify,
  writeObject,
} from '../lib/posix-store';
import { resolveTemplateRuntime } from '../lib/evaluation/lib/resolve-template';
import type {
  AuditAction,
  AuditEvent,
  CaseRunArtifact,
  EvaluationJob,
  EvaluationJobInput,
  EvaluationResults,
  EvaluationStatus,
  EvaluationTemplate,
  FindPreviousRunInput,
  FindPreviousRunOutput,
  LoadRunSnapshotInput,
  LoadRunSnapshotOutput,
  MinimalProvenance,
  PromoteToRegressionInput,
  ResolvedWorkflowSnapshot,
  RunOptions,
  UpdateJobStatusInput,
} from '../lib/evaluation';
const logger = getLogger('server');

function configServiceUrl(): string {
  const url = process.env['CONFIG_SERVICE_URL'];
  if (!url) {
    throw ApplicationFailure.nonRetryable(
      'CONFIG_SERVICE_URL is not configured',
      'InvalidInputError',
    );
  }
  return url.replace(/\/$/, '');
}

/**
 * Project-scoped run URL. Matches the routes mounted by config-service at
 * `app.use('/api/v1/projects/:projectId/evaluation/agents', evaluationAgentRoutes)`
 * (config-service/index.ts) — every persistence call from the worker
 * targets this prefix.
 */
function runUrl(projectId: string, runId: string): string {
  return `${configServiceUrl()}/api/v1/projects/${encodeURIComponent(
    projectId,
  )}/evaluation/agents/runs/${encodeURIComponent(runId)}`;
}

function notImplemented(activity: string, plannedRoute: string): never {
  throw ApplicationFailure.nonRetryable(
    `${activity}: not implemented — config-service does not expose ${plannedRoute} yet`,
    'NotImplemented',
  );
}

function mapHttpError(err: unknown, op: string): never {
  if (isHTTPError(err as Error)) {
    const status = (err as { response?: { statusCode?: number } }).response
      ?.statusCode;
    if (status === 404) {
      throw ApplicationFailure.nonRetryable(
        `${op}: not found`,
        'NotFoundError',
      );
    }
    if (status && status >= 400 && status < 500) {
      throw ApplicationFailure.nonRetryable(
        `${op}: ${(err as Error).message}`,
        'InvalidInputError',
      );
    }
  }
  throw err instanceof Error ? err : new Error(String(err));
}

// ── Run snapshot (§7.1) ─────────────────────────────────────────────

/**
 * Workflow entrypoint activity. Reads the persisted EvaluationRun row from
 * config-service (`GET /api/v1/projects/{projectId}/evaluation/agents/runs/{runId}`),
 * stages the immutable template snapshot into the job folder under
 * `<runDir>/_input/` (manifest.json + template-snapshot.json), and resolves
 * it into the `EvaluationJobInput` the workflow body consumes. Test cases
 * are NOT staged here — the next workflow activity (`validateTestCases`)
 * reads the eval-owned JSONL from the PVC and writes the
 * `_input/cases.jsonl` audit copy. Replays reuse the recorded activity
 * result, so a later PATCH against the live template cannot mutate the
 * in-flight workflow's view of the run.
 */
export async function loadRunSnapshot(
  input: LoadRunSnapshotInput,
): Promise<LoadRunSnapshotOutput> {
  try {
    const headers = await getAuthHeaders();
    const row = await gotGet<RunSnapshotRow>(
      runUrl(input.projectId, input.runId),
      { headers },
    );
    if (!row) {
      throw ApplicationFailure.nonRetryable(
        `loadRunSnapshot(${input.runId}): null response`,
        'NotFoundError',
      );
    }
    const snapshot = toResolvedSnapshot(input.runId, row);
    return await stageAndResolve(input, snapshot);
  } catch (err) {
    if (err instanceof ApplicationFailure) throw err;
    return mapHttpError(err, `loadRunSnapshot(${input.runId})`);
  }
}

interface RunSnapshotRow {
  runId: string;
  templateSnapshot?: EvaluationTemplate;
  provenance?: MinimalProvenance;
  trigger?: { actor: string; reason?: string; triggeredAt: string };
  overrides?: RunOptions['overrides'];
}

function toResolvedSnapshot(
  runId: string,
  row: RunSnapshotRow,
): ResolvedWorkflowSnapshot {
  if (!row.templateSnapshot) {
    throw ApplicationFailure.nonRetryable(
      `loadRunSnapshot(${runId}): row missing templateSnapshot`,
      'InvalidInputError',
    );
  }
  if (!row.provenance) {
    throw ApplicationFailure.nonRetryable(
      `loadRunSnapshot(${runId}): row missing provenance`,
      'InvalidInputError',
    );
  }
  return {
    runId,
    templateSnapshot: row.templateSnapshot,
    provenance: row.provenance,
    overrides: row.overrides,
  };
}

async function stageAndResolve(
  input: LoadRunSnapshotInput,
  snapshot: ResolvedWorkflowSnapshot,
): Promise<LoadRunSnapshotOutput> {
  const resolved = resolveTemplateRuntime(snapshot);
  const evalId = resolved.evalId
    ? resolved.evalId
    : resolved.evalName
      ? slugify(resolved.evalName)
      : slugify(snapshot.templateSnapshot.templateId);
  // Stamp the resolved evalId back onto the jobInput so downstream
  // activities (writeResultsFile, writeStakeholderReport) derive the same
  // <runDir> path as the staged input folder.
  const jobInput: EvaluationJobInput = { ...resolved, evalId };
  const dir = inputDirKey({
    projectId: input.projectId,
    evalId,
    runId: input.runId,
  });

  // Stage the immutable template snapshot under `<runDir>/_input/`.
  // Cases are NOT staged here — the workflow's next activity
  // (`validateTestCases`) writes the JSONL audit copy alongside.
  await writeObject(
    `${dir}/manifest.json`,
    JSON.stringify(
      {
        runId: input.runId,
        projectId: input.projectId,
        triggeredAt: snapshot.provenance.triggeredAt,
        stagedAt: new Date().toISOString(),
        evalId,
        templateId: snapshot.templateSnapshot.templateId,
        testCasesFilename: snapshot.templateSnapshot.cases?.filename,
        overrides: snapshot.overrides,
      },
      null,
      2,
    ),
  );
  await writeObject(
    `${dir}/template-snapshot.json`,
    JSON.stringify(snapshot.templateSnapshot, null, 2),
  );

  // Surface the test-cases pointer (filename only) from the template;
  // the workflow forwards it to `validateTestCases`. The full PVC path
  // is computed by the activity from `(projectId, evalId, filename)` —
  // there is no datasetId indirection.
  const testCasesRef: LoadRunSnapshotOutput['testCasesRef'] = {
    ...(snapshot.templateSnapshot.cases?.filename !== undefined && {
      filename: snapshot.templateSnapshot.cases.filename,
    }),
  };

  return {
    jobInput,
    jobFolderUri: posixUri(dir),
    evalId,
    templateId: snapshot.templateSnapshot.templateId,
    testCasesRef,
  };
}

export async function loadFailedCaseIds(input: {
  runId: string;
  projectId: string;
  errorType: 'quality' | 'infra';
}): Promise<string[]> {
  notImplemented(
    `loadFailedCaseIds(${input.runId})`,
    `GET /api/v1/projects/${input.projectId}/evaluation/agents/runs/${input.runId}/case-runs?errorType=… (not yet exposed)`,
  );
}

// ── Job status / results (§7.4) ─────────────────────────────────────

/**
 * Map a run status to a canonical {@link AuditAction}. The previous
 * `evaluation.${status}` interpolation emitted values like
 * `evaluation.success` / `evaluation.aggregating` that are not in the
 * enum, so audit consumers filtering on the enum silently dropped every
 * transition event. Transitional statuses all share `evaluation.started`;
 * terminal statuses get their canonical action.
 */
function statusToAuditAction(status: EvaluationStatus): AuditAction {
  switch (status) {
    case 'success':
      return 'evaluation.completed';
    case 'failed':
      return 'evaluation.failed';
    case 'cancelled':
      return 'evaluation.stopped';
    case 'queued':
    case 'running':
    case 'aggregating':
      return 'evaluation.started';
  }
}

export async function updateJobStatus(
  input: UpdateJobStatusInput,
): Promise<void> {
  try {
    const headers = await getAuthHeaders();
    await gotPatch(
      runUrl(input.projectId, input.runId),
      {
        status: input.status,
        auditAppend: [
          {
            actor: input.auditContext.actor,
            type: statusToAuditAction(input.status as EvaluationStatus),
            message: input.auditContext.reason,
            data: {
              ...input.auditContext.details,
              // Preserve the specific transitional status (queued/running/
              // aggregating) on the audit event since all three collapse
              // to `evaluation.started` at the enum level.
              transitionTo: input.status,
            },
          },
        ],
      },
      { headers },
    );
  } catch (err) {
    return mapHttpError(err, `updateJobStatus(${input.runId})`);
  }
}

export async function updateJobResults(input: {
  runId: string;
  projectId: string;
  results: EvaluationResults;
}): Promise<void> {
  try {
    const headers = await getAuthHeaders();
    await gotPatch(
      runUrl(input.projectId, input.runId),
      { results: input.results },
      { headers },
    );
  } catch (err) {
    return mapHttpError(err, `updateJobResults(${input.runId})`);
  }
}

export async function recordTradeoffDecision(input: {
  runId: string;
  projectId: string;
  decision: EvaluationResults['tradeoffDecision'];
  actor: string;
}): Promise<void> {
  notImplemented(
    `recordTradeoffDecision(${input.runId})`,
    `POST /api/v1/projects/${input.projectId}/evaluation/agents/runs/${input.runId}/tradeoff-decision (not yet exposed)`,
  );
}

// ── Reads (§7.4, §7.8) ──────────────────────────────────────────────

export async function getEvaluationJob(input: {
  runId: string;
  projectId: string;
}): Promise<EvaluationJob> {
  try {
    const headers = await getAuthHeaders();
    const data = await gotGet<EvaluationJob>(
      runUrl(input.projectId, input.runId),
      { headers },
    );
    if (!data) {
      throw ApplicationFailure.nonRetryable(
        `evaluation ${input.runId} not found`,
        'NotFoundError',
      );
    }
    return data;
  } catch (err) {
    if (err instanceof ApplicationFailure) throw err;
    return mapHttpError(err, `getEvaluationJob(${input.runId})`);
  }
}

/**
 * Resolve the most recent prior successful run for `(projectId, templateId)`.
 * The eval workflow calls this in Phase b when no baseline is pinned, so
 * compare defaults to "vs. the previous run for this template" (item 7).
 *
 * Implementation: list runs filtered by template + `status=success`,
 * ordered newest-first via the existing `GET /projects/{p}/evaluation/agents/runs`
 * route — `evaluationAgentRoutes.ts` orders by `createdAt DESC`. We ask for
 * a small page (3) so a same-second tie around the current run can't crowd
 * out the actual prior. Excluding `currentRunId` is done client-side here
 * because the list endpoint doesn't support an `excludeRunId` query yet.
 *
 * Note: the persisted run status is `success`, not `completed` — the doc
 * uses `completed` colloquially but the column enum (and the value the
 * workflow's `finalize` writes) is `success`. Filtering on `completed`
 * silently returned zero rows for every project.
 *
 * Returns `runId: null` (not an error) when there's no prior successful run
 * — the workflow then silently skips compare. Real I/O failures map to
 * `NotFoundError` / `InvalidInputError` via `mapHttpError` so Temporal
 * doesn't retry forever on misconfiguration.
 */
export async function findPreviousRun(
  input: FindPreviousRunInput,
): Promise<FindPreviousRunOutput> {
  if (!input.templateId) {
    throw ApplicationFailure.nonRetryable(
      'findPreviousRun: templateId is required',
      'InvalidInputError',
    );
  }
  try {
    const headers = await getAuthHeaders();
    const url =
      `${configServiceUrl()}/api/v1/projects/${encodeURIComponent(input.projectId)}/evaluation/agents/runs` +
      `?templateId=${encodeURIComponent(input.templateId)}` +
      `&status=success&limit=3`;
    const rows = await gotGet<Array<{ runId: string }>>(url, { headers });
    if (!rows || rows.length === 0) return { runId: null };
    for (const row of rows) {
      if (row && row.runId && row.runId !== input.currentRunId) {
        return { runId: row.runId };
      }
    }
    return { runId: null };
  } catch (err) {
    if (err instanceof ApplicationFailure) throw err;
    return mapHttpError(err, `findPreviousRun(${input.templateId})`);
  }
}

export async function loadEvaluationResults(input: {
  runIds: string[];
  projectId: string;
}): Promise<EvaluationResults[]> {
  if (input.runIds.length === 0) return [];
  const headers = await getAuthHeaders();
  const jobs = await Promise.all(
    input.runIds.map(async (id): Promise<EvaluationResults | undefined> => {
      try {
        const job = await gotGet<EvaluationJob>(runUrl(input.projectId, id), {
          headers,
        });
        return job?.results;
      } catch (err) {
        logger.warn(
          `loadEvaluationResults: failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
    }),
  );
  return jobs.filter((r): r is EvaluationResults => r !== undefined);
}

export async function loadCaseArtifacts(input: {
  runId: string;
  projectId: string;
}): Promise<CaseRunArtifact[]> {
  notImplemented(
    `loadCaseArtifacts(${input.runId})`,
    `GET /api/v1/projects/${input.projectId}/evaluation/agents/runs/${input.runId}/case-runs (not yet exposed)`,
  );
}

// ── Audit (§7.4) ────────────────────────────────────────────────────

export async function writeAuditEvent(
  event: AuditEvent & { projectId: string },
): Promise<void> {
  if (!event.runId) {
    logger.warn(
      `writeAuditEvent missing runId; skipping (action=${event.action})`,
    );
    return;
  }
  try {
    const headers = await getAuthHeaders();
    await gotPost(
      `${runUrl(event.projectId, event.runId)}/audit-events`,
      {
        type: event.action,
        message:
          typeof event.details?.['reason'] === 'string'
            ? (event.details['reason'] as string)
            : undefined,
        data: event.details,
        actor: event.actor,
      },
      { headers },
    );
  } catch (err) {
    // Audit writes must never block the main flow; log and swallow.
    logger.error(
      `writeAuditEvent failed (swallowed): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Promote-to-regression ──────────────────────────────────────────

// Internal HTTP helper for the public `promoteToRegression` activity
// below. Not exported as its own activity — keeps the registered surface
// to a single `promoteToRegression` (CR-A1.3 / CR-L1.3).
async function promoteCaseToRegression(
  input: PromoteToRegressionInput,
): Promise<{ caseId: string; datasetVersion: string }> {
  notImplemented(
    `promoteToRegression(${input.targetDatasetId})`,
    'POST /api/v1/projects/{projectId}/datasets/{datasetId}/cases (not yet exposed for evaluation promote-to-regression)',
  );
}

/**
 * One-shot Promote-to-Regression entry point called by config-service.
 * Promotion is a single activity, not a workflow.
 *
 * Currently a stub — the underlying `POST /datasets/{id}/cases` route is
 * not exposed by config-service yet, so the inner helper throws
 * NotImplemented. The argument validation is kept so that obvious
 * client-side errors still surface as `InvalidInputError` rather than
 * masquerading as NotImplemented.
 */
export async function promoteToRegression(
  input: PromoteToRegressionInput,
): Promise<{ datasetId: string; datasetVersion: string; caseId: string }> {
  if (!input.targetDatasetId) {
    throw ApplicationFailure.nonRetryable(
      'promoteToRegression: targetDatasetId is required',
      'InvalidInputError',
    );
  }
  if (!input.actor) {
    throw ApplicationFailure.nonRetryable(
      'promoteToRegression: actor is required',
      'InvalidInputError',
    );
  }
  if (!input.sourceCaseId && !input.sandboxInteractionId) {
    throw ApplicationFailure.nonRetryable(
      'promoteToRegression: sourceCaseId or sandboxInteractionId is required',
      'InvalidInputError',
    );
  }

  const { caseId, datasetVersion } = await promoteCaseToRegression({
    sourceRunId: input.sourceRunId,
    sourceCaseId: input.sourceCaseId,
    sandboxInteractionId: input.sandboxInteractionId,
    targetDatasetId: input.targetDatasetId,
    actor: input.actor,
  });

  return {
    datasetId: input.targetDatasetId,
    datasetVersion,
    caseId,
  };
}

export type { EvaluationJobInput };
