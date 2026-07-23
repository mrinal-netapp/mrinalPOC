// Capture-file helpers — write/read the per-case capture.json on PVC.
//
// The capture file is the source of truth for per-case Phase-1 data:
// agent response, retrieved chunks, tool I/O, raw provider payload, and the
// observability trace. Activity payloads (`invokeAgent` output and every
// scorer/judge/observability/results-file input) carry only the
// `posix:///` URI of this file; the full body never re-enters Temporal
// event history. See `lib/evaluation/lib/case-artifact.ts` for the schema.

import { ApplicationFailure } from '@temporalio/activity';

import type { CaptureFile, CaseRef } from './evaluation';
import {
  captureFileKey,
  isPosixUri,
  parsePosixUri,
  posixUri,
  readObject,
  writeObject,
} from './posix-store';

/**
 * Persist a capture file for `ref`. Idempotent on path — repeated writes
 * (e.g. activity retries that produced a fresh capture) overwrite the
 * existing file.
 *
 * Returns the canonical `posix:///` URI to put on the activity result.
 */
export async function writeCaptureFile(
  ref: CaseRef,
  file: Omit<CaptureFile, 'schemaVersion' | 'caseRef'>,
): Promise<string> {
  const key = captureFileKey(ref);
  const body: CaptureFile = {
    schemaVersion: 1,
    caseRef: ref,
    envelopeHash: file.envelopeHash,
    capturedAt: file.capturedAt,
    capture: file.capture,
  };
  await writeObject(key, JSON.stringify(body));
  return posixUri(key);
}

/**
 * Read a capture file by `posix:///` URI. Throws a non-retryable
 * ApplicationFailure if the URI is malformed or the body fails the
 * minimum schema gate — those are programmer errors, never transient.
 */
export async function readCaptureFile(
  capturePath: string,
): Promise<CaptureFile> {
  if (!isPosixUri(capturePath)) {
    throw ApplicationFailure.nonRetryable(
      `readCaptureFile: not a posix:/// URI: ${capturePath}`,
      'InvalidInputError',
    );
  }
  const key = parsePosixUri(capturePath);
  const body = await readObject(key);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw ApplicationFailure.nonRetryable(
      `readCaptureFile: malformed JSON at ${capturePath}: ${err instanceof Error ? err.message : String(err)}`,
      'InvalidInputError',
    );
  }
  if (!isCaptureFile(parsed)) {
    throw ApplicationFailure.nonRetryable(
      `readCaptureFile: capture file at ${capturePath} did not match expected schema`,
      'InvalidInputError',
    );
  }
  return parsed;
}

function isCaptureFile(v: unknown): v is CaptureFile {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o['schemaVersion'] !== 1) return false;
  if (!o['caseRef'] || typeof o['caseRef'] !== 'object') return false;
  if (typeof o['envelopeHash'] !== 'string') return false;
  if (typeof o['capturedAt'] !== 'string') return false;
  if (!o['capture'] || typeof o['capture'] !== 'object') return false;
  return true;
}
