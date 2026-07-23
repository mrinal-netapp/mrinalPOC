// Test-cases validation activity.
//
// Test cases are owned by the evaluation template (NOT a project Dataset).
// The JSONL bytes live on the PVC at:
//
//   `projects/{projectId}/evaluations/{evalId}/testcases/{filename ?? 'cases.jsonl'}`
//
// alongside the eval's run history. There is no datasetId indirection.
//
// At workflow start `validateTestCases`:
//   1. reads the JSONL bytes from the PVC at the canonical path,
//   2. validates each row against the `GoldenTestCase` schema (via
//      `parseGoldenJsonl`),
//   3. stages a copy of the JSONL bytes at `<runDir>/_input/cases.jsonl`
//      for replay determinism + audit,
//   4. returns the parsed cases + the staged URI to the workflow.
//
// Customer payload never enters Temporal event history — cases travel
// inline in the activity *output* only because the row count is
// bounded; the source bytes themselves stay on PVC.

import { ApplicationFailure } from '@temporalio/activity';
import { FlatCsvParseError, parseFlatCsv } from '../lib/flat-csv';
import {
  GoldenJsonlParseError,
  parseFlatJsonArray,
  parseGoldenJsonl,
} from '../lib/golden-jsonl';
import { getLogger } from '../lib/logger';
import {
  DEFAULT_TEST_CASES_JSONL_FILENAME,
  inputDirKey,
  posixUri,
  readObject,
  testCasesJsonlKey,
  writeObject,
} from '../lib/posix-store';
import type {
  ValidateTestCasesInput,
  ValidateTestCasesOutput,
} from '../lib/evaluation';

const logger = getLogger('server');

/**
 * Read + validate the test-cases JSONL for a run, stage an audit copy
 * under `<runDir>/_input/`, and return the parsed cases.
 *
 * Failure modes:
 *   - PVC read error (file missing, ENOENT) → `NotFoundError` non-retryable.
 *   - Schema/parse error (any row fails validation, duplicate ids, JSON
 *     parse error) → `SchemaDrift` non-retryable. The error message
 *     embeds up to five line numbers + paths so the operator can fix
 *     the file without rerunning.
 *   - Empty file (zero valid rows) → `InvalidInputError` non-retryable.
 */
export async function validateTestCases(
  input: ValidateTestCasesInput,
): Promise<ValidateTestCasesOutput> {
  const filename = input.filename ?? DEFAULT_TEST_CASES_JSONL_FILENAME;
  const sourceKey = testCasesJsonlKey({
    projectId: input.projectId,
    evalId: input.evalId,
    filename,
  });
  const testCasesUri = posixUri(sourceKey);

  let raw: string;
  try {
    raw = await readObject(sourceKey);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      throw ApplicationFailure.nonRetryable(
        `validateTestCases: test-cases file not found at ${testCasesUri}`,
        'NotFoundError',
      );
    }
    throw err instanceof Error ? err : new Error(String(err));
  }

  // Pick parser by filename extension:
  //   `.csv`   → flat 3-column CSV
  //   `.json`  → single JSON document containing an array of rows
  //              (`[{id, query, expected_answer}, ...]` or the rich
  //              GoldenTestCase shape — `parseFlatJsonArray` promotes
  //              flat rows transparently)
  //   default  → JSONL, one row per line. The JSONL parser also
  //              auto-promotes flat-row lines, so users can upload a
  //              `.jsonl` of `{"id":"...","query":"...","expected_answer":"..."}`
  //              and it just works.
  // All parsers return the same `{ cases, rowCount }` shape and signal
  // failure with a typed error class that the catch arm below maps to
  // `SchemaDrift`.
  const lowerName = filename.toLowerCase();
  const isCsv = lowerName.endsWith('.csv');
  const isJson = lowerName.endsWith('.json');
  let result;
  try {
    result = isCsv
      ? parseFlatCsv(raw)
      : isJson
        ? parseFlatJsonArray(raw)
        : parseGoldenJsonl(raw);
  } catch (err) {
    if (
      err instanceof GoldenJsonlParseError ||
      err instanceof FlatCsvParseError
    ) {
      // Non-retryable — the file content is wrong; retrying won't help.
      // The full per-row error list rides on `details` so consumers can
      // surface it (e.g. the GUI run page).
      throw ApplicationFailure.nonRetryable(
        err.message,
        'SchemaDrift',
        { errors: err.errors, testCasesUri },
      );
    }
    throw err;
  }

  if (result.cases.length === 0) {
    throw ApplicationFailure.nonRetryable(
      `validateTestCases: file ${testCasesUri} contained zero valid rows`,
      'InvalidInputError',
    );
  }

  // Stage a byte-for-byte copy under the run's `_input/` folder for
  // replay/audit. The Temporal activity-result cache means later
  // replays re-use this copy without a second read of the source.
  const stagedKey = `${inputDirKey({
    projectId: input.projectId,
    evalId: input.evalId,
    runId: input.runId,
  })}/cases.jsonl`;
  await writeObject(stagedKey, raw);

  logger.info(
    `validateTestCases runId=${input.runId} evalId=${input.evalId} ` +
      `rows=${result.rowCount}`,
  );

  return {
    cases: result.cases,
    rowCount: result.rowCount,
    testCasesUri,
    inputCopyUri: posixUri(stagedKey),
  };
}
