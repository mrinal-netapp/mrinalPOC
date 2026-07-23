import { useState, useEffect, useCallback, useRef, Fragment, useMemo } from 'react'
import {
  makeStyles,
  tokens,
  Card,
  Text,
  Button,
  Spinner,
  MessageBar,
  MessageBarBody,
  Badge,
  Tooltip,
  Tree,
  TreeItem,
  TreeItemLayout,
  TreeItemValue,
  TreeOpenChangeData,
  TreeOpenChangeEvent,
} from '@fluentui/react-components'
import {
  Add16Regular,
  Add24Regular,
  Edit24Regular,
  Delete24Regular,
  Search24Regular,
  Database24Regular,
  CloudArrowUp24Regular,
  Cloud24Regular,
  PlugConnected24Regular,
  FolderOpen24Regular,
  Storage24Regular,
} from '@fluentui/react-icons'
import { datasourceApi, credentialApi, connectorApi, workflowApi, explorerApi, DataSourceItem, DataSourceConnectorConfig, CreateDataSourceRequest, ExplorerNode, ProviderCatalogEntry } from '../../services/api'
import { Input } from '@fluentui/react-components'
import { WizardModal } from '../wizard/WizardModal'
import {
  ConnectorWizard,
  ConnectorFormData,
  ConnectorWizardRef,
} from '../wizard/ConnectorWizard'
import {
  ConnectorTemplate,
  ConnectorTemplatePicker,
  getConnectorClassLabel,
} from '../wizard/ConnectorTemplates'
import { ConnectorExplorer, ConnectorExplorerHandle } from '../connector-explorer'
import { ScrollableDialogShell, HorizontalSplit } from '../dialog'
import { validateOntapVolumeMountReady } from '../../utils/ontapExplorerMount'
import { useToast } from '../../contexts/ToastContext'
import { Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions } from '@fluentui/react-components'
import type { ConnectorType } from '../../services/api'
import { useExplorerActionQueue } from '../connector-explorer/useExplorerActionQueue'
import { ExplorerActionQueue } from '../connector-explorer/ExplorerActionQueue'
import { OntapVolumeRegistrationStrategy } from '../connector-explorer/strategies/OntapVolumeRegistrationStrategy'

const useStyles = makeStyles({
  treeCard: {
    padding: '16px',
  },
  categoryNode: {
    fontWeight: 600,
    fontSize: '14px',
  },
  instanceNode: {
    fontSize: '13px',
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '8px',
    minWidth: 0,
  },
  searchBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    flexWrap: 'wrap',
    marginBottom: '12px',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  emptyText: {
    fontStyle: 'italic',
    color: tokens.colorNeutralForeground3,
    fontSize: '12px',
    padding: '4px 0',
  },
  actions: {
    display: 'flex',
    gap: '2px',
    alignItems: 'center',
  },
  subtitle: {
    color: tokens.colorNeutralForeground3,
    fontSize: '13px',
    marginBottom: '12px',
  },
  toolbar: {
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '8px',
  },
})

interface CategoryDef {
  id: ConnectorType
  label: string
  icon: JSX.Element
}

const CATEGORIES: CategoryDef[] = [
  { id: 'database', label: 'Databases', icon: <Database24Regular /> },
  { id: 'objectstore', label: 'Object Stores', icon: <CloudArrowUp24Regular /> },
  { id: 'cloud', label: 'Cloud Accounts', icon: <Cloud24Regular /> },
  { id: 'storage', label: 'Storage Systems', icon: <Storage24Regular /> },
  { id: 'api', label: 'APIs', icon: <PlugConnected24Regular /> },
]

function buildConnectorTypeSummary(data: ConnectorFormData): string {
  switch (data.connectorType) {
    case 'database': {
      const engine = data.databaseType === 'mysql' ? 'MySQL' : 'PostgreSQL'
      const ssl = data.sslMode === 'require' ? ' — SSL required' : ''
      return `Database · ${engine}${ssl}`
    }
    case 'objectstore': {
      if (data.provider === 'gcs') return 'Object Store · Google Cloud Storage'
      if (data.endpoint?.trim()) return 'Object Store · S3-compatible'
      return 'Object Store · Amazon S3'
    }
    case 'cloud':
      return 'Cloud Account · Google Cloud'
    case 'storage':
      return 'Storage System · NetApp ONTAP'
    case 'api':
      return 'API · Redash'
    default:
      return 'Connector'
  }
}

const defaultFormData: ConnectorFormData = {
  name: '',
  description: '',
  connectorType: 'database',
  credentialId: '',
  databaseType: 'postgresql',
  host: '',
  port: 5432,
  database: '',
  schema: 'public',
  sslMode: 'prefer',
  provider: 's3',
  bucket: '',
}

export interface ConnectorListingProps {
  projectId: string
  onResourcesRegistered?: () => void
}

export function ConnectorListing({ projectId, onResourcesRegistered }: ConnectorListingProps) {
  const styles = useStyles()
  const { showToast } = useToast()

  const [connectors, setConnectors] = useState<DataSourceItem[]>([])
  const [filteredConnectors, setFilteredConnectors] = useState<DataSourceItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editingConnectorId, setEditingConnectorId] = useState<string | null>(null)
  const [wizardStep, setWizardStep] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [connectorToDelete, setConnectorToDelete] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [formData, setFormData] = useState<ConnectorFormData>({ ...defaultFormData })
  const [credentials, setCredentials] = useState<Array<{ id: string; name: string; provider: string }>>([])
  const [testResults, setTestResults] = useState<Map<string, 'connected' | 'failed'>>(new Map())
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set())
  const [explorerOpen, setExplorerOpen] = useState(false)
  const [explorerConnector, setExplorerConnector] = useState<DataSourceItem | null>(null)
  const [selectedNode, setSelectedNode] = useState<ExplorerNode | null>(null)
  const [providerCatalog, setProviderCatalog] = useState<Record<string, ProviderCatalogEntry>>({})
  const [bucketPickerOpen, setBucketPickerOpen] = useState(false)
  const [bucketList, setBucketList] = useState<string[]>([])
  const [browseBucketsLoading, setBrowseBucketsLoading] = useState(false)
  const connectorWizardRef = useRef<ConnectorWizardRef>(null)
  const [openItems, setOpenItems] = useState<Set<TreeItemValue>>(new Set())
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false)
  const [templatePickerCategory, setTemplatePickerCategory] = useState<ConnectorType | null>(null)
  const [wizardOpenedFromTemplate, setWizardOpenedFromTemplate] = useState(false)
  const explorerRef = useRef<ConnectorExplorerHandle>(null)
  const [prevExplorerConnectorId, setPrevExplorerConnectorId] = useState<string | null>(null)

  const isOntapExplorer = explorerConnector != null && (
    explorerConnector.connector_config?.connector_type === 'storage' ||
    explorerConnector.connector_config?.provider === 'ontap'
  )

  const ontapStrategy = useMemo(() => new OntapVolumeRegistrationStrategy(), [])
  const strategyContext = useMemo(() => ({
    projectId,
    connectorId: explorerConnector?.id || '',
    clusterUrl: explorerConnector?.connector_config?.cluster_url || '',
  }), [projectId, explorerConnector?.id, explorerConnector?.connector_config?.cluster_url])

  const queue = useExplorerActionQueue(ontapStrategy, strategyContext)

  // Clear queue when switching connectors
  useEffect(() => {
    if (explorerConnector && explorerConnector.id !== prevExplorerConnectorId) {
      queue.clearAll()
      setPrevExplorerConnectorId(explorerConnector.id)
    }
  }, [explorerConnector?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const openTemplatePicker = useCallback((category: ConnectorType | null) => {
    setTemplatePickerCategory(category)
    setTemplatePickerOpen(true)
  }, [])

  const loadCredentials = async () => {
    if (!projectId) return
    try {
      const creds = await credentialApi.list(projectId)
      setCredentials(creds.map((c) => ({ id: c.id, name: c.name, provider: c.provider })))
    } catch (err: any) {
      console.error('Failed to load credentials:', err)
    }
  }

  const loadConnectors = async () => {
    if (!projectId) return
    try {
      setLoading(true)
      setError(null)
      const data = await datasourceApi.list(projectId, { type: 'connector' })
      setConnectors(data)
      setFilteredConnectors(data)
    } catch (err: any) {
      setError(err.message || 'Failed to load connectors')
      console.error('Failed to load connectors:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    explorerApi.getProviders().then(({ providers }) => {
      const map: Record<string, ProviderCatalogEntry> = {}
      for (const p of providers) map[p.id] = p
      setProviderCatalog(map)
    }).catch((err) => console.error('Failed to load provider catalog:', err))
  }, [])

  useEffect(() => {
    loadConnectors()
    loadCredentials()
  }, [projectId])

  useEffect(() => {
    if (!searchQuery.trim()) {
      setFilteredConnectors(connectors)
      return
    }
    const query = searchQuery.toLowerCase()
    setFilteredConnectors(
      connectors.filter(
        (ds) =>
          ds.name.toLowerCase().includes(query) ||
          ds.description?.toLowerCase().includes(query) ||
          ds.id.toLowerCase().includes(query)
      )
    )
  }, [searchQuery, connectors])

  useEffect(() => {
    const cats = new Set<TreeItemValue>()
    for (const ds of filteredConnectors) {
      const ct = ds.connector_config?.connector_type
      if (ct && CATEGORIES.some((c) => c.id === ct)) cats.add(`cat-${ct}`)
      else cats.add('cat-other')
    }
    setOpenItems(cats)
  }, [filteredConnectors])

  const handleDeleteClick = (id: string, name: string) => {
    setConnectorToDelete({ id, name })
    setDeleteDialogOpen(true)
  }

  const handleDeleteConfirm = async () => {
    if (!projectId || !connectorToDelete) return
    try {
      setDeleting(true)
      setError(null)
      await datasourceApi.delete(projectId, connectorToDelete.id)
      await loadConnectors()
      setDeleteDialogOpen(false)
      setConnectorToDelete(null)
      showToast(`Connector "${connectorToDelete.name}" deleted successfully`, 'success')
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Failed to delete connector')
      showToast(err.message || 'Failed to delete connector', 'error')
    } finally {
      setDeleting(false)
    }
  }

  const resetForm = () => {
    setFormData({ ...defaultFormData })
    setFormError(null)
    setWizardStep(1)
    setEditingConnectorId(null)
    setWizardOpenedFromTemplate(false)
  }

  const handleEdit = async (id: string) => {
    if (!projectId) return
    try {
      setError(null)
      const ds = await datasourceApi.get(projectId, id)
      const cfg: Partial<DataSourceConnectorConfig> = ds.connector_config || {}
      setFormData({
        name: ds.name,
        description: ds.description || '',
        connectorType: cfg.connector_type || 'database',
        credentialId: (ds as any).credentialId || (ds as any).credential_id || '',
        databaseType: cfg.database_type,
        host: cfg.host,
        port: cfg.port,
        database: cfg.database,
        schema: cfg.schema || 'public',
        sslMode: cfg.ssl_mode || 'prefer',
        provider: (cfg.provider as any) || 's3',
        endpoint: cfg.endpoint,
        bucket: cfg.bucket,
        prefix: cfg.prefix,
        region: cfg.region,
        projectId: cfg.project_id,
        defaultRegion: cfg.default_region,
        clusterUrl: cfg.cluster_url,
        verifyTls: cfg.verify_tls !== false,
        defaultSvm: cfg.default_svm,
        baseUrl: cfg.base_url,
        includeQueryResults: cfg.include_query_results ?? true,
        includeDashboards: cfg.include_dashboards ?? true,
        includeDataSources: cfg.include_data_sources ?? true,
        maxResultRows: cfg.max_result_rows,
      })
      setEditingConnectorId(id)
      setWizardOpenedFromTemplate(false)
      setWizardStep(1)
      setShowCreateModal(true)
    } catch (err: any) {
      setError(err.message || 'Failed to load connector')
    }
  }

  const buildConnectorConfig = (data: ConnectorFormData) => {
    if (data.connectorType === 'database') {
      return {
        connector_type: 'database' as const,
        scope: 'resource' as const,
        provider: data.databaseType || 'postgresql',
        database_type: data.databaseType,
        host: data.host,
        port: data.port,
        database: data.database,
        schema: data.schema,
        ssl_mode: data.sslMode,
      }
    }
    if (data.connectorType === 'cloud') {
      return {
        connector_type: 'cloud' as const,
        scope: 'account' as const,
        provider: data.provider || 'gcp',
        project_id: data.projectId,
        default_region: data.defaultRegion,
      }
    }
    if (data.connectorType === 'storage') {
      return {
        connector_type: 'storage' as const,
        scope: 'account' as const,
        provider: data.provider || 'ontap',
        cluster_url: data.clusterUrl,
        verify_tls: data.verifyTls !== false,
        default_svm: data.defaultSvm || undefined,
      }
    }
    if (data.connectorType === 'api') {
      return {
        connector_type: 'api' as const,
        scope: 'account' as const,
        provider: data.provider || 'redash',
        base_url: data.baseUrl,
        verify_tls: data.verifyTls !== false,
        include_query_results: data.includeQueryResults ?? true,
        include_dashboards: data.includeDashboards ?? true,
        include_data_sources: data.includeDataSources ?? true,
        max_result_rows: data.maxResultRows || 10000,
      }
    }
    return {
      connector_type: 'objectstore' as const,
      scope: 'resource' as const,
      provider: data.provider || 's3',
      endpoint: data.endpoint,
      bucket: data.bucket,
      prefix: data.prefix,
      region: data.region,
    }
  }

  const nextStep = () => {
    if (wizardStep === 1) {
      if (!formData.name?.trim()) {
        setFormError('Name is required')
        return
      }
      if (!formData.credentialId) {
        setFormError('Credential is required')
        return
      }
    } else if (wizardStep === 2) {
      if (formData.connectorType === 'database') {
        if (!formData.host || !formData.port) {
          setFormError('Host and port are required')
          return
        }
      } else if (formData.connectorType === 'cloud') {
        if (!formData.projectId?.trim()) {
          setFormError('Project ID is required')
          return
        }
      } else if (formData.connectorType === 'storage') {
        if (!formData.clusterUrl?.trim()) {
          setFormError('Cluster URL is required')
          return
        }
      } else if (formData.connectorType === 'api') {
        if (!(formData as any).baseUrl?.trim()) {
          setFormError('Base URL is required')
          return
        }
      }
    }
    setFormError(null)
    setWizardStep((prev) => Math.min(prev + 1, 3))
  }

  const prevStep = () => {
    setFormError(null)
    setWizardStep((prev) => Math.max(prev - 1, 1))
  }

  const updateFormField = (field: keyof ConnectorFormData, value: any) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
  }

  const handleTemplateSelect = (template: ConnectorTemplate) => {
    setTemplatePickerOpen(false)
    setWizardOpenedFromTemplate(true)
    setFormData({ ...defaultFormData, ...template.defaults })
    setWizardStep(1)
    setEditingConnectorId(null)
    setFormError(null)
    setShowCreateModal(true)
  }

  const handleRequestChangeConnectorType = () => {
    setShowCreateModal(false)
    resetForm()
    setTemplatePickerOpen(true)
  }

  const handleCreateCredential = useCallback(async (data: {
    name: string
    provider: string
    secretData: Record<string, string>
    labels?: string[]
  }): Promise<{ id: string; name: string; provider: string }> => {
    if (!projectId) throw new Error('No project selected')
    const created = await credentialApi.create(projectId, {
      name: data.name,
      provider: data.provider,
      secretData: data.secretData,
      labels: data.labels,
    })
    const newCred = { id: created.id, name: created.name, provider: created.provider }
    setCredentials((prev) => [...prev, newCred])
    showToast(`Credential "${created.name}" created`, 'success')
    return newCred
  }, [projectId, showToast])

  const pollWorkflowResult = useCallback(async (workflowId: string): Promise<{ success: boolean; message: string }> => {
    const maxAttempts = 15
    const intervalMs = 2000
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, intervalMs))
      try {
        const status = await workflowApi.getStatus(workflowId)
        if (status.status === 'completed') {
          return { success: true, message: 'Connection successful' }
        }
        if (status.status === 'failed') {
          return { success: false, message: status.failureMessage || 'Connection failed' }
        }
        if (!status.isRunning) {
          return { success: false, message: `Workflow ended with status: ${status.status}` }
        }
      } catch {
        // Status endpoint may 404 briefly while the workflow starts
      }
    }
    return { success: false, message: 'Test timed out after 30s' }
  }, [])

  const handleTestConnection = useCallback(async (): Promise<{ success: boolean; message: string }> => {
    if (!projectId) return { success: false, message: 'No project selected' }
    const config = buildConnectorConfig(formData)
    const connectorId = editingConnectorId || '_unsaved'
    try {
      const { workflowId } = await connectorApi.testConnection(projectId, connectorId, config as DataSourceConnectorConfig, formData.credentialId)
      return await pollWorkflowResult(workflowId)
    } catch (err: any) {
      return { success: false, message: err.response?.data?.error || err.message || 'Test request failed' }
    }
  }, [projectId, formData, editingConnectorId, pollWorkflowResult])

  const handleBrowseBuckets = useCallback(async () => {
    if (!projectId || !formData.credentialId) {
      showToast('Select a credential first', 'error')
      return
    }
    setBrowseBucketsLoading(true)
    try {
      const config = buildConnectorConfig({ ...formData, bucket: '' })
      const { workflowId } = await connectorApi.testConnection(
        projectId, '_unsaved', config as DataSourceConnectorConfig, formData.credentialId
      )
      const pollResult = await pollWorkflowResult(workflowId)
      if (!pollResult.success) {
        showToast(pollResult.message, 'error')
        return
      }
      const result = await workflowApi.getResult(workflowId)
      const buckets = result?.data?.buckets as string[] | undefined
      if (Array.isArray(buckets) && buckets.length > 0) {
        setBucketList(buckets)
        setBucketPickerOpen(true)
      } else {
        showToast(
          Array.isArray(buckets) && buckets.length === 0
            ? 'No buckets found'
            : (result?.message || 'Could not list buckets'),
          'info'
        )
      }
    } catch (err: any) {
      showToast(err?.response?.data?.error || err?.message || 'Failed to list buckets', 'error')
    } finally {
      setBrowseBucketsLoading(false)
    }
  }, [projectId, formData, pollWorkflowResult, showToast])

  const handleListTestConnection = async (ds: DataSourceItem) => {
    if (!projectId || !ds.connector_config) return
    const connectorId = ds.id
    setTestingIds((prev) => new Set(prev).add(connectorId))
    try {
      const { workflowId } = await connectorApi.testConnection(
        projectId, connectorId, ds.connector_config, (ds as any).credential_id || ''
      )
      const result = await pollWorkflowResult(workflowId)
      setTestResults((prev) => new Map(prev).set(connectorId, result.success ? 'connected' : 'failed'))
      showToast(result.message, result.success ? 'success' : 'error')
      await datasourceApi.recordConnectionTestResult(projectId, connectorId, {
        success: result.success,
        message: result.message,
      })
      const updateConnector = (list: DataSourceItem[]) =>
        list.map((c) =>
          c.id === connectorId
            ? { ...c, last_connection_test_at: new Date().toISOString(), last_connection_test_status: result.success ? ('success' as const) : ('failed' as const), last_connection_test_message: result.message }
            : c
        )
      setConnectors(updateConnector)
      setFilteredConnectors(updateConnector)
    } catch (err: any) {
      setTestResults((prev) => new Map(prev).set(connectorId, 'failed'))
      showToast(err.message || 'Test failed', 'error')
    } finally {
      setTestingIds((prev) => { const next = new Set(prev); next.delete(connectorId); return next })
    }
  }

  const handleSubmit = async () => {
    if (!projectId) return
    try {
      setSubmitting(true)
      setFormError(null)
      const connectorConfig = buildConnectorConfig(formData)
      if (editingConnectorId) {
        await datasourceApi.update(projectId, editingConnectorId, {
          name: formData.name,
          description: formData.description,
          connector_config: connectorConfig,
          credential_id: formData.credentialId,
        })
      } else {
        const dsRequest: CreateDataSourceRequest = {
          name: formData.name,
          type: 'connector',
          description: formData.description,
          connector_config: connectorConfig,
          credential_id: formData.credentialId,
        }
        await datasourceApi.create(projectId, dsRequest)
      }
      setShowCreateModal(false)
      resetForm()
      loadConnectors()
      showToast(
        `Connector "${formData.name}" ${editingConnectorId ? 'updated' : 'created'} successfully`,
        'success'
      )
    } catch (err: any) {
      setFormError(err.response?.data?.error || err.message || `Failed to ${editingConnectorId ? 'update' : 'create'} connector`)
    } finally {
      setSubmitting(false)
    }
  }

  const instancesByCategory = useMemo(() => {
    const byCat = new Map<ConnectorType, DataSourceItem[]>()
    for (const c of CATEGORIES) {
      byCat.set(c.id, [])
    }
    const other: DataSourceItem[] = []
    for (const ds of filteredConnectors) {
      const ct = ds.connector_config?.connector_type as ConnectorType | undefined
      if (ct && byCat.has(ct)) {
        byCat.get(ct)!.push(ds)
      } else {
        other.push(ds)
      }
    }
    const sortNamed = (list: DataSourceItem[]) =>
      list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    for (const id of byCat.keys()) {
      sortNamed(byCat.get(id)!)
    }
    sortNamed(other)
    return { byCat, other }
  }, [filteredConnectors])

  const searchActive = searchQuery.trim().length > 0
  const visibleCategories = useMemo(
    () =>
      CATEGORIES.filter((cat) => {
        if (!searchActive) return true
        return (instancesByCategory.byCat.get(cat.id)?.length ?? 0) > 0
      }),
    [searchActive, instancesByCategory.byCat],
  )
  const showOtherCategory = instancesByCategory.other.length > 0

  const handleTreeOpenChange = (_e: TreeOpenChangeEvent, data: TreeOpenChangeData) => {
    setOpenItems(data.openItems)
  }

  const getDisplayStatus = (ds: DataSourceItem): 'connected' | 'failed' | undefined => {
    const statusVal = testResults.get(ds.id)
    if (statusVal) return statusVal
    const ps = ds.last_connection_test_status
    if (ps === 'success') return 'connected'
    if (ps === 'failed') return 'failed'
    return undefined
  }

  const connectorCount = connectors.length

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
        <Spinner label="Loading connectors..." />
      </div>
    )
  }

  return (
    <>
      <div className={styles.toolbar}>
        <Badge appearance="outline" color="informative">{connectorCount} connector{connectorCount !== 1 ? 's' : ''}</Badge>
        <Button
          appearance="primary"
          icon={<Add24Regular />}
          onClick={() => openTemplatePicker(null)}
          aria-label="Add connector"
        >
          Add connector
        </Button>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <Card className={styles.treeCard}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
          <Search24Regular />
          <Input
            placeholder="Search connectors..."
            value={searchQuery}
            onChange={(_, data) => setSearchQuery(data.value)}
            style={{ flex: 1 }}
          />
        </div>

        {connectors.length === 0 && !searchQuery && (
          <Text className={styles.subtitle}>
            No connectors yet. Click <strong>Add connector</strong> to choose a type and finish setup in the wizard.
          </Text>
        )}

        {searchActive && (
          <div className={styles.searchBanner}>
            <span>
              Showing matches for &quot;{searchQuery.trim()}&quot;.
            </span>
            <Button appearance="transparent" size="small" onClick={() => setSearchQuery('')}>
              Clear search
            </Button>
          </div>
        )}

        <Tree
          aria-label="Connectors"
          openItems={openItems}
          onOpenChange={handleTreeOpenChange}
        >
          {visibleCategories.map((cat) => {
            const instances = instancesByCategory.byCat.get(cat.id) || []
            const catInstanceCount = instances.length

            return (
              <TreeItem key={cat.id} itemType="branch" value={`cat-${cat.id}`}>
                <TreeItemLayout
                  iconBefore={cat.icon}
                  aside={
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {catInstanceCount > 0 ? (
                        <Badge appearance="outline" size="small" color="informative">
                          {catInstanceCount}
                        </Badge>
                      ) : null}
                      <Tooltip content={`Add connector (${cat.label})`} relationship="label">
                        <Button
                          size="small"
                          icon={<Add16Regular />}
                          appearance="subtle"
                          aria-label={`Add connector (${cat.label})`}
                          onClick={(e) => {
                            e.stopPropagation()
                            openTemplatePicker(cat.id)
                          }}
                        >
                          Add
                        </Button>
                      </Tooltip>
                    </div>
                  }
                >
                  <span className={styles.categoryNode}>{cat.label}</span>
                </TreeItemLayout>
                <Tree>
                  {instances.length === 0 ? (
                    <TreeItem itemType="leaf" value={`empty-cat-${cat.id}`}>
                      <TreeItemLayout>
                        <span className={styles.emptyText}>(No connectors)</span>
                      </TreeItemLayout>
                    </TreeItem>
                  ) : (
                    instances.map((ds) => {
                      const displayStatus = getDisplayStatus(ds)
                      const isTesting = testingIds.has(ds.id)

                      return (
                        <TreeItem key={ds.id} itemType="leaf" value={`inst-${ds.id}`}>
                          <TreeItemLayout
                            aside={
                              <div className={styles.actions}>
                                {isTesting ? (
                                  <Spinner size="tiny" />
                                ) : displayStatus === 'connected' ? (
                                  <Badge appearance="filled" color="success" size="small">Connected</Badge>
                                ) : displayStatus === 'failed' ? (
                                  <Badge appearance="filled" color="danger" size="small">Failed</Badge>
                                ) : (
                                  <Badge appearance="outline" color="informative" size="small">Untested</Badge>
                                )}
                                <Tooltip content="Explore" relationship="label">
                                  <Button
                                    appearance="subtle"
                                    icon={<FolderOpen24Regular />}
                                    size="small"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setExplorerConnector(ds)
                                      setSelectedNode(null)
                                      setExplorerOpen(true)
                                    }}
                                  />
                                </Tooltip>
                                <Tooltip content="Test Connection" relationship="label">
                                  <Button
                                    appearance="subtle"
                                    icon={<PlugConnected24Regular />}
                                    size="small"
                                    disabled={isTesting}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleListTestConnection(ds)
                                    }}
                                  />
                                </Tooltip>
                                <Tooltip content="Edit" relationship="label">
                                  <Button
                                    appearance="subtle"
                                    icon={<Edit24Regular />}
                                    size="small"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleEdit(ds.id)
                                    }}
                                  />
                                </Tooltip>
                                <Tooltip content="Delete" relationship="label">
                                  <Button
                                    appearance="subtle"
                                    icon={<Delete24Regular />}
                                    size="small"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleDeleteClick(ds.id, ds.name)
                                    }}
                                  />
                                </Tooltip>
                              </div>
                            }
                          >
                            <span className={styles.instanceNode}>
                              <Text weight="semibold" size={300}>{ds.name}</Text>
                              <Badge appearance="outline" size="small" color="informative">
                                {getConnectorClassLabel(ds)}
                              </Badge>
                              {ds.description && (
                                <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                                  {ds.description}
                                </Text>
                              )}
                            </span>
                          </TreeItemLayout>
                        </TreeItem>
                      )
                    })
                  )}
                </Tree>
              </TreeItem>
            )
          })}
          {showOtherCategory && (
            <TreeItem key="other" itemType="branch" value="cat-other">
              <TreeItemLayout
                aside={
                  <Badge appearance="outline" size="small" color="warning">
                    {instancesByCategory.other.length}
                  </Badge>
                }
              >
                <span className={styles.categoryNode}>Uncategorized</span>
              </TreeItemLayout>
              <Tree>
                {instancesByCategory.other.map((ds) => {
                  const displayStatus = getDisplayStatus(ds)
                  const isTesting = testingIds.has(ds.id)
                  return (
                    <TreeItem key={ds.id} itemType="leaf" value={`inst-${ds.id}`}>
                      <TreeItemLayout
                        aside={
                          <div className={styles.actions}>
                            {isTesting ? (
                              <Spinner size="tiny" />
                            ) : displayStatus === 'connected' ? (
                              <Badge appearance="filled" color="success" size="small">Connected</Badge>
                            ) : displayStatus === 'failed' ? (
                              <Badge appearance="filled" color="danger" size="small">Failed</Badge>
                            ) : (
                              <Badge appearance="outline" color="informative" size="small">Untested</Badge>
                            )}
                            <Tooltip content="Explore" relationship="label">
                              <Button
                                appearance="subtle"
                                icon={<FolderOpen24Regular />}
                                size="small"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setExplorerConnector(ds)
                                  setSelectedNode(null)
                                  setExplorerOpen(true)
                                }}
                              />
                            </Tooltip>
                            <Tooltip content="Test Connection" relationship="label">
                              <Button
                                appearance="subtle"
                                icon={<PlugConnected24Regular />}
                                size="small"
                                disabled={isTesting}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleListTestConnection(ds)
                                }}
                              />
                            </Tooltip>
                            <Tooltip content="Edit" relationship="label">
                              <Button
                                appearance="subtle"
                                icon={<Edit24Regular />}
                                size="small"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleEdit(ds.id)
                                }}
                              />
                            </Tooltip>
                            <Tooltip content="Delete" relationship="label">
                              <Button
                                appearance="subtle"
                                icon={<Delete24Regular />}
                                size="small"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleDeleteClick(ds.id, ds.name)
                                }}
                              />
                            </Tooltip>
                          </div>
                        }
                      >
                        <span className={styles.instanceNode}>
                          <Text weight="semibold" size={300}>{ds.name}</Text>
                          <Badge appearance="outline" size="small" color="informative">
                            {getConnectorClassLabel(ds)}
                          </Badge>
                          {ds.description && (
                            <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                              {ds.description}
                            </Text>
                          )}
                        </span>
                      </TreeItemLayout>
                    </TreeItem>
                  )
                })}
              </Tree>
            </TreeItem>
          )}
        </Tree>

        {searchActive && filteredConnectors.length === 0 && (
          <Text style={{ marginTop: '12px', color: tokens.colorNeutralForeground3, fontStyle: 'italic' }}>
            No connectors match your search.
          </Text>
        )}
      </Card>

      <Dialog
        open={templatePickerOpen}
        onOpenChange={(_, data) => {
          if (!data.open) setTemplatePickerOpen(false)
        }}
      >
        <DialogSurface style={{ maxWidth: '960px', width: '92vw' }}>
          <DialogTitle>
            {templatePickerCategory == null
              ? 'Add connector'
              : `Add connector — ${CATEGORIES.find((c) => c.id === templatePickerCategory)?.label ?? ''}`}
          </DialogTitle>
          <DialogBody>
            <DialogContent>
              <Text size={200} style={{ color: tokens.colorNeutralForeground3, marginBottom: '12px', display: 'block' }}>
                Choose a connector type. You can add credentials and connection details in the next steps.
              </Text>
              <ConnectorTemplatePicker
                categoryFilter={templatePickerCategory}
                onSelect={handleTemplateSelect}
              />
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setTemplatePickerOpen(false)}>
                Cancel
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {showCreateModal && (
        <WizardModal
          title={editingConnectorId ? 'Edit Connector' : 'Create Connector'}
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
            { number: 1, title: 'Basic Info', description: 'Name and type' },
            { number: 2, title: 'Connection', description: 'Details' },
            { number: 3, title: 'Review', description: 'Confirm' },
          ]}
          submitLabel={editingConnectorId ? 'Update Connector' : 'Create Connector'}
          mode={editingConnectorId ? 'edit' : 'create'}
          onStepClick={(s) => { setFormError(null); setWizardStep(s) }}
        >
          <>
            <ConnectorWizard
              ref={connectorWizardRef}
              step={wizardStep}
              formData={formData}
              updateFormField={updateFormField}
              credentials={credentials}
              onTestConnection={handleTestConnection}
              onCreateCredential={handleCreateCredential}
              onBrowseBuckets={formData.connectorType === 'objectstore' ? handleBrowseBuckets : undefined}
              browseBucketsLoading={browseBucketsLoading}
              connectorTypeSelection={wizardOpenedFromTemplate ? 'summary' : 'dropdown'}
              connectorTypeSummary={buildConnectorTypeSummary(formData)}
              onRequestChangeConnectorType={
                wizardOpenedFromTemplate ? handleRequestChangeConnectorType : undefined
              }
              applyFullFormData={setFormData}
            />
            <Dialog
              open={bucketPickerOpen}
              onOpenChange={(_, data) => {
                if (!data.open) setBucketPickerOpen(false)
              }}
              modalType="modal"
            >
              <DialogSurface>
                <DialogTitle>Choose a bucket</DialogTitle>
                <DialogBody>
                  <DialogContent>
                    <p style={{ marginBottom: '12px', color: tokens.colorNeutralForeground3 }}>
                      Select a bucket from your S3-compatible store to use with this connector.
                    </p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '320px', overflowY: 'auto' }}>
                      {bucketList.map((name) => (
                        <Button
                          key={name}
                          appearance="secondary"
                          style={{ justifyContent: 'flex-start' }}
                          onClick={() => {
                            updateFormField('bucket', name)
                            setBucketPickerOpen(false)
                            setBucketList([])
                            setTimeout(() => connectorWizardRef.current?.focusBucketInput(), 0)
                          }}
                        >
                          {name}
                        </Button>
                      ))}
                    </div>
                  </DialogContent>
                </DialogBody>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => { setBucketPickerOpen(false); setBucketList([]) }}>
                    Cancel
                  </Button>
                </DialogActions>
              </DialogSurface>
            </Dialog>
          </>
        </WizardModal>
      )}

      <Dialog open={deleteDialogOpen} onOpenChange={(_, data) => {
        setDeleteDialogOpen(data.open)
        if (!data.open) setConnectorToDelete(null)
      }}>
        <DialogSurface>
          <DialogTitle>Delete Connector</DialogTitle>
          <DialogBody>
            <DialogContent>
              <Text>
                Are you sure you want to delete connector &quot;{connectorToDelete?.name}&quot;? This action cannot be undone.
              </Text>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDeleteDialogOpen(false)} disabled={deleting}>
                Cancel
              </Button>
              <Button appearance="primary" onClick={handleDeleteConfirm} disabled={deleting}>
                {deleting ? 'Deleting...' : 'Delete'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <ScrollableDialogShell
        open={explorerOpen}
        onOpenChange={(o) => {
          if (!o) {
            setExplorerOpen(false)
            setExplorerConnector(null)
            setSelectedNode(null)
          }
        }}
        title={`Explore: ${explorerConnector?.name || 'Connector'}`}
        bodyPadding="flush"
        resizable
        initialWidth="min(1040px, 92vw)"
        initialHeight="min(72vh, 720px)"
        minWidth={640}
        minHeight={440}
        body={
          explorerConnector && projectId ? (
            <HorizontalSplit
              pinnedSide="right"
              storageKey="explorerSelectionPaneWidth"
              initialRightPx={360}
              minLeftPx={400}
              minRightPx={260}
              left={
                <ConnectorExplorer
                  ref={explorerRef}
                  embedded
                  projectId={projectId}
                  connectorId={explorerConnector.id}
                  productTag={
                    explorerConnector.connector_config?.connector_type === 'storage' ||
                    explorerConnector.connector_config?.provider === 'ontap'
                      ? 'ontap'
                      : undefined
                  }
                  connectorScope={
                    (explorerConnector.connector_config as any)?.scope || 'resource'
                  }
                  initialAction={(() => {
                    const cfg = (explorerConnector.connector_config || {}) as { provider?: string; connector_type?: string; database?: string }
                    const provider = cfg.provider
                    const model = provider ? providerCatalog[provider]?.dataAccessModel : undefined
                    // For database connectors, when a specific database is configured we
                    // want to skip the "pick a database" level and start at schemas.
                    if (cfg.connector_type === 'database' && cfg.database) {
                      return 'listSchemas'
                    }
                    if (model?.rootAction) return model.rootAction
                    // Fallback for providers that haven't declared a dataAccessModel yet
                    // or for connectors we still need to support before the catalog loads.
                    switch (cfg.connector_type) {
                      case 'database': return 'listDatabases'
                      case 'cloud': return 'listServices'
                      case 'objectstore': return 'listBuckets'
                      case 'storage': return 'listServices'
                      case 'api': return 'listRootFolders'
                      default: return 'listPath'
                    }
                  })()}
                  hasRegionSelector={explorerConnector.connector_config?.provider === 'gcp'}
                  defaultRegion={explorerConnector.connector_config?.default_region}
                  onSelectNode={setSelectedNode}
                  selectedNodeId={isOntapExplorer ? undefined : selectedNode?.id}
                  selectionMode={isOntapExplorer ? 'multi' : 'single'}
                  selectableTypes={isOntapExplorer ? ontapStrategy.selectableNodeTypes : undefined}
                  selectedNodeIds={isOntapExplorer ? queue.selectedNodeIds : undefined}
                  onToggleNode={isOntapExplorer ? queue.toggleNode : undefined}
                  style={{ border: 'none', borderRadius: 0, height: '100%' }}
                />
              }
              right={
                isOntapExplorer ? (
                  <div style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: tokens.colorNeutralBackground2 }}>
                    <div style={{ padding: '6px 10px', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}>
                      <Button
                        size="small"
                        appearance="secondary"
                        onClick={() => {
                          const visible = explorerRef.current?.getVisibleNodes('volume') || []
                          const eligible = visible.filter((n) => validateOntapVolumeMountReady(n).ok)
                          if (eligible.length > 0) {
                            queue.addNodes(eligible)
                          } else {
                            showToast('No eligible volumes visible (expand SVMs to see volumes)', 'info')
                          }
                        }}
                      >
                        Add all eligible
                      </Button>
                    </div>
                    <div style={{ flex: 1, minHeight: 0 }}>
                      <ExplorerActionQueue
                        strategy={ontapStrategy}
                        items={queue.items}
                        onUpdateItem={queue.updateItem}
                        onRemoveItem={queue.removeItem}
                        onClearAll={queue.clearAll}
                        onApplyAll={async () => {
                          const result = await queue.applyAll()
                          if (result.succeeded > 0) {
                            showToast(
                              result.failed > 0
                                ? `Registered ${result.succeeded} volume(s), ${result.failed} failed`
                                : `Registered ${result.succeeded} volume(s) successfully`,
                              result.failed > 0 ? 'warning' : 'success',
                            )
                            onResourcesRegistered?.()
                          } else if (result.failed > 0) {
                            showToast(`All ${result.failed} volume(s) failed to register`, 'error')
                          }
                        }}
                        applying={queue.applying}
                        eligibleCount={queue.eligibleCount}
                        totalCount={queue.totalCount}
                      />
                    </div>
                  </div>
                ) : selectedNode ? (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      padding: '12px 14px',
                      overflow: 'auto',
                      height: '100%',
                      backgroundColor: tokens.colorNeutralBackground2,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <Text size={200} weight="semibold">Selected:</Text>
                      <Text size={200} style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                        {selectedNode.label}
                      </Text>
                      {selectedNode.kind && (
                        <Badge appearance="outline" size="small" color="informative">
                          {selectedNode.kind}
                        </Badge>
                      )}
                    </div>
                    {selectedNode.resource && Object.keys(selectedNode.resource).length > 0 && (
                      <dl
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'auto 1fr',
                          columnGap: '12px',
                          rowGap: '2px',
                          margin: 0,
                          fontSize: '12px',
                        }}
                      >
                        {Object.entries(selectedNode.resource)
                          .filter(([, v]) => v !== null && v !== undefined && v !== '')
                          .map(([k, v]) => (
                            <Fragment key={k}>
                              <dt style={{ color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap' }}>{k}</dt>
                              <dd
                                style={{
                                  margin: 0,
                                  fontFamily: 'monospace',
                                  wordBreak: 'break-all',
                                  color: tokens.colorNeutralForeground1,
                                }}
                              >
                                {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                              </dd>
                            </Fragment>
                          ))}
                      </dl>
                    )}
                  </div>
                ) : null
              }
            />
          ) : null
        }
        actions={
          <Button
            appearance="secondary"
            onClick={() => {
              setExplorerOpen(false)
              setExplorerConnector(null)
              setSelectedNode(null)
            }}
          >
            Close
          </Button>
        }
      />
    </>
  )
}
