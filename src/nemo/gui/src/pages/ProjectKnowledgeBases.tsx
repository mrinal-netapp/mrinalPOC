import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  makeStyles,
  tokens,
  Card,
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
  ProgressBar,
  Tooltip,
} from '@fluentui/react-components'
import { Add24Regular, Edit24Regular, Delete24Regular, Search24Regular, ArrowSync24Regular, ArrowClockwise24Regular } from '@fluentui/react-icons'
import { knowledgeBaseApi, datasetApi, KnowledgeBase, DataSet, CreateKnowledgeBaseRequest, ChunkStrategy, ChunkOptions, IndexingMode, QuantizationType, QuantizationOptions, DependentsPage, getApiErrorMessage, getDependentsFromError } from '../services/api'
import { DependentsCell, DependentsBlockerList } from '../components/DependentsCell'
import { Input, Dropdown, Option, Field, Checkbox } from '@fluentui/react-components'
import { WizardModal } from '../components/wizard/WizardModal'
import { KnowledgeBaseWizard, EMBEDDING_MODELS, CHUNK_STRATEGIES, STRATEGY_DEFAULTS, INDEXING_MODES, QUANTIZATION_TYPES, DEFAULT_QUANTIZATION_OPTIONS, DEFAULT_SCALAR_OPTIONS, DEFAULT_IVF_RQ_OPTIONS } from '../components/wizard/KnowledgeBaseWizard'
import { useToast } from '../contexts/ToastContext'
import { Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions } from '@fluentui/react-components'

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: '24px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
})

export default function ProjectKnowledgeBases() {
  const styles = useStyles()
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const { showToast } = useToast()
  
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [filteredKnowledgeBases, setFilteredKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [datasets, setDatasets] = useState<DataSet[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editingKnowledgeBaseId, setEditingKnowledgeBaseId] = useState<string | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [knowledgeBaseToDelete, setKnowledgeBaseToDelete] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteBlockers, setDeleteBlockers] = useState<DependentsPage | null>(null)
  const [reprocessDialogOpen, setReprocessDialogOpen] = useState(false)
  const [knowledgeBaseToReprocess, setKnowledgeBaseToReprocess] = useState<KnowledgeBase | null>(null)
  const [reprocessing, setReprocessing] = useState(false)
  const [reprocessSettings, setReprocessSettings] = useState<{
    embeddingModel: string
    vectorSize: number
    chunkSize: number
    chunkStrategy: ChunkStrategy
    chunkOverlap: number
    chunkOptions: ChunkOptions
    indexingMode: IndexingMode
    quantizationType: QuantizationType
    quantizationOptions: QuantizationOptions
  }>({
    embeddingModel: '',
    vectorSize: 384,
    chunkSize: 512,
    chunkStrategy: 'fixed',
    chunkOverlap: 50,
    chunkOptions: {},
    indexingMode: 'hybrid',
    quantizationType: 'auto',
    quantizationOptions: {},
  })
  const [wizardStep, setWizardStep] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [formData, setFormData] = useState<CreateKnowledgeBaseRequest>({
    name: '',
    description: '',
    sourceDataset: '',
    embeddingModel: '',
    chunkSize: 512,
    chunkStrategy: 'fixed',
    chunkOverlap: 50,
    chunkOptions: {},
    vectorSize: 384,
    textColumns: '', // For structured datasets
  })

  const loadKnowledgeBases = async (silent = false) => {
    if (!projectId) return
    try {
      if (!silent) setLoading(true)
      setError(null)
      // Load both knowledge bases and datasets in parallel
      const [kbData, datasetData] = await Promise.all([
        knowledgeBaseApi.list(projectId),
        datasetApi.list(projectId).catch(() => [] as DataSet[]), // Don't fail if datasets can't be loaded
      ])
      setKnowledgeBases(kbData)
      setFilteredKnowledgeBases(kbData)
      setDatasets(datasetData)
    } catch (err: any) {
      if (!silent) {
        setError(err.message || 'Failed to load knowledge bases')
        console.error('Failed to load knowledge bases:', err)
      }
    } finally {
      if (!silent) setLoading(false)
    }
  }

  // Helper to get dataset name from ID
  const getDatasetName = (datasetId: string): string => {
    const dataset = datasets.find((d) => d.id === datasetId)
    return dataset ? dataset.name : datasetId // Fallback to ID if not found
  }

  useEffect(() => {
    loadKnowledgeBases()
  }, [projectId])

  // Poll when any KB is in_progress so progress updates are shown
  useEffect(() => {
    const hasInProgress = knowledgeBases.some(kb => kb.status === 'in_progress')
    if (!hasInProgress) return

    const interval = setInterval(() => {
      loadKnowledgeBases(true)
    }, 5000) // refresh every 5 seconds

    return () => clearInterval(interval)
  }, [knowledgeBases])

  // Client-side search filtering
  useEffect(() => {
    if (!searchQuery.trim()) {
      setFilteredKnowledgeBases(knowledgeBases)
      return
    }

    const query = searchQuery.toLowerCase()
    setFilteredKnowledgeBases(
      knowledgeBases.filter(
        (kb) =>
          kb.name.toLowerCase().includes(query) ||
          kb.description?.toLowerCase().includes(query) ||
          kb.id.toLowerCase().includes(query) ||
          kb.sourceDataset.toLowerCase().includes(query) ||
          getDatasetName(kb.sourceDataset).toLowerCase().includes(query) ||
          kb.embeddingModel.toLowerCase().includes(query)
      )
    )
  }, [searchQuery, knowledgeBases])

  const handleDeleteClick = (id: string, name: string) => {
    setKnowledgeBaseToDelete({ id, name })
    setDeleteBlockers(null)
    setDeleteDialogOpen(true)
  }

  const handleDeleteConfirm = async () => {
    if (!projectId || !knowledgeBaseToDelete) return

    try {
      setDeleting(true)
      setError(null)
      await knowledgeBaseApi.delete(projectId, knowledgeBaseToDelete.id)
      await loadKnowledgeBases()
      setDeleteDialogOpen(false)
      setKnowledgeBaseToDelete(null)
      setDeleteBlockers(null)
      showToast(`Knowledge base "${knowledgeBaseToDelete.name}" deleted successfully`, 'success')
    } catch (err: unknown) {
      const msg = getApiErrorMessage(err, 'Failed to delete knowledge base')
      const blockers = getDependentsFromError(err)
      setError(msg)
      if (blockers) {
        setDeleteBlockers(blockers)
        showToast(msg, 'warning')
      } else {
        showToast(msg, 'error')
      }
    } finally {
      setDeleting(false)
    }
  }

  const handleReprocessClick = (kb: KnowledgeBase) => {
    // Load KB settings into reprocess form
    setKnowledgeBaseToReprocess(kb)
    setReprocessSettings({
      embeddingModel: kb.embeddingModel,
      vectorSize: kb.vectorSize,
      chunkSize: kb.chunkSize,
      chunkStrategy: kb.chunkStrategy || 'fixed',
      chunkOverlap: kb.chunkOverlap ?? 50,
      chunkOptions: kb.chunkOptions || {},
      indexingMode: kb.indexingMode || 'hybrid',
      quantizationType: kb.quantizationType || 'none',
      quantizationOptions: kb.quantizationOptions || {},
    })
    setReprocessDialogOpen(true)
  }

  const handleReprocessConfirm = async () => {
    if (!projectId || !knowledgeBaseToReprocess) return

    try {
      setReprocessing(true)
      setError(null)
      await knowledgeBaseApi.reprocess(projectId, knowledgeBaseToReprocess.id, reprocessSettings)
      await loadKnowledgeBases()
      setReprocessDialogOpen(false)
      setKnowledgeBaseToReprocess(null)
      showToast(`Knowledge base "${knowledgeBaseToReprocess.name}" reprocessing started`, 'success')
    } catch (err: any) {
      setError(err.message || 'Failed to reprocess knowledge base')
      showToast(err.message || 'Failed to reprocess knowledge base', 'error')
    } finally {
      setReprocessing(false)
    }
  }

  const updateReprocessSetting = <K extends keyof typeof reprocessSettings>(
    field: K,
    value: typeof reprocessSettings[K]
  ) => {
    setReprocessSettings((prev) => ({ ...prev, [field]: value }))
  }

  // Reset form
  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      sourceDataset: '',
      embeddingModel: '',
      chunkSize: 512,
      chunkStrategy: 'fixed',
      chunkOverlap: 50,
      chunkOptions: {},
      vectorSize: 384,
      textColumns: '', // For structured datasets
    })
    setFormError(null)
    setWizardStep(1)
    setEditingKnowledgeBaseId(null)
  }

  // Load knowledge base for editing
  const handleEdit = async (id: string) => {
    if (!projectId) return

    try {
      setError(null)
      const kb = await knowledgeBaseApi.get(projectId, id)

      // Populate form with knowledge base data
      setFormData({
        name: kb.name,
        description: kb.description || '',
        sourceDataset: kb.sourceDataset,
        embeddingModel: kb.embeddingModel,
        chunkSize: kb.chunkSize,
        chunkStrategy: kb.chunkStrategy || 'fixed',
        chunkOverlap: kb.chunkOverlap ?? 50,
        chunkOptions: kb.chunkOptions || {},
        vectorSize: kb.vectorSize,
        textColumns: kb.textColumns || '', // For structured datasets
      })

      setEditingKnowledgeBaseId(id)
      setWizardStep(1)
      setShowCreateModal(true)
    } catch (err: any) {
      setError(err.message || 'Failed to load knowledge base')
      console.error('Failed to load knowledge base:', err)
    }
  }

  // Wizard navigation
  const nextStep = () => {
    if (wizardStep === 1) {
      if (!formData.name || !formData.name.trim()) {
        setFormError('Name is required')
        return
      }
    } else if (wizardStep === 2) {
      if (!formData.sourceDataset || !formData.sourceDataset.trim()) {
        setFormError('Source dataset is required')
        return
      }
      if (!formData.embeddingModel || !formData.embeddingModel.trim()) {
        setFormError('Embedding model is required')
        return
      }
      if (!formData.chunkSize || formData.chunkSize <= 0) {
        setFormError('Chunk size must be greater than 0')
        return
      }
      if (!formData.vectorSize || formData.vectorSize <= 0) {
        setFormError('Vector size must be greater than 0')
        return
      }
    }
    setFormError(null)
    setWizardStep((prev) => Math.min(prev + 1, 3))
  }

  const prevStep = () => {
    setFormError(null)
    setWizardStep((prev) => Math.max(prev - 1, 1))
  }

  // Update form field
  const updateFormField = (field: keyof CreateKnowledgeBaseRequest, value: any) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
  }

  // Handle create or update
  const handleSubmit = async () => {
    if (!projectId) return

    try {
      setSubmitting(true)
      setFormError(null)

      if (editingKnowledgeBaseId) {
        // Update existing knowledge base
        await knowledgeBaseApi.update(projectId, editingKnowledgeBaseId, formData)
        showToast('Knowledge base updated successfully', 'success')
      } else {
        // Create new knowledge base
        await knowledgeBaseApi.create(projectId, formData)
        showToast('Knowledge base created successfully', 'success')
      }
      
      setShowCreateModal(false)
      resetForm()
      loadKnowledgeBases()
    } catch (err: any) {
      // Extract error message from API response
      let errorMessage = `Failed to ${editingKnowledgeBaseId ? 'update' : 'create'} knowledge base`
      if (err.response?.data?.error) {
        errorMessage = err.response.data.error
      } else if (err.message) {
        errorMessage = err.message
      }
      setFormError(errorMessage)
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
        <Spinner label="Loading knowledge bases..." />
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Knowledge Bases</h1>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button
            appearance="subtle"
            icon={<ArrowClockwise24Regular />}
            onClick={() => loadKnowledgeBases()}
            disabled={loading}
            title="Refresh knowledge bases"
          >
            Refresh
          </Button>
          <Button appearance="primary" icon={<Add24Regular />} onClick={() => {
            resetForm()
            setShowCreateModal(true)
          }}>
            Create Knowledge Base
          </Button>
        </div>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '16px', paddingBottom: '0' }}>
          <Search24Regular />
          <Input
            placeholder="Search knowledge bases..."
            value={searchQuery}
            onChange={(_, data) => setSearchQuery(data.value)}
            style={{ flex: 1 }}
          />
        </div>
        {filteredKnowledgeBases.length === 0 ? (
          <div style={{ padding: '24px' }}>
            <Text>No knowledge bases found</Text>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Description</TableHeaderCell>
                <TableHeaderCell>Source Dataset</TableHeaderCell>
                <TableHeaderCell>Embedding Model</TableHeaderCell>
                <TableHeaderCell>Chunk Size</TableHeaderCell>
                <TableHeaderCell>Vector Size</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Used by</TableHeaderCell>
                <TableHeaderCell>Created</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredKnowledgeBases.map((kb) => (
                <TableRow key={kb.id}>
                  <TableCell>
                    <Text
                      weight="semibold"
                      style={{ cursor: 'pointer', color: tokens.colorBrandForeground1 }}
                      onClick={() => navigate(`/projects/${projectId}/knowledgebases/${kb.id}`)}
                    >
                      {kb.name}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <Text>{kb.description || '-'}</Text>
                  </TableCell>
                  <TableCell>
                    <Tooltip content={`ID: ${kb.sourceDataset}`} relationship="label">
                      <Text>{getDatasetName(kb.sourceDataset)}</Text>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <Text>{kb.embeddingModel}</Text>
                  </TableCell>
                  <TableCell>
                    <Text>{kb.chunkSize}</Text>
                  </TableCell>
                  <TableCell>
                    <Text>{kb.vectorSize}</Text>
                  </TableCell>
                  <TableCell>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <Badge
                        color={
                          kb.status === 'ready'
                            ? 'success'
                            : kb.status === 'in_progress'
                            ? 'warning'
                            : kb.status === 'errored'
                            ? 'danger'
                            : 'brand'
                        }
                        appearance="filled"
                      >
                        {kb.status === 'in_progress' && <Spinner size="tiny" style={{ marginRight: '4px' }} />}
                        {kb.status === 'in_progress' ? 'In Progress' : kb.status === 'ready' ? 'Ready' : kb.status === 'errored' ? 'Errored' : kb.status || 'Ready'}
                      </Badge>
                      {kb.status === 'in_progress' && (
                        kb.progress?.percentage != null ? (
                          (() => {
                            const pct = Math.round(kb.progress.percentage * 100) / 100
                            return (
                              <Tooltip
                                content={`${kb.progress.phase || 'Processing'}: ${pct}% — Click for details`}
                                relationship="label"
                              >
                                <div
                                  style={{ width: '100px', cursor: 'pointer' }}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    const wfId = kb.jobId || `kb-creation-${projectId}-${kb.id}`
                                    navigate(`/projects/${projectId}/workflows/${wfId}`)
                                  }}
                                  role="link"
                                  tabIndex={0}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault()
                                      const wfId = kb.jobId || `kb-creation-${projectId}-${kb.id}`
                                      navigate(`/projects/${projectId}/workflows/${wfId}`)
                                    }
                                  }}
                                >
                                  <ProgressBar
                                    value={kb.progress.percentage}
                                    max={100}
                                    thickness="medium"
                                  />
                                  <Text size={100} style={{ marginTop: '2px', color: tokens.colorBrandForeground1 }}>
                                    {pct}% ↗
                                  </Text>
                                </div>
                              </Tooltip>
                            )
                          })()
                        ) : (
                          <div style={{ width: '100px' }}>
                            <ProgressBar thickness="medium" />
                            <Text size={100} style={{ marginTop: '2px', color: tokens.colorNeutralForeground3 }}>
                              Processing...
                            </Text>
                          </div>
                        )
                      )}
                      {kb.status === 'errored' && kb.errorMessage && (
                        <Tooltip content={kb.errorMessage} relationship="label">
                          <Text size={100} style={{ color: tokens.colorPaletteRedForeground1 }}>
                            Error
                          </Text>
                        </Tooltip>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {projectId && (
                      <DependentsCell
                        projectId={projectId}
                        targetKind="knowledge_base"
                        targetId={kb.id}
                        summary={kb.dependentsSummary}
                      />
                    )}
                  </TableCell>
                  <TableCell>
                    <Text>
                      {new Date(kb.createdAt).toLocaleDateString()}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <Button
                        appearance="subtle"
                        icon={<Edit24Regular />}
                        onClick={() => handleEdit(kb.id)}
                        title="Edit Knowledge Base"
                      />
                      {(kb.status === 'ready' || kb.status === 'errored') && (
                        <Tooltip content="Re-process knowledge base" relationship="label">
                          <Button
                            appearance="subtle"
                            icon={<ArrowSync24Regular />}
                            onClick={() => handleReprocessClick(kb)}
                            title="Re-process Knowledge Base"
                          />
                        </Tooltip>
                      )}
                      <Button
                        appearance="subtle"
                        icon={<Delete24Regular />}
                        onClick={() => handleDeleteClick(kb.id, kb.name)}
                        title="Delete Knowledge Base"
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Create/Edit Modal - Wizard */}
      {showCreateModal && (
        <WizardModal
          title={editingKnowledgeBaseId ? 'Edit Knowledge Base' : 'Create Knowledge Base'}
          onClose={() => {
            setShowCreateModal(false)
            resetForm()
          }}
          onSubmit={handleSubmit}
          submitting={submitting}
          formError={formError}
          currentStep={wizardStep}
          onNext={nextStep}
          onPrev={prevStep}
          steps={[
            { number: 1, title: 'Basic Info', description: 'Name and description' },
            { number: 2, title: 'Configuration', description: 'Dataset and model settings' },
            { number: 3, title: 'Review', description: 'Confirm details' },
          ]}
          submitLabel={editingKnowledgeBaseId ? 'Update Knowledge Base' : 'Create Knowledge Base'}
          mode={editingKnowledgeBaseId ? 'edit' : 'create'}
          onStepClick={(s) => { setFormError(null); setWizardStep(s) }}
        >
          <KnowledgeBaseWizard
            step={wizardStep}
            formData={formData}
            updateFormField={updateFormField}
            projectId={projectId}
          />
        </WizardModal>
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={(_, data) => {
        setDeleteDialogOpen(data.open)
        if (!data.open) {
          setKnowledgeBaseToDelete(null)
          setDeleteBlockers(null)
        }
      }}>
        <DialogSurface>
          <DialogTitle>Delete Knowledge Base</DialogTitle>
          <DialogBody>
            <DialogContent>
              {deleteBlockers ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <Text>
                    Cannot delete &quot;{knowledgeBaseToDelete?.name}&quot; while it is still in use by:
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
                  Are you sure you want to delete knowledge base &quot;{knowledgeBaseToDelete?.name}&quot;? This action cannot be undone.
                </Text>
              )}
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                onClick={() => setDeleteDialogOpen(false)}
                disabled={deleting}
              >
                {deleteBlockers ? 'Close' : 'Cancel'}
              </Button>
              {!deleteBlockers && (
                <Button
                  appearance="primary"
                  onClick={handleDeleteConfirm}
                  disabled={deleting}
                >
                  {deleting ? 'Deleting...' : 'Delete'}
                </Button>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Re-process Configuration Dialog */}
      <Dialog open={reprocessDialogOpen} onOpenChange={(_, data) => {
        setReprocessDialogOpen(data.open)
        if (!data.open) {
          setKnowledgeBaseToReprocess(null)
        }
      }}>
        <DialogSurface style={{ maxWidth: '600px' }}>
          <DialogTitle>Re-process Knowledge Base</DialogTitle>
          <DialogBody>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <Text>
                  Configure settings for re-processing "{knowledgeBaseToReprocess?.name}".
                  All existing embeddings will be replaced.
                </Text>

                {/* Embedding Model Selection */}
                <Field label="Embedding Model" required>
                  <Dropdown
                    placeholder="Select an embedding model"
                    value={reprocessSettings.embeddingModel}
                    selectedOptions={reprocessSettings.embeddingModel ? [reprocessSettings.embeddingModel] : []}
                    onOptionSelect={(_, data) => {
                      if (data.optionValue) {
                        updateReprocessSetting('embeddingModel', data.optionValue)
                        const selectedModel = EMBEDDING_MODELS.find((m) => m.name === data.optionValue)
                        if (selectedModel) {
                          updateReprocessSetting('vectorSize', selectedModel.vectorSize)
                          updateReprocessSetting('chunkSize', selectedModel.recommendedChunkSize)
                        }
                      }
                    }}
                  >
                    {EMBEDDING_MODELS.map((model) => (
                      <Option key={model.name} value={model.name} text={model.displayName}>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <Text weight="semibold">{model.displayName}</Text>
                          <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                            {model.vectorSize}d • {model.description}
                          </Text>
                        </div>
                      </Option>
                    ))}
                  </Dropdown>
                </Field>

                {/* Indexing Mode Selection */}
                <Field label="Indexing Mode" required>
                  <Dropdown
                    placeholder="Select an indexing mode"
                    value={reprocessSettings.indexingMode}
                    selectedOptions={[reprocessSettings.indexingMode]}
                    onOptionSelect={(_, data) => {
                      if (data.optionValue) {
                        updateReprocessSetting('indexingMode', data.optionValue as IndexingMode)
                      }
                    }}
                  >
                    {INDEXING_MODES.map((mode) => (
                      <Option key={mode.id} value={mode.id} text={mode.displayName}>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <Text weight="semibold">{mode.displayName}</Text>
                          <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                            {mode.description}
                          </Text>
                        </div>
                      </Option>
                    ))}
                  </Dropdown>
                </Field>

                {/* Quantization Type Selection */}
                <Field label="Vector Quantization">
                  <Dropdown
                    placeholder="Select quantization type"
                    value={reprocessSettings.quantizationType}
                    selectedOptions={[reprocessSettings.quantizationType]}
                    onOptionSelect={(_, data) => {
                      if (data.optionValue) {
                        const quantType = data.optionValue as QuantizationType
                        updateReprocessSetting('quantizationType', quantType)
                        // Set default quantization options based on type
                        if (quantType === 'ivf_pq') {
                          updateReprocessSetting('quantizationOptions', DEFAULT_QUANTIZATION_OPTIONS)
                        } else if (quantType === 'scalar') {
                          updateReprocessSetting('quantizationOptions', DEFAULT_SCALAR_OPTIONS)
                        } else if (quantType === 'ivf_rq') {
                          updateReprocessSetting('quantizationOptions', DEFAULT_IVF_RQ_OPTIONS)
                        } else {
                          updateReprocessSetting('quantizationOptions', {})
                        }
                      }
                    }}
                  >
                    {QUANTIZATION_TYPES.map((qtype) => (
                      <Option key={qtype.id} value={qtype.id} text={qtype.displayName}>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <Text weight="semibold">{qtype.displayName}</Text>
                          <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                            {qtype.description}
                          </Text>
                        </div>
                      </Option>
                    ))}
                  </Dropdown>
                </Field>

                {/* IVF_PQ Options */}
                {reprocessSettings.quantizationType === 'ivf_pq' && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginLeft: '16px', padding: '12px', border: `1px solid ${tokens.colorNeutralStroke1}`, borderRadius: '4px' }}>
                    <Field label="Num Partitions">
                      <Input
                        type="number"
                        value={(reprocessSettings.quantizationOptions?.numPartitions ?? 256).toString()}
                        onChange={(e) => {
                          const value = parseInt(e.target.value, 10)
                          if (!isNaN(value) && value > 0) {
                            updateReprocessSetting('quantizationOptions', { ...reprocessSettings.quantizationOptions, numPartitions: value })
                          }
                        }}
                        placeholder="e.g., 256"
                      />
                      <div style={{ marginTop: '4px', fontSize: '12px', color: tokens.colorNeutralForeground3 }}>
                        Number of Voronoi cells (default: 256)
                      </div>
                    </Field>

                    <Field label="Num Sub-Vectors">
                      <Input
                        type="number"
                        value={(reprocessSettings.quantizationOptions?.numSubVectors ?? 96).toString()}
                        onChange={(e) => {
                          const value = parseInt(e.target.value, 10)
                          if (!isNaN(value) && value > 0) {
                            updateReprocessSetting('quantizationOptions', { ...reprocessSettings.quantizationOptions, numSubVectors: value })
                          }
                        }}
                        placeholder="e.g., 96"
                      />
                      <div style={{ marginTop: '4px', fontSize: '12px', color: tokens.colorNeutralForeground3 }}>
                        PQ sub-vectors for compression (default: 96)
                      </div>
                    </Field>
                  </div>
                )}

                {/* Scalar (IVF_HNSW_SQ) Options */}
                {reprocessSettings.quantizationType === 'scalar' && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px', marginLeft: '16px', padding: '12px', border: `1px solid ${tokens.colorNeutralStroke1}`, borderRadius: '4px' }}>
                    <Field label="ef_construction">
                      <Input
                        type="number"
                        value={(reprocessSettings.quantizationOptions?.efConstruction ?? 150).toString()}
                        onChange={(e) => {
                          const value = parseInt(e.target.value, 10)
                          if (!isNaN(value) && value > 0) {
                            updateReprocessSetting('quantizationOptions', { ...reprocessSettings.quantizationOptions, efConstruction: value })
                          }
                        }}
                        placeholder="e.g., 150"
                      />
                      <div style={{ marginTop: '4px', fontSize: '12px', color: tokens.colorNeutralForeground3 }}>
                        HNSW construction parameter (default: 150)
                      </div>
                    </Field>

                    <Field label="m (Connectivity)">
                      <Input
                        type="number"
                        value={(reprocessSettings.quantizationOptions?.m ?? '').toString()}
                        onChange={(e) => {
                          const value = parseInt(e.target.value, 10)
                          if (!isNaN(value) && value > 0) {
                            updateReprocessSetting('quantizationOptions', { ...reprocessSettings.quantizationOptions, m: value })
                          } else if (e.target.value === '') {
                            const { m: _, ...rest } = reprocessSettings.quantizationOptions || {}
                            updateReprocessSetting('quantizationOptions', rest)
                          }
                        }}
                        placeholder="Auto"
                      />
                      <div style={{ marginTop: '4px', fontSize: '12px', color: tokens.colorNeutralForeground3 }}>
                        HNSW graph connections per node (default: auto)
                      </div>
                    </Field>

                    <Field label="Num Partitions">
                      <Input
                        type="number"
                        value={(reprocessSettings.quantizationOptions?.numPartitions ?? '').toString()}
                        onChange={(e) => {
                          const value = parseInt(e.target.value, 10)
                          if (!isNaN(value) && value > 0) {
                            updateReprocessSetting('quantizationOptions', { ...reprocessSettings.quantizationOptions, numPartitions: value })
                          } else if (e.target.value === '') {
                            const { numPartitions: _, ...rest } = reprocessSettings.quantizationOptions || {}
                            updateReprocessSetting('quantizationOptions', rest)
                          }
                        }}
                        placeholder="Auto"
                      />
                      <div style={{ marginTop: '4px', fontSize: '12px', color: tokens.colorNeutralForeground3 }}>
                        IVF partitions (default: auto)
                      </div>
                    </Field>
                  </div>
                )}

                {/* IVF_RQ Options */}
                {reprocessSettings.quantizationType === 'ivf_rq' && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginLeft: '16px', padding: '12px', border: `1px solid ${tokens.colorNeutralStroke1}`, borderRadius: '4px' }}>
                    <Field label="Num Bits">
                      <Input
                        type="number"
                        value={(reprocessSettings.quantizationOptions?.numBits ?? 1).toString()}
                        onChange={(e) => {
                          const value = parseInt(e.target.value, 10)
                          if (!isNaN(value) && value >= 1 && value <= 8) {
                            updateReprocessSetting('quantizationOptions', { ...reprocessSettings.quantizationOptions, numBits: value })
                          }
                        }}
                        placeholder="e.g., 1"
                      />
                      <div style={{ marginTop: '4px', fontSize: '12px', color: tokens.colorNeutralForeground3 }}>
                        Bits per dimension: 1 (standard RaBitQ), 2/4/8 for higher fidelity
                      </div>
                    </Field>

                    <Field label="Num Partitions">
                      <Input
                        type="number"
                        value={(reprocessSettings.quantizationOptions?.numPartitions ?? '').toString()}
                        onChange={(e) => {
                          const value = parseInt(e.target.value, 10)
                          if (!isNaN(value) && value > 0) {
                            updateReprocessSetting('quantizationOptions', { ...reprocessSettings.quantizationOptions, numPartitions: value })
                          } else if (e.target.value === '') {
                            const { numPartitions: _, ...rest } = reprocessSettings.quantizationOptions || {}
                            updateReprocessSetting('quantizationOptions', rest)
                          }
                        }}
                        placeholder="Auto"
                      />
                      <div style={{ marginTop: '4px', fontSize: '12px', color: tokens.colorNeutralForeground3 }}>
                        IVF partitions (default: auto)
                      </div>
                    </Field>
                  </div>
                )}

                {/* Chunking Strategy Selection */}
                <Field label="Chunking Strategy" required>
                  <Dropdown
                    placeholder="Select a chunking strategy"
                    value={reprocessSettings.chunkStrategy}
                    selectedOptions={[reprocessSettings.chunkStrategy]}
                    onOptionSelect={(_, data) => {
                      if (data.optionValue) {
                        const strategy = data.optionValue as ChunkStrategy
                        updateReprocessSetting('chunkStrategy', strategy)
                        const defaults = STRATEGY_DEFAULTS[strategy]
                        if (defaults.chunkSize) updateReprocessSetting('chunkSize', defaults.chunkSize)
                        if (defaults.chunkOverlap !== undefined) updateReprocessSetting('chunkOverlap', defaults.chunkOverlap)
                        if (defaults.chunkOptions) updateReprocessSetting('chunkOptions', defaults.chunkOptions)
                      }
                    }}
                  >
                    {CHUNK_STRATEGIES.map((strategy) => (
                      <Option key={strategy.id} value={strategy.id} text={strategy.displayName}>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <Text weight="semibold">{strategy.displayName}</Text>
                          <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                            {strategy.description}
                          </Text>
                        </div>
                      </Option>
                    ))}
                  </Dropdown>
                </Field>

                {/* Strategy-specific options */}
                {reprocessSettings.chunkStrategy === 'fixed' && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                    <Field label="Chunk Size">
                      <Input
                        type="number"
                        value={reprocessSettings.chunkSize.toString()}
                        onChange={(e) => {
                          const value = parseInt(e.target.value, 10)
                          if (!isNaN(value) && value > 0) updateReprocessSetting('chunkSize', value)
                        }}
                      />
                    </Field>
                    <Field label="Chunk Overlap">
                      <Input
                        type="number"
                        value={reprocessSettings.chunkOverlap.toString()}
                        onChange={(e) => {
                          const value = parseInt(e.target.value, 10)
                          if (!isNaN(value) && value >= 0) updateReprocessSetting('chunkOverlap', value)
                        }}
                      />
                    </Field>
                  </div>
                )}

                {reprocessSettings.chunkStrategy === 'sentence' && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                    <Field label="Max Sentences">
                      <Input
                        type="number"
                        value={(reprocessSettings.chunkOptions?.maxSentences ?? 5).toString()}
                        onChange={(e) => {
                          const value = parseInt(e.target.value, 10)
                          if (!isNaN(value) && value > 0) {
                            updateReprocessSetting('chunkOptions', { ...reprocessSettings.chunkOptions, maxSentences: value })
                          }
                        }}
                      />
                    </Field>
                    <Field label="Overlap Sentences">
                      <Input
                        type="number"
                        value={(reprocessSettings.chunkOptions?.overlapSentences ?? 1).toString()}
                        onChange={(e) => {
                          const value = parseInt(e.target.value, 10)
                          if (!isNaN(value) && value >= 0) {
                            updateReprocessSetting('chunkOptions', { ...reprocessSettings.chunkOptions, overlapSentences: value })
                          }
                        }}
                      />
                    </Field>
                  </div>
                )}

                {reprocessSettings.chunkStrategy === 'recursive' && (
                  <Field label="Max Chunk Size">
                    <Input
                      type="number"
                      value={reprocessSettings.chunkSize.toString()}
                      onChange={(e) => {
                        const value = parseInt(e.target.value, 10)
                        if (!isNaN(value) && value > 0) updateReprocessSetting('chunkSize', value)
                      }}
                    />
                  </Field>
                )}

                {reprocessSettings.chunkStrategy === 'token' && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                    <Field label="Max Tokens">
                      <Input
                        type="number"
                        value={(reprocessSettings.chunkOptions?.maxTokens ?? 256).toString()}
                        onChange={(e) => {
                          const value = parseInt(e.target.value, 10)
                          if (!isNaN(value) && value > 0) {
                            updateReprocessSetting('chunkOptions', { ...reprocessSettings.chunkOptions, maxTokens: value })
                          }
                        }}
                      />
                    </Field>
                    <Field label="Token Overlap">
                      <Input
                        type="number"
                        value={(reprocessSettings.chunkOptions?.tokenOverlap ?? 20).toString()}
                        onChange={(e) => {
                          const value = parseInt(e.target.value, 10)
                          if (!isNaN(value) && value >= 0) {
                            updateReprocessSetting('chunkOptions', { ...reprocessSettings.chunkOptions, tokenOverlap: value })
                          }
                        }}
                      />
                    </Field>
                  </div>
                )}

                {reprocessSettings.chunkStrategy === 'markdown' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <Field label="Max Chunk Size">
                      <Input
                        type="number"
                        value={reprocessSettings.chunkSize.toString()}
                        onChange={(e) => {
                          const value = parseInt(e.target.value, 10)
                          if (!isNaN(value) && value > 0) updateReprocessSetting('chunkSize', value)
                        }}
                      />
                    </Field>
                    <Checkbox
                      checked={reprocessSettings.chunkOptions?.splitOnHeaders !== false}
                      onChange={(_, data) => {
                        updateReprocessSetting('chunkOptions', { ...reprocessSettings.chunkOptions, splitOnHeaders: data.checked === true })
                      }}
                      label="Split on markdown headers (##, ###)"
                    />
                  </div>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                onClick={() => setReprocessDialogOpen(false)}
                disabled={reprocessing}
              >
                Cancel
              </Button>
              <Button
                appearance="primary"
                onClick={handleReprocessConfirm}
                disabled={reprocessing || !reprocessSettings.embeddingModel}
              >
                {reprocessing ? 'Starting...' : 'Re-process'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

    </div>
  )
}

