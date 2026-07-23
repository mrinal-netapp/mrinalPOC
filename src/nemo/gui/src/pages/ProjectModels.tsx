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
  Input,
  Tooltip,
  Checkbox,
  Link,
} from '@fluentui/react-components'
import { Delete24Regular, Search24Regular, Play24Regular } from '@fluentui/react-icons'
import {
  modelApi,
  Model,
  getApiErrorMessage,
  getDependentsFromError,
  DependentsPage,
} from '../services/api'
import { useToast } from '../contexts/ToastContext'
import { Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions } from '@fluentui/react-components'
import { OpenAIIcon, AWSIcon, AzureIcon, GoogleCloudIcon, LocalServerIcon, ConnectIcon } from '../components/icons'
import { DependentsCell, DependentsBlockerList } from '../components/DependentsCell'

const isLlmModel = (m: Model) => !m.modelType || m.modelType === 'llm'

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
  providerGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: '16px',
  },
  providerCard: {
    cursor: 'pointer',
    transitionProperty: 'all',
    transitionDuration: '0.2s',
    transitionTimingFunction: 'ease',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    ':hover': {
      boxShadow: tokens.shadow8,
    },
    padding: '20px',
    borderRadius: '12px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '12px',
    textAlign: 'center',
    minHeight: '160px',
    justifyContent: 'center',
  },
  providerLogo: {
    width: '48px',
    height: '48px',
    borderRadius: '12px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '24px',
    fontWeight: '700',
  },
  providerName: {
    fontSize: '16px',
    fontWeight: '600',
    color: tokens.colorNeutralForeground1,
  },
  providerDesc: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    lineHeight: '1.4',
  },
  sectionTitle: {
    fontSize: '18px',
    fontWeight: '600',
    color: tokens.colorNeutralForeground1,
  },
  playgroundNameLink: {
    display: 'inline-block',
    textAlign: 'left',
    background: 'none',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    color: tokens.colorBrandForeground1,
    font: 'inherit',
    ':hover': {
      textDecoration: 'underline',
    },
  },
})

interface ProviderInfo {
  key: string
  name: string
  description: string
  color: string
  bgColor: string
  icon: React.ReactNode
}

const PROVIDERS: ProviderInfo[] = [
  {
    key: 'openai',
    name: 'OpenAI',
    description: 'GPT-4o, GPT-4, embeddings and more',
    color: '#10a37f',
    bgColor: '#e6f7f1',
    icon: <OpenAIIcon style={{ width: 28, height: 28, color: '#10a37f' }} />,
  },
  {
    key: 'aws_bedrock',
    name: 'AWS Bedrock',
    description: 'Claude, Titan, Llama, Cohere and more',
    color: '#ff9900',
    bgColor: '#fff4e0',
    icon: <AWSIcon style={{ width: 28, height: 28 }} />,
  },
  {
    key: 'azure',
    name: 'Azure OpenAI',
    description: 'GPT-4, GPT-3.5, embeddings on Azure',
    color: '#0078d4',
    bgColor: '#e5f1fb',
    icon: <AzureIcon style={{ width: 28, height: 28 }} />,
  },
  {
    key: 'google',
    name: 'Google AI',
    description: 'Gemini, PaLM, and text embeddings',
    color: '#4285f4',
    bgColor: '#e8f0fe',
    icon: <GoogleCloudIcon style={{ width: 28, height: 28 }} />,
  },
  {
    key: 'openai_compatible',
    name: 'OpenAI Compatible',
    description: 'Any endpoint with an OpenAI-compatible API',
    color: '#8b5cf6',
    bgColor: '#ede9fe',
    icon: <ConnectIcon style={{ width: 28, height: 28, color: '#8b5cf6' }} />,
  },
  {
    key: 'ollama',
    name: 'Ollama',
    description: 'Self-hosted models served via Ollama (Llama, Mistral, ...)',
    color: '#6b7280',
    bgColor: '#f3f4f6',
    icon: <LocalServerIcon style={{ width: 28, height: 28, color: '#6b7280' }} />,
  },
]

export default function ProjectModels() {
  const styles = useStyles()
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const { showToast } = useToast()

  const [models, setModels] = useState<Model[]>([])
  const [filteredModels, setFilteredModels] = useState<Model[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [modelToDelete, setModelToDelete] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteBlockers, setDeleteBlockers] = useState<DependentsPage | null>(null)
  const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(new Set())
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false)

  const loadModels = async () => {
    if (!projectId) return
    try {
      setLoading(true)
      setError(null)
      const data = await modelApi.list(projectId)
      setModels(data)
      setFilteredModels(data)
    } catch (err: any) {
      setError(err.message || 'Failed to load models')
      console.error('Failed to load models:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadModels()
  }, [projectId])

  useEffect(() => {
    if (!searchQuery.trim()) {
      setFilteredModels(models)
      return
    }
    const query = searchQuery.toLowerCase()
    setFilteredModels(
      models.filter(
        (model) =>
          model.name.toLowerCase().includes(query) ||
          (model.displayName && model.displayName.toLowerCase().includes(query)) ||
          (model.provider && model.provider.toLowerCase().includes(query)) ||
          (model.providerModelId && model.providerModelId.toLowerCase().includes(query))
      )
    )
  }, [searchQuery, models])

  useEffect(() => {
    // Keep selection in sync with current model list.
    setSelectedModelIds((prev) => {
      const modelIds = new Set(models.map((m) => m.id))
      const next = new Set<string>()
      prev.forEach((id) => {
        if (modelIds.has(id)) next.add(id)
      })
      return next
    })
  }, [models])

  const handleDeleteClick = (id: string, name: string) => {
    setModelToDelete({ id, name })
    setDeleteBlockers(null)
    setDeleteDialogOpen(true)
  }

  const handleDeleteConfirm = async () => {
    if (!projectId || !modelToDelete) return
    try {
      setDeleting(true)
      setError(null)
      await modelApi.delete(projectId, modelToDelete.id)
      await loadModels()
      setDeleteDialogOpen(false)
      setModelToDelete(null)
      setDeleteBlockers(null)
      showToast(`Model "${modelToDelete.name}" deleted successfully`, 'success')
    } catch (err: unknown) {
      const msg = getApiErrorMessage(err, 'Failed to delete model')
      const blockers = getDependentsFromError(err)
      setError(msg)
      if (blockers) {
        // Keep the dialog open so the user can see what's blocking the delete.
        setDeleteBlockers(blockers)
        showToast(msg, 'warning')
      } else {
        showToast(msg, 'error')
      }
    } finally {
      setDeleting(false)
    }
  }

  const handleBulkDeleteConfirm = async () => {
    if (!projectId || selectedModelIds.size === 0) return
    try {
      setDeleting(true)
      setError(null)
      const ids = Array.from(selectedModelIds)
      const results = await Promise.allSettled(
        ids.map((id) => modelApi.delete(projectId, id))
      )
      const succeeded = results.filter((r) => r.status === 'fulfilled').length
      const failed = results.length - succeeded

      await loadModels()
      setBulkDeleteDialogOpen(false)
      setSelectedModelIds(new Set())

      if (failed === 0) {
        showToast(`Deleted ${succeeded} model${succeeded === 1 ? '' : 's'} successfully`, 'success')
      } else {
        const rejected = results.filter(
          (r): r is PromiseRejectedResult => r.status === 'rejected'
        )
        const apiDetail = rejected[0]?.reason
          ? getApiErrorMessage(rejected[0].reason, '')
          : ''
        showToast(
          apiDetail ||
            `Deleted ${succeeded} model${succeeded === 1 ? '' : 's'}, ${failed} failed`,
          failed === results.length ? 'error' : 'warning'
        )
      }
    } catch (err: unknown) {
      const msg = getApiErrorMessage(err, 'Failed to delete selected models')
      setError(msg)
      showToast(msg, 'error')
    } finally {
      setDeleting(false)
    }
  }

  const handleProviderClick = (providerKey: string) => {
    navigate(`/projects/${projectId}/models/provider/${providerKey}`)
  }

  const handleCompareSelected = () => {
    if (!projectId) return
    const selectedIds = Array.from(selectedModelIds)
    if (selectedIds.length === 0) {
      showToast('Select at least one model to compare', 'warning')
      return
    }
    const llmSelected = selectedIds.filter((id) => {
      const m = models.find((x) => x.id === id)
      return !m?.modelType || m.modelType === 'llm'
    })
    if (llmSelected.length === 0) {
      showToast('Selected models are not LLM models', 'warning')
      return
    }
    const picked = llmSelected.slice(0, 3)
    if (selectedIds.length > 3) {
      showToast('Playground supports up to 3 selected models; using first 3 LLM models', 'warning')
    }
    const qs = picked.length ? `?modelIds=${encodeURIComponent(picked.join(','))}` : ''
    navigate(`/projects/${projectId}/models/playground${qs}`)
  }

  const openModelPlayground = (model: Model) => {
    if (!projectId) return
    if (!isLlmModel(model)) {
      showToast('The model playground is for LLM models only.', 'warning')
      return
    }
    navigate(`/projects/${projectId}/models/playground?modelIds=${encodeURIComponent(model.id)}`)
  }

  const getProviderBadge = (provider?: string) => {
    const p = PROVIDERS.find(pr => pr.key === provider)
    if (!p) return null
    return (
      <Badge appearance="outline" color="informative" style={{ fontSize: '11px' }}>
        {p.name}
      </Badge>
    )
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
        <Spinner label="Loading models..." />
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Models</h1>
          <div className={styles.subtitle}>
            Register and manage LLM and embedding models from cloud providers or local deployments
          </div>
        </div>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {/* Provider Cards */}
      <div>
        <Text className={styles.sectionTitle} block style={{ marginBottom: '12px' }}>
          Model Providers
        </Text>
        <div className={styles.providerGrid}>
          {PROVIDERS.map((provider) => (
            <div
              key={provider.key}
              className={styles.providerCard}
              onClick={() => handleProviderClick(provider.key)}
            >
              <div
                className={styles.providerLogo}
                style={{ backgroundColor: provider.bgColor }}
              >
                {provider.icon}
              </div>
              <div className={styles.providerName}>{provider.name}</div>
              <div className={styles.providerDesc}>{provider.description}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Registered Models Table */}
      <Card>
        <CardHeader
          header={
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
              <Text weight="semibold">
                Registered Models ({filteredModels.length})
              </Text>
              <div style={{ display: 'flex', gap: '8px' }}>
                <Button
                  appearance="primary"
                  icon={<Play24Regular />}
                  disabled={selectedModelIds.size === 0}
                  onClick={handleCompareSelected}
                >
                  Compare Selected ({selectedModelIds.size})
                </Button>
                <Button
                  appearance="secondary"
                  icon={<Delete24Regular />}
                  disabled={selectedModelIds.size === 0 || deleting}
                  onClick={() => setBulkDeleteDialogOpen(true)}
                >
                  Delete Selected ({selectedModelIds.size})
                </Button>
              </div>
            </div>
          }
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '16px', paddingBottom: '0' }}>
          <Search24Regular />
          <Input
            placeholder="Search models..."
            value={searchQuery}
            onChange={(_, data) => setSearchQuery(data.value)}
            style={{ flex: 1 }}
          />
        </div>
        {filteredModels.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <Text style={{ color: tokens.colorNeutralForeground3 }}>
              No models registered yet. Click a provider card above to browse and register models.
            </Text>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell style={{ width: '44px' }}>
                  <Checkbox
                    checked={
                      filteredModels.length > 0 && filteredModels.every((m) => selectedModelIds.has(m.id))
                        ? true
                        : filteredModels.some((m) => selectedModelIds.has(m.id))
                          ? 'mixed'
                          : false
                    }
                    onChange={(_, data) => {
                      setSelectedModelIds((prev) => {
                        const next = new Set(prev)
                        if (data.checked) {
                          filteredModels.forEach((m) => next.add(m.id))
                        } else {
                          filteredModels.forEach((m) => next.delete(m.id))
                        }
                        return next
                      })
                    }}
                    aria-label="Select all models"
                  />
                </TableHeaderCell>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Provider</TableHeaderCell>
                <TableHeaderCell>Model ID</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Used by</TableHeaderCell>
                <TableHeaderCell>Created</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredModels.map((model) => (
                <TableRow key={model.id}>
                  <TableCell>
                    <Checkbox
                      checked={selectedModelIds.has(model.id)}
                      onChange={(_, data) => {
                        setSelectedModelIds((prev) => {
                          const next = new Set(prev)
                          if (data.checked) next.add(model.id)
                          else next.delete(model.id)
                          return next
                        })
                      }}
                      aria-label={`Select model ${model.displayName || model.name}`}
                    />
                  </TableCell>
                  <TableCell>
                    {isLlmModel(model) ? (
                      <Link
                        as="button"
                        type="button"
                        className={styles.playgroundNameLink}
                        onClick={() => openModelPlayground(model)}
                        title="Open in model playground"
                      >
                        <Text weight="semibold" as="span">{model.displayName || model.name}</Text>
                      </Link>
                    ) : (
                      <Text weight="semibold">{model.displayName || model.name}</Text>
                    )}
                  </TableCell>
                  <TableCell>
                    {getProviderBadge(model.provider)}
                  </TableCell>
                  <TableCell>
                    <Text style={{ fontFamily: 'monospace', fontSize: '12px' }}>
                      {model.providerModelId || model.endpoint || '—'}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <Badge
                      appearance="tint"
                      color={model.modelType === 'embedding' ? 'success' : 'brand'}
                    >
                      {model.modelType || 'llm'}
                    </Badge>
                    {model.isBuiltin && (
                      <Badge
                        appearance="outline"
                        color="informative"
                        style={{ marginLeft: 6 }}
                        title="System-managed built-in model. Re-seeded on every config-service restart. PUT rejects non-displayName edits; DELETE returns BUILTIN_MODEL_IMMUTABLE."
                      >
                        system-managed
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {projectId && (
                      <DependentsCell
                        projectId={projectId}
                        targetKind="model"
                        targetId={model.id}
                        summary={model.dependentsSummary}
                      />
                    )}
                  </TableCell>
                  <TableCell>
                    <Text>{new Date(model.createdAt).toLocaleDateString()}</Text>
                  </TableCell>
                  <TableCell>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <Tooltip
                        content={
                          model.isBuiltin
                            ? 'Built-in models are system-managed and cannot be deleted'
                            : 'Delete model'
                        }
                        relationship="label"
                      >
                        <span>
                          <Button
                            appearance="subtle"
                            icon={<Delete24Regular />}
                            disabled={model.isBuiltin}
                            onClick={() =>
                              handleDeleteClick(model.id, model.displayName || model.name)
                            }
                            title={
                              model.isBuiltin
                                ? 'Built-in model — delete disabled'
                                : 'Delete Model'
                            }
                          />
                        </span>
                      </Tooltip>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={(_, data) => {
        setDeleteDialogOpen(data.open)
        if (!data.open) {
          setModelToDelete(null)
          setDeleteBlockers(null)
        }
      }}>
        <DialogSurface>
          <DialogTitle>Delete Model</DialogTitle>
          <DialogBody>
            <DialogContent>
              {deleteBlockers ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <Text>
                    Cannot delete &quot;{modelToDelete?.name}&quot; while it is still in use by:
                  </Text>
                  {projectId && (
                    <DependentsBlockerList projectId={projectId} page={deleteBlockers} />
                  )}
                  <Text style={{ marginTop: 4, color: tokens.colorNeutralForeground2 }}>
                    Update or remove these references, then try deleting again.
                  </Text>
                </div>
              ) : (
                <Text>
                  Are you sure you want to delete model &quot;{modelToDelete?.name}&quot;? This action cannot be undone.
                </Text>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDeleteDialogOpen(false)} disabled={deleting}>
                {deleteBlockers ? 'Close' : 'Cancel'}
              </Button>
              {!deleteBlockers && (
                <Button appearance="primary" onClick={handleDeleteConfirm} disabled={deleting}>
                  {deleting ? 'Deleting...' : 'Delete'}
                </Button>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Bulk Delete Confirmation Dialog */}
      <Dialog open={bulkDeleteDialogOpen} onOpenChange={(_, data) => setBulkDeleteDialogOpen(data.open)}>
        <DialogSurface>
          <DialogTitle>Delete Selected Models</DialogTitle>
          <DialogBody>
            <DialogContent>
              <Text>
                Are you sure you want to delete {selectedModelIds.size} selected model{selectedModelIds.size === 1 ? '' : 's'}?
                This action cannot be undone.
              </Text>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setBulkDeleteDialogOpen(false)} disabled={deleting}>
                Cancel
              </Button>
              <Button appearance="primary" onClick={handleBulkDeleteConfirm} disabled={deleting || selectedModelIds.size === 0}>
                {deleting ? 'Deleting...' : `Delete ${selectedModelIds.size} Selected`}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  )
}
