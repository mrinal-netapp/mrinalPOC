// Test-cases JSONL parser.
//
// Schema overview (one JSON object per line):
//   - Required: `id` (non-empty string), `input.query` (non-empty string),
//     `evaluation` (object — may be empty `{}`).
//   - Optional: every other `GoldenTestCase` field (category, difficulty,
//     tags, label_suspect, input.attachments, input.context_hints, plus the
//     full `evaluation.*` tree — retrieval_expectation, expected_tool_use,
//     safety_expectation, classification_labels, sla, budget,
//     expected_response.final.{expected_answer, reference_text,
//     must_include, must_cite, forbidden, required_schema}, and
//     expected_response.sub_agents).
//   - Lines that are empty (after trim) or start with `#` are ignored —
//     authors can keep section headers as comments.
//
// Pure module — no I/O. Tested in `test/lib/golden-jsonl.test.ts`.

import type { GoldenTestCase } from './evaluation';

// ── Types ────────────────────────────────────────────────────────────

export interface GoldenJsonlValidationError {
  /** 1-based line number in the source JSONL text. */
  line: number;
  /** 0-based row index after empty/comment lines are skipped. */
  rowIndex?: number;
  /** Sub-path within the row (e.g. `input.query`). */
  path?: string;
  message: string;
}

export interface ParseGoldenJsonlResult {
  cases: GoldenTestCase[];
  rowCount: number;
}

export class GoldenJsonlParseError extends Error {
  errors: GoldenJsonlValidationError[];
  constructor(errors: GoldenJsonlValidationError[]) {
    super(formatErrors(errors));
    this.name = 'GoldenJsonlParseError';
    this.errors = errors;
  }
}

// Allowlist of known top-level keys on a parsed golden test case row.
// Any other top-level keys present in the JSONL are dropped at validate
// time so attacker-controlled extras never reach prompts/scoring.
const GOLDEN_CASE_TOP_LEVEL_KEYS = [
  'id',
  'category',
  'difficulty',
  'tags',
  'label_suspect',
  'input',
  'evaluation',
] as const;

function pickAllowed(
  obj: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Parse + validate a golden-dataset JSONL blob.
 *
 * Throws `GoldenJsonlParseError` with the full error list when any row
 * fails parse/validation. The activity layer maps this to a `SchemaDrift`
 * `ApplicationFailure` so the workflow surfaces it as a non-retryable
 * validator failure (matches `runPreflight`'s contract).
 */
export function parseGoldenJsonl(text: string): ParseGoldenJsonlResult {
  const errors: GoldenJsonlValidationError[] = [];
  const cases: GoldenTestCase[] = [];
  const seenIds = new Set<string>();

  // Normalise CRLF/CR → LF so editors that save with Windows line endings
  // don't desync line numbers reported in errors.
  // We do NOT canonicalise here so error line numbers reference the
  // user's raw bytes (helpful when the JSONL is rendered to a buffer).
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let rowIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    // Skip blank + comment lines so authors can section the file.
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      errors.push({
        line: i + 1,
        rowIndex,
        message: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
      });
      rowIndex++;
      continue;
    }

    // Promote a flat `{id, query, expected_answer}` row to the rich
    // GoldenTestCase shape so spreadsheet exports / hand-authored
    // smoke datasets work without forcing users to learn the nested
    // schema. Detection is conservative — anything that already
    // carries the rich `input` / `evaluation` keys falls through
    // unchanged.
    parsed = maybePromoteFlatRow(parsed);
    const rowResult = validateGoldenRow(parsed, {
      line: i + 1,
      rowIndex,
    });
    if (rowResult.errors.length > 0) {
      errors.push(...rowResult.errors);
    } else {
      const c = rowResult.case_;
      if (seenIds.has(c.id)) {
        errors.push({
          line: i + 1,
          rowIndex,
          path: 'id',
          message: `duplicate case id '${c.id}' (row ${rowIndex} collides with an earlier row)`,
        });
      } else {
        seenIds.add(c.id);
        cases.push(c);
      }
    }
    rowIndex++;
  }

  if (errors.length > 0) {
    throw new GoldenJsonlParseError(errors);
  }

  return {
    cases,
    rowCount: cases.length,
  };
}

// ── Per-row validator ────────────────────────────────────────────────

interface ValidateRowResult {
  case_: GoldenTestCase;
  errors: GoldenJsonlValidationError[];
}

/**
 * Validate a single parsed row against the `GoldenTestCase` shape.
 *
 * Strategy: minimal shape gate (id, input.query, evaluation), then a
 * permissive pass-through. The detailed sub-tree shapes
 * (`expected_response.final.must_include[]` etc.) are validated lazily
 * by the scorers that consume them — duplicating the full Zod schema
 * here would be a maintenance burden for low marginal safety.
 */
function validateGoldenRow(
  raw: unknown,
  ctx: { line: number; rowIndex: number },
): ValidateRowResult {
  const errors: GoldenJsonlValidationError[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({
      ...ctx,
      message: 'row must be a JSON object',
    });
    return { case_: emptyCase(), errors };
  }

  const obj = raw as Record<string, unknown>;

  // id ------------------------------------------------------------------
  // caseId flows into the per-case PVC path
  // (`projects/.../cases/{caseId}/...`). Reject anything that could
  // escape that prefix or collide with a sibling case via a relative
  // segment.
  const idVal = obj['id'];
  let id = '';
  if (typeof idVal === 'string' && idVal.trim().length > 0) {
    const trimmed = idVal.trim();
    if (
      trimmed === '.' ||
      trimmed === '..' ||
      trimmed.includes('/') ||
      trimmed.includes('\\') ||
      trimmed.includes('\0')
    ) {
      errors.push({
        ...ctx,
        path: 'id',
        message:
          '`id` must not contain path separators (`/`, `\\`), `..`, or NUL',
      });
    } else {
      id = trimmed;
    }
  } else {
    errors.push({
      ...ctx,
      path: 'id',
      message: '`id` is required and must be a non-empty string',
    });
  }

  // input.query ---------------------------------------------------------
  const input = obj['input'];
  if (input === undefined || input === null || typeof input !== 'object') {
    errors.push({
      ...ctx,
      path: 'input',
      message: '`input` is required and must be an object',
    });
  } else {
    const q = (input as Record<string, unknown>)['query'];
    if (typeof q !== 'string' || q.trim().length === 0) {
      errors.push({
        ...ctx,
        path: 'input.query',
        message: '`input.query` is required and must be a non-empty string',
      });
    }
  }

  // evaluation ----------------------------------------------------------
  const evaluation = obj['evaluation'];
  if (
    evaluation !== undefined &&
    evaluation !== null &&
    (typeof evaluation !== 'object' || Array.isArray(evaluation))
  ) {
    errors.push({
      ...ctx,
      path: 'evaluation',
      message: '`evaluation` (when present) must be an object',
    });
  }

  // Build a normalised case with safe defaults so downstream consumers
  // see a stable shape even when the row is mostly empty. Only known
  // top-level keys flow through — attacker-controlled extras (which
  // would otherwise reach judge prompts via JSON.stringify) are dropped.
  const allowed = pickAllowed(obj, GOLDEN_CASE_TOP_LEVEL_KEYS);
  const case_: GoldenTestCase = {
    ...(allowed as Partial<GoldenTestCase>),
    id,
    input: {
      query: '',
      ...(typeof input === 'object' && input !== null
        ? (input as GoldenTestCase['input'])
        : {}),
    },
    evaluation: {
      expected_response: { final: {} },
      ...(typeof evaluation === 'object' && evaluation !== null
        ? (evaluation as GoldenTestCase['evaluation'])
        : {}),
    },
  };

  return { case_, errors };
}

function emptyCase(): GoldenTestCase {
  return {
    id: '',
    input: { query: '' },
    evaluation: { expected_response: { final: {} } },
  };
}

/**
 * Detect a flat `{id, query, expected_answer}`-style row and promote it
 * to the rich `GoldenTestCase` shape. Returns the input unchanged when
 * it isn't a flat row (no `query` field, or already carries the rich
 * `input` / `evaluation` keys). Used by both the JSONL parser and the
 * `.json` array parser so the same lenient detection works regardless
 * of how the file is laid out on disk.
 */
function maybePromoteFlatRow(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return parsed;
  }
  const r = parsed as Record<string, unknown>;
  // The rich shape uses `input.query`; if `input` or `evaluation` is
  // already present we leave the row alone and let the regular
  // validator handle it (or report the right schema error).
  if ('input' in r || 'evaluation' in r) return parsed;
  if (typeof r['query'] !== 'string') return parsed;

  const promoted: Record<string, unknown> = {
    id: r['id'],
    input: { query: r['query'] },
    evaluation: {
      expected_response: {
        final:
          typeof r['expected_answer'] === 'string' && r['expected_answer'].length > 0
            ? { expected_answer: r['expected_answer'] }
            : {},
      },
    },
  };
  // Carry through the optional top-level fields the rich schema
  // already permits so a flat row can still be tagged for filtering.
  if (typeof r['category'] === 'string') promoted['category'] = r['category'];
  if (typeof r['difficulty'] === 'string') promoted['difficulty'] = r['difficulty'];
  if (Array.isArray(r['tags'])) promoted['tags'] = r['tags'];
  return promoted;
}

/**
 * Parse a plain JSON document (NOT JSONL) whose payload is an array of
 * flat-row test cases:
 *
 *   [{ "id": "hello-001", "query": "Hi", "expected_answer": "Hello!" }, ...]
 *
 * Each row goes through the same `maybePromoteFlatRow` → `validateGoldenRow`
 * pipeline as the JSONL parser, so rich-shape rows in the same array
 * are also accepted. Throws `GoldenJsonlParseError` on any failure so
 * the activity layer maps it to the same `SchemaDrift` ApplicationFailure
 * as the other parsers.
 */
export function parseFlatJsonArray(text: string): ParseGoldenJsonlResult {
  const errors: GoldenJsonlValidationError[] = [];
  const cases: GoldenTestCase[] = [];
  const seenIds = new Set<string>();

  let outer: unknown;
  try {
    outer = JSON.parse(text);
  } catch (err) {
    throw new GoldenJsonlParseError([
      {
        line: 1,
        message: `JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
      },
    ]);
  }
  if (!Array.isArray(outer)) {
    throw new GoldenJsonlParseError([
      {
        line: 1,
        message:
          'JSON file must contain an array of test-case objects at the top level',
      },
    ]);
  }

  outer.forEach((raw, rowIndex) => {
    const promoted = maybePromoteFlatRow(raw);
    const rowResult = validateGoldenRow(promoted, { line: 1, rowIndex });
    if (rowResult.errors.length > 0) {
      errors.push(...rowResult.errors);
      return;
    }
    const c = rowResult.case_;
    if (seenIds.has(c.id)) {
      errors.push({
        line: 1,
        rowIndex,
        path: 'id',
        message: `duplicate case id '${c.id}' (row ${rowIndex} collides with an earlier row)`,
      });
      return;
    }
    seenIds.add(c.id);
    cases.push(c);
  });

  if (errors.length > 0) {
    throw new GoldenJsonlParseError(errors);
  }
  return { cases, rowCount: cases.length };
}

function formatErrors(errors: GoldenJsonlValidationError[]): string {
  if (errors.length === 0) return 'unknown JSONL parse error';
  const head = errors.slice(0, 5).map((e) => {
    const where =
      e.line > 0
        ? e.path
          ? `line ${e.line} (${e.path})`
          : `line ${e.line}`
        : '<dataset>';
    return `${where}: ${e.message}`;
  });
  const more = errors.length > 5 ? ` (+${errors.length - 5} more)` : '';
  return `golden JSONL validation failed: ${head.join('; ')}${more}`;
}
