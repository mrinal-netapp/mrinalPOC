import { useState, useRef, useImperativeHandle, forwardRef } from 'react'
import {
  Field,
  Input,
  Textarea,
  Dropdown,
  Option,
  Button,
  Spinner,
  Text,
  tokens,
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogContent,
  DialogActions,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components'
import {
  PlugConnected24Regular,
  CheckmarkCircle24Regular,
  DismissCircle24Regular,
  Add16Regular,
  FolderOpen24Regular,
} from '@fluentui/react-icons'
import type { ConnectorType } from '../../services/api'
import { CredentialSecretFields } from '../CredentialSecretFields'
import { PROVIDER_PRESETS } from '../../constants/providerPresets'
import { normalizeProviderSecretData } from '../../utils/gcpServiceAccountJson'

export interface ConnectorFormData {
  name: string
  description: string
  connectorType: ConnectorType
  credentialId: string
  // Database fields
  databaseType?: 'postgresql' | 'mysql'
  host?: string
  port?: number
  database?: string
  schema?: string
  sslMode?: string
  // Object store / cloud / storage / api provider id. Metrics are now served
  // by the unified `ontap` and `gcp` connectors via metric_category resource
  // selectors, so the dedicated metrics provider IDs are gone from this union.
  provider?: 's3' | 'gcs' | 'gcp' | 'ontap' | 'redash'
  endpoint?: string
  bucket?: string
  prefix?: string
  region?: string
  // Cloud account fields
  projectId?: string
  defaultRegion?: string
  // Storage system fields (NetApp ONTAP and similar)
  clusterUrl?: string
  verifyTls?: boolean
  defaultSvm?: string
  // API connector fields
  baseUrl?: string
  includeQueryResults?: boolean
  includeDashboards?: boolean
  includeDataSources?: boolean
  maxResultRows?: number
}

export interface ConnectorWizardProps {
  step: number
  formData: ConnectorFormData
  updateFormField: (field: keyof ConnectorFormData, value: any) => void
  credentials?: Array<{ id: string; name: string; provider: string }>
  onTestConnection?: () => Promise<{ success: boolean; message: string }>
  onCreateCredential?: (data: {
    name: string
    provider: string
    secretData: Record<string, string>
    labels?: string[]
  }) => Promise<{ id: string; name: string; provider: string }>
  /** Called when user clicks Browse to list buckets (S3-compatible). Optional; only for object store. */
  onBrowseBuckets?: () => void
  /** True while listing buckets (enables loading state on Browse button). */
  browseBucketsLoading?: boolean
  /**
   * When `summary`, step 1 shows a read-only connector kind line instead of the coarse type dropdown
   * (used after picking a template so users cannot drift from template-derived defaults).
   */
  connectorTypeSelection?: 'dropdown' | 'summary'
  /** Display text for summary mode, e.g. `Database · PostgreSQL`. */
  connectorTypeSummary?: string
  /** Opens the template picker again and resets the create flow. */
  onRequestChangeConnectorType?: () => void
  /**
   * When set, changing the coarse connector type replaces the whole form (name/description preserved,
   * credential cleared, type-specific fields reset) so edit mode cannot carry stale fields across types.
   */
  applyFullFormData?: (data: ConnectorFormData) => void
}

export interface ConnectorWizardRef {
  focusBucketInput: () => void
}

/** Fluent Dropdown may emit string or boolean option values; avoid brittle === 'true' only. */
function tlsVerifyFromDropdownOption(
  optionValue: string | number | boolean | undefined,
): boolean | null {
  if (optionValue === true || optionValue === 'true' || optionValue === 'yes') return true
  if (optionValue === false || optionValue === 'false' || optionValue === 'no') return false
  return null
}

function deriveProvider(formData: ConnectorFormData): string {
  if (formData.connectorType === 'database') {
    return formData.databaseType || 'postgresql'
  }
  if (formData.connectorType === 'cloud') {
    return formData.provider || 'gcp'
  }
  if (formData.connectorType === 'storage') {
    return formData.provider || 'ontap'
  }
  if (formData.connectorType === 'api') {
    return formData.provider || 'redash'
  }
  return formData.provider || 's3'
}

/** Defaults when switching coarse connector type: credential cleared and fields match the new type. */
export function createEmptyConnectorFormDataForType(connectorType: ConnectorType): ConnectorFormData {
  const shared: ConnectorFormData = {
    name: '',
    description: '',
    connectorType: connectorType,
    credentialId: '',
    databaseType: 'postgresql',
    host: '',
    port: 5432,
    database: '',
    schema: 'public',
    sslMode: 'prefer',
    provider: 's3',
    bucket: '',
    endpoint: undefined,
    prefix: undefined,
    region: undefined,
    projectId: '',
    defaultRegion: '',
    clusterUrl: '',
    verifyTls: true,
    defaultSvm: '',
    baseUrl: '',
    includeQueryResults: true,
    includeDashboards: true,
    includeDataSources: true,
    maxResultRows: 10000,
  }

  switch (connectorType) {
    case 'database':
      return shared
    case 'objectstore':
      return {
        ...shared,
        connectorType: 'objectstore',
        provider: 's3',
        region: 'us-east-1',
        bucket: '',
        databaseType: undefined,
        host: '',
        port: undefined,
        database: '',
        schema: undefined,
        sslMode: undefined,
      }
    case 'cloud':
      return {
        ...shared,
        connectorType: 'cloud',
        provider: 'gcp',
        projectId: '',
        defaultRegion: '',
        databaseType: undefined,
        host: '',
        port: undefined,
        database: '',
        schema: undefined,
        sslMode: undefined,
        bucket: '',
        region: undefined,
      }
    case 'storage':
      return {
        ...shared,
        connectorType: 'storage',
        provider: 'ontap',
        clusterUrl: '',
        verifyTls: true,
        defaultSvm: '',
        databaseType: undefined,
        host: '',
        port: undefined,
        database: '',
        schema: undefined,
        sslMode: undefined,
        bucket: '',
        region: undefined,
      }
    case 'api':
      return {
        ...shared,
        connectorType: 'api',
        provider: 'redash',
        baseUrl: '',
        verifyTls: true,
        databaseType: undefined,
        host: '',
        port: undefined,
        database: '',
        schema: undefined,
        sslMode: undefined,
        bucket: '',
        region: undefined,
        clusterUrl: '',
      }
  }
}

export function switchCoarseConnectorTypePreserveIdentity(
  prev: ConnectorFormData,
  next: ConnectorType,
): ConnectorFormData {
  const empty = createEmptyConnectorFormDataForType(next)
  return {
    ...empty,
    name: prev.name,
    description: prev.description,
  }
}

export const ConnectorWizard = forwardRef<ConnectorWizardRef, ConnectorWizardProps>(function ConnectorWizard({
  step,
  formData,
  updateFormField,
  credentials = [],
  onTestConnection,
  onCreateCredential,
  onBrowseBuckets,
  browseBucketsLoading = false,
  connectorTypeSelection = 'dropdown',
  connectorTypeSummary,
  onRequestChangeConnectorType,
  applyFullFormData,
}, ref) {
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const bucketInputRef = useRef<HTMLInputElement>(null)

  useImperativeHandle(ref, () => ({
    focusBucketInput: () => {
      const el = bucketInputRef.current
      if (el?.focus) (el as HTMLInputElement).focus()
      else (el as HTMLElement)?.querySelector?.('input')?.focus()
    },
  }), [])
  const [showCredDialog, setShowCredDialog] = useState(false)
  const [credName, setCredName] = useState('')
  const [credSecretData, setCredSecretData] = useState<Record<string, string>>({})
  const [credLabels, setCredLabels] = useState('')
  const [credCreating, setCredCreating] = useState(false)
  const [credError, setCredError] = useState<string | null>(null)

  const resetCredDialog = () => {
    setCredName('')
    setCredSecretData({})
    setCredLabels('')
    setCredError(null)
    setShowCredDialog(false)
  }

  const handleCreateCredential = async () => {
    if (!onCreateCredential) return
    const provider = deriveProvider(formData)
    if (!credName.trim()) {
      setCredError('Name is required')
      return
    }
    const preset = PROVIDER_PRESETS[provider]
    const missingRequired = (preset?.secretFields || [])
      .filter((f) => f.required)
      .filter((f) => !credSecretData[f.key]?.trim())
    if (missingRequired.length > 0) {
      setCredError(`Required fields: ${missingRequired.map((f) => f.label).join(', ')}`)
      return
    }
    if (!preset) {
      const hasAnySecret = Object.entries(credSecretData).some(([k, v]) => k.trim() && v.trim())
      if (!hasAnySecret) {
        setCredError('Add at least one secret field')
        return
      }
    }
    if (Object.keys(credSecretData).length === 0) {
      setCredError('All secret fields are required')
      return
    }
    const normalizedSecrets = normalizeProviderSecretData(provider, credSecretData)
    if (!normalizedSecrets.ok) {
      setCredError(normalizedSecrets.message)
      return
    }
    setCredCreating(true)
    setCredError(null)
    try {
      const labels = credLabels.trim()
        ? credLabels.split(',').map((l) => l.trim()).filter(Boolean)
        : undefined
      const result = await onCreateCredential({
        name: credName.trim(),
        provider,
        secretData: normalizedSecrets.secretData,
        labels,
      })
      updateFormField('credentialId', result.id)
      resetCredDialog()
    } catch (err: any) {
      setCredError(err.message || 'Failed to create credential')
    } finally {
      setCredCreating(false)
    }
  }

  const handleTestConnection = async () => {
    if (!onTestConnection) return
    setTesting(true)
    setTestResult(null)
    try {
      const result = await onTestConnection()
      setTestResult(result)
    } catch (err: any) {
      setTestResult({ success: false, message: err.message || 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  // Step 1: Basic Information
  if (step === 1) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div>
          <h3 style={{ marginBottom: '8px' }}>Basic Information</h3>
          <p style={{ color: 'var(--colorNeutralForeground3)', marginBottom: '20px' }}>
            Provide a name, description, and type for your connector.
          </p>
        </div>

        <Field label="Name" required>
          <Input
            value={formData.name}
            onChange={(e) => updateFormField('name', e.target.value)}
            placeholder="Enter connector name"
          />
        </Field>

        <Field label="Description">
          <Textarea
            value={formData.description}
            onChange={(e) => updateFormField('description', e.target.value)}
            placeholder="Enter description (optional)"
            rows={3}
          />
        </Field>

        <Field label="Connector Type" required>
          {connectorTypeSelection === 'summary' && connectorTypeSummary ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '8px' }}>
              <Text weight="semibold" size={400}>
                {connectorTypeSummary}
              </Text>
              {onRequestChangeConnectorType && (
                <Button appearance="subtle" size="small" onClick={onRequestChangeConnectorType}>
                  Change type
                </Button>
              )}
            </div>
          ) : (
            <Dropdown
              value={
                formData.connectorType === 'database'
                  ? 'Database'
                  : formData.connectorType === 'cloud'
                    ? 'Cloud Account'
                    : formData.connectorType === 'storage'
                      ? 'Storage System'
                      : formData.connectorType === 'api'
                        ? 'API'
                        : 'Object Store'
              }
              onOptionSelect={(_, data) => {
                if (!data.optionValue) return
                const next = data.optionValue as ConnectorType
                if (next === formData.connectorType) return
                if (applyFullFormData) {
                  applyFullFormData(switchCoarseConnectorTypePreserveIdentity(formData, next))
                } else {
                  updateFormField('connectorType', next)
                }
              }}
            >
              <Option value="database">Database</Option>
              <Option value="objectstore">Object Store</Option>
              <Option value="cloud">Cloud Account</Option>
              <Option value="storage">Storage System</Option>
              <Option value="api">API</Option>
            </Dropdown>
          )}
        </Field>

        <Field label="Credential" required>
          <Dropdown
            value={credentials.find(c => c.id === formData.credentialId)?.name || ''}
            onOptionSelect={(_, data) => {
              if (data.optionValue) {
                updateFormField('credentialId', data.optionValue)
              }
            }}
            placeholder="Select a credential"
          >
            {credentials.map((cred) => (
              <Option key={cred.id} value={cred.id} text={`${cred.name} (${cred.provider})`}>
                {`${cred.name} (${cred.provider})`}
              </Option>
            ))}
          </Dropdown>
          {onCreateCredential && (
            <Button
              appearance="subtle"
              size="small"
              icon={<Add16Regular />}
              onClick={() => setShowCredDialog(true)}
              style={{ alignSelf: 'flex-start', marginTop: '4px' }}
            >
              New Credential
            </Button>
          )}
        </Field>

        {onCreateCredential && (
          <Dialog open={showCredDialog} onOpenChange={(_, data) => {
            if (!data.open) resetCredDialog()
          }}>
            <DialogSurface style={{ maxWidth: '480px' }}>
              <DialogTitle>Create Credential</DialogTitle>
              <DialogBody>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    {credError && (
                      <MessageBar intent="error">
                        <MessageBarBody>{credError}</MessageBarBody>
                      </MessageBar>
                    )}
                    <Field label="Name" required>
                      <Input
                        value={credName}
                        onChange={(_, d) => setCredName(d.value)}
                        placeholder="e.g. production-db-creds"
                        disabled={credCreating}
                      />
                    </Field>
                    <Field label="Provider">
                      <Text size={300} weight="semibold" style={{ padding: '6px 0' }}>
                        {deriveProvider(formData)}
                      </Text>
                      <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                        Derived from the selected connector type.
                      </Text>
                    </Field>
                    <CredentialSecretFields
                      provider={deriveProvider(formData)}
                      secretData={credSecretData}
                      onChange={setCredSecretData}
                      disabled={credCreating}
                    />
                    <Field label="Labels (optional)">
                      <Input
                        value={credLabels}
                        onChange={(_, d) => setCredLabels(d.value)}
                        placeholder="label1, label2"
                        disabled={credCreating}
                      />
                    </Field>
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button
                    appearance="secondary"
                    onClick={resetCredDialog}
                    disabled={credCreating}
                  >
                    Cancel
                  </Button>
                  <Button
                    appearance="primary"
                    onClick={handleCreateCredential}
                    disabled={credCreating}
                  >
                    {credCreating ? 'Creating...' : 'Create Credential'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        )}
      </div>
    )
  }

  // Step 2: Connection Details (type-specific)
  if (step === 2) {
    if (formData.connectorType === 'database') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div>
            <h3 style={{ marginBottom: '8px' }}>Database Connection</h3>
            <p style={{ color: 'var(--colorNeutralForeground3)', marginBottom: '20px' }}>
              Configure your database connection details.
            </p>
          </div>

          <Field label="Database Type" required>
            <Dropdown
              value={formData.databaseType === 'mysql' ? 'MySQL' : 'PostgreSQL'}
              onOptionSelect={(_, data) => {
                if (data.optionValue) {
                  updateFormField('databaseType', data.optionValue as 'postgresql' | 'mysql')
                  if (data.optionValue === 'postgresql') {
                    updateFormField('port', 5432)
                  } else {
                    updateFormField('port', 3306)
                  }
                }
              }}
            >
              <Option value="postgresql">PostgreSQL</Option>
              <Option value="mysql">MySQL</Option>
            </Dropdown>
          </Field>

          <div style={{ display: 'flex', gap: '12px' }}>
            <Field label="Host" required style={{ flex: 2 }}>
              <Input
                value={formData.host || ''}
                onChange={(e) => updateFormField('host', e.target.value)}
                placeholder="e.g. db.example.com"
              />
            </Field>
            <Field label="Port" required style={{ flex: 1 }}>
              <Input
                type="number"
                value={String(formData.port || '')}
                onChange={(e) => updateFormField('port', parseInt(e.target.value) || undefined)}
                placeholder="5432"
              />
            </Field>
          </div>

          <Field label="Database">
            <Input
              value={formData.database || ''}
              onChange={(e) => updateFormField('database', e.target.value)}
              placeholder="Optional — leave blank to browse all databases in the explorer"
            />
          </Field>

          <div style={{ display: 'flex', gap: '12px' }}>
            <Field label="Schema" style={{ flex: 1 }}>
              <Input
                value={formData.schema || ''}
                onChange={(e) => updateFormField('schema', e.target.value)}
                placeholder="public"
              />
            </Field>
            <Field label="SSL Mode" style={{ flex: 1 }}>
              <Dropdown
                value={formData.sslMode || 'prefer'}
                onOptionSelect={(_, data) => {
                  if (data.optionValue) updateFormField('sslMode', data.optionValue)
                }}
              >
                <Option value="disable">Disable</Option>
                <Option value="prefer">Prefer</Option>
                <Option value="require">Require</Option>
                <Option value="verify-ca">Verify CA</Option>
                <Option value="verify-full">Verify Full</Option>
              </Dropdown>
            </Field>
          </div>

          {onTestConnection && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px' }}>
              <Button
                appearance="secondary"
                icon={testing ? <Spinner size="tiny" /> : <PlugConnected24Regular />}
                onClick={handleTestConnection}
                disabled={testing || !formData.host || !formData.port}
              >
                {testing ? 'Testing...' : 'Test Connection'}
              </Button>
              {testResult && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  {testResult.success ? (
                    <CheckmarkCircle24Regular style={{ color: 'var(--colorPaletteGreenForeground1)' }} />
                  ) : (
                    <DismissCircle24Regular style={{ color: 'var(--colorPaletteRedForeground1)' }} />
                  )}
                  <span style={{
                    color: testResult.success
                      ? 'var(--colorPaletteGreenForeground1)'
                      : 'var(--colorPaletteRedForeground1)',
                    fontSize: '13px',
                  }}>
                    {testResult.message}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )
    }

    // Storage System form (NetApp ONTAP, etc.)
    if (formData.connectorType === 'storage') {
      const provider = formData.provider || 'ontap'
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div>
            <h3 style={{ marginBottom: '8px' }}>Storage System</h3>
            <p style={{ color: 'var(--colorNeutralForeground3)', marginBottom: '20px' }}>
              {provider === 'ontap'
                ? 'Configure your NetApp ONTAP cluster connection.'
                : 'Configure your storage system connection.'}
            </p>
          </div>

          <Field label="Cluster URL" required>
            <Input
              value={formData.clusterUrl || ''}
              onChange={(e) => updateFormField('clusterUrl', e.target.value)}
              placeholder="https://cluster.example.com (port optional)"
            />
          </Field>

          <Field label="Verify TLS Certificate">
            <Dropdown
              value={formData.verifyTls === false ? 'No (skip verification)' : 'Yes (default)'}
              onOptionSelect={(_, data) => {
                const tls = tlsVerifyFromDropdownOption(data.optionValue)
                if (tls !== null) updateFormField('verifyTls', tls)
              }}
            >
              <Option value="yes">Yes (default)</Option>
              <Option value="no">No (skip verification)</Option>
            </Dropdown>
            <Text size={200} style={{ color: tokens.colorNeutralForeground3, marginTop: '4px' }}>
              For self-signed clusters, either disable verification or supply ca_bundle_pem in the credential.
            </Text>
          </Field>

          <Field label="Default SVM">
            <Input
              value={formData.defaultSvm || ''}
              onChange={(e) => updateFormField('defaultSvm', e.target.value)}
              placeholder="Optional — when set, browsing scopes to this SVM"
            />
          </Field>

          {onTestConnection && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px' }}>
              <Button
                appearance="secondary"
                icon={testing ? <Spinner size="tiny" /> : <PlugConnected24Regular />}
                onClick={handleTestConnection}
                disabled={testing || !formData.clusterUrl?.trim()}
              >
                {testing ? 'Testing...' : 'Test Connection'}
              </Button>
              {testResult && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  {testResult.success ? (
                    <CheckmarkCircle24Regular style={{ color: 'var(--colorPaletteGreenForeground1)' }} />
                  ) : (
                    <DismissCircle24Regular style={{ color: 'var(--colorPaletteRedForeground1)' }} />
                  )}
                  <span style={{
                    color: testResult.success
                      ? 'var(--colorPaletteGreenForeground1)'
                      : 'var(--colorPaletteRedForeground1)',
                    fontSize: '13px',
                  }}>
                    {testResult.message}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )
    }

    // API Connector form (Redash)
    if (formData.connectorType === 'api') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div>
            <h3 style={{ marginBottom: '8px' }}>API Connector</h3>
            <p style={{ color: 'var(--colorNeutralForeground3)', marginBottom: '20px' }}>
              Connect to a Redash instance to pull queries, dashboards, and data source configurations.
            </p>
          </div>

          <Field label="Base URL" required>
            <Input
              value={formData.baseUrl || ''}
              onChange={(e) => updateFormField('baseUrl', e.target.value)}
              placeholder="https://redash.example.com"
            />
          </Field>

          <Field label="Verify TLS Certificate">
            <Dropdown
              value={formData.verifyTls === false ? 'No (skip verification)' : 'Yes (default)'}
              onOptionSelect={(_, data) => {
                const tls = tlsVerifyFromDropdownOption(data.optionValue)
                if (tls !== null) updateFormField('verifyTls', tls)
              }}
            >
              <Option value="yes">Yes (default)</Option>
              <Option value="no">No (skip verification)</Option>
            </Dropdown>
            <Text size={200} style={{ color: tokens.colorNeutralForeground3, marginTop: '4px' }}>
              Disable if the Redash instance uses a self-signed or internal CA certificate.
            </Text>
          </Field>

          <Field label="Include Query Results">
            <Dropdown
              value={formData.includeQueryResults === false ? 'No' : 'Yes (default)'}
              onOptionSelect={(_, data) => {
                if (data.optionValue !== undefined) {
                  updateFormField('includeQueryResults', data.optionValue === 'true')
                }
              }}
            >
              <Option value="true">Yes (default)</Option>
              <Option value="false">No</Option>
            </Dropdown>
          </Field>

          <Field label="Include Dashboards">
            <Dropdown
              value={formData.includeDashboards === false ? 'No' : 'Yes (default)'}
              onOptionSelect={(_, data) => {
                if (data.optionValue !== undefined) {
                  updateFormField('includeDashboards', data.optionValue === 'true')
                }
              }}
            >
              <Option value="true">Yes (default)</Option>
              <Option value="false">No</Option>
            </Dropdown>
          </Field>

          <Field label="Include Data Sources">
            <Dropdown
              value={formData.includeDataSources === false ? 'No' : 'Yes (default)'}
              onOptionSelect={(_, data) => {
                if (data.optionValue !== undefined) {
                  updateFormField('includeDataSources', data.optionValue === 'true')
                }
              }}
            >
              <Option value="true">Yes (default)</Option>
              <Option value="false">No</Option>
            </Dropdown>
          </Field>

          <Field label="Max Result Rows">
            <Input
              type="number"
              value={String(formData.maxResultRows || 10000)}
              onChange={(e) => updateFormField('maxResultRows', parseInt(e.target.value, 10) || 10000)}
              placeholder="10000"
            />
          </Field>

          {onTestConnection && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px' }}>
              <Button
                appearance="secondary"
                icon={testing ? <Spinner size="tiny" /> : <PlugConnected24Regular />}
                onClick={handleTestConnection}
                disabled={testing || !formData.baseUrl?.trim()}
              >
                {testing ? 'Testing...' : 'Test Connection'}
              </Button>
              {testResult && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  {testResult.success ? (
                    <CheckmarkCircle24Regular style={{ color: 'var(--colorPaletteGreenForeground1)' }} />
                  ) : (
                    <DismissCircle24Regular style={{ color: 'var(--colorPaletteRedForeground1)' }} />
                  )}
                  <span style={{
                    color: testResult.success
                      ? 'var(--colorPaletteGreenForeground1)'
                      : 'var(--colorPaletteRedForeground1)',
                    fontSize: '13px',
                  }}>
                    {testResult.message}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )
    }

    // Cloud Account form
    if (formData.connectorType === 'cloud') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div>
            <h3 style={{ marginBottom: '8px' }}>Cloud Account</h3>
            <p style={{ color: 'var(--colorNeutralForeground3)', marginBottom: '20px' }}>
              Configure your Google Cloud project details.
            </p>
          </div>

          <Field label="Project ID" required>
            <Input
              value={formData.projectId || ''}
              onChange={(e) => updateFormField('projectId', e.target.value)}
              placeholder="e.g. my-gcp-project-123"
            />
          </Field>

          <Field label="Default Region">
            <Input
              value={formData.defaultRegion || ''}
              onChange={(e) => updateFormField('defaultRegion', e.target.value)}
              placeholder="e.g. us-central1 (optional)"
            />
          </Field>

          {onTestConnection && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px' }}>
              <Button
                appearance="secondary"
                icon={testing ? <Spinner size="tiny" /> : <PlugConnected24Regular />}
                onClick={handleTestConnection}
                disabled={testing || !formData.projectId}
              >
                {testing ? 'Testing...' : 'Test Connection'}
              </Button>
              {testResult && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  {testResult.success ? (
                    <CheckmarkCircle24Regular style={{ color: 'var(--colorPaletteGreenForeground1)' }} />
                  ) : (
                    <DismissCircle24Regular style={{ color: 'var(--colorPaletteRedForeground1)' }} />
                  )}
                  <span style={{
                    color: testResult.success
                      ? 'var(--colorPaletteGreenForeground1)'
                      : 'var(--colorPaletteRedForeground1)',
                    fontSize: '13px',
                  }}>
                    {testResult.message}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )
    }

    // Object Store form
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div>
          <h3 style={{ marginBottom: '8px' }}>Object Store Connection</h3>
          <p style={{ color: 'var(--colorNeutralForeground3)', marginBottom: '20px' }}>
            Configure your S3-compatible object store details.
          </p>
        </div>

        <Field label="Provider" required>
          <Dropdown
            value={formData.provider === 'gcs' ? 'GCS' : 'S3'}
            onOptionSelect={(_, data) => {
              if (data.optionValue) {
                updateFormField('provider', data.optionValue as 's3' | 'gcs')
              }
            }}
          >
            <Option value="s3">Amazon S3 / S3-compatible</Option>
            <Option value="gcs">Google Cloud Storage</Option>
          </Dropdown>
        </Field>

        <Field label="Endpoint">
          <Input
            value={formData.endpoint || ''}
            onChange={(e) => updateFormField('endpoint', e.target.value)}
            placeholder="e.g. https://s3.amazonaws.com (leave empty for AWS default)"
          />
        </Field>

        <Field label="Bucket">
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <Input
              ref={bucketInputRef}
              value={formData.bucket ?? ''}
              onChange={(_, data) => updateFormField('bucket', data.value ?? '')}
              placeholder="my-data-bucket (optional — use Browse to list)"
              style={{ flex: 1 }}
            />
            {onBrowseBuckets && (
              <Button
                appearance="secondary"
                icon={<FolderOpen24Regular />}
                onClick={onBrowseBuckets}
                disabled={browseBucketsLoading}
              >
                {browseBucketsLoading ? 'Listing…' : 'Browse'}
              </Button>
            )}
          </div>
        </Field>

        <div style={{ display: 'flex', gap: '12px' }}>
          <Field label="Prefix" style={{ flex: 1 }}>
            <Input
              value={formData.prefix || ''}
              onChange={(e) => updateFormField('prefix', e.target.value)}
              placeholder="data/incoming/"
            />
          </Field>
          <Field label="Region" style={{ flex: 1 }}>
            <Input
              value={formData.region || ''}
              onChange={(e) => updateFormField('region', e.target.value)}
              placeholder="us-east-1"
            />
          </Field>
        </div>

        {onTestConnection && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px' }}>
            <Button
              appearance="secondary"
              icon={testing ? <Spinner size="tiny" /> : <PlugConnected24Regular />}
              onClick={handleTestConnection}
              disabled={testing}
            >
              {testing ? 'Testing...' : 'Test Connection'}
            </Button>
            {testResult && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                {testResult.success ? (
                  <CheckmarkCircle24Regular style={{ color: 'var(--colorPaletteGreenForeground1)' }} />
                ) : (
                  <DismissCircle24Regular style={{ color: 'var(--colorPaletteRedForeground1)' }} />
                )}
                <span style={{
                  color: testResult.success
                    ? 'var(--colorPaletteGreenForeground1)'
                    : 'var(--colorPaletteRedForeground1)',
                  fontSize: '13px',
                }}>
                  {testResult.message}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // Step 3: Review
  if (step === 3) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <div>
          <h3 style={{ marginBottom: '8px' }}>Review & Confirm</h3>
          <p style={{ color: 'var(--colorNeutralForeground3)', marginBottom: '20px' }}>
            Please review your connector configuration before creating it.
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <ReviewSection title="Basic Information">
            <ReviewRow label="Name" value={formData.name} />
            <ReviewRow label="Description" value={formData.description || '-'} />
            <ReviewRow label="Type" value={formData.connectorType} />
            <ReviewRow
              label="Credential"
              value={credentials.find(c => c.id === formData.credentialId)?.name || formData.credentialId}
            />
          </ReviewSection>

          {formData.connectorType === 'database' ? (
            <ReviewSection title="Database Connection">
              <ReviewRow label="Database Type" value={formData.databaseType || '-'} />
              <ReviewRow label="Host" value={formData.host || '-'} />
              <ReviewRow label="Port" value={String(formData.port || '-')} />
              <ReviewRow label="Database" value={formData.database || '-'} />
              <ReviewRow label="Schema" value={formData.schema || 'public'} />
              <ReviewRow label="SSL Mode" value={formData.sslMode || 'prefer'} />
            </ReviewSection>
          ) : formData.connectorType === 'cloud' ? (
            <ReviewSection title="Cloud Account">
              <ReviewRow label="Provider" value="Google Cloud" />
              <ReviewRow label="Project ID" value={formData.projectId || '-'} />
              <ReviewRow label="Default Region" value={formData.defaultRegion || '(none)'} />
            </ReviewSection>
          ) : formData.connectorType === 'storage' ? (
            <ReviewSection title="Storage System">
              <ReviewRow label="Provider" value={formData.provider || 'ontap'} />
              <ReviewRow label="Cluster URL" value={formData.clusterUrl || '-'} />
              <ReviewRow label="Verify TLS" value={formData.verifyTls === false ? 'No' : 'Yes'} />
              <ReviewRow label="Default SVM" value={formData.defaultSvm || '(none)'} />
            </ReviewSection>
          ) : formData.connectorType === 'api' ? (
            <ReviewSection title="API Connection">
              <ReviewRow label="Provider" value={formData.provider || 'redash'} />
              <ReviewRow label="Base URL" value={formData.baseUrl || '-'} />
              <ReviewRow label="Verify TLS" value={formData.verifyTls === false ? 'No' : 'Yes'} />
              <ReviewRow label="Include Query Results" value={formData.includeQueryResults === false ? 'No' : 'Yes'} />
              <ReviewRow label="Include Dashboards" value={formData.includeDashboards === false ? 'No' : 'Yes'} />
              <ReviewRow label="Include Data Sources" value={formData.includeDataSources === false ? 'No' : 'Yes'} />
              <ReviewRow label="Max Result Rows" value={String(formData.maxResultRows || 10000)} />
            </ReviewSection>
          ) : (
            <ReviewSection title="Object Store Connection">
              <ReviewRow label="Provider" value={formData.provider || '-'} />
              <ReviewRow label="Endpoint" value={formData.endpoint || '(default)'} />
              <ReviewRow label="Bucket" value={formData.bucket || '-'} />
              <ReviewRow label="Prefix" value={formData.prefix || '(none)'} />
              <ReviewRow label="Region" value={formData.region || '(default)'} />
            </ReviewSection>
          )}
        </div>
      </div>
    )
  }

  return null
})

function ReviewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 style={{ marginBottom: '12px', fontSize: '16px', fontWeight: 600 }}>{title}</h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>{children}</div>
    </div>
  )
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: 'var(--colorNeutralForeground3)' }}>{label}:</span>
      <span style={{ fontWeight: 500 }}>{value}</span>
    </div>
  )
}
