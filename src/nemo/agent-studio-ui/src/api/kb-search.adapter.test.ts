import { describe, expect, it } from 'vitest';

import { kbSearchResultToAgentChunk, kbSearchResultsToAgentChunks } from './kb-search.adapter';

describe('kb-search.adapter', () => {
  it('maps gateway search results to AgentChunk', () => {
    const chunk = kbSearchResultToAgentChunk({
      id: 'chunk-1',
      text: 'Relevant passage',
      score: 0.87,
      source: 'admin-guide.pdf',
      chunkIndex: 2,
      knowledgeBaseName: 'Admin Guide',
    });

    expect(chunk.chunkId).toBe('chunk-1');
    expect(chunk.content).toBe('Relevant passage');
    expect(chunk.score).toBe(0.87);
    expect(chunk.relevance_score).toBe(0.87);
    expect(chunk.metadata.fileName).toBe('admin-guide.pdf');
    expect(chunk.metadata.chunkIndex).toBe(2);
    expect(chunk.metadata.datasetName).toBe('Admin Guide');
  });

  it('falls back to metadata.fileName when source is absent', () => {
    const chunk = kbSearchResultToAgentChunk({
      id: 'chunk-2',
      text: 'Body',
      score: 0.5,
      metadata: {
        fileName: 'from-meta.txt',
        chunkIndex: 7,
        filePath: '/docs/from-meta.txt',
        page: 3,
        section: 'Intro',
      },
    });

    expect(chunk.metadata.fileName).toBe('from-meta.txt');
    // chunkIndex prefers the top-level field; falls back to metadata here.
    expect(chunk.metadata.chunkIndex).toBe(7);
    expect(chunk.metadata.filePath).toBe('/docs/from-meta.txt');
    expect(chunk.metadata.page).toBe(3);
    expect(chunk.metadata.section).toBe('Intro');
  });

  it('uses defaults when metadata is missing or has wrong-typed fields', () => {
    const chunk = kbSearchResultToAgentChunk({
      id: 'chunk-3',
      text: 'Body',
      score: 0.1,
      metadata: {
        // Non-string / non-number values exercise the type-guard fallbacks.
        fileName: 42,
        chunkIndex: 'not-a-number',
        filePath: '',
        section: 123,
      },
    });

    // fileName is non-string → metadataString returns ''.
    expect(chunk.metadata.fileName).toBe('');
    // chunkIndex non-number → metadataNumber returns 0.
    expect(chunk.metadata.chunkIndex).toBe(0);
    // Empty filePath → `|| undefined`.
    expect(chunk.metadata.filePath).toBeUndefined();
    // Non-string section → '' → `|| undefined`.
    expect(chunk.metadata.section).toBeUndefined();
  });

  it('treats non-finite metadata numbers as the default', () => {
    const chunk = kbSearchResultToAgentChunk({
      id: 'chunk-4',
      text: 'Body',
      score: 0,
      metadata: { chunkIndex: Number.POSITIVE_INFINITY },
    });

    expect(chunk.metadata.chunkIndex).toBe(0);
  });

  it('maps a list of results preserving order', () => {
    const chunks = kbSearchResultsToAgentChunks([
      { id: 'a', text: 'A', score: 1 },
      { id: 'b', text: 'B', score: 2 },
    ]);

    expect(chunks.map((c) => c.chunkId)).toEqual(['a', 'b']);
  });
});
