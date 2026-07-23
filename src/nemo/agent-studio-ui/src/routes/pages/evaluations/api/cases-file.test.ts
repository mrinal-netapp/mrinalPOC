import { describe, expect, it } from 'vitest';

import { parseCasesFile } from './cases-file';

describe('parseCasesFile', () => {
  it('[tag:eval] parses flat CSV cases with quoted fields', () => {
    const text = [
      'id,query,expected_answer',
      'hello-001,Hi,"Hello! How can I help you today?"',
      'hello-002,"Hello, my name is Aniket. What\'s yours?","Hi Aniket, I\'m an assistant."',
    ].join('\n');

    expect(parseCasesFile(text)).toEqual([
      {
        caseId: 'hello-001',
        query: 'Hi',
        expected: 'Hello! How can I help you today?',
      },
      {
        caseId: 'hello-002',
        query: "Hello, my name is Aniket. What's yours?",
        expected: "Hi Aniket, I'm an assistant.",
      },
    ]);
  });

  it('[tag:eval] parses golden JSONL cases', () => {
    const text = [
      JSON.stringify({
        id: 'case-001',
        input: { query: 'What is RAG?' },
        evaluation: {
          expected_response: {
            final: { expected_answer: 'Retrieval augmented generation.' },
          },
        },
      }),
      JSON.stringify({
        caseId: 'case-002',
        input: { query: 'Summarize the handoff.' },
        reference: { response: 'The team completed the migration.' },
      }),
    ].join('\n');

    expect(parseCasesFile(text)).toEqual([
      {
        caseId: 'case-001',
        query: 'What is RAG?',
        expected: 'Retrieval augmented generation.',
      },
      {
        caseId: 'case-002',
        query: 'Summarize the handoff.',
        expected: 'The team completed the migration.',
      },
    ]);
  });

  it('[tag:eval] skips malformed JSONL lines', () => {
    const text = [
      JSON.stringify({
        id: 'case-001',
        input: { query: 'What is RAG?' },
        evaluation: {
          expected_response: {
            final: { expected_answer: 'Retrieval augmented generation.' },
          },
        },
      }),
      '{not json}',
      JSON.stringify({
        caseId: 'case-002',
        input: { query: 'Summarize the handoff.' },
        reference: { response: 'The team completed the migration.' },
      }),
    ].join('\n');

    expect(parseCasesFile(text)).toEqual([
      {
        caseId: 'case-001',
        query: 'What is RAG?',
        expected: 'Retrieval augmented generation.',
      },
      {
        caseId: 'case-002',
        query: 'Summarize the handoff.',
        expected: 'The team completed the migration.',
      },
    ]);
  });
});
