import { useState, useMemo } from 'react'
import {
  makeStyles,
  tokens,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Button,
  Input,
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogActions,
  DialogContent,
  Field,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components'
import { Search24Regular, Edit24Regular, Delete24Regular, Play24Regular } from '@fluentui/react-icons'
import { Pipeline, pipelineApi, pipelineExecutionApi, DependentsPage, getApiErrorMessage, getDependentsFromError } from '../../services/api'
import { DependentsBlockerList } from '../DependentsCell'
import { useToast } from '../../contexts/ToastContext'

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  header: {
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: '16px',
  },
  searchContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    marginBottom: '16px',
  },
  table: {
    width: '100%',
  },
  emptyState: {
    padding: '32px',
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
  },
})

interface PipelineListProps {
  pipelines: Pipeline[]
  onCreate: () => void
  projectId: string
  onPipelineUpdated?: () => void
  onEdit?: (pipeline: Pipeline) => void
  createButtonLabel?: string
  /** When true, show a Type column (Data/API) - useful when showing mixed pipeline types */
  showTypeColumn?: boolean
}

export function PipelineList({ pipelines, onCreate, projectId, onPipelineUpdated, onEdit, createButtonLabel = 'Create Pipeline', showTypeColumn = false }: PipelineListProps) {
  const styles = useStyles()
  const { showToast } = useToast()
  const [searchQuery, setSearchQuery] = useState('')
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [selectedPipeline, setSelectedPipeline] = useState<Pipeline | null>(null)
  const [deleteBlockers, setDeleteBlockers] = useState<DependentsPage | null>(null)
  const [nameValue, setNameValue] = useState('')
  const [descriptionValue, setDescriptionValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const filteredPipelines = useMemo(() => {
    if (!searchQuery.trim()) {
      return pipelines
    }

    const query = searchQuery.toLowerCase()
    return pipelines.filter(
      (pipeline) =>
        pipeline.name.toLowerCase().includes(query) ||
        pipeline.id.toLowerCase().includes(query)
    )
  }, [pipelines, searchQuery])

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleString()
  }

  const getNodeCount = (pipeline: Pipeline) => {
    return pipeline.graph?.nodes?.length || 0
  }

  const handleEditClick = (e: React.MouseEvent, pipeline: Pipeline) => {
    e.stopPropagation()
    if (onEdit) {
      onEdit(pipeline)
    } else {
      // Fallback to dialog if onEdit is not provided
      setSelectedPipeline(pipeline)
      setNameValue(pipeline.name)
      setDescriptionValue(pipeline.description || '')
      setError(null)
      setEditDialogOpen(true)
    }
  }

  const handleDeleteClick = (e: React.MouseEvent, pipeline: Pipeline) => {
    e.stopPropagation()
    setSelectedPipeline(pipeline)
    setError(null)
    setDeleteBlockers(null)
    setDeleteDialogOpen(true)
  }

  const handleExecuteClick = async (e: React.MouseEvent, pipeline: Pipeline) => {
    e.stopPropagation()
    try {
      setLoading(true)
      const result = await pipelineExecutionApi.execute(projectId, pipeline.id)
      showToast(`Pipeline execution started: ${result.executionId}`, 'success')
    } catch (err: any) {
      showToast(`Failed to execute pipeline: ${err.message}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  const handleEditConfirm = async () => {
    if (!selectedPipeline || !nameValue.trim()) {
      setError('Pipeline name is required')
      return
    }

    try {
      setLoading(true)
      setError(null)
      await pipelineApi.update(projectId, selectedPipeline.id, {
        name: nameValue.trim(),
        description: descriptionValue.trim() || undefined
      })
      setEditDialogOpen(false)
      setSelectedPipeline(null)
      setNameValue('')
      setDescriptionValue('')
      onPipelineUpdated?.()
    } catch (err: any) {
      setError(err.message || 'Failed to update pipeline')
    } finally {
      setLoading(false)
    }
  }

  const handleDeleteConfirm = async () => {
    if (!selectedPipeline) {
      return
    }

    try {
      setLoading(true)
      setError(null)
      await pipelineApi.delete(projectId, selectedPipeline.id)
      setDeleteDialogOpen(false)
      const pipelineName = selectedPipeline.name
      setSelectedPipeline(null)
      setDeleteBlockers(null)
      onPipelineUpdated?.()
      showToast(`Pipeline "${pipelineName}" deleted successfully`, 'success')
    } catch (err: unknown) {
      const msg = getApiErrorMessage(err, 'Failed to delete pipeline')
      const blockers = getDependentsFromError(err)
      setError(msg)
      if (blockers) {
        setDeleteBlockers(blockers)
        showToast(msg, 'warning')
      } else {
        showToast(msg, 'error')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.container}>

      <div className={styles.header}>
        <Button appearance="primary" onClick={onCreate}>
          {createButtonLabel}
        </Button>
      </div>
      <div className={styles.searchContainer}>
        <Search24Regular />
        <Input
          placeholder="Search pipelines..."
          value={searchQuery}
          onChange={(_, data) => setSearchQuery(data.value)}
          style={{ flex: 1 }}
        />
      </div>
      {filteredPipelines.length === 0 ? (
        <div className={styles.emptyState}>
          <Text>
            {searchQuery
              ? 'No pipelines found matching your search'
              : 'No pipelines found. Create your first pipeline to get started.'}
          </Text>
        </div>
      ) : (
        <Table className={styles.table}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              {showTypeColumn && <TableHeaderCell>Type</TableHeaderCell>}
              <TableHeaderCell>Description</TableHeaderCell>
              <TableHeaderCell>Nodes</TableHeaderCell>
              <TableHeaderCell>Created</TableHeaderCell>
              <TableHeaderCell>Updated</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredPipelines.map((pipeline) => (
              <TableRow
                key={pipeline.id}
              >
                <TableCell>
                  <Text weight="semibold">{pipeline.name}</Text>
                </TableCell>
                {showTypeColumn && (
                  <TableCell>
                    <Text>{(pipeline.type ?? 'Data') === 'API' ? 'API' : 'Data'}</Text>
                  </TableCell>
                )}
                <TableCell>
                  <Text>{pipeline.description || '-'}</Text>
                </TableCell>
                <TableCell>
                  <Text>{getNodeCount(pipeline)}</Text>
                </TableCell>
                <TableCell>
                  <Text>{formatDate(pipeline.createdAt)}</Text>
                </TableCell>
                <TableCell>
                  <Text>{formatDate(pipeline.updatedAt)}</Text>
                </TableCell>
                <TableCell>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <Button
                      appearance="subtle"
                      icon={<Play24Regular />}
                      onClick={(e) => handleExecuteClick(e, pipeline)}
                      title="Execute Pipeline"
                      disabled={loading}
                    />
                    <Button
                      appearance="subtle"
                      icon={<Edit24Regular />}
                      onClick={(e) => handleEditClick(e, pipeline)}
                      title="Edit Pipeline"
                    />
                    <Button
                      appearance="subtle"
                      icon={<Delete24Regular />}
                      onClick={(e) => handleDeleteClick(e, pipeline)}
                      title="Delete Pipeline"
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={(_, data) => {
        setEditDialogOpen(data.open)
        if (!data.open) {
          setSelectedPipeline(null)
          setNameValue('')
          setDescriptionValue('')
          setError(null)
        }
      }}>
        <DialogSurface>
          <DialogTitle>Edit Pipeline</DialogTitle>
          <DialogBody>
            <DialogContent>
              {error && (
                <MessageBar intent="error" style={{ marginBottom: '16px' }}>
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              )}
              <Field label="Pipeline Name" required style={{ marginBottom: '16px' }}>
                <Input
                  value={nameValue}
                  onChange={(_, data) => setNameValue(data.value)}
                  placeholder="Enter pipeline name"
                  disabled={loading}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && nameValue.trim() && !loading) {
                      handleEditConfirm()
                    }
                  }}
                />
              </Field>
              <Field label="Description">
                <Input
                  value={descriptionValue}
                  onChange={(_, data) => setDescriptionValue(data.value)}
                  placeholder="Enter pipeline description"
                  disabled={loading}
                />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                onClick={() => setEditDialogOpen(false)}
                disabled={loading}
              >
                Cancel
              </Button>
              <Button
                appearance="primary"
                onClick={handleEditConfirm}
                disabled={!nameValue.trim() || loading}
              >
                Save
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={(_, data) => {
        setDeleteDialogOpen(data.open)
        if (!data.open) {
          setSelectedPipeline(null)
          setError(null)
          setDeleteBlockers(null)
        }
      }}>
        <DialogSurface>
          <DialogTitle>Delete Pipeline</DialogTitle>
          <DialogBody>
            <DialogContent>
              {deleteBlockers ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <Text>
                    Cannot delete pipeline &quot;{selectedPipeline?.name}&quot; while it is still in use by:
                  </Text>
                  <DependentsBlockerList projectId={projectId} page={deleteBlockers} />
                  <Text style={{ marginTop: 4, color: tokens.colorNeutralForeground2 }}>
                    Update or remove these references, then try deleting again.
                  </Text>
                </div>
              ) : (
                <>
                  {error && (
                    <MessageBar intent="error" style={{ marginBottom: '16px' }}>
                      <MessageBarBody>{error}</MessageBarBody>
                    </MessageBar>
                  )}
                  <Text>
                    Are you sure you want to delete pipeline &quot;{selectedPipeline?.name}&quot;? This action cannot be undone.
                  </Text>
                </>
              )}
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                onClick={() => setDeleteDialogOpen(false)}
                disabled={loading}
              >
                {deleteBlockers ? 'Close' : 'Cancel'}
              </Button>
              {!deleteBlockers && (
                <Button
                  appearance="primary"
                  onClick={handleDeleteConfirm}
                  disabled={loading}
                >
                  Delete
                </Button>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  )
}

