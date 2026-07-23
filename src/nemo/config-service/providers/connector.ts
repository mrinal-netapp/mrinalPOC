import { ProviderAdapter, ProviderModel } from './types';

const CONNECTOR_PROVIDERS: Record<string, { keys: string[]; label: string }> = {
  s3:         { keys: ['access_key_id', 'secret_access_key', 'session_token'], label: 'S3-Compatible Object Store' },
  gcs:        { keys: ['service_account_json'],               label: 'Google Cloud Storage' },
  gcp:        { keys: ['service_account_json'],               label: 'Google Cloud' },
  azure_cloud: { keys: ['tenant_id', 'client_id', 'client_secret'], label: 'Microsoft Azure' },
  postgresql: { keys: ['username', 'password'],               label: 'PostgreSQL' },
  mysql:      { keys: ['username', 'password'],               label: 'MySQL' },
  redash:     { keys: ['api_key'],                            label: 'Redash' },
};

/**
 * Generic adapter for connector credential providers (S3, PostgreSQL, MySQL, GCS).
 * Validation checks that the required secret keys are present and non-empty.
 * Actual connection testing is handled by the connector-worker via Temporal.
 */
class ConnectorCredentialAdapter implements ProviderAdapter {
  readonly provider: string;
  readonly expectedSecretKeys: string[];
  private label: string;

  constructor(provider: string, keys: string[], label: string) {
    this.provider = provider;
    this.expectedSecretKeys = keys;
    this.label = label;
  }

  async validate(
    credentials: Record<string, string>,
    _metadata?: Record<string, any>
  ): Promise<boolean> {
    for (const key of this.expectedSecretKeys) {
      if (!credentials[key] || credentials[key].trim() === '') {
        throw new Error(`Missing required secret key "${key}" for ${this.label} credential`);
      }
    }
    return true;
  }

  async listModels(
    _credentials: Record<string, string>,
    _metadata?: Record<string, any>,
    _modelType?: 'llm' | 'embedding'
  ): Promise<ProviderModel[]> {
    return [];
  }
}

/**
 * S3 credential adapter.
 * Requires access_key_id + secret_access_key. session_token is optional (STS / AWS SSO export).
 */
class S3CredentialAdapter extends ConnectorCredentialAdapter {
  constructor() {
    super('s3', ['access_key_id', 'secret_access_key', 'session_token'], 'S3-Compatible Object Store');
  }

  async validate(
    credentials: Record<string, string>,
    _metadata?: Record<string, any>
  ): Promise<boolean> {
    if (!credentials.access_key_id?.trim()) {
      throw new Error('Missing required secret key "access_key_id" for S3-Compatible Object Store credential');
    }
    if (!credentials.secret_access_key?.trim()) {
      throw new Error('Missing required secret key "secret_access_key" for S3-Compatible Object Store credential');
    }
    return true;
  }
}

/**
 * NetApp ONTAP credential adapter.
 * ONTAP REST supports either basic auth (username + password) or mutual TLS
 * (client_cert_pem + client_key_pem). Either pair satisfies validation.
 * `expectedSecretKeys` lists the union of all five accepted keys so generic
 * UI components can iterate over them.
 */
class OntapCredentialAdapter extends ConnectorCredentialAdapter {
  constructor() {
    super(
      'ontap',
      ['username', 'password', 'client_cert_pem', 'client_key_pem', 'ca_bundle_pem'],
      'NetApp ONTAP',
    );
  }

  async validate(
    credentials: Record<string, string>,
    _metadata?: Record<string, any>
  ): Promise<boolean> {
    const hasBasic =
      typeof credentials.username === 'string' && credentials.username.trim() !== '' &&
      typeof credentials.password === 'string' && credentials.password.trim() !== '';
    const hasMtls =
      typeof credentials.client_cert_pem === 'string' && credentials.client_cert_pem.trim() !== '' &&
      typeof credentials.client_key_pem === 'string' && credentials.client_key_pem.trim() !== '';
    if (!hasBasic && !hasMtls) {
      throw new Error(
        'NetApp ONTAP credential requires either (username + password) or (client_cert_pem + client_key_pem)'
      );
    }
    return true;
  }
}

export function createConnectorAdapters(): ProviderAdapter[] {
  const generic = Object.entries(CONNECTOR_PROVIDERS)
    .filter(([provider]) => provider !== 's3')
    .map(([provider, { keys, label }]) => new ConnectorCredentialAdapter(provider, keys, label));
  return [new S3CredentialAdapter(), ...generic, new OntapCredentialAdapter()];
}

/**
 * Provider ids handled by data-source connector credential adapters — S3, GCS,
 * GCP (Google Cloud, incl. GCNV), Azure cloud, PostgreSQL, MySQL, Redash and
 * NetApp ONTAP. These are persisted in the shared `credentials` table but are
 * never registered on the Bifrost LLM gateway. Callers that only care about
 * model/LLM providers (e.g. the Models > Providers overview) use this to
 * exclude connector credentials so they don't masquerade as model providers.
 */
export function connectorProviderIds(): Set<string> {
  return new Set(createConnectorAdapters().map((a) => a.provider));
}
