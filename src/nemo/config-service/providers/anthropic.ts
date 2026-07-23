import axios from 'axios';
import { ProviderAdapter, ProviderModel } from './types';

const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';

/**
 * Anthropic (Claude) provider adapter.
 *
 * Validation + listing use the Anthropic `/v1/models` endpoint
 * (https://docs.anthropic.com/en/api/models-list), which requires the
 * `x-api-key` + `anthropic-version` headers. Anthropic serves chat models
 * only (no first-party embeddings — Voyage is recommended and is registered
 * via `openai_compatible`), so every listed model is typed `llm`.
 *
 * On a listing failure we fall back to a small static catalog of well-known
 * Claude ids (the same ids tracked in `staticMetadata.ts`) so the picker
 * still offers models when the account can't hit `/v1/models`.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly provider = 'anthropic';
  readonly expectedSecretKeys = ['api_key'];

  private baseUrl(metadata?: Record<string, any>): string {
    return (metadata?.endpoint as string) || DEFAULT_BASE_URL;
  }

  private headers(apiKey: string): Record<string, string> {
    return {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
    };
  }

  async validate(
    credentials: Record<string, string>,
    metadata?: Record<string, any>
  ): Promise<boolean> {
    const apiKey = credentials.api_key;
    if (!apiKey) return false;

    try {
      const response = await axios.get(`${this.baseUrl(metadata)}/v1/models`, {
        headers: this.headers(apiKey),
        timeout: 8000,
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  async listModels(
    credentials: Record<string, string>,
    metadata?: Record<string, any>,
    modelType?: 'llm' | 'embedding'
  ): Promise<ProviderModel[]> {
    const apiKey = credentials.api_key;
    if (!apiKey) throw new Error('Missing api_key in credentials');

    let models: ProviderModel[];
    try {
      const response = await axios.get(`${this.baseUrl(metadata)}/v1/models`, {
        headers: this.headers(apiKey),
        timeout: 15000,
      });
      models = (response.data?.data || []).map((m: any) => {
        const id = m.id as string;
        return {
          id,
          name: m.display_name || id,
          // Anthropic exposes chat models only through this endpoint.
          type: 'llm',
          description: `Anthropic model ${id}`,
          contextWindow: 200000,
          metadata: { created_at: m.created_at },
        } as ProviderModel;
      });
    } catch {
      models = ANTHROPIC_STATIC_MODELS;
    }

    if (modelType) {
      return models.filter((m) => m.type === modelType);
    }
    return models;
  }
}

const ANTHROPIC_STATIC_MODELS: ProviderModel[] = [
  { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', type: 'llm', description: 'Anthropic Claude 3.5 Sonnet', contextWindow: 200000 },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', type: 'llm', description: 'Anthropic Claude 3.5 Haiku', contextWindow: 200000 },
  { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', type: 'llm', description: 'Anthropic Claude 3 Opus', contextWindow: 200000 },
  { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku', type: 'llm', description: 'Anthropic Claude 3 Haiku', contextWindow: 200000 },
];
