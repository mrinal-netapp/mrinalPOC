import axios from 'axios';
import { ProviderAdapter, ProviderModel } from './types';

const BASE_URL = 'https://router.huggingface.co';

/**
 * Hugging Face provider adapter (Bifrost native `huggingface` provider, plain
 * API key). Targets the Hugging Face Inference Router, which exposes an
 * OpenAI-compatible `/v1/models` + `/v1/chat/completions` surface
 * (https://huggingface.co/docs/inference-providers). Validation + listing use
 * `/v1/models` with a Bearer token; a listing failure falls back to a small
 * static catalog of popular chat models.
 *
 * Model ids are org-scoped (e.g. `meta-llama/Llama-3.3-70B-Instruct`) and are
 * passed through verbatim to Bifrost's `huggingface` provider.
 */
export class HuggingFaceAdapter implements ProviderAdapter {
  readonly provider = 'huggingface';
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
        return {
          id,
          name: id,
          // The router's OpenAI-compatible surface serves chat models.
          type: 'llm',
          description: `Hugging Face model ${id}`,
        } as ProviderModel;
      });
    } catch {
      models = HUGGINGFACE_STATIC_MODELS;
    }

    if (modelType) {
      return models.filter((m) => m.type === modelType);
    }
    return models;
  }
}

const HUGGINGFACE_STATIC_MODELS: ProviderModel[] = [
  { id: 'meta-llama/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B Instruct', type: 'llm', description: 'Meta Llama 3.3 70B Instruct', contextWindow: 128000 },
  { id: 'meta-llama/Meta-Llama-3-8B-Instruct', name: 'Llama 3 8B Instruct', type: 'llm', description: 'Meta Llama 3 8B Instruct', contextWindow: 8192 },
  { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', name: 'Mixtral 8x7B Instruct', type: 'llm', description: 'Mistral Mixtral 8x7B Instruct', contextWindow: 32768 },
  { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen2.5 72B Instruct', type: 'llm', description: 'Qwen2.5 72B Instruct', contextWindow: 32768 },
];
