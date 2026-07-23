import axios from 'axios';
import { ProviderAdapter, ProviderModel } from './types';

/**
 * OpenAI provider adapter.
 * Uses the OpenAI /v1/models endpoint to list and validate.
 */
export class OpenAIAdapter implements ProviderAdapter {
  readonly provider = 'openai';
  readonly expectedSecretKeys = ['api_key'];

  async validate(
    credentials: Record<string, string>,
    metadata?: Record<string, any>
  ): Promise<boolean> {
    const apiKey = credentials.api_key;
    if (!apiKey) return false;

    const baseUrl = metadata?.endpoint || 'https://api.openai.com';
    const response = await axios.get(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 8000,
    });
    return response.status === 200;
  }

  async listModels(
    credentials: Record<string, string>,
    metadata?: Record<string, any>,
    modelType?: 'llm' | 'embedding'
  ): Promise<ProviderModel[]> {
    const apiKey = credentials.api_key;
    if (!apiKey) throw new Error('Missing api_key in credentials');

    const baseUrl = metadata?.endpoint || 'https://api.openai.com';
    const response = await axios.get(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 15000,
    });

    const models: ProviderModel[] = (response.data?.data || []).map((m: any) => {
      const id = m.id as string;
      const isEmbedding = id.includes('embedding');
      return {
        id,
        name: id,
        type: isEmbedding ? 'embedding' : 'llm',
        description: `OpenAI model ${id}`,
        metadata: { owned_by: m.owned_by, created: m.created },
      } as ProviderModel;
    });

    if (modelType) {
      return models.filter(m => m.type === modelType);
    }
    return models;
  }
}
