import { ProviderAdapter, ProviderModel } from './types';

/**
 * Ollama provider adapter.
 *
 * Exposes a static catalog of Ollama-served LLMs (Llama 3.2 family,
 * Mistral) without requiring a credential -- the model identifiers are
 * Ollama tag names that the operator must have already pulled on the
 * Ollama server. The Ollama server endpoint is supplied per-model at
 * registration time via the wizard's `endpoint` metadata field.
 *
 * Note: this adapter does NOT include sentence-transformer embeddings
 * (Nomic, all-MiniLM, etc.) -- those aren't served by Ollama in the
 * shape we expose. A separate adapter for an embedding-server provider
 * (TEI / sentence-transformers / etc.) is tracked as a follow-up.
 */
export class OllamaAdapter implements ProviderAdapter {
  readonly provider = 'ollama';
  readonly expectedSecretKeys: string[] = [];

  async validate(
    _credentials: Record<string, string>,
    _metadata?: Record<string, any>
  ): Promise<boolean> {
    return true;
  }

  async listModels(
    _credentials: Record<string, string>,
    _metadata?: Record<string, any>,
    modelType?: 'llm' | 'embedding'
  ): Promise<ProviderModel[]> {
    const ollamaModels: ProviderModel[] = [
      {
        id: 'llama3.2-3b',
        name: 'Llama 3.2 3B',
        type: 'llm',
        description: 'Meta Llama 3.2 3B served via Ollama',
        contextWindow: 128000,
        metadata: { compute: 'CPU/GPU', size: '3B', gpu: 'optional' },
      },
      {
        id: 'llama3.2-1b',
        name: 'Llama 3.2 1B',
        type: 'llm',
        description: 'Meta Llama 3.2 1B served via Ollama',
        contextWindow: 128000,
        metadata: { compute: 'CPU', size: '1B', gpu: 'none' },
      },
      {
        id: 'mistral-7b-instruct',
        name: 'Mistral 7B Instruct',
        type: 'llm',
        description: 'Mistral 7B Instruct served via Ollama',
        contextWindow: 32768,
        metadata: { compute: 'GPU', size: '7B', gpu: 'required' },
      },
    ];

    if (modelType) {
      return ollamaModels.filter((m) => m.type === modelType);
    }
    return ollamaModels;
  }
}
