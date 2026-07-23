export type KbSearchMode = 'vector' | 'fts' | 'hybrid';

export type KbRerankerType = 'rrf' | 'none';

export interface KbSearchRequest {
  query: string;
  topK?: number;
  minScore?: number;
  searchMode?: KbSearchMode;
  distanceMetric?: 'cosine' | 'l2' | 'dot';
  rerankerType?: KbRerankerType;
}

export interface KbSearchResult {
  id: string;
  documentId?: string;
  source?: string;
  text: string;
  score: number;
  chunkIndex?: number;
  metadata?: Record<string, unknown>;
  downloadUrl?: string;
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
}

export interface KbSearchResponse {
  results: KbSearchResult[];
  query: string;
  topK?: number;
  resultCount?: number;
  processingTimeMs?: number;
  knowledgeBaseId?: string;
  searchMode?: string;
}
