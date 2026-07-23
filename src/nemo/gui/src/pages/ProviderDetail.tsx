import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  makeStyles,
  tokens,
  Card,
  CardHeader,
  Text,
  Button,
  Spinner,
  MessageBar,
  MessageBarBody,
  Table,
  TableBody,
  TableCell,
  TableRow,
  TableHeader,
  TableHeaderCell,
  Badge,
} from '@fluentui/react-components'
import { ArrowLeft24Regular, Add24Regular } from '@fluentui/react-icons'
import { modelApi, ProviderModel, credentialApi, Credential } from '../services/api'
import { useToast } from '../contexts/ToastContext'
import { RegisterModelWizard } from '../components/wizard/RegisterModelWizard'
import { OpenAIIcon, AWSIcon, AzureIcon, GoogleCloudIcon, LocalServerIcon, ConnectIcon } from '../components/icons'

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
  },
  title: {
    fontSize: '24px',
    fontWeight: '600',
    color: tokens.colorNeutralForeground1,
  },
  subtitle: {
    fontSize: '14px',
    color: tokens.colorNeutralForeground3,
    marginTop: '4px',
  },
  providerLogo: {
    width: '48px',
    height: '48px',
    borderRadius: '12px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '22px',
    fontWeight: '700',
  },
  infoGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
    gap: '12px',
    marginBottom: '8px',
  },
  infoItem: {
    padding: '12px 16px',
    borderRadius: '8px',
    backgroundColor: tokens.colorNeutralBackground2,
  },
})

interface ProviderMeta {
  name: string
  description: string
  color: string
  bgColor: string
  icon: React.ReactNode
  docsUrl?: string
}

const PROVIDER_META: Record<string, ProviderMeta> = {
  openai: {
    name: 'OpenAI',
    description: 'Access GPT-4o, GPT-4, GPT-3.5 Turbo, and embedding models via OpenAI API.',
    color: '#10a37f',
    bgColor: '#e6f7f1',
    icon: <OpenAIIcon style={{ width: 28, height: 28, color: '#10a37f' }} />,
    docsUrl: 'https://platform.openai.com/docs',
  },
  aws_bedrock: {
    name: 'AWS Bedrock',
    description: 'Access Claude, Titan, Llama, and Cohere models through Amazon Bedrock.',
    color: '#ff9900',
    bgColor: '#fff4e0',
    icon: <AWSIcon style={{ width: 28, height: 28 }} />,
    docsUrl: 'https://docs.aws.amazon.com/bedrock/',
  },
  azure: {
    name: 'Azure OpenAI',
    description: 'Access GPT-4, GPT-3.5 Turbo, and embedding models through Azure OpenAI Service.',
    color: '#0078d4',
    bgColor: '#e5f1fb',
    icon: <AzureIcon style={{ width: 28, height: 28 }} />,
    docsUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/openai/',
  },
  google: {
    name: 'Google AI',
    description: 'Access Gemini, PaLM, and text embedding models via Google AI API.',
    color: '#4285f4',
    bgColor: '#e8f0fe',
    icon: <GoogleCloudIcon style={{ width: 28, height: 28 }} />,
    docsUrl: 'https://ai.google.dev/docs',
  },
  openai_compatible: {
    name: 'OpenAI Compatible',
    description: 'Any endpoint with an OpenAI-compatible API (vLLM, Ollama, etc.).',
    color: '#8b5cf6',
    bgColor: '#ede9fe',
    icon: <ConnectIcon style={{ width: 28, height: 28, color: '#8b5cf6' }} />,
  },
  local: {
    name: 'Local',
    description: 'Self-hosted models running on your infrastructure (Llama, Mistral, etc.).',
    color: '#6b7280',
    bgColor: '#f3f4f6',
    icon: <LocalServerIcon style={{ width: 28, height: 28, color: '#6b7280' }} />,
  },
}

export default function ProviderDetail() {
  const styles = useStyles()
  const { projectId, provider } = useParams<{ projectId: string; provider: string }>()
  const navigate = useNavigate()
  const { showToast } = useToast()

  const [availableModels, setAvailableModels] = useState<ProviderModel[]>([])
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)

  const meta = provider ? PROVIDER_META[provider] : null

  const loadData = async () => {
    if (!projectId || !provider) return
    try {
      setLoading(true)
      setError(null)

      // Load credentials for this provider
      const creds = await credentialApi.list(projectId, { provider })
      setCredentials(creds)

      // For local provider or if we have credentials, load available models
      if (provider === 'ollama') {
        const result = await modelApi.listAvailable(projectId, { provider })
        setAvailableModels(result.models)
      } else if (creds.length > 0) {
        // Use the first credential to list available models
        try {
          const result = await modelApi.listAvailable(projectId, {
            provider,
            credentialId: creds[0].id,
          })
          setAvailableModels(result.models)
        } catch (listErr: any) {
          console.warn('Could not list models from provider:', listErr.message)
          setAvailableModels([])
        }
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load provider data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [projectId, provider])

  const handleWizardClose = () => {
    setWizardOpen(false)
    loadData()
  }

  if (!provider || !meta) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>Unknown provider</MessageBarBody>
      </MessageBar>
    )
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
        <Spinner label={`Loading ${meta.name} models...`} />
      </div>
    )
  }

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Button
            appearance="subtle"
            icon={<ArrowLeft24Regular />}
            onClick={() => navigate(`/projects/${projectId}/models`)}
          />
          <div
            className={styles.providerLogo}
            style={{ backgroundColor: meta.bgColor }}
          >
            {meta.icon}
          </div>
          <div>
            <h1 className={styles.title}>{meta.name}</h1>
            <div className={styles.subtitle}>{meta.description}</div>
          </div>
        </div>
        <Button
          appearance="primary"
          icon={<Add24Regular />}
          onClick={() => setWizardOpen(true)}
        >
          Register Model
        </Button>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {/* Info section */}
      <div className={styles.infoGrid}>
        <div className={styles.infoItem}>
          <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>Credentials</Text>
          <Text block weight="semibold" size={500}>{credentials.length}</Text>
        </div>
        <div className={styles.infoItem}>
          <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>Available Models</Text>
          <Text block weight="semibold" size={500}>{availableModels.length}</Text>
        </div>
        {meta.docsUrl && (
          <div className={styles.infoItem}>
            <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>Documentation</Text>
            <a href={meta.docsUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: '13px' }}>
              View Docs
            </a>
          </div>
        )}
      </div>

      {/* Available Models from Provider */}
      <Card>
        <CardHeader
          header={
            <Text weight="semibold">
              Available Models ({availableModels.length})
            </Text>
          }
        />
        {provider !== 'ollama' && credentials.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <Text style={{ color: tokens.colorNeutralForeground3, display: 'block', marginBottom: '12px' }}>
              Add a credential to browse available models from {meta.name}.
            </Text>
            <Button appearance="primary" onClick={() => setWizardOpen(true)}>
              Register Model
            </Button>
          </div>
        ) : availableModels.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <Text style={{ color: tokens.colorNeutralForeground3 }}>
              No models available from this provider.
            </Text>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Model</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Description</TableHeaderCell>
                {provider === 'ollama' ? (
                  <>
                    <TableHeaderCell>Compute</TableHeaderCell>
                    <TableHeaderCell>Size</TableHeaderCell>
                  </>
                ) : (
                  <>
                    <TableHeaderCell>Context Window</TableHeaderCell>
                    <TableHeaderCell>Rate</TableHeaderCell>
                  </>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {availableModels.map((model) => (
                <TableRow key={model.id}>
                  <TableCell>
                    <div>
                      <Text weight="semibold">{model.name}</Text>
                      <Text block size={200} style={{ fontFamily: 'monospace', color: tokens.colorNeutralForeground3 }}>
                        {model.id}
                      </Text>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      appearance="tint"
                      color={model.type === 'embedding' ? 'success' : 'brand'}
                    >
                      {model.type}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Text size={200}>{model.description || '—'}</Text>
                  </TableCell>
                  {provider === 'ollama' ? (
                    <>
                      <TableCell>
                        <Text size={200}>{model.metadata?.compute || '—'}</Text>
                      </TableCell>
                      <TableCell>
                        <Text size={200}>{model.metadata?.size || '—'}</Text>
                      </TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell>
                        <Text size={200}>
                          {model.contextWindow ? `${(model.contextWindow / 1000).toFixed(0)}K` : '—'}
                        </Text>
                      </TableCell>
                      <TableCell>
                        <Text size={200}>
                          {model.rateCard?.inputPricePerToken
                            ? `$${(model.rateCard.inputPricePerToken * 1_000_000).toFixed(2)} / 1M tokens`
                            : '—'}
                        </Text>
                      </TableCell>
                    </>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Register Model Wizard */}
      {wizardOpen && projectId && (
        <RegisterModelWizard
          projectId={projectId}
          provider={provider}
          onClose={handleWizardClose}
          onSuccess={() => {
            showToast('Model(s) registered successfully', 'success')
            handleWizardClose()
          }}
        />
      )}
    </div>
  )
}
