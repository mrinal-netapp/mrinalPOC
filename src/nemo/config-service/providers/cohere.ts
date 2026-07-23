import axios from 'axios';
import { ProviderAdapter, ProviderModel } from './types';

const BASE_URL = 'https://api.cohere.com';

/**
 * Cohere provider adapter (Bifrost native `cohere` provider, plain API key).
 *
 * Validation + listing use the Cohere `/v1/models` endpoint
 * (https://docs.cohere.com/reference/list-models), which returns each model's
 * supported `endpoints` (e.g. `chat`, `embed`, `rerank`). We surface only the
 * chat + embed models the Add-Model wizard can register and type them from the
 * `endpoints` list. On a listing failure we fall back to a small static catalog
 * of well-known Command / Embed ids so the picker still offers models.
 */
export class CohereAdapter implements ProviderAdapter {
  readonly provider = 'cohere';
  readonly expectedSecretKeys = ['api_key'];

  private headers(apiKey: string): Record<string, string> {
    return { Authorization: `Bearer ${apiKey}` };
  }

  async validate(credentials: Record<string, string>): Promise<boolean> {
    const apiKey = credentials.api_key;
    if (!apiKey) return false;

    try {
      const response = await axios.get(`${BASE_URL}/v1/models?page_size=1`, {
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
      const response = await axios.get(`${BASE_URL}/v1/models?page_size=1000`, {
        headers: this.headers(apiKey),
        timeout: 15000,
      });
      models = (response.data?.models || [])
        .map((m: any) => {
          const id = m.name as string;
          const endpoints: string[] = Array.isArray(m.endpoints) ? m.endpoints : [];
          // Skip rerank/classify-only models — the wizard registers chat and
          // embedding models only.
          if (!endpoints.includes('chat') && !endpoints.includes('embed')) return null;
          const isEmbedding = endpoints.includes('embed') && !endpoints.includes('chat');
          return {
            id,
            name: id,
            type: isEmbedding ? 'embedding' : 'llm',
            description: `Cohere model ${id}`,
            contextWindow: m.context_length,
          } as ProviderModel;
        })
        .filter((m: ProviderModel | null): m is ProviderModel => m !== null);
    } catch {
      models = COHERE_STATIC_MODELS;
    }

    if (modelType) {
      return models.filter((m) => m.type === modelType);
    }
    return models;
  }
}

const COHERE_STATIC_MODELS: ProviderModel[] = [
  { id: 'command-r-plus', name: 'Command R+', type: 'llm', description: 'Cohere Command R+', contextWindow: 128000 },
  { id: 'command-r', name: 'Command R', type: 'llm', description: 'Cohere Command R', contextWindow: 128000 },
  { id: 'command', name: 'Command', type: 'llm', description: 'Cohere Command', contextWindow: 4096 },
  { id: 'embed-english-v3.0', name: 'Embed English v3.0', type: 'embedding', description: 'Cohere Embed English v3.0' },
  { id: 'embed-multilingual-v3.0', name: 'Embed Multilingual v3.0', type: 'embedding', description: 'Cohere Embed Multilingual v3.0' },
];
