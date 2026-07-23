// Artifact generation activities (spec §7.6).
//
// Phase c of AgentEvaluationWorkflow dumps two artifacts to the configured artifact
// store and lets config-service register the URIs on the EvaluationJob row:
//
//   • writeResultsFile     — JSON containing results + per-case artifacts +
//                            provenance, used by config-service composition
//                            drivers (A/B compare, sweep leaderboard, regression
//                            baseline) to read final state without re-querying
//                            the worker.
//   • writeStakeholderReport  — Human-readable stakeholder report, currently
//                            rendered as markdown with PDF rendering pluggable
//                            via the artifact store.
//
// Both are idempotent on `runId` — repeated runs replace the object at
// the same URI rather than creating new files.

import { ApplicationFailure, heartbeat } from '@temporalio/activity';
import { readCaptureFile } from '../lib/capture-file';
import { getLogger } from '../lib/logger';
import {
  posixUri,
  runDirKey,
  slugify,
  writeObject,
} from '../lib/posix-store';
import type {
  CaseRunArtifact,
  CaseRunSlot,
  EvaluationResults,
  ProvenanceEnvelope,
} from '../lib/evaluation';

const logger = getLogger('server');

const HEARTBEAT_INTERVAL_MS = 60_000;

// ── writeResultsFile ────────────────────────────────────────────────

export interface WriteResultsFileInput {
  runId: string;
  projectId: string;
  evalId?: string;
  evalName?: string;
  results: EvaluationResults;
  /**
   * Small per-case slots accumulated by the parent workflow. Each slot
   * carries the capturePath; the activity reads each capture.json from
   * PVC and merges `response` + full `telemetry` into a `CaseRunArtifact`
   * row in the on-disk `results.json`. Heavy fields (`retrievedChunks`,
   * `toolCalls`, `perAgent[]`, `raw`, `citations`) stay on PVC and are
   * NOT denormalized — readers reach them via the row's `capturePath`.
   * This keeps customer-derived data out of Temporal event history and
   * bounds `results.json` size so the UI run page can fetch it eagerly
   * (~2 MB for a 100-case A/B vs 12–110 MB when fully inlined).
   */
  perCaseSlots: CaseRunSlot[];
  provenance: ProvenanceEnvelope;
}

export interface WriteResultsFileOutput {
  resultsFileUri: string;
}

export async function writeResultsFile(
  input: WriteResultsFileInput,
): Promise<WriteResultsFileOutput> {
  heartbeat({ phase: 'serialize-start', runId: input.runId });

  // Denormalize each slot by reading its capture.json from PVC. We
  // heartbeat every CAPTURE_HEARTBEAT_BATCH cases so a 10k-case run
  // doesn't tickle the heartbeatTimeout while we read files.
  const perCaseArtifacts: CaseRunArtifact[] = [];
  const CAPTURE_HEARTBEAT_BATCH = 50;
  for (let i = 0; i < input.perCaseSlots.length; i++) {
    const slot = input.perCaseSlots[i]!;
    perCaseArtifacts.push(await materializeArtifact(slot));
    if (i % CAPTURE_HEARTBEAT_BATCH === 0) {
      heartbeat({
        phase: 'materialize',
        runId: input.runId,
        slotIndex: i,
        slotCount: input.perCaseSlots.length,
      });
    }
  }

  const body = JSON.stringify(
    {
      runId: input.runId,
      generatedAt: new Date().toISOString(),
      results: input.results,
      perCaseArtifacts,
      provenance: input.provenance,
    },
    null,
    2,
  );

  const key = `${runDirKey({
    projectId: input.projectId,
    evalId: resolveEvalId(input),
    runId: input.runId,
  })}/results.json`;

  heartbeat({
    phase: 'upload-start',
    runId: input.runId,
    bytes: body.length,
  });
  const { uri } = await uploadArtifact(key, body);
  return { resultsFileUri: uri };
}

/**
 * Materialize a `CaseRunArtifact` for `results.json` by combining the
 * slot's small fields with `response` + full `telemetry` read from the
 * per-case capture file on PVC.
 *
 * Heavy fields on the capture (`retrievedChunks`, `toolCalls`,
 * `perAgent[]`, `raw`, `citations`) are NOT denormalized into the row —
 * they stay on PVC and are reachable via `capturePath` for on-demand
 * drill-in. This keeps `results.json` small (~2 MB for a 100-case A/B
 * vs 12–110 MB when fully inlined) so the UI's run page can fetch it
 * eagerly without browser/worker heap pressure.
 *
 * For FAILED slots (no capturePath) the capture-derived fields default
 * to empty/null from `base` so readers can use a single branch-free
 * shape for both COMPLETED and FAILED rows.
 */
async function materializeArtifact(slot: CaseRunSlot): Promise<CaseRunArtifact> {
  const base: CaseRunArtifact = {
    runId: slot.caseRef.runId,
    caseId: slot.caseRef.caseId,
    model: slot.caseRef.model,
    ...(slot.caseRef.variantId !== undefined
      ? { variantId: slot.caseRef.variantId }
      : {}),
    ...(slot.caseRef.seed !== undefined ? { repeatSeed: slot.caseRef.seed } : {}),
    status: slot.status,
    passed: slot.passed,
    startedAt: slot.startedAt,
    completedAt: slot.completedAt,
    durationMs: slot.durationMs,
    citations: [],
    retrievedChunks: [],
    toolCalls: [],
    perAgent: [],
    retrievalAnnotation: slot.retrievalAnnotation ?? null,
    resolvedRuntimeParams: slot.resolvedRuntimeParams ?? {},
    deterministicMetrics: slot.deterministicMetrics ?? {},
    ...(slot.goldenAssertions !== undefined
      ? { goldenAssertions: slot.goldenAssertions }
      : {}),
    judgeRubrics: slot.judgeRubrics ?? [],
    ...(slot.failureCategory !== undefined
      ? { failureCategory: slot.failureCategory }
      : {}),
    ...(slot.rootCause !== undefined ? { rootCause: slot.rootCause } : {}),
    telemetry: slot.telemetry
      ? {
          e2eMs: slot.telemetry.e2eMs,
          ...(slot.telemetry.ttftMs !== undefined
            ? { ttftMs: slot.telemetry.ttftMs }
            : {}),
          ...(slot.telemetry.retrievalMs !== undefined
            ? { retrievalMs: slot.telemetry.retrievalMs }
            : {}),
          ...(slot.telemetry.inferMs !== undefined
            ? { inferMs: slot.telemetry.inferMs }
            : {}),
          ...(slot.telemetry.inputTokens !== undefined
            ? { inputTokens: slot.telemetry.inputTokens }
            : {}),
          ...(slot.telemetry.outputTokens !== undefined
            ? { outputTokens: slot.telemetry.outputTokens }
            : {}),
          ...(slot.telemetry.estCostUsd !== undefined
            ? { estCostUsd: slot.telemetry.estCostUsd }
            : {}),
        }
      : { e2eMs: slot.durationMs },
    ...(slot.error !== undefined ? { error: slot.error } : {}),
    ...(slot.errorType !== undefined ? { errorType: slot.errorType } : {}),
    ...(slot.traceRef !== undefined ? { traceRef: slot.traceRef } : {}),
    ...(slot.capturePath !== undefined ? { capturePath: slot.capturePath } : {}),
  };

  if (!slot.capturePath) {
    return base;
  }

  try {
    const file = await readCaptureFile(slot.capturePath);
    return {
      ...base,
      response: file.capture.response,
      // Capture telemetry overrides slot headline (full set vs the
      // bounded numeric subset that the slot carried in workflow memory).
      telemetry: file.capture.telemetry,
    };
  } catch (err) {
    logger.warn(
      `materializeArtifact: failed to load capture for caseId=${slot.caseRef.caseId} (${slot.capturePath}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return base;
  }
}

// ── writeStakeholderReport ──────────────────────────────────────────

export interface WriteStakeholderReportInput {
  runId: string;
  projectId: string;
  evalId?: string;
  /** When provided, used to render the report in-line. */
  results?: EvaluationResults;
  /** Optional title surfaced at the top of the report. */
  evalName?: string;
}

export interface WriteStakeholderReportOutput {
  /**
   * URI of the rendered stakeholder report. The body is currently
   * markdown (filename `stakeholder-report.md`); the field name
   * deliberately omits a format suffix so a future swap to PDF /
   * HTML / etc. through a `report-service` doesn't trigger another
   * rename across every callsite.
   */
  reportUri: string;
}

/**
 * Renders the stakeholder-facing report and uploads it. Today the body is a
 * markdown summary; the activity stays the natural seam to swap in a real PDF
 * renderer (e.g. through a `report-service`) without touching workflow code.
 */
export async function writeStakeholderReport(
  input: WriteStakeholderReportInput,
): Promise<WriteStakeholderReportOutput> {
  heartbeat({ phase: 'render-start', runId: input.runId });

  const intervalHandle = startHeartbeatLoop(input.runId);
  try {
    const body = renderStakeholderMarkdown({
      runId: input.runId,
      evalName: input.evalName,
      results: input.results,
    });

    heartbeat({ phase: 'upload-start', runId: input.runId });
    const key = `${runDirKey({
      projectId: input.projectId,
      evalId: resolveEvalId(input),
      runId: input.runId,
    })}/stakeholder-report.md`;
    const { uri } = await uploadArtifact(key, body);
    return { reportUri: uri };
  } finally {
    clearInterval(intervalHandle);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function startHeartbeatLoop(runId: string): NodeJS.Timeout {
  return setInterval(() => {
    heartbeat({ phase: 'render-progress', runId });
  }, HEARTBEAT_INTERVAL_MS);
}

function resolveEvalId(input: { evalId?: string; evalName?: string }): string {
  if (input.evalId && input.evalId.length > 0) return input.evalId;
  return slugify(input.evalName ?? '');
}

async function uploadArtifact(
  key: string,
  body: string,
): Promise<{ uri: string }> {
  try {
    await writeObject(key, body);
    return { uri: posixUri(key) };
  } catch (err) {
    logger.error(
      `uploadArtifact failed (${posixUri(key)}): ${err instanceof Error ? err.message : String(err)}`,
    );
    // EACCES / EPERM / ENOSPC / ENOTDIR / ENOENT are configuration issues we don't want Temporal
    // to retry forever on.
    const code = (err as { code?: string }).code;
    if (code && ['EACCES', 'EPERM', 'ENOSPC', 'ENOTDIR', 'ENOENT'].includes(code)) {
      throw ApplicationFailure.nonRetryable(
        `POSIX write failed (${code}) at ${key}: ${err instanceof Error ? err.message : String(err)}`,
        'PosixWriteError',
      );
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function renderStakeholderMarkdown(args: {
  runId: string;
  evalName?: string;
  results?: EvaluationResults;
}): string {
  const { runId, evalName, results } = args;
  const lines: string[] = [];
  lines.push(`# Evaluation Report — ${evalName ?? runId}`);
  lines.push('');
  lines.push(`- **Evaluation ID:** \`${runId}\``);
  if (results) {
    lines.push(`- **Verdict:** \`${results.verdict}\``);
    lines.push(
      `- **Coverage:** ${results.coverage.completed}/${results.coverage.total} (${results.coverage.completedPct.toFixed(1)}%)`,
    );
    lines.push(
      `- **Infra failure rate:** ${(results.infraFailureRate * 100).toFixed(2)}%`,
    );
    lines.push(
      `- **Judge coverage:** ${results.judgeCoverage.scored}/${results.judgeCoverage.target} (${results.judgeCoverage.pct.toFixed(1)}%)`,
    );
    lines.push('');
    lines.push('## Gates');
    lines.push('');
    lines.push('| Gate | Level | Status | Threshold | Actual |');
    lines.push('|------|-------|--------|-----------|--------|');
    for (const g of results.triggeredGates) {
      lines.push(
        `| ${g.id} | ${g.level} | ${g.status} | ${g.threshold ?? '—'} | ${g.actual ?? '—'} |`,
      );
    }
    lines.push('');
    lines.push('## Dimensions');
    for (const d of results.dimensions) {
      lines.push(`- **${d.label}**: ${JSON.stringify(d.headline)}`);
    }
  } else {
    lines.push('');
    lines.push(
      '_Results unavailable — workflow ended without a results block._',
    );
  }
  return lines.join('\n');
}
