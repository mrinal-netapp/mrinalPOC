import axios from 'axios';
import { ProviderAdapter, ProviderModel } from './types';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Google Gemini (Google AI Studio) provider adapter.
 *
 * Distinct from the `google` provider (kept as "Google Vertex AI"): this one
 * targets the Gemini Developer API with a plain API key (`?key=`), which is
 * the credential Bifrost's native `gemini` provider expects. Validation +
 * listing use the Generative Language `models` endpoint, with a static
 * fallback catalog when the account can't reach the listing endpoint.
 */
export class GeminiAdapter implements ProviderAdapter {
  readonly provider = 'gemini';
  readonly expectedSecretKeys = ['api_key'];

  async validate(
    credentials: Record<string, string>,
    _metadata?: Record<string, any>
  ): Promise<boolean> {
    const apiKey = credentials.api_key;
    if (!apiKey) return false;

    try {
      const response = await axios.get(`${BASE_URL}?key=${apiKey}`, {
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
      const response = await axios.get(`${BASE_URL}?key=${apiKey}`, {
        timeout: 15000,
      });
      models = (response.data?.models || []).map((m: any) => {
        const id = m.name?.replace('models/', '') || m.name;
        const isEmbedding = id.includes('embedding');
        return {
          id,
          name: m.displayName || id,
          type: isEmbedding ? 'embedding' : 'llm',
          description: m.description || `Google Gemini model ${id}`,
          contextWindow: m.inputTokenLimit,
          metadata: {
            supportedGenerationMethods: m.supportedGenerationMethods,
            inputTokenLimit: m.inputTokenLimit,
            outputTokenLimit: m.outputTokenLimit,
          },
        } as ProviderModel;
      });
    } catch {
      models = GEMINI_STATIC_MODELS;
    }

    if (modelType) {
      return models.filter((m) => m.type === modelType);
    }
    return models;
  }
}

const GEMINI_STATIC_MODELS: ProviderModel[] = [
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', type: 'llm', description: 'Google Gemini 2.0 Flash', contextWindow: 1048576 },
  { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', type: 'llm', description: 'Google Gemini 1.5 Pro', contextWindow: 2097152 },
  { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', type: 'llm', description: 'Google Gemini 1.5 Flash', contextWindow: 1048576 },
  { id: 'gemini-embedding-001', name: 'Gemini Embedding 001', type: 'embedding', description: 'Google Gemini Embedding 001' },
  { id: 'text-embedding-004', name: 'Text Embedding 004', type: 'embedding', description: 'Google Text Embedding 004' },
];
