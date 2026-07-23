import axios from 'axios';
import { ProviderAdapter, ProviderModel } from './types';

/**
 * OpenAI-compatible provider adapter.
 * Works with any endpoint that exposes an OpenAI-compatible /v1/models API.
 * Requires metadata.endpoint (the custom base URL) and api_key in credentials.
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly provider = 'openai_compatible';
  readonly expectedSecretKeys = ['api_key'];

  async validate(
    credentials: Record<string, string>,
    metadata?: Record<string, any>
  ): Promise<boolean> {
    const apiKey = credentials.api_key;
    const baseUrl = metadata?.endpoint;
    if (!baseUrl) throw new Error('metadata.endpoint is required for openai_compatible provider');

    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await axios.get(`${baseUrl}/v1/models`, {
      headers,
      timeout: 8000,
    });
    return response.status === 200;
  }

  async listModels(
    credentials: Record<string, string>,
    metadata?: Record<string, any>,
    modelType?: 'llm' | 'embedding'
  ): Promise<ProviderModel[]> {
    const baseUrl = metadata?.endpoint;
    if (!baseUrl) throw new Error('metadata.endpoint is required for openai_compatible provider');

    const apiKey = credentials.api_key;
    const headers: Record<string, string> = {};
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await axios.get(`${baseUrl}/v1/models`, {
      headers,
      timeout: 15000,
    });

    const models: ProviderModel[] = (response.data?.data || []).map((m: any) => {
      const id = m.id as string;
      const isEmbedding = id.includes('embedding');
      return {
        id,
        name: id,
        type: isEmbedding ? 'embedding' : 'llm',
        description: `${id} (OpenAI-compatible)`,
        metadata: { owned_by: m.owned_by, created: m.created },
      } as ProviderModel;
    });

    if (modelType) {
      return models.filter(m => m.type === modelType);
    }
    return models;
  }
}
