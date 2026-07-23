/**
 * Parse evaluation run input cases from `_input/cases.jsonl`.
 *
 * The worker stores CSV or golden-JSONL bytes under that filename regardless
 * of format. This module sniffs the content and normalizes both into a flat
 * `{ caseId, query, expected }` list for the test-cases table.
 */

export type ParsedEvalCase = {
  caseId: string;
  query: string;
  expected: string;
};

type Column = 'id' | 'query' | 'expected_answer';
const DEFAULT_COLUMN_ORDER: readonly Column[] = ['id', 'query', 'expected_answer'];

const HEADER_ALIASES: Record<string, Column> = {
  id: 'id',
  query: 'query',
  expected_answer: 'expected_answer',
  'expected answer': 'expected_answer',
  'expected-answer': 'expected_answer',
};

function detectHeader(cells: string[]): Column[] | null {
  const mapped = cells.map((cell) => HEADER_ALIASES[cell.trim().toLowerCase()] ?? null);
  if (mapped.some((value) => value === null)) {
    return null;
  }
  return mapped as Column[];
}

function tokeniseRows(text: string): Array<{ line: number; cells: string[] }> {
  const rows: Array<{ line: number; cells: string[] }> = [];
  let line = 1;
  let field = '';
  let cells: string[] = [];
  let inQuotes = false;

  const pushField = () => {
    cells.push(field);
    field = '';
  };

  const pushRow = () => {
    pushField();
    rows.push({ line, cells: [...cells] });
    cells = [];
    line += 1;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\n') {
      pushRow();
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || cells.length > 0 || inQuotes) {
    pushRow();
  }

  return rows;
}

function parseFlatCsv(text: string): ParsedEvalCase[] {
  const normalised = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const rows = tokeniseRows(normalised).filter(
    (row) => !row.cells.every((cell) => cell.trim() === ''),
  );
  if (rows.length === 0) {
    return [];
  }

  const columns = detectHeader(rows[0].cells);
  const dataStart = columns ? 1 : 0;
  const columnOrder = columns ?? DEFAULT_COLUMN_ORDER;
  const cases: ParsedEvalCase[] = [];
  const seenIds = new Set<string>();

  for (let i = dataStart; i < rows.length; i += 1) {
    const rowCells = rows[i].cells;
    if (rowCells.length !== columnOrder.length) {
      continue;
    }

    const byCol: Partial<Record<Column, string>> = {};
    for (let j = 0; j < columnOrder.length; j += 1) {
      byCol[columnOrder[j]] = rowCells[j]?.trim() ?? '';
    }

    const caseId = byCol.id ?? '';
    const query = byCol.query ?? '';
    const expected = byCol.expected_answer ?? '';
    if (!caseId || seenIds.has(caseId)) {
      continue;
    }
    seenIds.add(caseId);
    cases.push({ caseId, query, expected });
  }

  return cases;
}

function parseGoldenJsonlLine(raw: Record<string, unknown>): ParsedEvalCase | null {
  const caseId = String(raw.id ?? raw.caseId ?? raw.case_id ?? '').trim();
  if (!caseId) {
    return null;
  }

  const input = raw.input as Record<string, unknown> | undefined;
  const evaluation = raw.evaluation as Record<string, unknown> | undefined;
  const expectedResponse = evaluation?.expected_response as Record<string, unknown> | undefined;
  const final = expectedResponse?.final as Record<string, unknown> | undefined;
  const reference = raw.reference as Record<string, unknown> | undefined;

  const query = String(input?.query ?? raw.query ?? '').trim();
  const expected = String(
    final?.expected_answer ??
    final?.reference_text ??
    reference?.response ??
    raw.expected_answer ??
    raw.expectedAnswer ??
    '',
  ).trim();

  return { caseId, query, expected };
}

function parseGoldenJsonl(text: string): ParsedEvalCase[] {
  const cases: ParsedEvalCase[] = [];
  const seenIds = new Set<string>();

  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const row = parseGoldenJsonlLine(parsed);
    if (!row || seenIds.has(row.caseId)) {
      continue;
    }
    seenIds.add(row.caseId);
    cases.push(row);
  }

  return cases;
}

function firstNonEmptyLine(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? '';
}

/** Sniff CSV vs golden JSONL and parse run `_input/cases.jsonl` bytes. */
export function parseCasesFile(text: string): ParsedEvalCase[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const firstLine = firstNonEmptyLine(trimmed);
  if (firstLine.startsWith('{')) {
    return parseGoldenJsonl(trimmed);
  }

  return parseFlatCsv(trimmed);
}
