import { useState, useEffect, useCallback, useRef } from 'react'
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
} from '@fluentui/react-components'
import { Add24Regular, Edit24Regular, Delete24Regular, Search24Regular, ArrowSync24Regular } from '@fluentui/react-icons'
import { mcpServerApi, mcpCatalogApi, credentialApi, MCPServer, MCPServerCatalogEntry, CreateMCPServerRequest, UpdateMCPServerRequest, Credential, DependentsPage, getApiErrorMessage, getDependentsFromError } from '../services/api'
import { DependentsCell, DependentsBlockerList } from '../components/DependentsCell'
import { Input } from '@fluentui/react-components'
import { WizardModal } from '../components/wizard/WizardModal'
import { MCPServerWizard } from '../components/wizard/MCPServerWizard'
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

const defaultFormData: CreateMCPServerRequest = {
  name: '',
  description: '',
  deploymentType: 'remote',
  transport: 'http',
  url: '',
  command: '',
  args: [],
  env: {},
  authType: 'none',
  staticHeaders: {},
  queryParams: [],
  headerParams: [],
  extraHeaders: [],
  allowedTools: [],
  disallowedTools: [],
  timeout: 600000,
  trust: false,
}

export default function ProjectMCPServers() {
  const styles = useStyles()
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const { showToast } = useToast()

  const [servers, setServers] = useState<MCPServer[]>([])
  const [filteredServers, setFilteredServers] = useState<MCPServer[]>([])
  const [catalog, setCatalog] = useState<MCPServerCatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editingServerId, setEditingServerId] = useState<string | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [serverToDelete, setServerToDelete] = useState<{ id: string; name: string } | null>(null)
  const [deleteBlockers, setDeleteBlockers] = useState<DependentsPage | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [wizardStep, setWizardStep] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [formData, setFormData] = useState<CreateMCPServerRequest>({ ...defaultFormData })

  const [credentials, setCredentials] = useState<Credential[]>([])

  // Runtime status polling for managed servers
  const pollingRef = useRef<NodeJS.Timeout | null>(null)

  const loadServers = useCallback(async () => {
    if (!projectId) return
    try {
      setLoading(true)
      setError(null)
      const data = await mcpServerApi.list(projectId)
      setServers(data)
      setFilteredServers(data)
    } catch (err: any) {
      setError(err.message || 'Failed to load MCP servers')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    loadServers()
    mcpCatalogApi.list().then(setCatalog).catch(() => {})
  }, [loadServers])

  // Poll for provisioning/deleting servers
  useEffect(() => {
    const hasActiveServers = servers.some(
      (s) => s.runtimeStatus === 'provisioning' || s.runtimeStatus === 'deleting'
    )
    if (hasActiveServers) {
      pollingRef.current = setInterval(() => {
        loadServers()
      }, 5000)
    }
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [servers, loadServers])

  useEffect(() => {
    if (!searchQuery.trim()) {
      setFilteredServers(servers)
      return
    }
    const query = searchQuery.toLowerCase()
    setFilteredServers(
      servers.filter(
        (s) =>
          s.name.toLowerCase().includes(query) ||
          s.description?.toLowerCase().includes(query) ||
          s.url?.toLowerCase().includes(query) ||
          s.command?.toLowerCase().includes(query)
      )
    )
  }, [searchQuery, servers])

  const handleDeleteClick = (id: string, name: string) => {
    setServerToDelete({ id, name })
    setDeleteBlockers(null)
    setDeleteDialogOpen(true)
  }

  const handleDeleteConfirm = async () => {
    if (!projectId || !serverToDelete) return
    try {
      setDeleting(true)
      await mcpServerApi.delete(projectId, serverToDelete.id)
      await loadServers()
      setDeleteDialogOpen(false)
      setServerToDelete(null)
      setDeleteBlockers(null)
      showToast(`MCP server "${serverToDelete.name}" deleted`, 'success')
    } catch (err: unknown) {
      const msg = getApiErrorMessage(err, 'Failed to delete MCP server')
      const blockers = getDependentsFromError(err)
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

  const resetForm = () => {
    setFormData({ ...defaultFormData })
    setFormError(null)
    setWizardStep(1)
    setEditingServerId(null)
  }

  const handleEdit = async (id: string) => {
    if (!projectId) return
    try {
      const server = await mcpServerApi.get(projectId, id)
      setFormData({
        name: server.name,
        description: server.description || '',
        deploymentType: (server.deploymentType === 'platform' ? 'remote' : server.deploymentType) || 'remote',
        catalogId: server.catalogId,
        managedConfig: server.managedConfig,
        transport: server.transport,
        url: server.url || '',
        command: server.command || '',
        args: server.args || [],
        env: server.env || {},
        authType: server.authType || 'none',
        credentialId: server.credentialId,
        authorizationUrl: server.authorizationUrl || '',
        tokenUrl: server.tokenUrl || '',
        staticHeaders: server.staticHeaders || {},
        queryParams: server.queryParams || [],
        headerParams: server.headerParams || [],
        authConfig: server.authConfig,
        extraHeaders: server.extraHeaders || [],
        allowedTools: server.allowedTools || [],
        disallowedTools: server.disallowedTools || [],
        specPath: server.specPath || '',
        timeout: server.timeout,
        trust: server.trust,
      })
      setEditingServerId(id)
      setWizardStep(1)
      if (projectId) credentialApi.list(projectId).then(setCredentials).catch(() => setCredentials([]))
      setShowCreateModal(true)
    } catch (err: any) {
      setError(err.message || 'Failed to load MCP server')
    }
  }

  const deploymentType = formData.deploymentType || 'remote'

  const getSteps = () => {
    if (editingServerId) {
      if (deploymentType === 'managed') {
        return [
          { number: 1, title: 'Configuration', description: 'Env vars and resources' },
          { number: 2, title: 'Tools & Security', description: 'Tool filtering and trust' },
          { number: 3, title: 'Review', description: 'Confirm details' },
        ]
      }
      return [
        { number: 1, title: 'Basic Info', description: 'Name and description' },
        { number: 2, title: 'Connection', description: 'Transport and endpoint' },
        { number: 3, title: 'Auth & Params', description: 'Auth, headers, query params' },
        { number: 4, title: 'Tools & Security', description: 'Tool filtering and trust' },
        { number: 5, title: 'Review', description: 'Confirm details' },
      ]
    }
    if (deploymentType === 'managed') {
      return [
        { number: 1, title: 'Deployment Type', description: 'Remote or managed' },
        { number: 2, title: 'Select Server', description: 'Choose from catalog' },
        { number: 3, title: 'Configuration', description: 'Name, env vars, resources' },
        { number: 4, title: 'Tools & Security', description: 'Tool filtering and trust' },
        { number: 5, title: 'Review', description: 'Confirm details' },
      ]
    }
    return [
      { number: 1, title: 'Deployment Type', description: 'Remote or managed' },
      { number: 2, title: 'Basic Info', description: 'Name and description' },
      { number: 3, title: 'Connection', description: 'Transport and endpoint' },
      { number: 4, title: 'Auth & Params', description: 'Auth, headers, query params' },
      { number: 5, title: 'Tools & Security', description: 'Tool filtering and trust' },
      { number: 6, title: 'Review', description: 'Confirm details' },
    ]
  }

  const steps = getSteps()
  const totalSteps = steps.length

  const getRemoteStepKey = (s: number): string => {
    if (editingServerId) {
      return ['basic-info', 'connection', 'auth-params', 'tools', 'review'][s - 1] || 'review'
    }
    return ['deploy-type', 'basic-info', 'connection', 'auth-params', 'tools', 'review'][s - 1] || 'review'
  }

  const getManagedStepKey = (s: number): string => {
    if (editingServerId) {
      return ['config', 'tools', 'review'][s - 1] || 'review'
    }
    return ['deploy-type', 'catalog', 'config', 'tools', 'review'][s - 1] || 'review'
  }

  const currentStepKey = deploymentType === 'managed'
    ? getManagedStepKey(wizardStep)
    : getRemoteStepKey(wizardStep)

  const nextStep = () => {
    if (deploymentType === 'managed') {
      if (currentStepKey === 'catalog' && !formData.catalogId) {
        setFormError('Please select a server from the catalog')
        return
      }
      if (currentStepKey === 'config') {
        if (!formData.name?.trim()) {
          setFormError('Name is required')
          return
        }
        if (!/^[a-zA-Z0-9_]+$/.test(formData.name)) {
          setFormError('Name must be alphanumeric with underscores only')
          return
        }
        const selectedCatalog = catalog.find((c) => c.id === formData.catalogId)
        if (selectedCatalog) {
          for (const env of selectedCatalog.envSchema) {
            if (env.required && !formData.managedConfig?.envOverrides?.[env.name]?.trim()) {
              setFormError(`${env.name} is required`)
              return
            }
          }
        }
      }
    } else {
      if (currentStepKey === 'basic-info') {
        if (!formData.name?.trim()) {
          setFormError('Name is required')
          return
        }
        if (!/^[a-zA-Z0-9_]+$/.test(formData.name)) {
          setFormError('Name must be alphanumeric with underscores only')
          return
        }
      } else if (currentStepKey === 'connection') {
        if ((formData.transport === 'http' || formData.transport === 'sse') && !formData.url?.trim()) {
          setFormError('URL is required for HTTP/SSE transport')
          return
        }
        if (formData.transport === 'stdio' && !formData.command?.trim()) {
          setFormError('Command is required for stdio transport')
          return
        }
      } else if (currentStepKey === 'auth-params') {
        for (const p of formData.queryParams || []) {
          if (!p.name?.trim()) {
            setFormError('Query parameter name is required for all rows')
            return
          }
          if (!p.value && !p.secretRef?.credentialId) {
            setFormError(`Query parameter "${p.name}" needs a value or secret reference`)
            return
          }
        }
        const qpNames = (formData.queryParams || []).map((p) => p.name?.trim().toLowerCase())
        if (new Set(qpNames).size !== qpNames.length) {
          setFormError('Duplicate query parameter names are not allowed')
          return
        }
        for (const p of formData.headerParams || []) {
          if (!p.name?.trim()) {
            setFormError('Header parameter name is required for all rows')
            return
          }
          if (!p.value && !p.secretRef?.credentialId) {
            setFormError(`Header parameter "${p.name}" needs a value or secret reference`)
            return
          }
        }
        const hpNames = (formData.headerParams || []).map((p) => p.name?.trim().toLowerCase())
        if (new Set(hpNames).size !== hpNames.length) {
          setFormError('Duplicate header parameter names are not allowed')
          return
        }
        if (formData.authConfig?.keyName && !formData.authConfig?.secretRef?.credentialId) {
          setFormError('Auth injection requires a secret source when a key name is set')
          return
        }
      }
    }
    setFormError(null)
    setWizardStep((prev) => Math.min(prev + 1, totalSteps))
  }

  const prevStep = () => {
    setFormError(null)
    setWizardStep((prev) => Math.max(prev - 1, 1))
  }

  const updateFormField = (field: keyof CreateMCPServerRequest, value: any) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
  }

  const handleSubmit = async () => {
    if (!projectId) return
    try {
      setSubmitting(true)
      setFormError(null)

      const cleanedData: CreateMCPServerRequest = {
        ...formData,
        args: formData.args?.filter((a) => a.trim() !== ''),
        allowedTools: formData.allowedTools?.filter((t) => t.trim() !== ''),
        disallowedTools: formData.disallowedTools?.filter((t) => t.trim() !== ''),
        queryParams: formData.queryParams?.filter((p) => p.name?.trim() && p.enabled !== false),
        headerParams: formData.headerParams?.filter((p) => p.name?.trim() && p.enabled !== false),
      }

      if (editingServerId) {
        const updatePayload = { ...cleanedData } as Record<string, unknown>
        if (formData.deploymentType === 'managed') {
          const managedDisallowed = ['transport', 'url', 'command', 'args', 'authType', 'credentialId',
            'env', 'authorizationUrl', 'tokenUrl', 'staticHeaders', 'queryParams', 'headerParams', 'authConfig',
            'extraHeaders', 'specPath',
            'deploymentType', 'catalogId']
          for (const field of managedDisallowed) {
            delete updatePayload[field]
          }
        } else {
          const remoteDisallowed = ['deploymentType', 'catalogId', 'managedConfig']
          for (const field of remoteDisallowed) {
            delete updatePayload[field]
          }
        }
        await mcpServerApi.update(projectId, editingServerId, updatePayload as UpdateMCPServerRequest)
        showToast('MCP server updated', 'success')
      } else {
        await mcpServerApi.create(projectId, cleanedData)
        showToast(
          deploymentType === 'managed' ? 'MCP server provisioning started' : 'MCP server created',
          'success'
        )
      }

      setShowCreateModal(false)
      resetForm()
      loadServers()
    } catch (err: any) {
      const msg = err.response?.data?.error || err.message || 'Operation failed'
      setFormError(msg)
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
        <Spinner label="Loading MCP servers..." />
      </div>
    )
  }

  const getConnectionDisplay = (s: MCPServer) => {
    if (s.deploymentType === 'managed') {
      const entry = catalog.find((c) => c.id === s.catalogId)
      return entry?.name || s.catalogId || 'Managed'
    }
    if (s.transport === 'stdio') return `stdio: ${s.command}`
    return `${s.transport}: ${s.url}`
  }

  const getTypeBadge = (s: MCPServer) => {
    if (s.deploymentType === 'managed') return <Badge appearance="filled" color="brand">Managed</Badge>
    return <Badge appearance="outline">Remote</Badge>
  }

  const getStatusBadge = (s: MCPServer) => {
    // For managed servers, show the runtime lifecycle status
    if (s.deploymentType === 'managed' && s.runtimeStatus) {
      switch (s.runtimeStatus) {
        case 'provisioning':
          return <Badge appearance="filled" color="warning">Provisioning...</Badge>
        case 'running':
          return <Badge appearance="filled" color="success">Running</Badge>
        case 'failed':
          return <Badge appearance="filled" color="danger">Failed</Badge>
        case 'deleting':
          return <Badge appearance="filled" color="warning">Deleting...</Badge>
      }
    }

    // For remote servers (or managed without runtime status), show connection status
    if (s.status === 'connected') return <Badge appearance="filled" color="success">Healthy</Badge>
    if (s.status === 'error' || s.status === 'disconnected') return <Badge appearance="filled" color="danger">Unhealthy</Badge>
    return <Badge appearance="outline" color="informative">Unknown</Badge>
  }

  const getSyncBadge = (s: MCPServer) => {
    if (s.syncStatus === 'synced') return <Badge appearance="filled" color="success">Synced</Badge>
    if (s.syncStatus === 'error') return <Badge appearance="filled" color="danger">Error</Badge>
    return <Badge appearance="filled" color="warning">Pending</Badge>
  }

  const handleRestart = async (server: MCPServer) => {
    if (!projectId) return
    try {
      showToast(`Restarting ${server.name}...`, 'info')
      await mcpServerApi.delete(projectId, server.id)
      await mcpServerApi.create(projectId, {
        name: server.name,
        description: server.description,
        deploymentType: 'managed',
        catalogId: server.catalogId,
        managedConfig: server.managedConfig,
        runtimeCredentialId: server.runtimeCredentialId,
        allowedTools: server.allowedTools,
        disallowedTools: server.disallowedTools,
        trust: server.trust,
        timeout: server.timeout,
      })
      await loadServers()
      showToast(`${server.name} restart initiated`, 'success')
    } catch (err: any) {
      showToast(err.message || 'Failed to restart', 'error')
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>MCP Servers</h1>
        <Button appearance="primary" icon={<Add24Regular />} onClick={() => {
          resetForm()
          if (projectId) credentialApi.list(projectId).then(setCredentials).catch(() => setCredentials([]))
          setShowCreateModal(true)
        }}>
          Add MCP Server
        </Button>
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
            placeholder="Search MCP servers..."
            value={searchQuery}
            onChange={(_, data) => setSearchQuery(data.value)}
            style={{ flex: 1 }}
          />
        </div>
        {filteredServers.length === 0 ? (
          <div style={{ padding: '24px' }}>
            <Text>No MCP servers found</Text>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Connection</TableHeaderCell>
                <TableHeaderCell>Sync</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Used by</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredServers.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <div
                      style={{ cursor: 'pointer' }}
                      onClick={() => navigate(`/projects/${projectId}/mcp-servers/${s.id}`)}
                    >
                      <Text weight="semibold" style={{ color: tokens.colorBrandForeground1, textDecoration: 'none' }}>
                        {s.name}
                      </Text>
                      {s.description && (
                        <Text size={200} style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>
                          {s.description}
                        </Text>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{getTypeBadge(s)}</TableCell>
                  <TableCell>
                    <Text size={200}>{getConnectionDisplay(s)}</Text>
                  </TableCell>
                  <TableCell>{getSyncBadge(s)}</TableCell>
                  <TableCell>{getStatusBadge(s)}</TableCell>
                  <TableCell>
                    {projectId && (
                      <DependentsCell
                        projectId={projectId}
                        targetKind="mcp_server"
                        targetId={s.id}
                        summary={s.dependentsSummary}
                      />
                    )}
                  </TableCell>
                  <TableCell>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <Button appearance="subtle" icon={<Edit24Regular />} onClick={() => handleEdit(s.id)} title="Edit" />
                      {s.deploymentType === 'managed' && s.runtimeStatus !== 'provisioning' && s.runtimeStatus !== 'deleting' && (
                        <Button appearance="subtle" icon={<ArrowSync24Regular />} onClick={() => handleRestart(s)} title="Restart" />
                      )}
                      <Button appearance="subtle" icon={<Delete24Regular />} onClick={() => handleDeleteClick(s.id, s.name)} title="Delete" />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {showCreateModal && (
        <WizardModal
          title={editingServerId ? 'Edit MCP Server' : 'Add MCP Server'}
          onClose={() => { setShowCreateModal(false); resetForm() }}
          onSubmit={handleSubmit}
          submitting={submitting}
          formError={formError}
          currentStep={wizardStep}
          onNext={nextStep}
          onPrev={prevStep}
          steps={steps}
          submitLabel={editingServerId ? 'Update' : deploymentType === 'managed' ? 'Deploy' : 'Create'}
          mode={editingServerId ? 'edit' : 'create'}
          onStepClick={(s) => { setFormError(null); setWizardStep(s) }}
        >
          <MCPServerWizard
            step={wizardStep}
            formData={formData}
            updateFormField={updateFormField}
            catalog={catalog}
            isEditing={!!editingServerId}
            credentials={credentials}
          />
        </WizardModal>
      )}

      <Dialog open={deleteDialogOpen} onOpenChange={(_, data) => {
        setDeleteDialogOpen(data.open)
        if (!data.open) {
          setServerToDelete(null)
          setDeleteBlockers(null)
        }
      }}>
        <DialogSurface>
          <DialogTitle>Delete MCP Server</DialogTitle>
          <DialogBody>
            <DialogContent>
              {deleteBlockers ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <Text>
                    Cannot delete MCP server &quot;{serverToDelete?.name}&quot; while it is still in use by:
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
                  Are you sure you want to delete MCP server &quot;{serverToDelete?.name}&quot;?
                  {servers.find(s => s.id === serverToDelete?.id)?.deploymentType === 'managed'
                    ? ' This will also deprovision the Kubernetes pod.'
                    : ' This will also remove it from the LLM gateway.'}
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
    </div>
  )
}
