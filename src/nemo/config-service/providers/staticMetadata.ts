import { ProviderModel } from './types';

type StaticEntry = Pick<
  ProviderModel,
  'contextWindow' | 'maxOutputTokens' | 'supportsExtendedOutput'
>;

const ANTHROPIC_CLAUDE_LATEST: StaticEntry = {
  contextWindow: 200000,
  maxOutputTokens: 8192,
  supportsExtendedOutput: true,
};

const ANTHROPIC_CLAUDE_LEGACY: StaticEntry = {
  contextWindow: 200000,
  maxOutputTokens: 4096,
  supportsExtendedOutput: false,
};

const OPENAI_GPT4O: StaticEntry = {
  contextWindow: 128000,
  maxOutputTokens: 16384,
  supportsExtendedOutput: false,
};

const OPENAI_GPT4: StaticEntry = {
  contextWindow: 8192,
  maxOutputTokens: 4096,
  supportsExtendedOutput: false,
};

const OPENAI_GPT35: StaticEntry = {
  contextWindow: 16384,
  maxOutputTokens: 4096,
  supportsExtendedOutput: false,
};

const GEMINI_15_PRO: StaticEntry = {
  contextWindow: 2097152,
  maxOutputTokens: 8192,
  supportsExtendedOutput: false,
};

const GEMINI_15_FLASH: StaticEntry = {
  contextWindow: 1048576,
  maxOutputTokens: 8192,
  supportsExtendedOutput: false,
};

const GEMINI_20: StaticEntry = {
  contextWindow: 1048576,
  maxOutputTokens: 8192,
  supportsExtendedOutput: false,
};

const LLAMA_32: StaticEntry = {
  contextWindow: 128000,
  maxOutputTokens: 4096,
  supportsExtendedOutput: false,
};

const TITAN_TEXT: StaticEntry = {
  contextWindow: 32000,
  maxOutputTokens: 4096,
  supportsExtendedOutput: false,
};

type ProviderCatalog = Record<string, StaticEntry>;

const STATIC_CATALOG: Record<string, ProviderCatalog> = {
  anthropic: {
    'claude-opus-4-7': ANTHROPIC_CLAUDE_LATEST,
    'claude-sonnet-4-6': ANTHROPIC_CLAUDE_LATEST,
    'claude-haiku-4-5': ANTHROPIC_CLAUDE_LATEST,
    'claude-3-5-sonnet-20241022': ANTHROPIC_CLAUDE_LATEST,
    'claude-3-5-haiku-20241022': ANTHROPIC_CLAUDE_LATEST,
    'claude-3-opus-20240229': ANTHROPIC_CLAUDE_LEGACY,
    'claude-3-sonnet-20240229': ANTHROPIC_CLAUDE_LEGACY,
    'claude-3-haiku-20240307': ANTHROPIC_CLAUDE_LEGACY,
  },
  aws_bedrock: {
    'anthropic.claude-3-5-sonnet-20241022-v2:0': ANTHROPIC_CLAUDE_LATEST,
    'anthropic.claude-3-5-haiku-20241022-v1:0': ANTHROPIC_CLAUDE_LATEST,
    'anthropic.claude-3-opus-20240229-v1:0': ANTHROPIC_CLAUDE_LEGACY,
    'meta.llama3-2-90b-instruct-v1:0': LLAMA_32,
    'meta.llama3-2-11b-instruct-v1:0': LLAMA_32,
    'amazon.titan-text-premier-v1:0': TITAN_TEXT,
    'amazon.titan-text-express-v1': TITAN_TEXT,
  },
  openai: {
    'gpt-4o': OPENAI_GPT4O,
    'gpt-4o-mini': OPENAI_GPT4O,
    'gpt-4o-2024-08-06': OPENAI_GPT4O,
    'gpt-4-turbo': { contextWindow: 128000, maxOutputTokens: 4096, supportsExtendedOutput: false },
    'gpt-4': OPENAI_GPT4,
    'gpt-3.5-turbo': OPENAI_GPT35,
    'gpt-3.5-turbo-16k': OPENAI_GPT35,
  },
  azure: {
    'gpt-4o': OPENAI_GPT4O,
    'gpt-4o-mini': OPENAI_GPT4O,
    'gpt-4': OPENAI_GPT4,
    'gpt-35-turbo': OPENAI_GPT35,
    'gpt-35-turbo-16k': OPENAI_GPT35,
  },
  google: {
    'gemini-2.0-flash': GEMINI_20,
    'gemini-2.0-flash-exp': GEMINI_20,
    'gemini-1.5-pro': GEMINI_15_PRO,
    'gemini-1.5-pro-latest': GEMINI_15_PRO,
    'gemini-1.5-flash': GEMINI_15_FLASH,
    'gemini-1.5-flash-latest': GEMINI_15_FLASH,
  },
  gemini: {
    'gemini-2.0-flash': GEMINI_20,
    'gemini-2.0-flash-exp': GEMINI_20,
    'gemini-1.5-pro': GEMINI_15_PRO,
    'gemini-1.5-pro-latest': GEMINI_15_PRO,
    'gemini-1.5-flash': GEMINI_15_FLASH,
    'gemini-1.5-flash-latest': GEMINI_15_FLASH,
  },
  local: {
    'claude-haiku-4-5': ANTHROPIC_CLAUDE_LATEST,
    'claude-sonnet-4-6': ANTHROPIC_CLAUDE_LATEST,
    'claude-opus-4-7': ANTHROPIC_CLAUDE_LATEST,
  },
};

const PROVIDER_FALLBACK: ProviderCatalog = {
  anthropic: { contextWindow: 200000, maxOutputTokens: 4096, supportsExtendedOutput: false },
  openai: { contextWindow: 128000, maxOutputTokens: 4096, supportsExtendedOutput: false },
  azure: { contextWindow: 32000, maxOutputTokens: 4096, supportsExtendedOutput: false },
  google: { contextWindow: 1048576, maxOutputTokens: 8192, supportsExtendedOutput: false },
  gemini: { contextWindow: 1048576, maxOutputTokens: 8192, supportsExtendedOutput: false },
  aws_bedrock: { contextWindow: 128000, maxOutputTokens: 4096, supportsExtendedOutput: false },
  local: { contextWindow: 32000, maxOutputTokens: 4096, supportsExtendedOutput: false },
  openai_compatible: { contextWindow: 32000, maxOutputTokens: 4096, supportsExtendedOutput: false },
};

const FUZZY_RULES: Array<{ test: (id: string) => boolean; entry: StaticEntry }> = [
  { test: id => /claude-(opus|sonnet|haiku)-4/.test(id), entry: ANTHROPIC_CLAUDE_LATEST },
  { test: id => /claude-3-5/.test(id), entry: ANTHROPIC_CLAUDE_LATEST },
  { test: id => /claude-3-/.test(id), entry: ANTHROPIC_CLAUDE_LEGACY },
  { test: id => /gpt-4o/.test(id), entry: OPENAI_GPT4O },
  { test: id => /gpt-4-turbo/.test(id), entry: { contextWindow: 128000, maxOutputTokens: 4096, supportsExtendedOutput: false } },
  { test: id => /gpt-4/.test(id), entry: OPENAI_GPT4 },
  { test: id => /gpt-3\.5|gpt-35/.test(id), entry: OPENAI_GPT35 },
  { test: id => /gemini-2/.test(id), entry: GEMINI_20 },
  { test: id => /gemini-1\.5-pro/.test(id), entry: GEMINI_15_PRO },
  { test: id => /gemini-1\.5-flash/.test(id), entry: GEMINI_15_FLASH },
  { test: id => /llama-?3[._-]2/.test(id), entry: LLAMA_32 },
];

/**
 * Look up static metadata (contextWindow, maxOutputTokens, supportsExtendedOutput)
 * for a registered model by (provider, providerModelId).
 *
 * Resolution order:
 *   1. Exact match in STATIC_CATALOG[provider][providerModelId]
 *   2. Fuzzy match against well-known model name patterns
 *   3. Provider-level fallback (covers any model from a known provider)
 *   4. undefined (caller falls back to its own default)
 */
export function getStaticModelMetadata(
  provider: string | undefined | null,
  providerModelId: string | undefined | null
): StaticEntry | undefined {
  if (!provider) return undefined;
  const catalog = STATIC_CATALOG[provider];
  if (catalog && providerModelId && catalog[providerModelId]) {
    return catalog[providerModelId];
  }
  if (providerModelId) {
    for (const rule of FUZZY_RULES) {
      if (rule.test(providerModelId)) return rule.entry;
    }
  }
  return PROVIDER_FALLBACK[provider];
}
