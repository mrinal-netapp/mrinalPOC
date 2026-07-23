import type { ScheduleType } from '@/api/dataset.types';

import type {
  KBChunkingStrategy,
  KBChunkOptions,
  KBIndexType,
  KBSyncMode,
  KBVectorIndexConfiguration,
  KBVectorQuantization,
} from '@/api/kb.types';

export type { KBChunkOptions };

export type KBScheduleFormMode = 'builder' | 'cron';

export interface KBFormScheduleRefreshConfig {
  schedule_type: ScheduleType;
  interval_minutes: number;
  time_of_day_hour: number;
  time_of_day_minute: number;
  day_of_week: number[];
  day_of_month: number;
  cron_expression: string;
}

export interface KBFormScheduleValues {
  sync_schedule_mode: KBScheduleFormMode;
  refresh_config: KBFormScheduleRefreshConfig;
}

export interface KBFormValues {
  name: string;
  description: string;
  labels: (string | number)[];
  /** Pipeline toggle is disabled in UI; kept for API parity / future use. */
  use_pipeline: boolean;
  dataset_id: string;
  /** Comma-separated column names for text extraction. Required for structured datasets only. */
  text_columns: string;

  sync_mode: KBSyncMode;
  kb_schedule: KBFormScheduleValues;

  data_change_threshold_enabled: boolean;
  data_change_threshold_value: string;

  embedding_model: string;
  embedding_dimensions: number;

  chunking_strategy: KBChunkingStrategy;
  /** Used by fixed, recursive, markdown strategies */
  chunk_size: number;
  /** Used by fixed strategy */
  chunk_overlap: number;
  /** Used by sentence strategy */
  max_sentences: number;
  /** Used by sentence strategy */
  overlap_sentences: number;
  /** Used by token strategy */
  max_tokens: number;
  /** Used by token strategy */
  token_overlap: number;

  index_type: KBIndexType;
  vector_quantization: KBVectorQuantization;
  /** ivf_pq / scalar / ivf_rq: number of IVF partitions */
  quant_num_partitions: string;
  /** ivf_pq: PQ sub-vectors (default: 96) */
  quant_num_sub_vectors: string;
  /** scalar: HNSW ef_construction (default: 150) */
  quant_ef_construction: string;
  /** scalar: HNSW connectivity parameter (m) */
  quant_m: string;
  /** ivf_rq: bits per dimension (default: 1) */
  quant_num_bits: string;
  vector_index_configuration: KBVectorIndexConfiguration;
}

export const DESCRIPTION_MAX_LENGTH = 500;

/** Name pattern aligned with OpenAPI `KnowledgeBaseCreateRequest.name`. */
export const KB_NAME_PATTERN = /^[a-zA-Z0-9\s\-_]+$/;

export const SYNC_MODE_OPTIONS: {
  value: KBSyncMode;
  title: string;
  description: string;
}[] = [
    {
      value: 'manual',
      title: 'Synchronize manually',
      description: 'Updates must be applied manually from the knowledge base detail page.',
    },
    {
      value: 'after_dataset_updates',
      title: 'Synchronize after dataset updates',
      description: 'Starts automatically after each dataset synchronization completes.',
    },
    {
      value: 'scheduled',
      title: 'Sync on Knowledge Base schedule',
      description: 'Runs on an independent schedule using the builder or a cron expression.',
    },
  ];

export const KB_DEFAULT_EMBEDDING_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';
export const KB_DEFAULT_EMBEDDING_DIMENSIONS = 384;

/** Default values for each chunking strategy, matching backend processor defaults. */
export const KB_CHUNKING_STRATEGY_DEFAULTS: Record<
  KBChunkingStrategy,
  {
    chunk_size: number;
    chunk_overlap: number;
    max_sentences: number;
    overlap_sentences: number;
    max_tokens: number;
    token_overlap: number;
  }
> = {
  chunk_by_character: {
    chunk_size: 512,
    chunk_overlap: 50,
    max_sentences: 5,
    overlap_sentences: 1,
    max_tokens: 256,
    token_overlap: 20,
  },
  sentence: {
    chunk_size: 512,
    chunk_overlap: 50,
    max_sentences: 5,
    overlap_sentences: 1,
    max_tokens: 256,
    token_overlap: 20,
  },
  recursive: {
    chunk_size: 1000,
    chunk_overlap: 50,
    max_sentences: 5,
    overlap_sentences: 1,
    max_tokens: 256,
    token_overlap: 20,
  },
  chunk_by_token: {
    chunk_size: 512,
    chunk_overlap: 50,
    max_sentences: 5,
    overlap_sentences: 1,
    max_tokens: 256,
    token_overlap: 20,
  },
  hierarchical: {
    chunk_size: 1000,
    chunk_overlap: 50,
    max_sentences: 5,
    overlap_sentences: 1,
    max_tokens: 256,
    token_overlap: 20,
  },
  semantic: {
    chunk_size: 512,
    chunk_overlap: 50,
    max_sentences: 5,
    overlap_sentences: 1,
    max_tokens: 256,
    token_overlap: 20,
  },
  none: {
    chunk_size: 512,
    chunk_overlap: 50,
    max_sentences: 5,
    overlap_sentences: 1,
    max_tokens: 256,
    token_overlap: 20,
  },
};

export const KB_EMBEDDING_MODEL_DIMENSIONS: Record<string, number> = {
  'sentence-transformers/all-MiniLM-L6-v2': 384,
  'BAAI/bge-small-en-v1.5': 384,
  'sentence-transformers/all-MiniLM-L12-v2': 384,
  'BAAI/bge-base-en-v1.5': 768,
  'sentence-transformers/all-mpnet-base-v2': 768,
  'BAAI/bge-large-en-v1.5': 1024,
  'sentence-transformers/paraphrase-MiniLM-L3-v2': 384,
  'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2': 384,
  'sentence-transformers/paraphrase-multilingual-mpnet-base-v2': 768,
  'sentence-transformers/multi-qa-MiniLM-L6-cos-v1': 384,
};

/** Platform built-in embedding models — keep in sync with config-service `BUILTIN_EMBEDDING_MODELS`.
 *  Project-registered embedding models (Add Model screen) are merged at runtime via
 *  `useKbEmbeddingModelOptions`. */
export const KB_EMBEDDING_MODEL_OPTIONS: {
  key: string;
  value: string;
  label: string;
  isDisabled?: boolean;
}[] = [
  {
    key: 'all-minilm-l6-v2',
    value: 'sentence-transformers/all-MiniLM-L6-v2',
    label: 'all-MiniLM-L6-v2 (Default)',
  },
  {
    key: 'bge-small-en-v1-5',
    value: 'BAAI/bge-small-en-v1.5',
    label: 'BGE Small EN v1.5',
  },
  {
    key: 'all-minilm-l12-v2',
    value: 'sentence-transformers/all-MiniLM-L12-v2',
    label: 'all-MiniLM-L12-v2',
  },
  {
    key: 'bge-base-en-v1-5',
    value: 'BAAI/bge-base-en-v1.5',
    label: 'BGE Base EN v1.5',
  },
  {
    key: 'all-mpnet-base-v2',
    value: 'sentence-transformers/all-mpnet-base-v2',
    label: 'all-mpnet-base-v2',
  },
  {
    key: 'bge-large-en-v1-5',
    value: 'BAAI/bge-large-en-v1.5',
    label: 'BGE Large EN v1.5',
  },
  {
    key: 'paraphrase-minilm-l3-v2',
    value: 'sentence-transformers/paraphrase-MiniLM-L3-v2',
    label: 'paraphrase-MiniLM-L3-v2 (Fastest)',
  },
  {
    key: 'paraphrase-multilingual-minilm-l12-v2',
    value: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
    label: 'Multilingual MiniLM L12',
  },
  {
    key: 'paraphrase-multilingual-mpnet-base-v2',
    value: 'sentence-transformers/paraphrase-multilingual-mpnet-base-v2',
    label: 'Multilingual MPNet Base',
  },
  {
    key: 'multi-qa-minilm-l6-cos-v1',
    value: 'sentence-transformers/multi-qa-MiniLM-L6-cos-v1',
    label: 'Multi-QA MiniLM L6',
  },
];

export const KB_CHUNKING_STRATEGY_LABELS: Record<
  'chunk_by_character' | 'sentence' | 'recursive' | 'chunk_by_token' | 'hierarchical',
  string
> = {
  chunk_by_character: 'Fixed Size',
  sentence: 'Sentence-Based',
  recursive: 'Recursive',
  chunk_by_token: 'Token-Based',
  hierarchical: 'Markdown-aware',
};

/** UI labels for the five processor chunkers (`fixed`, `sentence`, `recursive`, `token`, `markdown`). */
export const KB_CHUNKING_STRATEGY_OPTIONS: { key: string; value: KBChunkingStrategy; label: string; isDisabled?: boolean }[] = [
  { key: 'fixed', value: 'chunk_by_character', label: KB_CHUNKING_STRATEGY_LABELS.chunk_by_character },
  { key: 'sentence', value: 'sentence', label: KB_CHUNKING_STRATEGY_LABELS.sentence },
  { key: 'recursive', value: 'recursive', label: KB_CHUNKING_STRATEGY_LABELS.recursive },
  { key: 'token', value: 'chunk_by_token', label: KB_CHUNKING_STRATEGY_LABELS.chunk_by_token },
  { key: 'markdown', value: 'hierarchical', label: KB_CHUNKING_STRATEGY_LABELS.hierarchical },
];

export function getKBChunkingStrategyLabel(strategy?: KBChunkingStrategy): string {
  if (!strategy) return '—';
  return KB_CHUNKING_STRATEGY_LABELS[strategy as keyof typeof KB_CHUNKING_STRATEGY_LABELS] ?? strategy;
}

export const KB_INDEX_TYPE_OPTIONS: { key: string; value: KBIndexType; label: string; sublabel?: string }[] = [
  { key: 'hybrid_search', value: 'hybrid_search', label: 'Hybrid search (recommended)', sublabel: 'Vector + FTS with reciprocal-rank fusion. Best for most use cases.' },
  { key: 'vector_only', value: 'vector_only', label: 'Vector only', sublabel: 'Semantic vector search only. Best when keyword matching is not needed.' },
  { key: 'keyword_only', value: 'keyword_only', label: 'Keyword only', sublabel: 'BM25 / FTS only. Best for exact term matching without semantic understanding.' },
];

export interface KBVectorQuantizationOption {
  key: string;
  value: KBVectorQuantization;
  label: string;
  sublabel: string;
}

export const KB_VECTOR_QUANTIZATION_OPTIONS: KBVectorQuantizationOption[] = [
  {
    key: 'auto',
    value: 'auto',
    label: 'Automatic (Recommended)',
    sublabel: 'System selects the best index type based on KB size. Uses IVF_HNSW_SQ for large KBs, brute-force for small ones.',
  },
  {
    key: 'none',
    value: 'none',
    label: 'None (Exact Search)',
    sublabel: 'No vector index. Highest accuracy but slower for large KBs. Best for small datasets (<10k vectors).',
  },
  {
    key: 'ivf_pq',
    value: 'ivf_pq',
    label: 'IVF_PQ (Product Quantization)',
    sublabel: 'Inverted File + Product Quantization. Significant compression with minimal accuracy loss. Best for >10k vectors.',
  },
  {
    key: 'scalar',
    value: 'scalar',
    label: 'Scalar Quantization (IVF_HNSW_SQ)',
    sublabel: 'HNSW graph + scalar quantization (float32 to int8). Best recall/latency trade-off (~1/4 compression).',
  },
  {
    key: 'ivf_rq',
    value: 'ivf_rq',
    label: 'IVF_RQ (RaBitQ - Maximum Compression)',
    sublabel: 'RaBitQ binary quantization (~1/32 compression). Fastest build, best for large high-dimensional datasets.',
  },
];

/** Default values for quantization options by strategy */
export const KB_QUANTIZATION_DEFAULTS: Record<KBVectorQuantization, {
  numPartitions?: number;
  numSubVectors?: number;
  efConstruction?: number;
  m?: number;
  numBits?: number;
}> = {
  auto: {},
  none: {},
  ivf_pq: { numPartitions: 256, numSubVectors: 96 },
  scalar: { efConstruction: 150 },
  ivf_rq: { numBits: 1 },
};
