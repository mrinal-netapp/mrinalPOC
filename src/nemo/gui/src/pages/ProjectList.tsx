import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  makeStyles,
  tokens,
  Button,
  Table,
  TableBody,
  TableCell,
  TableRow,
  TableHeader,
  TableHeaderCell,
  TableCellLayout,
  Spinner,
  MessageBar,
  MessageBarBody,
  Dialog,
  DialogTrigger,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogActions,
  DialogContent,
  Input,
  Field,
  Text,
} from '@fluentui/react-components'
import {
  Add24Regular,
  Cloud24Regular,
  Navigation24Regular,
  Delete24Regular,
  Edit24Regular,
} from '@fluentui/react-icons'
import { projectApi, Project } from '../services/api'
import { useToast } from '../contexts/ToastContext'

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
  table: {
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  actionCell: {
    display: 'flex',
    gap: '8px',
  },
  emptyState: {
    padding: '48px',
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
  },
})

export default function ProjectList() {
  const styles = useStyles()
  const navigate = useNavigate()
  const { showToast } = useToast()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [creating, setCreating] = useState(false)
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [editingName, setEditingName] = useState('')
  const [updating, setUpdating] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [projectToDelete, setProjectToDelete] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    loadProjects()
  }, [])

  const loadProjects = async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await projectApi.list()
      setProjects(data)
    } catch (err: any) {
      setError(err.message || 'Failed to load projects')
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = async () => {
    if (!newProjectName.trim()) {
      return
    }

    try {
      setCreating(true)
      await projectApi.create({ name: newProjectName.trim() })
      setNewProjectName('')
      setCreateDialogOpen(false)
      await loadProjects()
    } catch (err: any) {
      setError(err.message || 'Failed to create project')
    } finally {
      setCreating(false)
    }
  }

  const handleEdit = (project: Project) => {
    setEditingProject(project)
    setEditingName(project.name)
    setEditDialogOpen(true)
  }

  const handleUpdate = async () => {
    if (!editingProject || !editingName.trim()) {
      return
    }

    try {
      setUpdating(true)
      setError(null)
      await projectApi.update(editingProject.id, { name: editingName.trim() })
      setEditDialogOpen(false)
      setEditingProject(null)
      setEditingName('')
      await loadProjects()
      
      // Dispatch custom event to notify other components
      window.dispatchEvent(new CustomEvent('project-updated', {
        detail: { projectId: editingProject.id, newName: editingName.trim() }
      }))
    } catch (err: any) {
      setError(err.message || 'Failed to update project')
    } finally {
      setUpdating(false)
    }
  }

  const handleDeleteClick = (projectId: string) => {
    setProjectToDelete(projectId)
    setDeleteDialogOpen(true)
  }

  const handleDeleteConfirm = async () => {
    if (!projectToDelete) return

    try {
      setDeleting(true)
      await projectApi.delete(projectToDelete)
      await loadProjects()
      setDeleteDialogOpen(false)
      setProjectToDelete(null)
      showToast('Project deleted successfully', 'success')
    } catch (err: any) {
      setError(err.message || 'Failed to delete project')
      showToast(err.message || 'Failed to delete project', 'error')
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
        <Spinner label="Loading projects..." />
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Projects</h1>
        <Dialog open={createDialogOpen} onOpenChange={(_, data) => setCreateDialogOpen(data.open)}>
          <DialogTrigger disableButtonEnhancement>
            <Button appearance="primary" icon={<Add24Regular />}>
              Create Project
            </Button>
          </DialogTrigger>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Create New Project</DialogTitle>
              <DialogContent>
                <Field label="Project Name" required>
                  <Input
                    value={newProjectName}
                    onChange={(_, data) => setNewProjectName(data.value)}
                    placeholder="Enter project name"
                  />
                </Field>
              </DialogContent>
              <DialogActions>
                <DialogTrigger disableButtonEnhancement>
                  <Button appearance="secondary">Cancel</Button>
                </DialogTrigger>
                <Button appearance="primary" onClick={handleCreate} disabled={creating}>
                  {creating ? 'Creating...' : 'Create'}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </div>

      {/* Edit Project Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={(_, data) => setEditDialogOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Edit Project</DialogTitle>
            <DialogContent>
              <Field label="Project Name" required>
                <Input
                  value={editingName}
                  onChange={(_, data) => setEditingName(data.value)}
                  placeholder="Enter project name"
                />
              </Field>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Cancel</Button>
              </DialogTrigger>
              <Button appearance="primary" onClick={handleUpdate} disabled={updating || !editingName.trim()}>
                {updating ? 'Updating...' : 'Update'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {projects.length === 0 ? (
        <div className={styles.emptyState}>
          <Cloud24Regular style={{ fontSize: '48px', marginBottom: '16px', opacity: 0.5 }} />
          <p>No projects found. Create your first project to get started.</p>
        </div>
      ) : (
        <Table className={styles.table}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>ID</TableHeaderCell>
              <TableHeaderCell>Created</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.map((ns) => (
              <TableRow key={ns.id}>
                <TableCell>
                  <TableCellLayout
                    media={<Cloud24Regular />}
                    onClick={() => navigate(`/projects/${ns.id}`)}
                    style={{ cursor: 'pointer' }}
                  >
                    {ns.name}
                  </TableCellLayout>
                </TableCell>
                <TableCell>{ns.id}</TableCell>
                <TableCell>
                  {new Date(ns.created_at).toLocaleDateString()}
                </TableCell>
                <TableCell>
                  <div className={styles.actionCell}>
                    <Button
                      appearance="subtle"
                      icon={<Edit24Regular />}
                      onClick={() => handleEdit(ns)}
                      title="Edit"
                    />
                    <Button
                      appearance="subtle"
                      icon={<Navigation24Regular />}
                      onClick={() => navigate(`/projects/${ns.id}/rays`)}
                      title="View Rays"
                    />
                    <Button
                      appearance="subtle"
                      icon={<Cloud24Regular />}
                      onClick={() => navigate(`/projects/${ns.id}/s3`)}
                      title="Project Explorer"
                    />
                    <Button
                      appearance="subtle"
                      icon={<Delete24Regular />}
                      onClick={() => handleDeleteClick(ns.id)}
                      title="Delete"
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={(_, data) => {
        setDeleteDialogOpen(data.open)
        if (!data.open) {
          setProjectToDelete(null)
        }
      }}>
        <DialogSurface>
          <DialogTitle>Delete Project</DialogTitle>
          <DialogBody>
            <DialogContent>
              <Text>
                Are you sure you want to delete this project? This action cannot be undone.
              </Text>
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                onClick={() => setDeleteDialogOpen(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                appearance="primary"
                onClick={handleDeleteConfirm}
                disabled={deleting}
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  )
}

