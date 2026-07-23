import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Spinner,
  MessageBar,
  MessageBarBody,
  Card,
  CardHeader,
  Text,
  Button,
  makeStyles,
  tokens,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  Dialog,
  DialogTrigger,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Input,
  Field,
} from '@fluentui/react-components'
import { Add24Regular, Flow24Regular, Edit24Regular, Archive24Regular, Link24Regular, Table24Regular } from '@fluentui/react-icons'
import { datasourceApi, projectApi, DataSourceItem, Bucket, CreateDataSourceRequest } from '../services/api'
import { useProject } from '../hooks/useProject'
import { useProjectOverview } from '../hooks/useProjectOverview'
import { BucketForm } from '../components/bucket/BucketForm'
import { BucketTable } from '../components/bucket/BucketTable'
import { ProjectOverview } from '../components/project/ProjectOverview'
import { BucketFormData, initialBucketFormData } from '../types/bucket'
import { bucketToFormData, formDataToCreateRequest, formDataToUpdateRequest } from '../utils/bucketForm'
import styles from '../styles/projectDetail.module.css'

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
    padding: '24px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '8px',
  },
  headerContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  title: {
    fontSize: '28px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
    margin: 0,
  },
  subtitle: {
    fontSize: '14px',
    color: tokens.colorNeutralForeground3,
    display: 'flex',
    gap: '12px',
    alignItems: 'center',
  },
  iconWithOverlay: {
    position: 'relative',
    display: 'inline-flex',
  },
  iconOverlay: {
    position: 'absolute',
    bottom: '-2px',
    right: '-2px',
    fontSize: '10px',
    fontWeight: 600,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    borderRadius: '50%',
    width: '14px',
    height: '14px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: `1px solid ${tokens.colorNeutralBackground1}`,
  },
  iconOverlayGreen: {
    position: 'absolute',
    bottom: '-2px',
    right: '-2px',
    fontSize: '10px',
    fontWeight: 600,
    backgroundColor: tokens.colorPaletteGreenBackground2,
    color: tokens.colorPaletteGreenForeground2,
    borderRadius: '50%',
    width: '14px',
    height: '14px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: `1px solid ${tokens.colorNeutralBackground1}`,
  },
})

export default function ProjectDetail() {
  const customStyles = useStyles()
  const navigate = useNavigate()
  const { projectId } = useParams<{ projectId: string }>()
  const { project, buckets, loading, error, reload } = useProject(projectId)
  const { overview: overviewData, lineageFacet, loading: overviewLoading, reload: reloadOverview } = useProjectOverview(projectId)
  
  const [volumeIds, setVolumeIds] = useState<Record<string, string>>({})
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [editingBucket, setEditingBucket] = useState<Bucket | null>(null)
  const [formData, setFormData] = useState<BucketFormData>(initialBucketFormData)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [editNameDialogOpen, setEditNameDialogOpen] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [newNamespaceName, setNewNamespaceName] = useState('')

  // Load volume name -> datasource ID mapping
  const loadVolumeIds = async () => {
    if (!projectId) return
    try {
      const dataSources = await datasourceApi.list(projectId, { type: 'volume' })
      const idMap: Record<string, string> = {}
      dataSources.forEach((ds: DataSourceItem) => {
        idMap[ds.name] = ds.id
      })
      setVolumeIds(idMap)
    } catch (err) {
      // Silently fail — CRUD operations will report errors
    }
  }

  useEffect(() => {
    if (projectId) {
      loadVolumeIds()
    }
  }, [projectId])

  const openCreateDialog = () => {
    setFormData(initialBucketFormData)
    setSubmitError(null)
    setCreateDialogOpen(true)
  }

  const openEditDialog = (bucket: Bucket) => {
    setEditingBucket(bucket)
    setFormData(bucketToFormData(bucket))
    setSubmitError(null)
    setEditDialogOpen(true)
  }

  const handleCreate = async (data: BucketFormData) => {
    if (!projectId) return

    try {
      setSubmitting(true)
      setSubmitError(null)
      const request = formDataToCreateRequest(data)
      
      const dsRequest: CreateDataSourceRequest = {
        name: request.name,
        type: 'volume',
        volume_config: {
          region: request.region,
          volume_info: request.volume_info,
          auth_info: request.auth_info,
          protocol: request.protocol,
          deployment_config: request.deployment_config,
        },
        metadata: request.metadata,
      }
      
      await datasourceApi.create(projectId, dsRequest)
      setCreateDialogOpen(false)
      setFormData(initialBucketFormData)
      await Promise.all([reload(), reloadOverview(), loadVolumeIds()])
    } catch (err: any) {
      setSubmitError(err.response?.data?.error || err.message || 'Failed to create volume')
      throw err
    } finally {
      setSubmitting(false)
    }
  }

  const handleUpdate = async (data: BucketFormData) => {
    if (!projectId || !editingBucket) return

    try {
      setSubmitting(true)
      setSubmitError(null)
      const request = formDataToUpdateRequest(data)
      const dsId = volumeIds[editingBucket.name]
      
      if (dsId) {
        await datasourceApi.update(projectId, dsId, {
          volume_config: {
            region: request.region,
            volume_info: request.volume_info,
            auth_info: request.auth_info,
            protocol: request.protocol,
            deployment_config: request.deployment_config,
          },
          metadata: request.metadata,
        })
      }
      
      setEditDialogOpen(false)
      setEditingBucket(null)
      setFormData(initialBucketFormData)
      await Promise.all([reload(), reloadOverview()])
    } catch (err: any) {
      setSubmitError(err.response?.data?.error || err.message || 'Failed to update volume')
      throw err
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (bucketName: string) => {
    if (!projectId) return
    if (!confirm(`Are you sure you want to delete volume "${bucketName}"?`)) {
      return
    }

    try {
      setSubmitError(null)
      const dsId = volumeIds[bucketName]
      
      if (dsId) {
        await datasourceApi.delete(projectId, dsId)
      }
      
      await Promise.all([reload(), reloadOverview(), loadVolumeIds()])
    } catch (err: any) {
      setSubmitError(err.response?.data?.error || err.message || 'Failed to delete volume')
    }
  }

  if (loading || overviewLoading) {
    return (
      <div className={styles.loadingContainer}>
        <Spinner label="Loading project..." />
      </div>
    )
  }

  if (error && !project) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>{error || 'Project not found'}</MessageBarBody>
      </MessageBar>
    )
  }

  if (!project) {
    return null
  }

  const formatDate = (dateString: string | undefined) => {
    if (!dateString) return 'N/A'
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  const handleEditName = () => {
    if (!project) return
    setNewNamespaceName(project.name)
    setEditNameDialogOpen(true)
  }

  const handleUpdateName = async () => {
    if (!projectId || !newNamespaceName.trim()) return

    try {
      setEditingName(true)
      setSubmitError(null)
      await projectApi.update(projectId, { name: newNamespaceName.trim() })
      setEditNameDialogOpen(false)
      await Promise.all([reload(), reloadOverview()])
      
      // Dispatch custom event to notify other components
      window.dispatchEvent(new CustomEvent('project-updated', {
        detail: { projectId, newName: newNamespaceName.trim() }
      }))
    } catch (err: any) {
      setSubmitError(err.message || 'Failed to update project name')
    } finally {
      setEditingName(false)
    }
  }

  return (
    <div className={customStyles.container}>
      <div className={customStyles.header}>
        <div className={customStyles.headerContent}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <h1 className={customStyles.title}>{project.name}</h1>
            <Button
              appearance="subtle"
              icon={<Edit24Regular />}
              onClick={handleEditName}
              title="Edit project name"
              size="small"
            />
          </div>
          <div className={customStyles.subtitle}>
            <Text>ID: {project.id}</Text>
            <Text>•</Text>
            <Text>Created: {formatDate(project.created_at)}</Text>
          </div>
        </div>
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button appearance="primary" icon={<Add24Regular />}>
              New
            </Button>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItem
                icon={<Archive24Regular />}
                onClick={openCreateDialog}
              >
                Bucket
              </MenuItem>
              <MenuItem
                icon={<Link24Regular />}
                onClick={() => navigate(`/projects/${projectId}/connectors`)}
              >
                Connector
              </MenuItem>
              <MenuItem
                icon={<Table24Regular />}
                onClick={() => navigate(`/projects/${projectId}/datasets`)}
              >
                Dataset
              </MenuItem>
              <MenuItem
                icon={<Flow24Regular />}
                onClick={() => navigate(`/projects/${projectId}/pipelines`)}
              >
                Pipeline
              </MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
      </div>

      {(error || submitError) && (
        <MessageBar intent="error">
          <MessageBarBody>{error || submitError}</MessageBarBody>
        </MessageBar>
      )}

      {/* Overview Dashboard */}
      <ProjectOverview projectId={projectId!} overview={overviewData} lineageFacet={lineageFacet} />

      {/* Recent Buckets Section */}
      {buckets.length > 0 && (
        <Card className={styles.card}>
          <CardHeader 
            header={
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                <Text weight="semibold">Recent Buckets</Text>
                <Button 
                  appearance="subtle" 
                  onClick={() => navigate(`/projects/${projectId}/buckets`)}
                >
                  View All
                </Button>
              </div>
            } 
          />
          <BucketTable
            buckets={buckets.slice(0, 5)}
            projectId={projectId!}
            onEdit={openEditDialog}
            onDelete={handleDelete}
          />
        </Card>
      )}

      <BucketForm
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSubmit={handleCreate}
        onCancel={() => setCreateDialogOpen(false)}
        submitting={submitting}
        title="Create New Bucket"
        submitLabel="Create"
      />

      <BucketForm
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        onSubmit={handleUpdate}
        onCancel={() => {
          setEditDialogOpen(false)
          setEditingBucket(null)
        }}
        initialData={formData}
        editingBucket={editingBucket}
        submitting={submitting}
        title={`Edit Bucket: ${editingBucket?.name}`}
        submitLabel="Update"
      />

      {/* Edit Project Name Dialog */}
      <Dialog open={editNameDialogOpen} onOpenChange={(_, data) => setEditNameDialogOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Edit Project Name</DialogTitle>
              <DialogContent>
                <Field label="Project Name" required>
                <Input
                  value={newNamespaceName}
                  onChange={(_, data) => setNewNamespaceName(data.value)}
                  placeholder="Enter project name"
                />
              </Field>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Cancel</Button>
              </DialogTrigger>
              <Button appearance="primary" onClick={handleUpdateName} disabled={editingName || !newNamespaceName.trim()}>
                {editingName ? 'Updating...' : 'Update'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  )
}
