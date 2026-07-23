// sendObservabilityTrace — forwards the Phase-1 trace payload to
// observability-service (spec §7.4). Failures are logged but never propagate;
// traceRef is best-effort.
//
// The activity takes only `caseRef + capturePath`. The trace blob lives
// in the capture file on PVC and is read inline before being POSTed to
// observability-service, so the (potentially large) trace payload stays
// out of Temporal event history.

import { readCaptureFile } from '../lib/capture-file';
import type { CaseRef } from '../lib/evaluation';
import { gotPost } from '../lib/got';
import { getLogger } from '../lib/logger';

const logger = getLogger('server');

export async function sendObservabilityTrace(input: {
  caseRef: CaseRef;
  capturePath: string;
}): Promise<{ traceRef: string }> {
  const { caseRef, capturePath } = input;
  const base = process.env['OBSERVABILITY_SERVICE_URL'];
  if (!base) {
    // Observability is optional; fall back to a synthetic ref so downstream
    // code has something to record.
    return { traceRef: `local:${caseRef.runId}:${caseRef.caseId}` };
  }

  let trace: unknown;
  try {
    const file = await readCaptureFile(capturePath);
    trace = file.capture.trace;
  } catch (err) {
    // If the capture file is unreadable we can't forward the trace — soft
    // fail with a marker ref. invokeAgent's retries should make the missing
    // file case vanishingly rare in practice.
    logger.warn(
      `sendObservabilityTrace failed to load capture (${capturePath}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { traceRef: `missing:${caseRef.runId}:${caseRef.caseId}` };
  }

  if (trace === undefined || trace === null) {
    // Capture file present but trace was never populated — agent-service
    // didn't return a trace id. Skip the POST and fall back to a marker.
    return { traceRef: `missing:${caseRef.runId}:${caseRef.caseId}` };
  }

  try {
    const result = await gotPost<{ traceRef: string }>(`${base}/traces`, {
      runId: caseRef.runId,
      caseId: caseRef.caseId,
      trace,
    });
    if (result?.traceRef) return result;
    return { traceRef: `missing:${caseRef.runId}:${caseRef.caseId}` };
  } catch (err) {
    logger.warn(
      `sendObservabilityTrace soft-failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { traceRef: `error:${caseRef.runId}:${caseRef.caseId}` };
  }
}
