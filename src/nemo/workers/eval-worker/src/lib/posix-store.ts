// POSIX-on-PVC storage adapter — eval-worker's replacement for the prior
// S3 (@aws-sdk/client-s3) path.
//
// Convention shared with dataset-processor / kb-processor / connector-worker:
// every worker mounts the s3gateway default bucket as a filesystem at
// NEMO_DEFAULT_STORE_ROOT (default `/mnt/pvcs/default-nemo`) and writes via
// plain `fs` calls. The mount is the same versitygw bucket; only the access
// path differs.
//
// Keys are stored on the EvaluationRun row as `posix:///{key}` URIs so
// downstream readers can resolve them against their own mount root without
// knowing the writer's `NEMO_DEFAULT_STORE_ROOT`.

import { promises as fs } from 'fs';
import * as path from 'path';

import type { CaseRef } from './evaluation';

const URI_PREFIX = 'posix:///';

/** Mount root resolved from env; defaults to the shared PVC path. */
export function storeRoot(): string {
  return process.env['NEMO_DEFAULT_STORE_ROOT'] || '/mnt/pvcs/default-nemo';
}

/** Lowercase + replace non-alphanumeric runs with `-`. Used as evalId fallback. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unnamed';
}

export interface EvaluationKeyParts {
  projectId: string;
  evalId: string;
  runId: string;
}

/** Per-run directory: projects/{pid}/evaluations/{evalId}/runs/{runId}/ */
export function runDirKey(parts: EvaluationKeyParts): string {
  return `projects/${parts.projectId}/evaluations/${parts.evalId}/runs/${parts.runId}`;
}

/**
 * Per-run input staging directory: `<runDir>/_input/`.
 *
 * Mirrors the `_acquisition/` convention used by dataset-import (see
 * `workflow-engine/internal/workflows/data_acquisition.go`). The job
 * folder's `_input/` holds the frozen template + cases snapshots written
 * by `loadRunSnapshot` at workflow start so subsequent activities can
 * reload them without re-querying config-service.
 */
export function inputDirKey(parts: EvaluationKeyParts): string {
  return `${runDirKey(parts)}/_input`;
}

/**
 * Per-case directory under a run. Resolves to:
 *   `<runDir>/cases/<caseId>/<variantId|single>/<model>/<seed|0>/`
 *
 * The variant/model/seed segments keep A/B variants and repeat-N seeds from
 * colliding when the same `caseId` runs multiple times in the same job.
 */
export function caseDirKey(ref: CaseRef): string {
  const variant = ref.variantId ?? 'single';
  const model = sanitizePathSegment(ref.model || 'default');
  const seed = ref.seed ?? 0;
  return `${runDirKey({
    projectId: ref.projectId,
    evalId: ref.evalId,
    runId: ref.runId,
  })}/cases/${ref.caseId}/${variant}/${model}/${seed}`;
}

/** Capture-file key (posix-store key) for a case ref. */
export function captureFileKey(ref: CaseRef): string {
  return `${caseDirKey(ref)}/capture.json`;
}

/** Sanitize a model id (which can contain `/`, `:`, etc.) for path use. */
function sanitizePathSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

// A/B compare data is folded into `<runDir>/results.json` as a top-level
// `compareReport` field; there is no separate `compares/{idA}_vs_{idB}/`
// directory. `buildCompareReport` writes through `runDirKey()` of the
// current run.

/**
 * Per-eval test-cases directory: `projects/{pid}/evaluations/{evalId}/testcases/`.
 *
 * Test cases are owned by the evaluation template — NOT a project Dataset.
 * The JSONL bytes live alongside the eval's run history under the same
 * `evaluations/{evalId}/` parent so that the entire lifecycle of an eval
 * (test cases + run results + audit) is rooted at one path. There is no
 * separate `datasets/{datasetId}/` indirection.
 */
export function evalTestCasesDirKey(args: {
  projectId: string;
  evalId: string;
}): string {
  return `projects/${args.projectId}/evaluations/${args.evalId}/testcases`;
}

/**
 * Default filename for an eval's test-cases JSONL within its
 * `testcases/` folder. `validateTestCases` reads this path unless the
 * template specifies an override.
 */
export const DEFAULT_TEST_CASES_JSONL_FILENAME = 'cases.jsonl';

/** Full key for the eval's test-cases JSONL file. */
export function testCasesJsonlKey(args: {
  projectId: string;
  evalId: string;
  filename?: string;
}): string {
  const f = args.filename ?? DEFAULT_TEST_CASES_JSONL_FILENAME;
  return `${evalTestCasesDirKey({
    projectId: args.projectId,
    evalId: args.evalId,
  })}/${f}`;
}

/** Render the canonical posix:/// URI for a key. */
export function posixUri(key: string): string {
  return `${URI_PREFIX}${key}`;
}

export function isPosixUri(uri: string): boolean {
  return uri.startsWith(URI_PREFIX);
}

/** Strip the `posix:///` prefix to recover the relative key. */
export function parsePosixUri(uri: string): string {
  if (!isPosixUri(uri)) throw new Error(`not a posix:/// URI: ${uri}`);
  return uri.slice(URI_PREFIX.length);
}

/**
 * Absolute filesystem path for a relative key under the configured root.
 *
 * Keys are built from external inputs (projectId / evalId / runId arrive
 * over HTTP from config-service) and flow straight into `fs.writeFile` /
 * `fs.readFile`, so this function is the chokepoint that prevents path
 * traversal. `path.resolve` collapses `..` segments and treats an absolute
 * `key` as a new root — both can escape `storeRoot()`. We resolve, then
 * reject any result that isn't equal to or contained by the root.
 */
export function fullPath(key: string): string {
  const root = path.resolve(storeRoot());
  const abs = path.resolve(root, key);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(
      `posix-store: key '${key}' resolves outside store root '${root}'`,
    );
  }
  return abs;
}

/** Write a UTF-8 string body to `key`. Creates parent directories as needed. */
export async function writeObject(key: string, body: string): Promise<void> {
  const abs = fullPath(key);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, 'utf8');
}

/** Read a UTF-8 string body at `key`. Throws if missing. */
export async function readObject(key: string): Promise<string> {
  return fs.readFile(fullPath(key), 'utf8');
}
