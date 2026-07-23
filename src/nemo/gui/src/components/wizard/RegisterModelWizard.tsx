import { useState, useEffect } from 'react'
import {
  Field,
  Input,
  Dropdown,
  Option,
  Text,
  Checkbox,
  Badge,
  MessageBar,
  MessageBarBody,
  Spinner,
  Button,
  Table,
  TableBody,
  TableCell,
  TableRow,
  TableHeader,
  TableHeaderCell,
  tokens,
} from '@fluentui/react-components'
import { Eye24Regular, EyeOff24Regular } from '@fluentui/react-icons'
import { WizardModal, WizardStep } from './WizardModal'
import {
  credentialApi,
  modelApi,
  Credential,
  ProviderModel,
} from '../../services/api'
import { PROVIDER_PRESETS } from '../../constants/providerPresets'
import {
  defaultProviderDeploymentName,
  PROVIDER_DEPLOYMENT_COLUMN_LABEL,
  resolveProviderDeploymentName,
} from '../../utils/providerDeployment'

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  openai_compatible: 'OpenAI Compatible',
  aws_bedrock: 'AWS Bedrock',
  azure: 'Azure OpenAI',
  google: 'Google AI',
  local: 'Local',
}

function getProviderDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] || provider.charAt(0).toUpperCase() + provider.slice(1)
}

interface RegisterModelWizardProps {
  projectId: string
  provider: string
  onClose: () => void
  onSuccess: () => void
}

interface SelectedModel {
  providerModel: ProviderModel
  displayName: string
  /**
   * Upstream deployment/inference name when it differs from `providerModelId`.
   * Defaults to discovery (`metadata.deployment` or model id); user may override.
   */
  deploymentName?: string
  /**
   * Vector dimensions for embedding models. Prefilled from
   * `ProviderModel.dimensions` (server-side static catalog) when the model
   * is known; user may override or supply manually for catalog-unknown
   * deployments (e.g. custom Azure deployment names, downsized OpenAI v3
   * embeddings, novel vendors). `undefined`/0 sends nothing — the backend
   * cascade (modelRoutes -> embeddingDimensions catalog -> 400) takes over.
   * Required for embedding rows whose `providerModel.dimensions` is not set.
   */
  dimensions?: number
  rateOverride?: Record<string, any>
}

const WIZARD_STEPS: WizardStep[] = [
  { number: 1, title: 'Credentials', description: 'Provide or select credentials' },
  { number: 2, title: 'Select Models', description: 'Choose models to register' },
  { number: 3, title: 'Confirm', description: 'Review and register' },
]

export function RegisterModelWizard({ projectId, provider, onClose, onSuccess }: RegisterModelWizardProps) {
  const isLocal = provider === 'local'
  const isAzure = provider === 'azure'

  // Step state — all providers start at step 1 now (ollama collects endpoint in step 1)
  const [currentStep, setCurrentStep] = useState(1)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Step 1: Credential state
  const [credentialMode, setCredentialMode] = useState<'new' | 'existing'>('new')
  const [existingCredentials, setExistingCredentials] = useState<Credential[]>([])
  const [selectedCredentialId, setSelectedCredentialId] = useState<string>('')
  const [newCredName, setNewCredName] = useState('')
  const [newCredLabels, setNewCredLabels] = useState('model_provider')
  const [secretFields, setSecretFields] = useState<Record<string, string>>({})
  const [metadataFields, setMetadataFields] = useState<Record<string, string>>({})
  const [credentialLoading, setCredentialLoading] = useState(false)
  const [validating, setValidating] = useState(false)
  const [credentialId, setCredentialId] = useState<string>('')
  const [visibleSecrets, setVisibleSecrets] = useState<Record<string, boolean>>({})

  // Step 2: Model selection state
  const [availableModels, setAvailableModels] = useState<ProviderModel[]>([])
  const [selectedModels, setSelectedModels] = useState<Map<string, SelectedModel>>(new Map())
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelTypeFilter, setModelTypeFilter] = useState<'all' | 'llm' | 'embedding'>('all')
  const [manualAzureDeploymentId, setManualAzureDeploymentId] = useState('')
  const [manualAzureDisplayName, setManualAzureDisplayName] = useState('')
  const [manualAzureModelType, setManualAzureModelType] = useState<'llm' | 'embedding'>('llm')

  const secretFieldDefs = PROVIDER_PRESETS[provider]?.secretFields || []
  const metadataFieldDefs = isLocal
    ? [{ key: 'endpoint', label: 'Ollama Endpoint', placeholder: 'http://localhost:11434', required: true }]
    : (PROVIDER_PRESETS[provider]?.metadataFields || [])

  // Load existing credentials
  useEffect(() => {
    if (isLocal) return
    const loadCredentials = async () => {
      try {
        const creds = await credentialApi.list(projectId, { provider })
        setExistingCredentials(creds)
        if (creds.length > 0) {
          setCredentialMode('existing')
          setSelectedCredentialId(creds[0].id)
          setCredentialId(creds[0].id)
        }
      } catch (err) {
        console.error('Failed to load credentials:', err)
      }
    }
    loadCredentials()
  }, [projectId, provider])

  // Step 1 validation and submission
  const handleStep1Next = async () => {
    setFormError(null)

    if (isLocal) {
      const ollamaEndpoint = metadataFields['endpoint']?.trim()
      if (!ollamaEndpoint) {
        setFormError('Endpoint URL is required for the Ollama provider')
        return
      }
      await loadAvailableModels('')
      setCurrentStep(2)
      return
    }

    if (credentialMode === 'existing') {
      if (!selectedCredentialId) {
        setFormError('Please select a credential')
        return
      }
      // Validate existing credential
      setValidating(true)
      try {
        const result = await credentialApi.validate(projectId, selectedCredentialId)
        if (!result.valid) {
          setFormError(result.error || 'Credential validation failed')
          setValidating(false)
          return
        }
        setCredentialId(selectedCredentialId)
        await loadAvailableModels(selectedCredentialId)
        setCurrentStep(2)
      } catch (err: any) {
        setFormError(err.message || 'Validation failed')
      } finally {
        setValidating(false)
      }
    } else {
      // Create new credential
      if (!newCredName.trim()) {
        setFormError('Credential name is required')
        return
      }
      const missingRequired = secretFieldDefs
        .filter(f => f.required)
        .filter(f => !secretFields[f.key]?.trim())
      if (missingRequired.length > 0) {
        setFormError(`Required fields: ${missingRequired.map(f => f.label).join(', ')}`)
        return
      }

      setCredentialLoading(true)
      try {
        const metadata: Record<string, any> = {}
        metadataFieldDefs.forEach(f => {
          if (metadataFields[f.key]?.trim()) {
            metadata[f.key] = metadataFields[f.key].trim()
          }
        })

        const labels = newCredLabels
          .split(',')
          .map(l => l.trim())
          .filter(Boolean)

        const credential = await credentialApi.create(projectId, {
          name: newCredName.trim(),
          provider,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
          labels: labels.length > 0 ? labels : undefined,
          secretData: secretFields,
        })

        // Validate the new credential
        const result = await credentialApi.validate(projectId, credential.id)
        if (!result.valid) {
          setFormError(result.error || 'Credential created but validation failed. You may continue or go back.')
        }

        setCredentialId(credential.id)
        setExistingCredentials(prev => [credential, ...prev])
        await loadAvailableModels(credential.id)
        setCurrentStep(2)
      } catch (err: any) {
        setFormError(err.message || 'Failed to create credential')
      } finally {
        setCredentialLoading(false)
      }
    }
  }

  const loadAvailableModels = async (credId: string) => {
    setModelsLoading(true)
    try {
      const body: any = { provider }
      if (credId) body.credentialId = credId
      const result = await modelApi.listAvailable(projectId, body)
      setAvailableModels(result.models)
    } catch (err: any) {
      console.error('Failed to load available models:', err)
      setFormError(err.message || 'Failed to load models from provider')
    } finally {
      setModelsLoading(false)
    }
  }

  // Local provider loads models after step 1 (endpoint collected there)

  // Step 2: Model selection
  const toggleModelSelection = (model: ProviderModel) => {
    setSelectedModels(prev => {
      const next = new Map(prev)
      if (next.has(model.id)) {
        next.delete(model.id)
      } else {
        next.set(model.id, {
          providerModel: model,
          displayName: model.name,
          deploymentName: defaultProviderDeploymentName(model),
          // Prefill dimensions from the server-side embedding catalog
          // (stamped by modelRoutes.POST /list-available). undefined when
          // the model is unknown — UI surfaces this as a required field.
          dimensions: model.type === 'embedding' ? model.dimensions : undefined,
        })
      }
      return next
    })
  }

  const updateDisplayName = (modelId: string, displayName: string) => {
    setSelectedModels(prev => {
      const next = new Map(prev)
      const entry = next.get(modelId)
      if (entry) {
        next.set(modelId, { ...entry, displayName })
      }
      return next
    })
  }

  const updateDeploymentName = (modelId: string, deploymentName: string) => {
    setSelectedModels(prev => {
      const next = new Map(prev)
      const entry = next.get(modelId)
      if (entry) {
        next.set(modelId, { ...entry, deploymentName })
      }
      return next
    })
  }

  const updateDimensions = (modelId: string, dimensions: number | undefined) => {
    setSelectedModels(prev => {
      const next = new Map(prev)
      const entry = next.get(modelId)
      if (entry) {
        next.set(modelId, { ...entry, dimensions })
      }
      return next
    })
  }

  const handleStep2Next = () => {
    setFormError(null)
    if (selectedModels.size === 0 && (!isAzure || !manualAzureDeploymentId.trim())) {
      setFormError('Please select at least one model')
      return
    }
    // Block step-2 -> step-3 when any embedding row is missing dimensions.
    // The server cascade (modelRoutes -> embeddingDimensions catalog -> 400)
    // already enforces this, but failing at submit time would force the user
    // to re-select; surfacing it here matches the table's red "Required" hint.
    const missingDims: string[] = []
    selectedModels.forEach((entry) => {
      if (entry.providerModel.type !== 'embedding') return
      const dim = entry.dimensions ?? entry.providerModel.dimensions
      if (!dim || dim <= 0) {
        missingDims.push(entry.providerModel.id)
      }
    })
    if (missingDims.length > 0) {
      setFormError(
        `Embedding model(s) require dimensions: ${missingDims.join(', ')}. ` +
        `Set "Dimensions" in the table for each highlighted row.`,
      )
      return
    }
    setCurrentStep(3)
  }

  // Step 3: Submit
  const handleSubmit = async () => {
    setSubmitting(true)
    setFormError(null)
    try {
      const entries = Array.from(selectedModels.values())
      if (isAzure && manualAzureDeploymentId.trim() && !selectedModels.has(manualAzureDeploymentId.trim())) {
        const deploymentId = manualAzureDeploymentId.trim()
        entries.push({
          providerModel: {
            id: deploymentId,
            name: deploymentId,
            type: manualAzureModelType,
            description: 'Azure OpenAI deployment name',
          },
          displayName: manualAzureDisplayName.trim() || deploymentId,
        })
      }

      const ollamaEndpoint = metadataFields['endpoint']?.trim()

      for (const entry of entries) {
        const modelDeploymentName = resolveProviderDeploymentName(
          entry.providerModel,
          entry.deploymentName,
        )
        // Send dimensions only for embedding rows that have an explicit
        // user value. When omitted, the backend cascade falls back to the
        // static catalog (providers/embeddingDimensions.ts) and finally to
        // 400 EMBEDDING_DIMENSIONS_REQUIRED. Don't echo back the prefilled
        // catalog value — that's the catalog's job to resolve server-side.
        const userDim = entry.dimensions
        const sendModelInfo =
          entry.providerModel.type === 'embedding' && userDim && userDim > 0
            ? { dimensions: userDim }
            : undefined
        await modelApi.create(projectId, {
          name: entry.providerModel.id,
          displayName: entry.displayName,
          provider,
          providerModelId: entry.providerModel.id,
          providerDeploymentName: modelDeploymentName,
          credentialId: credentialId || undefined,
          modelType: entry.providerModel.type,
          rateCardOverride: entry.rateOverride,
          endpoint: isLocal && ollamaEndpoint ? ollamaEndpoint : undefined,
          ...(sendModelInfo ? { model_info: sendModelInfo } : {}),
        })
      }
      onSuccess()
    } catch (err: any) {
      setFormError(err.message || 'Failed to register models')
    } finally {
      setSubmitting(false)
    }
  }

  const handleNext = () => {
    if (currentStep === 1) handleStep1Next()
    else if (currentStep === 2) handleStep2Next()
  }

  const handlePrev = () => {
    setFormError(null)
    setCurrentStep(prev => Math.max(1, prev - 1))
  }

  const filteredAvailableModels = modelTypeFilter === 'all'
    ? availableModels
    : availableModels.filter(m => m.type === modelTypeFilter)

  const manualAzureSelected = isAzure && manualAzureDeploymentId.trim().length > 0
  const reviewEntries = [...Array.from(selectedModels.values())]
  if (manualAzureSelected && !selectedModels.has(manualAzureDeploymentId.trim())) {
    const deploymentId = manualAzureDeploymentId.trim()
    reviewEntries.push({
      providerModel: {
        id: deploymentId,
        name: deploymentId,
        type: manualAzureModelType,
        description: 'Azure OpenAI deployment name',
      },
      displayName: manualAzureDisplayName.trim() || deploymentId,
    })
  }

  const effectiveSteps = isLocal
    ? [
        { number: 1, title: 'Endpoint', description: 'Configure local endpoint' },
        { number: 2, title: 'Select Models', description: 'Choose models to register' },
        { number: 3, title: 'Confirm', description: 'Review and register' },
      ]
    : WIZARD_STEPS

  return (
    <WizardModal
      title={`Register Model — ${getProviderDisplayName(provider)}`}
      onClose={onClose}
      onSubmit={handleSubmit}
      submitting={submitting}
      formError={formError}
      currentStep={currentStep}
      onNext={handleNext}
      onPrev={handlePrev}
      steps={effectiveSteps}
      submitLabel="Register"
      onStepClick={(s) => { setFormError(null); setCurrentStep(s) }}
    >
      {/* Step 1: Credentials / endpoint */}
      {currentStep === 1 && isLocal && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <Text size={400} weight="semibold">
            Configure Local Model Endpoint
          </Text>
          {metadataFieldDefs.map(field => (
            <Field key={field.key} label={field.label} required={field.required}>
              <Input
                value={metadataFields[field.key] || ''}
                onChange={(_, data) => setMetadataFields(prev => ({ ...prev, [field.key]: data.value }))}
                placeholder={field.placeholder}
              />
            </Field>
          ))}
        </div>
      )}

      {currentStep === 1 && !isLocal && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <Text size={400} weight="semibold">
            Provide credentials for {getProviderDisplayName(provider)}
          </Text>

          {existingCredentials.length > 0 && (
            <div style={{ display: 'flex', gap: '12px' }}>
              <Button
                appearance={credentialMode === 'existing' ? 'primary' : 'secondary'}
                onClick={() => setCredentialMode('existing')}
                size="small"
              >
                Use Existing
              </Button>
              <Button
                appearance={credentialMode === 'new' ? 'primary' : 'secondary'}
                onClick={() => setCredentialMode('new')}
                size="small"
              >
                Create New
              </Button>
            </div>
          )}

          {credentialMode === 'existing' && existingCredentials.length > 0 ? (
            <Field label="Select credential">
              <Dropdown
                value={existingCredentials.find(c => c.id === selectedCredentialId)?.name || ''}
                selectedOptions={selectedCredentialId ? [selectedCredentialId] : []}
                onOptionSelect={(_, data) => {
                  if (data.optionValue) {
                    setSelectedCredentialId(data.optionValue)
                  }
                }}
              >
                {existingCredentials.map(cred => (
                  <Option key={cred.id} value={cred.id} text={cred.name}>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <Text weight="semibold">{cred.name}</Text>
                      <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                        {cred.provider} {cred.labels?.length ? `· ${cred.labels.join(', ')}` : ''}
                      </Text>
                    </div>
                  </Option>
                ))}
              </Dropdown>
            </Field>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <Field label="Credential Name" required>
                <Input
                  value={newCredName}
                  onChange={(_, data) => setNewCredName(data.value)}
                  placeholder={`My ${provider} credential`}
                />
              </Field>

              {secretFieldDefs.map(field => {
                const isPassword = field.type === 'password'
                const isRevealed = visibleSecrets[field.key]
                return (
                  <Field key={field.key} label={field.label} required={field.required}>
                    <Input
                      type={isPassword && !isRevealed ? 'password' : 'text'}
                      value={secretFields[field.key] || ''}
                      onChange={(_, data) => setSecretFields(prev => ({ ...prev, [field.key]: data.value }))}
                      placeholder={field.placeholder}
                      contentAfter={isPassword ? (
                        <Button
                          appearance="transparent"
                          size="small"
                          icon={isRevealed ? <EyeOff24Regular /> : <Eye24Regular />}
                          onClick={() => setVisibleSecrets(prev => ({ ...prev, [field.key]: !prev[field.key] }))}
                          aria-label={isRevealed ? 'Hide value' : 'Show value'}
                          style={{ minWidth: 'auto', padding: '2px' }}
                        />
                      ) : undefined}
                    />
                  </Field>
                )
              })}

              {metadataFieldDefs.map(field => (
                <Field key={field.key} label={field.label} required={field.required}>
                  <Input
                    value={metadataFields[field.key] || ''}
                    onChange={(_, data) => setMetadataFields(prev => ({ ...prev, [field.key]: data.value }))}
                    placeholder={field.placeholder}
                  />
                </Field>
              ))}

              <Field label="Labels (comma-separated)">
                <Input
                  value={newCredLabels}
                  onChange={(_, data) => setNewCredLabels(data.value)}
                  placeholder="model_provider, bedrock"
                />
              </Field>
            </div>
          )}

          {(validating || credentialLoading) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Spinner size="tiny" />
              <Text size={200}>{validating ? 'Validating...' : 'Creating credential...'}</Text>
            </div>
          )}
        </div>
      )}

      {/* Step 2: Model Selection */}
      {currentStep === 2 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {isAzure && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <MessageBar intent="info">
                <MessageBarBody>
                  Azure OpenAI chat uses the Azure deployment name, not the base model catalog ID. Enter the deployment name from Azure if the catalog entries do not match your deployment.
                </MessageBarBody>
              </MessageBar>

              <Field label="Azure Deployment Name">
                <Input
                  value={manualAzureDeploymentId}
                  onChange={(_, data) => {
                    setManualAzureDeploymentId(data.value)
                    if (!manualAzureDisplayName.trim()) {
                      setManualAzureDisplayName(data.value)
                    }
                  }}
                  placeholder="e.g. my-gpt-4o-mini-deployment"
                />
              </Field>

              <Field label="Display Name">
                <Input
                  value={manualAzureDisplayName}
                  onChange={(_, data) => setManualAzureDisplayName(data.value)}
                  placeholder="Friendly name shown in AgentStudio"
                />
              </Field>

              <div style={{ display: 'flex', gap: '8px' }}>
                {(['llm', 'embedding'] as const).map(t => (
                  <Button
                    key={t}
                    appearance={manualAzureModelType === t ? 'primary' : 'secondary'}
                    size="small"
                    onClick={() => setManualAzureModelType(t)}
                  >
                    {t === 'llm' ? 'LLM Deployment' : 'Embedding Deployment'}
                  </Button>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text size={400} weight="semibold">
              Select models to register ({selectedModels.size} selected)
            </Text>
            <div style={{ display: 'flex', gap: '8px' }}>
              {(['all', 'llm', 'embedding'] as const).map(t => (
                <Button
                  key={t}
                  appearance={modelTypeFilter === t ? 'primary' : 'secondary'}
                  size="small"
                  onClick={() => setModelTypeFilter(t)}
                >
                  {t === 'all' ? 'All' : t.toUpperCase()}
                </Button>
              ))}
            </div>
          </div>

          {modelsLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '32px' }}>
              <Spinner label="Loading models from provider..." />
            </div>
          ) : filteredAvailableModels.length === 0 ? (
            <MessageBar intent="warning">
              <MessageBarBody>No models available for the selected filter.</MessageBarBody>
            </MessageBar>
          ) : (
            <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell style={{ width: '40px' }} />
                    <TableHeaderCell>Model</TableHeaderCell>
                    <TableHeaderCell>Type</TableHeaderCell>
                    <TableHeaderCell>Display Name</TableHeaderCell>
                    <TableHeaderCell>{PROVIDER_DEPLOYMENT_COLUMN_LABEL}</TableHeaderCell>
                    <TableHeaderCell>Dimensions</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAvailableModels.map(model => {
                    const isSelected = selectedModels.has(model.id)
                    const entry = selectedModels.get(model.id)
                    const isEmbedding = model.type === 'embedding'
                    const effectiveDim = entry?.dimensions ?? (isEmbedding ? model.dimensions : undefined)
                    const dimensionsMissing = isEmbedding && isSelected && !(effectiveDim && effectiveDim > 0)
                    return (
                      <TableRow
                        key={model.id}
                        style={{
                          cursor: 'pointer',
                          backgroundColor: isSelected ? 'var(--colorBrandBackground2)' : undefined,
                        }}
                      >
                        <TableCell>
                          <Checkbox
                            checked={isSelected}
                            onChange={() => toggleModelSelection(model)}
                          />
                        </TableCell>
                        <TableCell onClick={() => toggleModelSelection(model)}>
                          <div>
                            <Text weight="semibold" size={300}>{model.name}</Text>
                            <Text
                              block
                              size={200}
                              style={{ fontFamily: 'monospace', color: tokens.colorNeutralForeground3 }}
                            >
                              {model.id}
                            </Text>
                            {model.description && (
                              <Text block size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                                {model.description}
                              </Text>
                            )}
                          </div>
                        </TableCell>
                        <TableCell onClick={() => toggleModelSelection(model)}>
                          <Badge
                            appearance="tint"
                            color={model.type === 'embedding' ? 'success' : 'brand'}
                          >
                            {model.type}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {isSelected && (
                            <Input
                              size="small"
                              value={entry?.displayName || model.name}
                              onChange={(_, data) => updateDisplayName(model.id, data.value)}
                              placeholder={model.name}
                              style={{ minWidth: '150px' }}
                            />
                          )}
                        </TableCell>
                        <TableCell>
                          {isSelected && (
                            <Input
                              size="small"
                              value={entry?.deploymentName ?? defaultProviderDeploymentName(model)}
                              onChange={(_, data) => updateDeploymentName(model.id, data.value)}
                              placeholder={defaultProviderDeploymentName(model)}
                              style={{ minWidth: '150px' }}
                            />
                          )}
                        </TableCell>
                        <TableCell>
                          {isSelected && isEmbedding ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                              <Input
                                size="small"
                                type="number"
                                min={1}
                                value={effectiveDim != null ? String(effectiveDim) : ''}
                                onChange={(_, data) => {
                                  const raw = data.value.trim()
                                  if (raw === '') {
                                    updateDimensions(model.id, undefined)
                                  } else {
                                    const n = parseInt(raw, 10)
                                    updateDimensions(model.id, Number.isFinite(n) && n > 0 ? n : undefined)
                                  }
                                }}
                                placeholder={model.dimensions ? String(model.dimensions) : 'Required'}
                                style={{ minWidth: '90px' }}
                              />
                              {dimensionsMissing && (
                                <Text size={100} style={{ color: 'var(--colorPaletteRedForeground1)' }}>
                                  Required
                                </Text>
                              )}
                            </div>
                          ) : (
                            <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>—</Text>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      {/* Step 3: Summary and Confirm */}
      {currentStep === 3 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <Text size={400} weight="semibold">
            Review and Confirm
          </Text>

          <div style={{
            padding: '16px',
            borderRadius: '8px',
            backgroundColor: 'var(--colorNeutralBackground2)',
          }}>
            <Text size={300} weight="semibold" block style={{ marginBottom: '8px' }}>
              Provider
            </Text>
            <Text size={300}>
              {getProviderDisplayName(provider)}
            </Text>

            {credentialId && (
              <>
                <Text size={300} weight="semibold" block style={{ marginTop: '12px', marginBottom: '4px' }}>
                  Credential
                </Text>
                <Text size={300}>
                  {existingCredentials.find(c => c.id === credentialId)?.name || credentialId}
                </Text>
              </>
            )}
          </div>

          <div>
            <Text size={300} weight="semibold" block style={{ marginBottom: '12px' }}>
              Models to Register ({reviewEntries.length})
            </Text>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Model ID</TableHeaderCell>
                  <TableHeaderCell>Display Name</TableHeaderCell>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>{PROVIDER_DEPLOYMENT_COLUMN_LABEL}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reviewEntries.map(entry => (
                  <TableRow key={entry.providerModel.id}>
                    <TableCell>
                      <Text style={{ fontFamily: 'monospace', fontSize: '12px' }}>
                        {entry.providerModel.id}
                      </Text>
                    </TableCell>
                    <TableCell>
                      <Text weight="semibold">{entry.displayName}</Text>
                    </TableCell>
                    <TableCell>
                      <Badge
                        appearance="tint"
                        color={entry.providerModel.type === 'embedding' ? 'success' : 'brand'}
                      >
                        {entry.providerModel.type}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Text style={{ fontFamily: 'monospace', fontSize: '12px' }}>
                        {entry.deploymentName?.trim() ||
                          defaultProviderDeploymentName(entry.providerModel)}
                      </Text>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </WizardModal>
  )
}
