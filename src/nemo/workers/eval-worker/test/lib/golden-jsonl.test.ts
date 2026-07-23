// Tests for the golden-dataset JSONL parser.
//
// Covers:
//   - happy-path parse
//   - blank + comment lines are skipped
//   - per-row validation errors (id, input.query, evaluation shape)
//   - duplicate id detection
//   - JSON parse errors are reported with line numbers
//
// The parser is pure — no PVC/network. The integration with PVC + the
// activity boundary is exercised in `dataset.activities.test.ts`.

import {
  GoldenJsonlParseError,
  parseFlatJsonArray,
  parseGoldenJsonl,
} from '../../src/lib/golden-jsonl';

function row(
  id: string,
  query = `query for ${id}`,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    id,
    input: { query },
    evaluation: { expected_response: { final: { expected_answer: 'x' } } },
    ...extra,
  });
}

describe('parseGoldenJsonl — happy path', () => {
  it('parses + normalises a typical multi-row dataset', () => {
    const text = [row('q-1'), row('q-2'), row('q-3')].join('\n');
    const result = parseGoldenJsonl(text);
    expect(result.rowCount).toBe(3);
    expect(result.cases.map((c) => c.id)).toEqual(['q-1', 'q-2', 'q-3']);
    expect(result.cases[0].input.query).toBe('query for q-1');
  });

  it('skips blank + comment lines without affecting line numbers in errors', () => {
    const text = [
      '# header — RAG faithfulness suite',
      '',
      row('q-1'),
      '   ',
      '# divider',
      row('q-2'),
    ].join('\n');
    const result = parseGoldenJsonl(text);
    expect(result.cases.map((c) => c.id)).toEqual(['q-1', 'q-2']);
    expect(result.rowCount).toBe(2);
  });
});

describe('parseGoldenJsonl — validation errors', () => {
  it('flags missing id with line number', () => {
    const bad = JSON.stringify({
      input: { query: 'q' },
      evaluation: {},
    });
    expect.assertions(3);
    try {
      parseGoldenJsonl(bad);
    } catch (err) {
      expect(err).toBeInstanceOf(GoldenJsonlParseError);
      const e = err as GoldenJsonlParseError;
      expect(e.errors).toHaveLength(1);
      expect(e.errors[0]).toMatchObject({ line: 1, path: 'id' });
    }
  });

  it('flags missing input.query', () => {
    const bad = JSON.stringify({ id: 'q-1', input: {}, evaluation: {} });
    try {
      parseGoldenJsonl(bad);
      fail('expected GoldenJsonlParseError');
    } catch (err) {
      const e = err as GoldenJsonlParseError;
      expect(e.errors[0].path).toBe('input.query');
    }
  });

  it('flags non-object evaluation', () => {
    const bad = JSON.stringify({
      id: 'q-1',
      input: { query: 'q' },
      evaluation: 'wrong',
    });
    try {
      parseGoldenJsonl(bad);
      fail('expected GoldenJsonlParseError');
    } catch (err) {
      const e = err as GoldenJsonlParseError;
      expect(e.errors[0].path).toBe('evaluation');
    }
  });

  it('flags array rows (must be objects)', () => {
    const bad = '[1, 2, 3]';
    try {
      parseGoldenJsonl(bad);
      fail('expected GoldenJsonlParseError');
    } catch (err) {
      const e = err as GoldenJsonlParseError;
      expect(e.errors[0].message).toMatch(/must be a JSON object/);
    }
  });

  it('flags JSON parse errors with the offending line number', () => {
    const text = [row('q-1'), '{not json}', row('q-3')].join('\n');
    try {
      parseGoldenJsonl(text);
      fail('expected GoldenJsonlParseError');
    } catch (err) {
      const e = err as GoldenJsonlParseError;
      expect(e.errors[0].line).toBe(2);
      expect(e.errors[0].message).toMatch(/JSON parse error/);
    }
  });

  it('flags duplicate ids', () => {
    const text = [row('q-dup'), row('q-other'), row('q-dup')].join('\n');
    try {
      parseGoldenJsonl(text);
      fail('expected GoldenJsonlParseError');
    } catch (err) {
      const e = err as GoldenJsonlParseError;
      expect(e.errors[0].message).toMatch(/duplicate case id/);
    }
  });

  it('aggregates multiple errors instead of stopping at the first', () => {
    const text = [
      JSON.stringify({ input: { query: 'q' } }),
      JSON.stringify({ id: 'q-2', input: {} }),
    ].join('\n');
    try {
      parseGoldenJsonl(text);
      fail('expected GoldenJsonlParseError');
    } catch (err) {
      const e = err as GoldenJsonlParseError;
      expect(e.errors.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('promotes flat {id, query, expected_answer} rows to the rich shape', () => {
    const text = [
      JSON.stringify({
        id: 'hello-001',
        query: 'Hi',
        expected_answer: 'Hello! How can I help you today?',
      }),
      JSON.stringify({ id: 'hello-002', query: '.', expected_answer: '' }),
    ].join('\n');
    const result = parseGoldenJsonl(text);
    expect(result.cases).toHaveLength(2);
    expect(result.cases[0]).toMatchObject({
      id: 'hello-001',
      input: { query: 'Hi' },
      evaluation: {
        expected_response: {
          final: { expected_answer: 'Hello! How can I help you today?' },
        },
      },
    });
    // Empty expected_answer collapses to an empty `final` so the rich
    // schema doesn't carry an empty string the scorers will misread.
    expect(result.cases[1].evaluation.expected_response.final).toEqual({});
  });

  it('leaves rich-shape rows unchanged (no double-promotion)', () => {
    const text = JSON.stringify({
      id: 'rich-1',
      input: { query: 'Why?' },
      evaluation: {
        expected_response: { final: { expected_answer: 'Because.' } },
      },
    });
    const result = parseGoldenJsonl(text);
    expect(result.cases[0].input.query).toBe('Why?');
    expect(result.cases[0].evaluation.expected_response.final).toEqual({
      expected_answer: 'Because.',
    });
  });
});

describe('parseFlatJsonArray', () => {
  it('accepts a plain JSON array of flat rows', () => {
    const text = JSON.stringify([
      { id: 'hello-001', query: 'Hi', expected_answer: 'Hello!' },
      { id: 'hello-002', query: 'Bye', expected_answer: 'Goodbye.' },
    ]);
    const result = parseFlatJsonArray(text);
    expect(result.cases).toHaveLength(2);
    expect(result.cases[0]).toMatchObject({
      id: 'hello-001',
      input: { query: 'Hi' },
      evaluation: {
        expected_response: { final: { expected_answer: 'Hello!' } },
      },
    });
  });

  it('accepts rich-shape rows in the same array', () => {
    const text = JSON.stringify([
      {
        id: 'rich-1',
        input: { query: 'Q' },
        evaluation: { expected_response: { final: { expected_answer: 'A' } } },
      },
      { id: 'flat-1', query: 'Q2', expected_answer: 'A2' },
    ]);
    const result = parseFlatJsonArray(text);
    expect(result.cases).toHaveLength(2);
    expect(result.cases[1].input.query).toBe('Q2');
  });

  it('rejects a JSON document that is not an array', () => {
    try {
      parseFlatJsonArray(JSON.stringify({ id: 'x', query: 'q' }));
      fail('expected GoldenJsonlParseError');
    } catch (err) {
      const e = err as GoldenJsonlParseError;
      expect(e.errors[0].message).toMatch(/must contain an array/);
    }
  });

  it('reports duplicate ids', () => {
    const text = JSON.stringify([
      { id: 'dup', query: 'a', expected_answer: 'b' },
      { id: 'dup', query: 'c', expected_answer: 'd' },
    ]);
    try {
      parseFlatJsonArray(text);
      fail('expected GoldenJsonlParseError');
    } catch (err) {
      const e = err as GoldenJsonlParseError;
      expect(e.errors[0].message).toMatch(/duplicate case id/);
    }
  });

  it('reports a top-level JSON parse error', () => {
    try {
      parseFlatJsonArray('not json');
      fail('expected GoldenJsonlParseError');
    } catch (err) {
      const e = err as GoldenJsonlParseError;
      expect(e.errors[0].message).toMatch(/JSON parse error/);
    }
  });
});

