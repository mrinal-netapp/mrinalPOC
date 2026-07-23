import axios from 'axios';
import { ProviderAdapter, ProviderModel } from './types';

const BASE_URL = 'https://api.fireworks.ai/inference';

/**
 * Fireworks AI provider adapter (Bifrost native `fireworks` provider, plain API
 * key). Fireworks exposes an OpenAI-compatible `/inference/v1/models` +
 * `/inference/v1/chat/completions` surface
 * (https://docs.fireworks.ai/api-reference/list-models). Validation + listing
 * use `/v1/models` with a Bearer token; a listing failure falls back to a small
 * static catalog of popular serverless models.
 *
 * Serverless model ids are account-scoped (e.g.
 * `accounts/fireworks/models/llama-v3p1-70b-instruct`) and are passed through
 * verbatim to Bifrost's `fireworks` provider.
 */
export class FireworksAdapter implements ProviderAdapter {
  readonly provider = 'fireworks';
  readonly expectedSecretKeys = ['api_key'];

  private headers(apiKey: string): Record<string, string> {
    return { Authorization: `Bearer ${apiKey}` };
  }

  async validate(credentials: Record<string, string>): Promise<boolean> {
    const apiKey = credentials.api_key;
    if (!apiKey) return false;

    try {
      const response = await axios.get(`${BASE_URL}/v1/models`, {
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
    _metadata?: Record<string, any>,
    modelType?: 'llm' | 'embedding'
  ): Promise<ProviderModel[]> {
    const apiKey = credentials.api_key;
    if (!apiKey) throw new Error('Missing api_key in credentials');

    let models: ProviderModel[];
    try {
      const response = await axios.get(`${BASE_URL}/v1/models`, {
        headers: this.headers(apiKey),
        timeout: 15000,
      });
      models = (response.data?.data || []).map((m: any) => {
        const id = m.id as string;
        const isEmbedding = id.includes('embedding') || id.includes('embed');
        return {
          id,
          name: id,
          type: isEmbedding ? 'embedding' : 'llm',
          description: `Fireworks AI model ${id}`,
        } as ProviderModel;
      });
    } catch {
      models = FIREWORKS_STATIC_MODELS;
    }

    if (modelType) {
      return models.filter((m) => m.type === modelType);
    }
    return models;
  }
}

const FIREWORKS_STATIC_MODELS: ProviderModel[] = [
  { id: 'accounts/fireworks/models/llama-v3p1-405b-instruct', name: 'Llama 3.1 405B Instruct', type: 'llm', description: 'Fireworks Llama 3.1 405B Instruct', contextWindow: 131072 },
  { id: 'accounts/fireworks/models/llama-v3p1-70b-instruct', name: 'Llama 3.1 70B Instruct', type: 'llm', description: 'Fireworks Llama 3.1 70B Instruct', contextWindow: 131072 },
  { id: 'accounts/fireworks/models/llama-v3p1-8b-instruct', name: 'Llama 3.1 8B Instruct', type: 'llm', description: 'Fireworks Llama 3.1 8B Instruct', contextWindow: 131072 },
  { id: 'accounts/fireworks/models/mixtral-8x7b-instruct', name: 'Mixtral 8x7B Instruct', type: 'llm', description: 'Fireworks Mixtral 8x7B Instruct', contextWindow: 32768 },
];
