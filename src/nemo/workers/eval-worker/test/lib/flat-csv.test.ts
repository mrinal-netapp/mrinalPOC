// Tests for the flat CSV test-cases parser.
//
// Covers:
//   - happy path with + without header row
//   - header order shuffling + alias matching
//   - RFC 4180 quoting (commas, newlines, escaped quotes)
//   - BOM stripping, CRLF normalisation
//   - blank-line skipping, trailing newline handling
//   - validation errors (missing id/query, duplicate id, path-injection)
//   - tokenisation errors (unterminated quote, mid-cell quote)
//
// The parser is pure — no PVC/network.

import {
  FlatCsvParseError,
  parseFlatCsv,
} from '../../src/lib/flat-csv';

describe('parseFlatCsv — happy path', () => {
  it('parses with a header in default order', () => {
    const text = ['id,query,expected_answer', 'q-1,Hi,Hello!'].join('\n');
    const result = parseFlatCsv(text);
    expect(result.rowCount).toBe(1);
    expect(result.cases[0]).toEqual({
      id: 'q-1',
      input: { query: 'Hi' },
      evaluation: { expected_response: { final: { expected_answer: 'Hello!' } } },
      origin: 'legacy_csv',
    });
  });

  it('parses with no header, default column order', () => {
    const text = 'q-1,Hi,Hello!\nq-2,Bye,Goodbye!';
    const result = parseFlatCsv(text);
    expect(result.cases.map((c) => c.id)).toEqual(['q-1', 'q-2']);
    expect(result.cases[0].input.query).toBe('Hi');
    expect(result.cases[1].evaluation.expected_response.final.expected_answer).toBe(
      'Goodbye!',
    );
  });

  it('respects shuffled header order + alias names', () => {
    const text = [
      'Query,ID,Expected Answer',
      'Hi there,q-7,Hello!',
    ].join('\n');
    const result = parseFlatCsv(text);
    expect(result.cases[0]).toMatchObject({
      id: 'q-7',
      input: { query: 'Hi there' },
      evaluation: { expected_response: { final: { expected_answer: 'Hello!' } } },
    });
  });

  it('treats empty expected_answer as final={}', () => {
    const text = 'id,query,expected_answer\nq-1,Hi,';
    const result = parseFlatCsv(text);
    expect(result.cases[0].evaluation.expected_response.final).toEqual({});
  });
});

describe('parseFlatCsv — RFC 4180 quoting', () => {
  it('handles commas inside quoted fields', () => {
    const text = [
      'id,query,expected_answer',
      'q-1,"Hello, world","Hi, friend"',
    ].join('\n');
    const result = parseFlatCsv(text);
    expect(result.cases[0].input.query).toBe('Hello, world');
    expect(result.cases[0].evaluation.expected_response.final.expected_answer).toBe(
      'Hi, friend',
    );
  });

  it('handles escaped double-quotes ("")', () => {
    const text = [
      'id,query,expected_answer',
      'q-1,"She said ""hi""","Quoted: ""ok"""',
    ].join('\n');
    const result = parseFlatCsv(text);
    expect(result.cases[0].input.query).toBe('She said "hi"');
    expect(result.cases[0].evaluation.expected_response.final.expected_answer).toBe(
      'Quoted: "ok"',
    );
  });

  it('handles newlines inside quoted fields', () => {
    const text = [
      'id,query,expected_answer',
      'q-1,"line1\nline2",ok',
    ].join('\n');
    const result = parseFlatCsv(text);
    expect(result.cases[0].input.query).toBe('line1\nline2');
  });
});

describe('parseFlatCsv — encoding + line endings', () => {
  it('strips UTF-8 BOM at start of file', () => {
    const text = '﻿id,query,expected_answer\nq-1,Hi,Hello!';
    const result = parseFlatCsv(text);
    expect(result.cases[0].id).toBe('q-1');
  });

  it('normalises CRLF line endings', () => {
    const text = 'id,query,expected_answer\r\nq-1,Hi,Hello!\r\nq-2,Bye,Goodbye!';
    const result = parseFlatCsv(text);
    expect(result.cases.map((c) => c.id)).toEqual(['q-1', 'q-2']);
  });

  it('skips blank lines and a trailing newline', () => {
    const text = 'id,query,expected_answer\nq-1,Hi,Hello!\n\nq-2,Bye,Goodbye!\n';
    const result = parseFlatCsv(text);
    expect(result.rowCount).toBe(2);
  });
});

describe('parseFlatCsv — validation errors', () => {
  it('reports missing id with line number', () => {
    const text = 'id,query,expected_answer\n,Hi,Hello!';
    expect(() => parseFlatCsv(text)).toThrow(FlatCsvParseError);
    try {
      parseFlatCsv(text);
    } catch (err) {
      const e = err as FlatCsvParseError;
      expect(e.errors[0]).toMatchObject({ line: 2, path: 'id' });
    }
  });

  it('reports missing query', () => {
    const text = 'id,query,expected_answer\nq-1,,Hello!';
    try {
      parseFlatCsv(text);
      fail('expected throw');
    } catch (err) {
      const e = err as FlatCsvParseError;
      expect(e.errors[0]).toMatchObject({ line: 2, path: 'query' });
    }
  });

  it('detects duplicate ids', () => {
    const text = [
      'id,query,expected_answer',
      'q-1,Hi,Hello!',
      'q-1,Hello again,Howdy!',
    ].join('\n');
    try {
      parseFlatCsv(text);
      fail('expected throw');
    } catch (err) {
      const e = err as FlatCsvParseError;
      expect(e.errors[0].message).toMatch(/duplicate case id 'q-1'/);
      expect(e.errors[0].line).toBe(3);
    }
  });

  it('rejects ids with path separators or relative segments', () => {
    const text = ['id,query,expected_answer', '../etc/passwd,Hi,Hello!'].join('\n');
    try {
      parseFlatCsv(text);
      fail('expected throw');
    } catch (err) {
      const e = err as FlatCsvParseError;
      expect(e.errors[0]).toMatchObject({ path: 'id' });
      expect(e.errors[0].message).toMatch(/path separators/);
    }
  });

  it('reports wrong column count', () => {
    const text = ['id,query,expected_answer', 'q-1,Hi'].join('\n');
    try {
      parseFlatCsv(text);
      fail('expected throw');
    } catch (err) {
      const e = err as FlatCsvParseError;
      expect(e.errors[0].message).toMatch(/expected 3 columns, got 2/);
    }
  });
});

describe('parseFlatCsv — tokenisation errors', () => {
  it('reports unterminated quoted field', () => {
    const text = 'id,query,expected_answer\nq-1,"unclosed,Hello!';
    try {
      parseFlatCsv(text);
      fail('expected throw');
    } catch (err) {
      const e = err as FlatCsvParseError;
      expect(e.errors[0].message).toMatch(/unterminated quoted field/);
    }
  });

  it('reports mid-cell quote', () => {
    const text = 'id,query,expected_answer\nq-1,Hi "there",Hello!';
    try {
      parseFlatCsv(text);
      fail('expected throw');
    } catch (err) {
      const e = err as FlatCsvParseError;
      expect(e.errors[0].message).toMatch(/unexpected `"` mid-cell/);
    }
  });
});

describe('parseFlatCsv — header detection edge cases', () => {
  it('falls back to default order when first row is not a header', () => {
    // Three plausible-looking strings, none of which match a known column name.
    const text = ['some-id,how are you,sample answer'].join('\n');
    const result = parseFlatCsv(text);
    expect(result.cases[0]).toMatchObject({
      id: 'some-id',
      input: { query: 'how are you' },
      evaluation: { expected_response: { final: { expected_answer: 'sample answer' } } },
    });
  });

  it('treats header-like row but wrong width as data', () => {
    const text = 'id,query\nq-1,Hi,Hello!';
    try {
      parseFlatCsv(text);
      fail('expected throw on wrong column count');
    } catch (err) {
      const e = err as FlatCsvParseError;
      // Both rows fail width check (header has 2 cols, data has 3).
      expect(e.errors[0].message).toMatch(/expected 3 columns, got 2/);
    }
  });
});
