/**
 * Static catalog of known embedding-model metadata per (provider,
 * providerModelId). Used at Model-create time to populate `model_info`,
 * and at read time (knowledgeBaseRoutes.resolveEmbeddingFields) to
 * resolve dimensions for Model rows that were registered before this
 * catalog existed — so the KB workflow never silently falls back to
 * the legacy 384-d default and corrupts a LanceDB index.
 *
 * For models not in the catalog, callers should leave `model_info`
 * as-is and surface a 400 / "unknown" UX so the user supplies
 * `model_info.dimensions` via the RegisterModelWizard's manual input.
 *
 * Aligned with the file of the same name on `project-copilot` so the
 * two branches can converge cleanly; the additions vs project-copilot
 * are: Cohere v2/v3 direct entries, Voyage 2/3 family, Gemini
 * embedding (configurable, default 3072), and the matching fuzzy
 * rules.
 *
 * Sources: provider docs as of 2026-06.
 */

export type EmbeddingCategory = 'balanced' | 'quality' | 'fast' | 'multilingual';

export interface KnownEmbeddingModel {
  dimensions: number;
  /** Recommended chunk size in tokens; reflects the model's input window. */
  recommendedChunkSize?: number;
  category?: EmbeddingCategory;
  description?: string;
}

// Reusable descriptors so the same model under different provider keys
// (e.g. OpenAI vs Azure vs OpenAI-compatible deployments) stays in sync.
const ADA_002: KnownEmbeddingModel = {
  dimensions: 1536,
  recommendedChunkSize: 1024,
  category: 'balanced',
  description: 'OpenAI Ada v2 — general-purpose, 1536-d, 8K context',
};
const V3_SMALL: KnownEmbeddingModel = {
  dimensions: 1536,
  recommendedChunkSize: 1024,
  category: 'balanced',
  description: 'OpenAI text-embedding-3-small — faster, supports Matryoshka truncation',
};
const V3_LARGE: KnownEmbeddingModel = {
  dimensions: 3072,
  recommendedChunkSize: 1024,
  category: 'quality',
  description: 'OpenAI text-embedding-3-large — highest quality, 3072-d',
};

const TITAN_V1: KnownEmbeddingModel = {
  dimensions: 1536,
  recommendedChunkSize: 1024,
  category: 'balanced',
  description: 'Amazon Titan Embeddings v1 — 1536-d, 8K context',
};
const TITAN_V2: KnownEmbeddingModel = {
  dimensions: 1024,
  recommendedChunkSize: 1024,
  category: 'balanced',
  description: 'Amazon Titan Embeddings v2 — 1024-d default, supports 512/256 truncation',
};
const TITAN_IMAGE: KnownEmbeddingModel = {
  dimensions: 1024,
  recommendedChunkSize: 512,
  category: 'balanced',
  description: 'Amazon Titan Multimodal Embeddings — 1024-d, image + text',
};
const COHERE_V3_EN: KnownEmbeddingModel = {
  dimensions: 1024,
  recommendedChunkSize: 512,
  category: 'quality',
  description: 'Cohere Embed English v3 — 1024-d, retrieval-optimized',
};
const COHERE_V3_MULTI: KnownEmbeddingModel = {
  dimensions: 1024,
  recommendedChunkSize: 512,
  category: 'multilingual',
  description: 'Cohere Embed Multilingual v3 — 1024-d, 100+ languages',
};
const COHERE_V3_EN_LIGHT: KnownEmbeddingModel = {
  dimensions: 384,
  recommendedChunkSize: 512,
  category: 'fast',
  description: 'Cohere Embed English Light v3 — 384-d, faster/cheaper variant',
};
const COHERE_V3_MULTI_LIGHT: KnownEmbeddingModel = {
  dimensions: 384,
  recommendedChunkSize: 512,
  category: 'fast',
  description: 'Cohere Embed Multilingual Light v3 — 384-d, fast multilingual',
};
const COHERE_V2_EN: KnownEmbeddingModel = {
  dimensions: 4096,
  recommendedChunkSize: 512,
  category: 'quality',
  description: 'Cohere Embed English v2 — 4096-d, legacy',
};
const COHERE_V2_MULTI: KnownEmbeddingModel = {
  dimensions: 768,
  recommendedChunkSize: 512,
  category: 'multilingual',
  description: 'Cohere Embed Multilingual v2 — 768-d, legacy',
};

// Voyage AI — the voyage family is typically routed through an
// openai-compatible proxy in AgentStudio.
const VOYAGE_3: KnownEmbeddingModel = {
  dimensions: 1024,
  recommendedChunkSize: 1024,
  category: 'quality',
  description: 'Voyage 3 — 1024-d, general-purpose',
};
const VOYAGE_3_LITE: KnownEmbeddingModel = {
  dimensions: 512,
  recommendedChunkSize: 1024,
  category: 'fast',
  description: 'Voyage 3 Lite — 512-d, faster/cheaper',
};
const VOYAGE_3_LARGE: KnownEmbeddingModel = {
  dimensions: 1024,
  recommendedChunkSize: 1024,
  category: 'quality',
  description: 'Voyage 3 Large — 1024-d, top retrieval quality',
};
const VOYAGE_2: KnownEmbeddingModel = {
  dimensions: 1024,
  recommendedChunkSize: 1024,
  category: 'quality',
  description: 'Voyage 2 — 1024-d',
};
const VOYAGE_LARGE_2: KnownEmbeddingModel = {
  dimensions: 1536,
  recommendedChunkSize: 1024,
  category: 'quality',
  description: 'Voyage Large 2 — 1536-d',
};
const VOYAGE_CODE_3: KnownEmbeddingModel = {
  dimensions: 1024,
  recommendedChunkSize: 1024,
  category: 'quality',
  description: 'Voyage Code 3 — 1024-d, code-tuned',
};
const VOYAGE_CODE_2: KnownEmbeddingModel = {
  dimensions: 1536,
  recommendedChunkSize: 1024,
  category: 'quality',
  description: 'Voyage Code 2 — 1536-d, code-tuned',
};
const VOYAGE_FINANCE_2: KnownEmbeddingModel = {
  dimensions: 1024,
  recommendedChunkSize: 1024,
  category: 'quality',
  description: 'Voyage Finance 2 — 1024-d, finance-domain',
};
const VOYAGE_LAW_2: KnownEmbeddingModel = {
  dimensions: 1024,
  recommendedChunkSize: 1024,
  category: 'quality',
  description: 'Voyage Law 2 — 1024-d, legal-domain',
};
const VOYAGE_MULTILINGUAL_2: KnownEmbeddingModel = {
  dimensions: 1024,
  recommendedChunkSize: 1024,
  category: 'multilingual',
  description: 'Voyage Multilingual 2 — 1024-d',
};

const GOOGLE_TEXT_004: KnownEmbeddingModel = {
  dimensions: 768,
  recommendedChunkSize: 1024,
  category: 'balanced',
  description: 'Google text-embedding-004 — 768-d, 2K input tokens',
};
const GOOGLE_TEXT_005: KnownEmbeddingModel = {
  dimensions: 768,
  recommendedChunkSize: 1024,
  category: 'balanced',
  description: 'Google text-embedding-005 — 768-d',
};
const GOOGLE_MULTILINGUAL: KnownEmbeddingModel = {
  dimensions: 768,
  recommendedChunkSize: 1024,
  category: 'multilingual',
  description: 'Google text-multilingual-embedding-002 — 768-d, multilingual',
};
const GEMINI_EMBEDDING_001: KnownEmbeddingModel = {
  dimensions: 3072,
  recommendedChunkSize: 2048,
  category: 'quality',
  description: 'Google gemini-embedding-001 — 3072-d default (configurable 768/1536/3072)',
};

const STATIC_CATALOG: Record<string, Record<string, KnownEmbeddingModel>> = {
  openai: {
    'text-embedding-ada-002': ADA_002,
    'text-embedding-3-small': V3_SMALL,
    'text-embedding-3-large': V3_LARGE,
  },
  azure: {
    'text-embedding-ada-002': ADA_002,
    'text-embedding-3-small': V3_SMALL,
    'text-embedding-3-large': V3_LARGE,
  },
  // Cohere / Voyage are commonly registered as openai_compatible providers
  // pointed at the vendor's `/v1/embeddings` endpoint.
  openai_compatible: {
    'text-embedding-ada-002': ADA_002,
    'text-embedding-3-small': V3_SMALL,
    'text-embedding-3-large': V3_LARGE,
    // Cohere direct
    'embed-english-v3.0': COHERE_V3_EN,
    'embed-multilingual-v3.0': COHERE_V3_MULTI,
    'embed-english-light-v3.0': COHERE_V3_EN_LIGHT,
    'embed-multilingual-light-v3.0': COHERE_V3_MULTI_LIGHT,
    'embed-english-v2.0': COHERE_V2_EN,
    'embed-multilingual-v2.0': COHERE_V2_MULTI,
    // Voyage AI
    'voyage-3': VOYAGE_3,
    'voyage-3-lite': VOYAGE_3_LITE,
    'voyage-3-large': VOYAGE_3_LARGE,
    'voyage-2': VOYAGE_2,
    'voyage-large-2': VOYAGE_LARGE_2,
    'voyage-code-3': VOYAGE_CODE_3,
    'voyage-code-2': VOYAGE_CODE_2,
    'voyage-finance-2': VOYAGE_FINANCE_2,
    'voyage-law-2': VOYAGE_LAW_2,
    'voyage-multilingual-2': VOYAGE_MULTILINGUAL_2,
  },
  aws_bedrock: {
    'amazon.titan-embed-text-v1': TITAN_V1,
    'amazon.titan-embed-text-v2:0': TITAN_V2,
    'amazon.titan-embed-image-v1': TITAN_IMAGE,
    'cohere.embed-english-v3': COHERE_V3_EN,
    'cohere.embed-multilingual-v3': COHERE_V3_MULTI,
  },
  google: {
    'text-embedding-004': GOOGLE_TEXT_004,
    'text-embedding-005': GOOGLE_TEXT_005,
    'embedding-001': GOOGLE_TEXT_004,
    'text-multilingual-embedding-002': GOOGLE_MULTILINGUAL,
    'gemini-embedding-001': GEMINI_EMBEDDING_001,
    'gemini-embedding-exp-03-07': GEMINI_EMBEDDING_001,
  },
  gemini: {
    'text-embedding-004': GOOGLE_TEXT_004,
    'text-embedding-005': GOOGLE_TEXT_005,
    'embedding-001': GOOGLE_TEXT_004,
    'text-multilingual-embedding-002': GOOGLE_MULTILINGUAL,
    'gemini-embedding-001': GEMINI_EMBEDDING_001,
    'gemini-embedding-exp-03-07': GEMINI_EMBEDDING_001,
  },
};

// Fuzzy patterns cover prefixed / suffixed variants (Azure deployment
// names, dated revisions). Patterns are checked top-down so the most
// specific id fragment wins — order matters: longer/more-specific
// substrings come first so e.g. `voyage-3-large` matches its own rule
// instead of the generic `/voyage-3/` rule.
const FUZZY_RULES: Array<{ test: (id: string) => boolean; entry: KnownEmbeddingModel }> = [
  // OpenAI family
  { test: id => /text-embedding-3-large/.test(id), entry: V3_LARGE },
  { test: id => /text-embedding-3-small/.test(id), entry: V3_SMALL },
  { test: id => /text-embedding-ada-002/.test(id), entry: ADA_002 },
  // Bedrock + Cohere via Bedrock
  { test: id => /titan-embed-text-v2/.test(id), entry: TITAN_V2 },
  { test: id => /titan-embed-text-v1/.test(id), entry: TITAN_V1 },
  { test: id => /titan-embed-image/.test(id), entry: TITAN_IMAGE },
  { test: id => /cohere\.embed-english-v3/.test(id), entry: COHERE_V3_EN },
  { test: id => /cohere\.embed-multilingual-v3/.test(id), entry: COHERE_V3_MULTI },
  // Cohere direct (light variants must precede the generic v3 patterns)
  { test: id => /embed-english-light-v3/.test(id), entry: COHERE_V3_EN_LIGHT },
  { test: id => /embed-multilingual-light-v3/.test(id), entry: COHERE_V3_MULTI_LIGHT },
  { test: id => /embed-english-v3/.test(id), entry: COHERE_V3_EN },
  { test: id => /embed-multilingual-v3/.test(id), entry: COHERE_V3_MULTI },
  { test: id => /embed-english-v2/.test(id), entry: COHERE_V2_EN },
  { test: id => /embed-multilingual-v2/.test(id), entry: COHERE_V2_MULTI },
  // Voyage (specific before generic)
  { test: id => /voyage-3-lite/.test(id), entry: VOYAGE_3_LITE },
  { test: id => /voyage-3-large/.test(id), entry: VOYAGE_3_LARGE },
  { test: id => /voyage-code-3/.test(id), entry: VOYAGE_CODE_3 },
  { test: id => /voyage-code-2/.test(id), entry: VOYAGE_CODE_2 },
  { test: id => /voyage-large-2/.test(id), entry: VOYAGE_LARGE_2 },
  { test: id => /voyage-finance-2/.test(id), entry: VOYAGE_FINANCE_2 },
  { test: id => /voyage-law-2/.test(id), entry: VOYAGE_LAW_2 },
  { test: id => /voyage-multilingual-2/.test(id), entry: VOYAGE_MULTILINGUAL_2 },
  { test: id => /voyage-3/.test(id), entry: VOYAGE_3 },
  { test: id => /voyage-2/.test(id), entry: VOYAGE_2 },
  // Google
  { test: id => /text-multilingual-embedding/.test(id), entry: GOOGLE_MULTILINGUAL },
  { test: id => /gemini-embedding/.test(id), entry: GEMINI_EMBEDDING_001 },
  { test: id => /text-embedding-00[2-5]/.test(id), entry: GOOGLE_TEXT_004 },
];

/**
 * Resolve full catalog metadata for an embedding model.
 *
 * Resolution order:
 *   1. Exact match in `STATIC_CATALOG[provider][providerModelId]`.
 *   2. Fuzzy match against well-known model-name patterns (covers
 *      provider-prefixed deployments like Azure custom names).
 *   3. `undefined` — caller should leave the fields unset and surface
 *      an explicit error / manual-override UX rather than silently
 *      default. Wrong embedding dimensions corrupt the LanceDB index.
 */
export function getKnownEmbeddingModelInfo(
  provider: string | undefined | null,
  providerModelId: string | undefined | null,
): KnownEmbeddingModel | undefined {
  if (!providerModelId) return undefined;

  if (provider) {
    const exact = STATIC_CATALOG[provider]?.[providerModelId];
    if (exact) return exact;
  }

  for (const rule of FUZZY_RULES) {
    if (rule.test(providerModelId)) return rule.entry;
  }

  return undefined;
}

/**
 * Convenience accessor for callers that only care about the dimension —
 * kept as a separate export so existing dim-only call sites don't have
 * to destructure the wider record.
 */
export function getKnownEmbeddingDimensions(
  provider: string | undefined | null,
  providerModelId: string | undefined | null,
): number | undefined {
  return getKnownEmbeddingModelInfo(provider, providerModelId)?.dimensions;
}

/**
 * Merge catalog metadata into an existing `model_info` jsonb blob,
 * filling in only the fields that aren't already set. Returns the
 * original object unchanged when no catalog entry exists or every
 * field is already populated. Pure — does not mutate `existing`.
 */
export function enrichModelInfoFromCatalog<T extends Record<string, unknown> | undefined | null>(
  existing: T,
  provider: string | undefined | null,
  providerModelId: string | undefined | null,
): Record<string, unknown> | T {
  const known = getKnownEmbeddingModelInfo(provider, providerModelId);
  if (!known) return existing;

  const base: Record<string, unknown> = { ...(existing || {}) };
  const setIfMissing = (key: keyof KnownEmbeddingModel) => {
    const v = known[key];
    if (v !== undefined && (base[key] === undefined || base[key] === null || base[key] === '')) {
      base[key] = v;
    }
  };
  setIfMissing('dimensions');
  setIfMissing('recommendedChunkSize');
  setIfMissing('category');
  setIfMissing('description');
  return base;
}
