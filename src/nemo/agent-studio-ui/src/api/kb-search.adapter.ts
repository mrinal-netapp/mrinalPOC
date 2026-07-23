import type { AgentChunk } from './agent.types';
import type { KbSearchResult } from './kb-search.types';

function metadataString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function metadataNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function kbSearchResultToAgentChunk(result: KbSearchResult): AgentChunk {
  const meta = result.metadata ?? {};
  const fileName =
    result.source
    ?? metadataString(meta.fileName)
    ?? metadataString(meta.source)
    ?? 'unknown';

  return {
    chunkId: result.id,
    content: result.text,
    score: result.score,
    relevance_score: result.score,
    metadata: {
      fileName,
      chunkIndex: result.chunkIndex ?? metadataNumber(meta.chunkIndex),
      filePath: metadataString(meta.filePath) || undefined,
      page: meta.page as number | string | undefined,
      section: metadataString(meta.section) || undefined,
      datasetName: result.knowledgeBaseName,
    },
  };
}

export function kbSearchResultsToAgentChunks(results: KbSearchResult[]): AgentChunk[] {
  return results.map(kbSearchResultToAgentChunk);
}
