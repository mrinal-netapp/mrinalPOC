export interface ProviderSecretField {
  key: string
  label: string
  type: 'text' | 'password'
  required: boolean
  placeholder?: string
  /** Render as a multi-line textarea (used for PEM blocks, JSON keys, etc.) */
  multiline?: boolean
  /** Offer file upload + validation (e.g. GCP service account key JSON). */
  jsonFileUpload?: boolean
}

export interface ProviderMetadataField {
  key: string
  label: string
  placeholder: string
  required?: boolean
}

export interface ProviderPreset {
  label: string
  category: 'Database' | 'Cloud' | 'AI / LLM' | 'External'
  secretFields: ProviderSecretField[]
  metadataFields?: ProviderMetadataField[]
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  postgresql: {
    label: 'PostgreSQL',
    category: 'Database',
    secretFields: [
      { key: 'username', label: 'Username', type: 'text', required: true, placeholder: 'Database username' },
      { key: 'password', label: 'Password', type: 'password', required: true, placeholder: 'Database password' },
    ],
  },
  mysql: {
    label: 'MySQL',
    category: 'Database',
    secretFields: [
      { key: 'username', label: 'Username', type: 'text', required: true, placeholder: 'Database username' },
      { key: 'password', label: 'Password', type: 'password', required: true, placeholder: 'Database password' },
    ],
  },
  s3: {
    label: 'Amazon S3',
    category: 'Cloud',
    secretFields: [
      { key: 'access_key_id', label: 'Access Key ID', type: 'text', required: true, placeholder: 'AKIA...' },
      { key: 'secret_access_key', label: 'Secret Access Key', type: 'password', required: true, placeholder: 'Secret access key' },
    ],
  },
  gcs: {
    label: 'Google Cloud Storage',
    category: 'Cloud',
    secretFields: [
      {
        key: 'service_account_json',
        label: 'Service Account JSON',
        type: 'password',
        required: true,
        placeholder: 'Paste JSON or use Upload JSON file',
        multiline: true,
        jsonFileUpload: true,
      },
    ],
  },
  gcp: {
    label: 'Google Cloud',
    category: 'Cloud',
    secretFields: [
      {
        key: 'service_account_json',
        label: 'Authorization (service account key)',
        type: 'password',
        required: true,
        placeholder: 'Paste JSON or use Upload JSON file',
        multiline: true,
        jsonFileUpload: true,
      },
    ],
  },
  openai: {
    label: 'OpenAI',
    category: 'AI / LLM',
    secretFields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'sk-...' },
    ],
  },
  openai_compatible: {
    label: 'OpenAI Compatible',
    category: 'AI / LLM',
    secretFields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: false, placeholder: 'API key (optional for some endpoints)' },
    ],
    metadataFields: [
      { key: 'endpoint', label: 'Endpoint URL', placeholder: 'https://your-server.example.com', required: true },
    ],
  },
  aws_bedrock: {
    label: 'AWS Bedrock',
    category: 'AI / LLM',
    secretFields: [
      { key: 'aws_access_key_id', label: 'Access Key ID', type: 'text', required: true, placeholder: 'AKIA...' },
      { key: 'aws_secret_access_key', label: 'Secret Access Key', type: 'password', required: true, placeholder: 'Secret key' },
    ],
    metadataFields: [
      { key: 'region', label: 'AWS Region', placeholder: 'us-east-1' },
    ],
  },
  azure_cloud: {
    label: 'Microsoft Azure',
    category: 'Cloud',
    secretFields: [
      { key: 'tenant_id', label: 'Tenant ID', type: 'text', required: true, placeholder: 'Azure AD tenant ID' },
      { key: 'client_id', label: 'Client ID', type: 'text', required: true, placeholder: 'Service principal application (client) ID' },
      { key: 'client_secret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Service principal client secret' },
    ],
  },
  azure: {
    label: 'Azure OpenAI',
    category: 'AI / LLM',
    secretFields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Azure API key' },
    ],
    metadataFields: [
      { key: 'endpoint', label: 'Azure Endpoint', placeholder: 'https://your-resource.openai.azure.com', required: true },
      {
        key: 'api_version',
        label: 'API Version',
        placeholder: '2023-03-15-preview',
      },
      {
        key: 'deployment_names',
        label: 'Deployment names (optional override)',
        placeholder: 'gpt-4o-mini,my-deploy — skip if api-version lists deployments',
        required: false,
      },
    ],
  },
  google: {
    label: 'Google AI',
    category: 'AI / LLM',
    secretFields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Google AI API key' },
    ],
  },
  tavily: {
    label: 'Tavily',
    category: 'External',
    secretFields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'tvly-...' },
    ],
  },
  ontap: {
    label: 'NetApp ONTAP',
    category: 'Cloud',
    secretFields: [
      { key: 'username', label: 'Username', type: 'text', required: false, placeholder: 'ONTAP user (basic auth)' },
      { key: 'password', label: 'Password', type: 'password', required: false, placeholder: 'ONTAP password (basic auth)' },
      {
        key: 'client_cert_pem',
        label: 'Client Certificate (PEM)',
        type: 'password',
        required: false,
        multiline: true,
        placeholder: '-----BEGIN CERTIFICATE-----\n... (mTLS only)',
      },
      {
        key: 'client_key_pem',
        label: 'Client Private Key (PEM)',
        type: 'password',
        required: false,
        multiline: true,
        placeholder: '-----BEGIN PRIVATE KEY-----\n... (mTLS only)',
      },
      {
        key: 'ca_bundle_pem',
        label: 'CA Bundle (PEM, optional)',
        type: 'password',
        required: false,
        multiline: true,
        placeholder: '-----BEGIN CERTIFICATE-----\n... (for self-signed clusters)',
      },
    ],
  },
  redash: {
    label: 'Redash',
    category: 'External',
    secretFields: [
      { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'Redash API key' },
    ],
  },
}

export const PROVIDER_OPTIONS = Object.entries(PROVIDER_PRESETS).map(([key, preset]) => ({
  value: key,
  label: preset.label,
  category: preset.category,
}))

