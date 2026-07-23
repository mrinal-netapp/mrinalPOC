import { useState } from 'react'
import {
  Field,
  Input,
  Dropdown,
  Option,
  Checkbox,
  Textarea,
  Text,
  tokens,
  Card,
  Badge,
  RadioGroup,
  Radio,
  Divider,
  Button,
  Combobox,
} from '@fluentui/react-components'
import {
  Server24Regular,
  Cloud24Regular,
  CheckmarkCircle24Regular,
  ChevronDown24Regular,
  ChevronRight24Regular,
  Add16Regular,
  Dismiss16Regular,
  LockClosed16Regular,
} from '@fluentui/react-icons'
import type {
  CreateMCPServerRequest,
  MCPServerCatalogEntry,
  Credential,
  MCPConnectionParam,
  MCPSecretRef,
  MCPAuthConfig,
} from '../../services/api'

interface MCPServerWizardProps {
  step: number
  formData: CreateMCPServerRequest
  updateFormField: (field: keyof CreateMCPServerRequest, value: any) => void
  catalog?: MCPServerCatalogEntry[]
  isEditing?: boolean
  credentials?: Credential[]
}

// ── Step key mapping ──

function getRemoteStepKey(step: number, isEditing: boolean): string {
  if (isEditing) {
    return ['basic-info', 'connection', 'auth-params', 'tools', 'review'][step - 1] || 'review'
  }
  return ['deploy-type', 'basic-info', 'connection', 'auth-params', 'tools', 'review'][step - 1] || 'review'
}

function getManagedStepKey(step: number, isEditing: boolean): string {
  if (isEditing) {
    return ['config', 'tools', 'review'][step - 1] || 'review'
  }
  return ['deploy-type', 'catalog', 'config', 'tools', 'review'][step - 1] || 'review'
}

// ── Shared styles ──

const categoryColors: Record<string, 'informative' | 'success' | 'warning' | 'danger' | 'important'> = {
  infrastructure: 'important',
  database: 'success',
  filesystem: 'warning',
  development: 'informative',
  general: 'informative',
  monitoring: 'danger',
}

const sectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
}

const paramRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr auto 1fr auto',
  gap: '8px',
  alignItems: 'start',
}

const FIELD_PRESETS = ['api_key', 'token', 'secret', 'password', 'client_id', 'client_secret']

// ── Sub-components ──

function ReviewRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline', padding: '6px 0' }}>
      <Text weight="semibold" size={300} style={{ minWidth: 140, color: tokens.colorNeutralForeground2 }}>
        {label}
      </Text>
      <Text size={300}>{children}</Text>
    </div>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <Text weight="semibold" size={400} style={{ color: tokens.colorNeutralForeground1, marginTop: '4px' }}>
      {children}
    </Text>
  )
}

function CredentialFieldPicker({
  credentials,
  secretRef,
  onChange,
}: {
  credentials: Credential[]
  secretRef: MCPSecretRef | undefined
  onChange: (ref: MCPSecretRef) => void
}) {
  const selectedCred = credentials.find((c) => c.id === secretRef?.credentialId)
  const metadataKeys = selectedCred?.metadata ? Object.keys(selectedCred.metadata) : []
  const fieldOptions = metadataKeys.length > 0 ? metadataKeys : FIELD_PRESETS

  return (
    <div style={{ display: 'flex', gap: '8px', flex: 1 }}>
      <Dropdown
        style={{ minWidth: '140px', flex: 1 }}
        placeholder="Select credential..."
        value={selectedCred?.name || ''}
        selectedOptions={secretRef?.credentialId ? [secretRef.credentialId] : []}
        onOptionSelect={(_, data) => {
          onChange({
            credentialId: data.optionValue as string,
            field: secretRef?.field || '',
          })
        }}
      >
        {credentials.length === 0 ? (
          <Option value="" disabled>No credentials available</Option>
        ) : (
          credentials.map((c) => (
            <Option key={c.id} value={c.id}>{c.name}</Option>
          ))
        )}
      </Dropdown>
      <Combobox
        style={{ minWidth: '120px', flex: 1 }}
        placeholder="Field name..."
        value={secretRef?.field || ''}
        freeform
        onOptionSelect={(_, data) => {
          onChange({
            credentialId: secretRef?.credentialId || '',
            field: data.optionText || '',
          })
        }}
        onChange={(e) => {
          onChange({
            credentialId: secretRef?.credentialId || '',
            field: (e.target as HTMLInputElement).value,
          })
        }}
      >
        {fieldOptions.map((f) => (
          <Option key={f} value={f}>{f}</Option>
        ))}
      </Combobox>
    </div>
  )
}

function ConnectionParamEditor({
  label,
  params,
  onChange,
  credentials,
}: {
  label: string
  params: MCPConnectionParam[]
  onChange: (params: MCPConnectionParam[]) => void
  credentials: Credential[]
}) {
  const updateRow = (index: number, patch: Partial<MCPConnectionParam>) => {
    const updated = [...params]
    updated[index] = { ...updated[index], ...patch }
    if (patch.secretRef !== undefined && patch.value === undefined) {
      delete updated[index].value
    }
    if (patch.value !== undefined && patch.secretRef === undefined) {
      delete updated[index].secretRef
    }
    onChange(updated)
  }

  const addRow = () => {
    onChange([...params, { name: '', value: '', enabled: true }])
  }

  const removeRow = (index: number) => {
    onChange(params.filter((_, i) => i !== index))
  }

  const isSecretRow = (p: MCPConnectionParam) => !!p.secretRef

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <Text weight="semibold" size={300}>{label}</Text>
      {params.length === 0 && (
        <Text size={200} style={{ color: tokens.colorNeutralForeground3, padding: '4px 0' }}>
          No parameters configured.
        </Text>
      )}
      {params.map((param, idx) => (
        <div key={idx} style={paramRowStyle}>
          <Input
            size="small"
            placeholder="Name"
            value={param.name || ''}
            onChange={(_, data) => updateRow(idx, { name: data.value })}
            style={{ minWidth: '100px' }}
          />
          <Dropdown
            size="small"
            style={{ minWidth: '120px' }}
            value={isSecretRow(param) ? 'Secret' : 'Literal'}
            selectedOptions={[isSecretRow(param) ? 'secret' : 'literal']}
            onOptionSelect={(_, data) => {
              if (data.optionValue === 'secret') {
                updateRow(idx, { secretRef: { credentialId: '', field: '' }, value: undefined })
              } else {
                updateRow(idx, { value: '', secretRef: undefined })
              }
            }}
          >
            <Option value="literal">Literal value</Option>
            <Option value="secret">From credential</Option>
          </Dropdown>
          {isSecretRow(param) ? (
            <CredentialFieldPicker
              credentials={credentials}
              secretRef={param.secretRef}
              onChange={(ref) => updateRow(idx, { secretRef: ref })}
            />
          ) : (
            <Input
              size="small"
              placeholder="Value"
              value={param.value || ''}
              onChange={(_, data) => updateRow(idx, { value: data.value })}
            />
          )}
          <Button
            size="small"
            appearance="subtle"
            icon={<Dismiss16Regular />}
            onClick={() => removeRow(idx)}
            title="Remove"
          />
        </div>
      ))}
      <Button
        size="small"
        appearance="subtle"
        icon={<Add16Regular />}
        onClick={addRow}
        style={{ alignSelf: 'flex-start' }}
      >
        Add parameter
      </Button>
    </div>
  )
}

function AuthInjectionSection({
  authConfig,
  onChange,
  credentials,
}: {
  authConfig: MCPAuthConfig | undefined
  onChange: (config: MCPAuthConfig | undefined) => void
  credentials: Credential[]
}) {
  const [expanded, setExpanded] = useState(!!authConfig?.keyName)
  const hasContent = !!authConfig?.keyName

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <Button
        appearance="subtle"
        size="small"
        icon={expanded || hasContent ? <ChevronDown24Regular /> : <ChevronRight24Regular />}
        onClick={() => setExpanded((v) => !v)}
        style={{ alignSelf: 'flex-start', fontWeight: 600 }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          Auth Injection (Advanced)
          {hasContent && !expanded && (
            <Badge appearance="outline" size="small" color="success">
              <LockClosed16Regular style={{ marginRight: '2px' }} />Configured
            </Badge>
          )}
        </span>
      </Button>
      <Text size={200} style={{ color: tokens.colorNeutralForeground3, marginTop: '-4px' }}>
        Inject a secret value into a specific header or query parameter at connection time.
      </Text>
      {(expanded || hasContent) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', paddingLeft: '8px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
            <Field label="Location" size="small">
              <Dropdown
                size="small"
                value={(authConfig?.location || 'header').charAt(0).toUpperCase() + (authConfig?.location || 'header').slice(1)}
                selectedOptions={[authConfig?.location || 'header']}
                onOptionSelect={(_, data) => {
                  onChange({
                    ...(authConfig || { keyName: '', location: 'header' }),
                    location: data.optionValue as 'header' | 'query' | 'cookie',
                  })
                }}
              >
                <Option value="header">Header</Option>
                <Option value="query">Query parameter</Option>
                <Option value="cookie">Cookie</Option>
              </Dropdown>
            </Field>
            <Field label="Key name" size="small">
              <Input
                size="small"
                placeholder={authConfig?.location === 'query' ? 'e.g. apiKey' : 'e.g. Authorization'}
                value={authConfig?.keyName || ''}
                onChange={(_, data) => {
                  onChange({
                    ...(authConfig || { location: 'header', keyName: '' }),
                    keyName: data.value,
                  })
                }}
              />
            </Field>
            {(!authConfig?.location || authConfig.location === 'header') && (
              <Field label="Prefix (optional)" size="small">
                <Input
                  size="small"
                  placeholder="e.g. Bearer "
                  value={authConfig?.prefix || ''}
                  onChange={(_, data) => {
                    onChange({
                      ...(authConfig || { location: 'header', keyName: '' }),
                      prefix: data.value,
                    })
                  }}
                />
              </Field>
            )}
          </div>
          <Field label="Secret source">
            <CredentialFieldPicker
              credentials={credentials}
              secretRef={authConfig?.secretRef}
              onChange={(ref) => {
                onChange({
                  ...(authConfig || { location: 'header', keyName: '' }),
                  secretRef: ref,
                })
              }}
            />
          </Field>
          {hasContent && (
            <Button
              size="small"
              appearance="subtle"
              onClick={() => onChange(undefined)}
              style={{ alignSelf: 'flex-start', color: tokens.colorPaletteRedForeground1 }}
            >
              Remove auth injection
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function ParamReviewTable({
  label,
  params,
  credentials,
}: {
  label: string
  params: MCPConnectionParam[]
  credentials: Credential[]
}) {
  if (!params.length) return null
  return (
    <>
      <ReviewRow label={label}>{`${params.length} configured`}</ReviewRow>
      {params.map((p, i) => {
        const cred = p.secretRef ? credentials.find((c) => c.id === p.secretRef!.credentialId) : null
        const source = p.secretRef
          ? `Cred: ${cred?.name || p.secretRef.credentialId.substring(0, 8)}... / ${p.secretRef.field}`
          : 'Literal'
        return (
          <div key={i} style={{ paddingLeft: '148px', fontSize: '12px', color: tokens.colorNeutralForeground3, padding: '2px 0 2px 148px' }}>
            {p.name} = {source}
          </div>
        )
      })}
    </>
  )
}

// ── Main wizard component ──

export function MCPServerWizard({
  step,
  formData,
  updateFormField,
  catalog = [],
  isEditing,
  credentials = [],
}: MCPServerWizardProps) {
  const [envExpanded, setEnvExpanded] = useState(false)
  const deploymentType = formData.deploymentType || 'remote'

  const stepKey = deploymentType === 'managed'
    ? getManagedStepKey(step, !!isEditing)
    : getRemoteStepKey(step, !!isEditing)

  // ── Deployment Type (shared step 1 for create) ──
  if (stepKey === 'deploy-type') {
    return (
      <div style={sectionStyle}>
        <Text size={400} style={{ color: tokens.colorNeutralForeground2 }}>
          How would you like to set up this MCP server?
        </Text>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
          {[
            {
              type: 'remote' as const,
              icon: <Cloud24Regular />,
              title: 'Remote Server',
              desc: 'Connect to an externally hosted MCP server via HTTP, SSE, or stdio.',
              onSelect: () => {
                updateFormField('deploymentType', 'remote')
                updateFormField('catalogId', undefined)
                updateFormField('managedConfig', undefined)
              },
            },
            {
              type: 'managed' as const,
              icon: <Server24Regular />,
              title: 'Managed Server (K8s Pod)',
              desc: 'Deploy a pre-built MCP server as an isolated Kubernetes pod.',
              onSelect: () => {
                updateFormField('deploymentType', 'managed')
                updateFormField('transport', undefined)
                updateFormField('url', undefined)
                updateFormField('command', undefined)
                updateFormField('args', undefined)
                updateFormField('authType', undefined)
                updateFormField('credentialId', undefined)
              },
            },
          ].map(({ type, icon, title, desc, onSelect }) => {
            const selected = deploymentType === type
            return (
              <Card
                key={type}
                style={{
                  cursor: 'pointer',
                  borderWidth: selected ? 2 : 1,
                  borderStyle: 'solid',
                  borderColor: selected ? tokens.colorBrandBackground : tokens.colorNeutralStroke1,
                  padding: '24px 20px',
                  background: selected ? tokens.colorBrandBackground2 : undefined,
                  transition: 'border-color 0.15s, background 0.15s',
                }}
                onClick={onSelect}
              >
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', textAlign: 'center' }}>
                  <div style={{ color: selected ? tokens.colorBrandForeground1 : tokens.colorNeutralForeground2 }}>
                    {icon}
                  </div>
                  <Text weight="semibold" size={400}>{title}</Text>
                  <Text size={200} style={{ color: tokens.colorNeutralForeground3, lineHeight: '18px' }}>
                    {desc}
                  </Text>
                </div>
              </Card>
            )
          })}
        </div>
      </div>
    )
  }

  // ═══════════ MANAGED DEPLOYMENT STEPS ═══════════

  if (stepKey === 'catalog') {
    return (
      <div style={sectionStyle}>
        <div>
          <Text size={400} weight="semibold">Select MCP Server</Text>
          <Text size={200} block style={{ color: tokens.colorNeutralForeground3, marginTop: '4px' }}>
            Choose from the catalog of pre-approved MCP servers to deploy.
          </Text>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          {catalog.map((entry) => {
            const selected = formData.catalogId === entry.id
            return (
              <Card
                key={entry.id}
                style={{
                  cursor: 'pointer',
                  borderWidth: selected ? 2 : 1,
                  borderStyle: 'solid',
                  borderColor: selected ? tokens.colorBrandBackground : tokens.colorNeutralStroke1,
                  padding: '16px',
                  background: selected ? tokens.colorBrandBackground2 : undefined,
                  transition: 'border-color 0.15s, background 0.15s',
                }}
                onClick={() => {
                  updateFormField('catalogId', entry.id)
                  const defaults: Record<string, string> = {}
                  for (const env of entry.envSchema || []) {
                    if (env.defaultValue && !env.secret) {
                      defaults[env.name] = env.defaultValue
                    }
                  }
                  updateFormField('allowedTools', [])
                  updateFormField('managedConfig', {
                    resourcePreset: entry.resourcePreset,
                    envOverrides: defaults,
                    volumeSize: entry.volumeMounts?.[0]?.sizeDefault,
                  })
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {selected && <CheckmarkCircle24Regular style={{ color: tokens.colorBrandForeground1 }} />}
                    <Text weight="semibold" size={300}>{entry.name}</Text>
                  </div>
                  <Badge
                    appearance="tint"
                    color={categoryColors[entry.category] || 'informative'}
                    size="small"
                  >
                    {entry.category}
                  </Badge>
                </div>
                <Text
                  size={200}
                  style={{ color: tokens.colorNeutralForeground3, marginTop: '8px', display: 'block', lineHeight: '16px' }}
                >
                  {entry.description}
                </Text>
                <div style={{ display: 'flex', gap: '6px', marginTop: '10px', flexWrap: 'wrap' }}>
                  <Badge appearance="outline" size="small">{entry.securityProfile}</Badge>
                  <Badge appearance="outline" size="small">{entry.resourcePreset}</Badge>
                  {entry.requiresRBAC && <Badge appearance="outline" size="small" color="warning">RBAC</Badge>}
                </div>
              </Card>
            )
          })}
        </div>
      </div>
    )
  }

  if (stepKey === 'config') {
    const selectedCatalog = catalog.find((c) => c.id === formData.catalogId)
    return (
      <div style={sectionStyle}>
        <Field label="Name" required>
          <Input
            value={formData.name || ''}
            onChange={(_, data) => updateFormField('name', data.value)}
            placeholder="my_mcp_server (alphanumeric + underscores)"
          />
        </Field>
        <Field label="Description">
          <Textarea
            value={formData.description || ''}
            onChange={(_, data) => updateFormField('description', data.value)}
            placeholder="Optional description for this server instance"
            rows={2}
          />
        </Field>

        {selectedCatalog?.credentialMapping?.expectedProvider && (() => {
          const expected = selectedCatalog.credentialMapping!.expectedProvider
          const matching = credentials.filter((c) => c.provider === expected)
          const selected = matching.find((c) => c.id === formData.runtimeCredentialId)
          return (
            <>
              <Divider />
              <Field
                label={
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    Runtime Credential
                    <Badge appearance="outline" size="small" color="brand">{expected}</Badge>
                  </span>
                }
                required
                hint={`Used by the MCP runtime to authenticate to the wrapped ${expected} system. Distinct from the gateway-auth credential below.`}
              >
                <Dropdown
                  placeholder={
                    matching.length === 0
                      ? `No '${expected}' credentials in this project yet`
                      : 'Select credential...'
                  }
                  value={selected?.name || ''}
                  selectedOptions={formData.runtimeCredentialId ? [formData.runtimeCredentialId] : []}
                  onOptionSelect={(_, data) =>
                    updateFormField('runtimeCredentialId', data.optionValue as string)
                  }
                  disabled={matching.length === 0}
                >
                  {matching.map((c) => (
                    <Option key={c.id} value={c.id} text={c.name}>
                      {c.name}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
            </>
          )
        })()}

        {selectedCatalog?.envSchema && selectedCatalog.envSchema.length > 0 && (() => {
          const allHaveDefaults = selectedCatalog.envSchema.every(
            (e) => e.defaultValue || !e.required
          )
          const hasRequired = selectedCatalog.envSchema.some((e) => e.required && !e.defaultValue)
          return (
            <>
              <Divider />
              <Button
                appearance="subtle"
                size="small"
                icon={envExpanded || hasRequired ? <ChevronDown24Regular /> : <ChevronRight24Regular />}
                onClick={() => setEnvExpanded((v) => !v)}
                style={{ alignSelf: 'flex-start', fontWeight: 600 }}
              >
                Environment Variables
                {allHaveDefaults && !envExpanded && (
                  <Text size={200} style={{ color: tokens.colorNeutralForeground3, marginLeft: '8px' }}>
                    (defaults configured)
                  </Text>
                )}
              </Button>
              {(envExpanded || hasRequired) && selectedCatalog.envSchema.map((envEntry) => (
                <Field
                  key={envEntry.name}
                  label={
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                      {envEntry.name}
                      {envEntry.secret && (
                        <Badge appearance="outline" size="small" color="warning">Secret</Badge>
                      )}
                    </span>
                  }
                  required={envEntry.required}
                  hint={envEntry.description}
                >
                  <Input
                    type={envEntry.secret ? 'password' : 'text'}
                    value={formData.managedConfig?.envOverrides?.[envEntry.name] || ''}
                    onChange={(_, data) => {
                      const current = formData.managedConfig?.envOverrides || {}
                      updateFormField('managedConfig', {
                        ...formData.managedConfig,
                        envOverrides: { ...current, [envEntry.name]: data.value },
                      })
                    }}
                    placeholder={envEntry.defaultValue
                      ? `Default: ${envEntry.defaultValue}`
                      : envEntry.secret ? '••••••••' : `Enter ${envEntry.name}`}
                  />
                </Field>
              ))}
            </>
          )
        })()}

        <Divider />
        <Field label="Resource Preset">
          <RadioGroup
            value={formData.managedConfig?.resourcePreset || selectedCatalog?.resourcePreset || 'small'}
            onChange={(_, data) =>
              updateFormField('managedConfig', {
                ...formData.managedConfig,
                resourcePreset: data.value,
              })
            }
            layout="horizontal"
          >
            <Radio value="small" label="Small (100m / 256Mi)" />
            <Radio value="medium" label="Medium (250m / 512Mi)" />
            <Radio value="large" label="Large (500m / 1Gi)" />
          </RadioGroup>
        </Field>

        {selectedCatalog?.volumeMounts && selectedCatalog.volumeMounts.length > 0 && (
          <Field label="Volume Size">
            <Input
              value={formData.managedConfig?.volumeSize || selectedCatalog.volumeMounts[0].sizeDefault}
              onChange={(_, data) =>
                updateFormField('managedConfig', {
                  ...formData.managedConfig,
                  volumeSize: data.value,
                })
              }
              placeholder="1Gi"
            />
          </Field>
        )}
      </div>
    )
  }

  // ── Tools step (shared between remote and managed) ──
  if (stepKey === 'tools') {
    return (
      <div style={sectionStyle}>
        <Field label="Allowed Tools" hint="Whitelist specific tools (one per line). Leave empty to allow all.">
          <Textarea
            value={(formData.allowedTools || []).join('\n')}
            onChange={(_, data) => updateFormField('allowedTools', data.value.split('\n').filter(Boolean))}
            placeholder="tool_name_1&#10;tool_name_2"
            rows={3}
          />
        </Field>
        <Field label="Disallowed Tools" hint="Blacklist specific tools (one per line).">
          <Textarea
            value={(formData.disallowedTools || []).join('\n')}
            onChange={(_, data) => updateFormField('disallowedTools', data.value.split('\n').filter(Boolean))}
            placeholder="tool_to_block"
            rows={3}
          />
        </Field>
        <Divider />
        <Checkbox
          checked={formData.trust || false}
          onChange={(_, data) => updateFormField('trust', data.checked)}
          label="Trust this server — auto-approve tool calls without confirmation"
        />
      </div>
    )
  }

  // ── Review step ──
  if (stepKey === 'review') {
    if (deploymentType === 'managed') {
      const selectedCatalog = catalog.find((c) => c.id === formData.catalogId)
      return (
        <div style={sectionStyle}>
          <Text weight="semibold" size={400}>Review Configuration</Text>
          <Card style={{ padding: '16px', background: tokens.colorNeutralBackground2 }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <ReviewRow label="Deployment">
                <Badge appearance="filled" color="brand" size="small">Managed (K8s Pod)</Badge>
              </ReviewRow>
              <ReviewRow label="Catalog Server">{selectedCatalog?.name || formData.catalogId}</ReviewRow>
              <ReviewRow label="Name">{formData.name}</ReviewRow>
              {formData.description && (
                <ReviewRow label="Description">{formData.description}</ReviewRow>
              )}
              <Divider style={{ margin: '4px 0' }} />
              <ReviewRow label="Resource Preset">
                <Badge appearance="outline" size="small">
                  {formData.managedConfig?.resourcePreset || 'small'}
                </Badge>
              </ReviewRow>
              {formData.managedConfig?.volumeSize && (
                <ReviewRow label="Volume Size">{formData.managedConfig.volumeSize}</ReviewRow>
              )}
              {selectedCatalog?.credentialMapping?.expectedProvider && (
                <ReviewRow
                  label={`Runtime Credential (${selectedCatalog.credentialMapping.expectedProvider})`}
                >
                  {credentials.find((c) => c.id === formData.runtimeCredentialId)?.name
                    || formData.runtimeCredentialId
                    || <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>(not selected)</Text>}
                </ReviewRow>
              )}
              {formData.managedConfig?.envOverrides &&
                Object.keys(formData.managedConfig.envOverrides).length > 0 && (
                <>
                  <Divider style={{ margin: '4px 0' }} />
                  {Object.entries(formData.managedConfig.envOverrides).map(([key, value]) => {
                    const schema = selectedCatalog?.envSchema?.find((e) => e.name === key)
                    return (
                      <ReviewRow key={key} label={key}>
                        {schema?.secret ? '••••••••' : value}
                      </ReviewRow>
                    )
                  })}
                </>
              )}
              <Divider style={{ margin: '4px 0' }} />
              <ReviewRow label="Trust">{formData.trust ? 'Yes' : 'No'}</ReviewRow>
              {formData.allowedTools?.length ? (
                <ReviewRow label="Allowed Tools">{formData.allowedTools.join(', ')}</ReviewRow>
              ) : null}
              {formData.disallowedTools?.length ? (
                <ReviewRow label="Disallowed Tools">{formData.disallowedTools.join(', ')}</ReviewRow>
              ) : null}
            </div>
          </Card>
        </div>
      )
    }

    // Remote review
    const authCfg = formData.authConfig
    const authCredName = authCfg?.secretRef
      ? credentials.find((c) => c.id === authCfg.secretRef!.credentialId)?.name
      : null
    return (
      <div style={sectionStyle}>
        <Text weight="semibold" size={400}>Review Configuration</Text>
        <Card style={{ padding: '16px', background: tokens.colorNeutralBackground2 }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <ReviewRow label="Deployment">
              <Badge appearance="outline" size="small">Remote</Badge>
            </ReviewRow>
            <ReviewRow label="Name">{formData.name}</ReviewRow>
            {formData.description && (
              <ReviewRow label="Description">{formData.description}</ReviewRow>
            )}
            <Divider style={{ margin: '4px 0' }} />
            <ReviewRow label="Transport">
              <Badge appearance="outline" size="small">
                {formData.transport?.toUpperCase() || 'HTTP'}
              </Badge>
            </ReviewRow>
            {formData.url && <ReviewRow label="URL">{formData.url}</ReviewRow>}
            {formData.command && <ReviewRow label="Command">{formData.command}</ReviewRow>}
            {formData.args?.length ? (
              <ReviewRow label="Arguments">{formData.args.join(', ')}</ReviewRow>
            ) : null}
            <ReviewRow label="Timeout">{formData.timeout || 600000}ms</ReviewRow>
            <Divider style={{ margin: '4px 0' }} />
            <ReviewRow label="Authentication">{formData.authType || 'none'}</ReviewRow>
            {formData.credentialId && (
              <ReviewRow label="Credential">
                {credentials.find((c) => c.id === formData.credentialId)?.name || formData.credentialId}
              </ReviewRow>
            )}
            <ParamReviewTable label="Query Params" params={formData.queryParams || []} credentials={credentials} />
            <ParamReviewTable label="Header Params" params={formData.headerParams || []} credentials={credentials} />
            {formData.extraHeaders?.length ? (
              <ReviewRow label="Forward Headers">{formData.extraHeaders.join(', ')}</ReviewRow>
            ) : null}
            {authCfg?.keyName ? (
              <ReviewRow label="Auth Injection">
                via {authCfg.location}, key={authCfg.keyName}
                {authCfg.prefix ? `, prefix="${authCfg.prefix}"` : ''}
                {authCredName ? `, secret=Cred: ${authCredName}/${authCfg.secretRef?.field}` : ''}
              </ReviewRow>
            ) : null}
            <Divider style={{ margin: '4px 0' }} />
            <ReviewRow label="Trust">{formData.trust ? 'Yes' : 'No'}</ReviewRow>
            {formData.allowedTools?.length ? (
              <ReviewRow label="Allowed Tools">{formData.allowedTools.join(', ')}</ReviewRow>
            ) : null}
            {formData.disallowedTools?.length ? (
              <ReviewRow label="Disallowed Tools">{formData.disallowedTools.join(', ')}</ReviewRow>
            ) : null}
          </div>
        </Card>
      </div>
    )
  }

  // ═══════════ REMOTE-ONLY STEPS ═══════════

  if (stepKey === 'basic-info') {
    return (
      <div style={sectionStyle}>
        <Field label="Name" required>
          <Input
            value={formData.name || ''}
            onChange={(_, data) => updateFormField('name', data.value)}
            placeholder="my_mcp_server (alphanumeric + underscores)"
          />
        </Field>
        <Field label="Description">
          <Textarea
            value={formData.description || ''}
            onChange={(_, data) => updateFormField('description', data.value)}
            placeholder="What does this MCP server provide?"
            rows={3}
          />
        </Field>
      </div>
    )
  }

  if (stepKey === 'connection') {
    return (
      <div style={sectionStyle}>
        <Field label="Transport" required>
          <Dropdown
            value={formData.transport?.toUpperCase() || 'HTTP'}
            selectedOptions={[formData.transport || 'http']}
            onOptionSelect={(_, data) => updateFormField('transport', data.optionValue)}
          >
            <Option value="http">HTTP (Streamable)</Option>
            <Option value="sse">SSE (Server-Sent Events)</Option>
            <Option value="stdio">Stdio (Local Process)</Option>
          </Dropdown>
        </Field>

        {(formData.transport === 'http' || formData.transport === 'sse' || !formData.transport) && (
          <Field label="URL" required hint="Base URL without secret query parameters.">
            <Input
              value={formData.url || ''}
              onChange={(_, data) => updateFormField('url', data.value)}
              placeholder="https://mcp-server.example.com/mcp"
            />
          </Field>
        )}

        {formData.transport === 'stdio' && (
          <>
            <Field label="Command" required>
              <Input
                value={formData.command || ''}
                onChange={(_, data) => updateFormField('command', data.value)}
                placeholder="npx @modelcontextprotocol/server-filesystem"
              />
            </Field>
            <Field label="Arguments" hint="One argument per line.">
              <Textarea
                value={(formData.args || []).join('\n')}
                onChange={(_, data) => updateFormField('args', data.value.split('\n').filter(Boolean))}
                placeholder="/path/to/directory"
                rows={3}
              />
            </Field>
          </>
        )}

        <Divider />
        <Field label="Timeout (ms)" hint="Maximum time to wait for a response from the server.">
          <Input
            type="number"
            value={String(formData.timeout || 600000)}
            onChange={(_, data) => updateFormField('timeout', parseInt(data.value) || 600000)}
          />
        </Field>
      </div>
    )
  }

  if (stepKey === 'auth-params') {
    return (
      <div style={sectionStyle}>
        {/* Authentication */}
        <SectionHeading>Authentication</SectionHeading>
        <Field label="Authentication Type">
          <Dropdown
            value={formData.authType || 'none'}
            selectedOptions={[formData.authType || 'none']}
            onOptionSelect={(_, data) => updateFormField('authType', data.optionValue)}
          >
            <Option value="none">None</Option>
            <Option value="api_key">API Key</Option>
            <Option value="bearer_token">Bearer Token</Option>
            <Option value="basic">Basic Auth</Option>
            <Option value="oauth2">OAuth2</Option>
          </Dropdown>
        </Field>

        {formData.authType === 'oauth2' && (
          <>
            <Field label="Token URL">
              <Input
                value={formData.tokenUrl || ''}
                onChange={(_, data) => updateFormField('tokenUrl', data.value)}
                placeholder="https://auth.example.com/token"
              />
            </Field>
            <Field label="Authorization URL">
              <Input
                value={formData.authorizationUrl || ''}
                onChange={(_, data) => updateFormField('authorizationUrl', data.value)}
                placeholder="https://auth.example.com/authorize"
              />
            </Field>
          </>
        )}

        {formData.authType && formData.authType !== 'none' && (
          <Field label="Credential" hint="Select a credential that stores the secret values.">
            <Dropdown
              placeholder="Select credential..."
              value={credentials.find((c) => c.id === formData.credentialId)?.name || ''}
              selectedOptions={formData.credentialId ? [formData.credentialId] : []}
              onOptionSelect={(_, data) => updateFormField('credentialId', data.optionValue as string)}
            >
              {credentials.length === 0 ? (
                <Option value="" disabled>No credentials available</Option>
              ) : (
                credentials.map((c) => (
                  <Option key={c.id} value={c.id}>{c.name}</Option>
                ))
              )}
            </Dropdown>
          </Field>
        )}

        <Divider />

        {/* Query Parameters */}
        <SectionHeading>Query Parameters</SectionHeading>
        <Text size={200} style={{ color: tokens.colorNeutralForeground3, marginTop: '-12px' }}>
          Parameters appended to the URL at connection time. Use secrets to avoid storing sensitive values in plain text.
        </Text>
        <ConnectionParamEditor
          label=""
          params={formData.queryParams || []}
          onChange={(params) => updateFormField('queryParams', params)}
          credentials={credentials}
        />

        <Divider />

        {/* Header Parameters */}
        <SectionHeading>Header Parameters</SectionHeading>
        <Text size={200} style={{ color: tokens.colorNeutralForeground3, marginTop: '-12px' }}>
          Custom headers sent with every request. Use secrets for API keys and tokens.
        </Text>
        <ConnectionParamEditor
          label=""
          params={formData.headerParams || []}
          onChange={(params) => updateFormField('headerParams', params)}
          credentials={credentials}
        />

        <Divider />

        {/* Static Headers (kept as-is for backward compat) */}
        <Field label="Static Headers (plaintext)" hint="Simple key-value headers as JSON. For secret-backed headers, use Header Parameters above.">
          <Textarea
            value={formData.staticHeaders ? JSON.stringify(formData.staticHeaders, null, 2) : '{}'}
            onChange={(_, data) => {
              try {
                updateFormField('staticHeaders', JSON.parse(data.value))
              } catch { /* ignore invalid JSON while typing */ }
            }}
            placeholder='{"X-Custom-Header": "value"}'
            rows={3}
            style={{ fontFamily: 'monospace', fontSize: '13px' }}
          />
        </Field>

        <Divider />

        <Field
          label="Forward Headers (Bifrost allow-list)"
          hint="One header name per line. These are runtime caller headers Bifrost is allowed to pass through."
        >
          <Textarea
            value={(formData.extraHeaders || []).join('\n')}
            onChange={(_, data) =>
              updateFormField(
                'extraHeaders',
                data.value
                  .split('\n')
                  .map((header) => header.trim())
                  .filter((header, index, arr) => header.length > 0 && arr.indexOf(header) === index)
              )
            }
            placeholder={'Authorization\nX-Project-ID\nX-User-ID\nX-Session-ID\nX-Agent-ID\nX-Team-ID'}
            rows={4}
          />
        </Field>

        <Divider />

        {/* Auth Injection */}
        <AuthInjectionSection
          authConfig={formData.authConfig}
          onChange={(config) => updateFormField('authConfig', config)}
          credentials={credentials}
        />
      </div>
    )
  }

  return null
}
