import { ProviderAdapter, ProviderModel } from './types';

/**
 * Google Vertex AI provider adapter.
 *
 * Vertex authenticates with a service-account JSON scoped to a GCP
 * `project_id` + `region` (mapped to Bifrost's native `vertex` provider via
 * `vertex_key_config`). This is distinct from the `gemini` provider, which
 * uses a plain Google AI Studio API key.
 *
 * `validate` does a structural check (project_id present + service-account JSON
 * parses and declares a credential `type`) rather than a live token exchange —
 * minting a Vertex OAuth token would require a GCP auth library and network
 * egress we don't want on the credential-save path. `listModels` returns a
 * curated static catalog because live Vertex model discovery needs an OAuth
 * token and a region-specific endpoint.
 */
export class GoogleAdapter implements ProviderAdapter {
  readonly provider = 'google';
  readonly expectedSecretKeys = ['service_account_json'];

  async validate(
    credentials: Record<string, string>,
    metadata?: Record<string, any>
  ): Promise<boolean> {
    const projectId = metadata?.project_id || metadata?.projectId;
    if (!projectId) return false;

    const serviceAccountJson =
      credentials.service_account_json || credentials.auth_credentials;
    // Empty credentials are allowed (ADC / IAM role auth); when provided, the
    // JSON must parse and declare a credential `type` (service_account, ...).
    if (!serviceAccountJson || serviceAccountJson.trim() === '') {
      return true;
    }
    try {
      const parsed = JSON.parse(serviceAccountJson) as { type?: unknown };
      return typeof parsed.type === 'string' && parsed.type.trim() !== '';
    } catch {
      return false;
    }
  }

  async listModels(
    _credentials: Record<string, string>,
    _metadata?: Record<string, any>,
    modelType?: 'llm' | 'embedding'
  ): Promise<ProviderModel[]> {
    const models: ProviderModel[] = VERTEX_STATIC_MODELS;
    if (modelType) {
      return models.filter((m) => m.type === modelType);
    }
    return models;
  }
}

const VERTEX_STATIC_MODELS: ProviderModel[] = [
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', type: 'llm', description: 'Vertex AI Gemini 2.0 Flash', contextWindow: 1048576 },
  { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', type: 'llm', description: 'Vertex AI Gemini 1.5 Pro', contextWindow: 2097152 },
  { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', type: 'llm', description: 'Vertex AI Gemini 1.5 Flash', contextWindow: 1048576 },
  { id: 'text-embedding-004', name: 'Text Embedding 004', type: 'embedding', description: 'Vertex AI Text Embedding 004' },
  { id: 'text-multilingual-embedding-002', name: 'Text Multilingual Embedding 002', type: 'embedding', description: 'Vertex AI Multilingual Embedding 002' },
];
