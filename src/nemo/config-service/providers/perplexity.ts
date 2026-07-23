import { ProviderAdapter, ProviderModel } from './types';

/**
 * Perplexity provider adapter (Bifrost native `perplexity` provider, plain API
 * key). Perplexity's OpenAI-compatible API does NOT expose a `/models` listing
 * endpoint, so there's no cheap live round-trip to enumerate models or verify a
 * key without spending a request. We therefore:
 *   - `validate`: accept any non-empty api_key (a bad key surfaces at first
 *     inference, same as Bifrost's own key check).
 *   - `listModels`: serve a curated static catalog of the current Sonar models
 *     (chat only — Perplexity has no embedding models).
 */
export class PerplexityAdapter implements ProviderAdapter {
  readonly provider = 'perplexity';
  readonly expectedSecretKeys = ['api_key'];

  async validate(credentials: Record<string, string>): Promise<boolean> {
    return Boolean(credentials.api_key);
  }

  async listModels(
    credentials: Record<string, string>,
    _metadata?: Record<string, any>,
    modelType?: 'llm' | 'embedding'
  ): Promise<ProviderModel[]> {
    const apiKey = credentials.api_key;
    if (!apiKey) throw new Error('Missing api_key in credentials');

    if (modelType) {
      return PERPLEXITY_STATIC_MODELS.filter((m) => m.type === modelType);
    }
    return PERPLEXITY_STATIC_MODELS;
  }
}

const PERPLEXITY_STATIC_MODELS: ProviderModel[] = [
  { id: 'sonar', name: 'Sonar', type: 'llm', description: 'Perplexity Sonar', contextWindow: 128000 },
  { id: 'sonar-pro', name: 'Sonar Pro', type: 'llm', description: 'Perplexity Sonar Pro', contextWindow: 200000 },
  { id: 'sonar-reasoning', name: 'Sonar Reasoning', type: 'llm', description: 'Perplexity Sonar Reasoning', contextWindow: 128000 },
  { id: 'sonar-reasoning-pro', name: 'Sonar Reasoning Pro', type: 'llm', description: 'Perplexity Sonar Reasoning Pro', contextWindow: 128000 },
  { id: 'sonar-deep-research', name: 'Sonar Deep Research', type: 'llm', description: 'Perplexity Sonar Deep Research', contextWindow: 128000 },
];
