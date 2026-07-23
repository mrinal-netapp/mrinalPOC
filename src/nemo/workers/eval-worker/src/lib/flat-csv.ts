// Flat CSV test-cases parser (alternative to the rich golden JSONL format).
//
// Schema overview (one row per test case):
//   - Required columns: `id`, `query`, `expected_answer`.
//   - Optional first row may be a header naming the columns in any order
//     (case-insensitive; also accepts `expected answer` with a space and
//     `expected-answer`). When no header is detected, the default column
//     order `id, query, expected_answer` is assumed.
//   - RFC 4180 quoting: fields with `,`, `"`, or newlines must be wrapped
//     in `"`; embedded `"` is escaped as `""`. CRLF is normalised to LF.
//   - A leading UTF-8 BOM (common for Excel exports) is stripped.
//   - Blank lines are skipped. There is no comment syntax.
//
// Each row maps to a minimal `GoldenTestCase`:
//   - `input.query`        ← query column
//   - `evaluation.expected_response.final.expected_answer` ← expected_answer column
//   - `origin: 'legacy_csv'`
//
// Pure module — no I/O. Tested in `test/lib/flat-csv.test.ts`.

import type { GoldenTestCase } from './evaluation';

export interface FlatCsvValidationError {
  /** 1-based line number in the source text (start line for multi-line cells). */
  line: number;
  /** 0-based row index after the header (if any) and blank lines are skipped. */
  rowIndex?: number;
  /** Column name when known (`id` | `query` | `expected_answer`). */
  path?: string;
  message: string;
}

export interface ParseFlatCsvResult {
  cases: GoldenTestCase[];
  rowCount: number;
}

export class FlatCsvParseError extends Error {
  errors: FlatCsvValidationError[];
  constructor(errors: FlatCsvValidationError[]) {
    super(formatErrors(errors));
    this.name = 'FlatCsvParseError';
    this.errors = errors;
  }
}

type Column = 'id' | 'query' | 'expected_answer';
const DEFAULT_COLUMN_ORDER: readonly Column[] = ['id', 'query', 'expected_answer'];

const HEADER_ALIASES: Record<string, Column> = {
  id: 'id',
  query: 'query',
  expected_answer: 'expected_answer',
  'expected answer': 'expected_answer',
  'expected-answer': 'expected_answer',
};

/**
 * Parse + validate a flat CSV blob.
 *
 * Throws `FlatCsvParseError` with the full error list when any row fails
 * parse/validation. The activity layer maps this to a `SchemaDrift`
 * `ApplicationFailure` (same contract as `parseGoldenJsonl`).
 */
export function parseFlatCsv(text: string): ParseFlatCsvResult {
  // Strip UTF-8 BOM and normalise CRLF/CR → LF so line numbers reported
  // in errors line up with what the user sees in their editor.
  const normalised = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  const errors: FlatCsvValidationError[] = [];
  const cells = tokeniseRows(normalised, errors);
  if (errors.length > 0) {
    throw new FlatCsvParseError(errors);
  }

  // Drop fully blank rows (every cell empty/whitespace). Trailing newline
  // in the source produces one such row that we want to ignore.
  const rows = cells.filter(
    (row) => !row.cells.every((cell) => cell.trim() === ''),
  );
  if (rows.length === 0) {
    return { cases: [], rowCount: 0 };
  }

  // Header detection: first row's cells (after trim) must all map to a
  // known column name. The user-chosen header order then becomes the
  // column map for the remaining rows. If detection fails, fall back to
  // the default order and treat row 1 as data.
  const columns = detectHeader(rows[0].cells);
  const dataStart = columns ? 1 : 0;
  const columnOrder = columns ?? DEFAULT_COLUMN_ORDER;

  const cases: GoldenTestCase[] = [];
  const seenIds = new Set<string>();
  let rowIndex = 0;
  for (let i = dataStart; i < rows.length; i++) {
    const { line, cells: rowCells } = rows[i];
    const ctx = { line, rowIndex };

    if (rowCells.length !== columnOrder.length) {
      errors.push({
        ...ctx,
        message: `expected ${columnOrder.length} columns, got ${rowCells.length}`,
      });
      rowIndex++;
      continue;
    }

    const byCol: Partial<Record<Column, string>> = {};
    for (let j = 0; j < columnOrder.length; j++) {
      byCol[columnOrder[j]] = rowCells[j];
    }

    const id = validateId(byCol.id ?? '', errors, ctx);
    const query = validateQuery(byCol.query ?? '', errors, ctx);

    if (id && query) {
      if (seenIds.has(id)) {
        errors.push({
          ...ctx,
          path: 'id',
          message: `duplicate case id '${id}' (row ${rowIndex} collides with an earlier row)`,
        });
      } else {
        seenIds.add(id);
        cases.push(buildCase(id, query, byCol.expected_answer ?? ''));
      }
    }
    rowIndex++;
  }

  if (errors.length > 0) {
    throw new FlatCsvParseError(errors);
  }
  return { cases, rowCount: cases.length };
}

// ── Internals ────────────────────────────────────────────────────────

interface ParsedRow {
  /** 1-based source line where this row started. */
  line: number;
  cells: string[];
}

/**
 * RFC 4180 tokeniser. Yields rows of string cells. Quoted cells preserve
 * embedded commas / newlines / escaped quotes (`""` → `"`). Any error
 * (unterminated quote, char after closing quote) is appended to `errors`
 * and parsing stops at the offending row.
 */
function tokeniseRows(
  text: string,
  errors: FlatCsvValidationError[],
): ParsedRow[] {
  const rows: ParsedRow[] = [];
  let line = 1;
  let i = 0;
  let rowStartLine = 1;
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        if (ch === '\n') line++;
        cell += ch;
        i++;
      }
      continue;
    }

    if (ch === '"') {
      if (cell !== '') {
        errors.push({
          line,
          message: 'unexpected `"` mid-cell — quote a cell only at its start',
        });
        return rows;
      }
      inQuotes = true;
      i++;
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
      i++;
    } else if (ch === '\n') {
      cells.push(cell);
      rows.push({ line: rowStartLine, cells });
      cells = [];
      cell = '';
      line++;
      rowStartLine = line;
      i++;
    } else {
      cell += ch;
      i++;
    }
  }

  if (inQuotes) {
    errors.push({
      line: rowStartLine,
      message: 'unterminated quoted field — missing closing `"`',
    });
    return rows;
  }

  // Flush trailing row (no terminating newline).
  if (cell !== '' || cells.length > 0) {
    cells.push(cell);
    rows.push({ line: rowStartLine, cells });
  }

  return rows;
}

function detectHeader(cells: string[]): Column[] | null {
  if (cells.length !== DEFAULT_COLUMN_ORDER.length) return null;
  const cols: Column[] = [];
  for (const cell of cells) {
    const key = cell.trim().toLowerCase();
    const col = HEADER_ALIASES[key];
    if (!col) return null;
    cols.push(col);
  }
  // All three required columns must be present exactly once.
  const seen = new Set(cols);
  if (seen.size !== DEFAULT_COLUMN_ORDER.length) return null;
  return cols;
}

function validateId(
  raw: string,
  errors: FlatCsvValidationError[],
  ctx: { line: number; rowIndex: number },
): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    errors.push({
      ...ctx,
      path: 'id',
      message: '`id` is required and must be a non-empty string',
    });
    return '';
  }
  // Same path-injection guard as parseGoldenJsonl — caseId becomes a PVC
  // path segment, so reject relative segments and separators.
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
    return '';
  }
  return trimmed;
}

function validateQuery(
  raw: string,
  errors: FlatCsvValidationError[],
  ctx: { line: number; rowIndex: number },
): string {
  if (raw.trim().length === 0) {
    errors.push({
      ...ctx,
      path: 'query',
      message: '`query` is required and must be a non-empty string',
    });
    return '';
  }
  return raw;
}

function buildCase(
  id: string,
  query: string,
  expectedAnswer: string,
): GoldenTestCase {
  return {
    id,
    input: { query },
    evaluation: {
      expected_response: {
        final: expectedAnswer.length > 0 ? { expected_answer: expectedAnswer } : {},
      },
    },
    origin: 'legacy_csv',
  };
}

function formatErrors(errors: FlatCsvValidationError[]): string {
  if (errors.length === 0) return 'unknown CSV parse error';
  const head = errors.slice(0, 5).map((e) => {
    const where = e.path ? `line ${e.line} (${e.path})` : `line ${e.line}`;
    return `${where}: ${e.message}`;
  });
  const more = errors.length > 5 ? ` (+${errors.length - 5} more)` : '';
  return `flat CSV validation failed: ${head.join('; ')}${more}`;
}
