import { useState, useEffect, useCallback } from 'react'
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
  Badge,
  TabList,
  Tab,
  Field,
  Input,
  Textarea,
  Switch,
} from '@fluentui/react-components'
import {
  ArrowLeft24Regular,
  ArrowSync24Regular,
  Play24Regular,
  PlugConnected24Regular,
  Search24Regular,
  Wrench24Regular,
  Warning24Regular,
} from '@fluentui/react-icons'
import { mcpServerApi, MCPServer, MCPToolInfo } from '../services/api'

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
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
  },
  headerBadges: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
  },
  title: {
    fontSize: '24px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  headerActions: {
    display: 'flex',
    gap: '8px',
  },
  card: {
    marginTop: '8px',
  },
  configGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: '24px',
    padding: '20px',
  },
  configSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  sectionTitle: {
    fontSize: '16px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
    marginBottom: '8px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  configItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  configLabel: {
    fontSize: '12px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  configValue: {
    fontSize: '14px',
    color: tokens.colorNeutralForeground1,
    wordBreak: 'break-all',
  },
  toolsContainer: {
    display: 'grid',
    gridTemplateColumns: '300px 1fr',
    gap: '16px',
    padding: '20px',
    minHeight: '400px',
  },
  toolsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    paddingRight: '16px',
    overflowY: 'auto',
    maxHeight: '600px',
  },
  toolItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: '10px 12px',
    borderRadius: '6px',
    cursor: 'pointer',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  toolItemActive: {
    backgroundColor: tokens.colorBrandBackground2,
  },
  toolName: {
    fontSize: '14px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  toolDesc: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  toolDetail: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    paddingLeft: '16px',
  },
  toolDetailHeader: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    paddingBottom: '12px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  toolDetailName: {
    fontSize: '18px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  toolDetailDesc: {
    fontSize: '14px',
    color: tokens.colorNeutralForeground3,
    lineHeight: '1.5',
  },
  formFields: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  resultContainer: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    marginTop: '8px',
  },
  resultBlock: {
    fontSize: '13px',
    lineHeight: '1.6',
    color: tokens.colorNeutralForeground1,
    whiteSpace: 'pre-wrap',
    backgroundColor: tokens.colorNeutralBackground2,
    padding: '16px',
    borderRadius: '6px',
    maxHeight: '400px',
    overflowY: 'auto',
    fontFamily: 'monospace',
    wordBreak: 'break-word',
  },
  resultError: {
    borderLeft: `4px solid ${tokens.colorPaletteRedForeground1}`,
  },
  emptyToolDetail: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    color: tokens.colorNeutralForeground3,
    gap: '8px',
  },
  chipList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
  },
  chip: {
    display: 'inline-block',
    padding: '2px 10px',
    borderRadius: '12px',
    fontSize: '12px',
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  searchBox: {
    marginBottom: '8px',
  },
})

function getStatusBadge(status: string) {
  switch (status) {
    case 'connected': return <Badge appearance="filled" color="success">Healthy</Badge>
    case 'disconnected': return <Badge appearance="filled" color="danger">Unhealthy</Badge>
    case 'error': return <Badge appearance="filled" color="danger">Unhealthy</Badge>
    default: return <Badge appearance="filled" color="informative">Unknown</Badge>
  }
}

function getSyncBadge(syncStatus: string) {
  switch (syncStatus) {
    case 'synced': return <Badge appearance="filled" color="success">Synced</Badge>
    case 'error': return <Badge appearance="filled" color="danger">Sync Error</Badge>
    default: return <Badge appearance="filled" color="warning">Pending</Badge>
  }
}

function getTypeBadge(server: MCPServer) {
  if (server.deploymentType === 'managed') return <Badge appearance="filled" color="brand">Managed</Badge>
  if (server.deploymentType === 'platform') return <Badge appearance="filled" color="important">Platform</Badge>
  return <Badge appearance="outline">Remote</Badge>
}

function getRuntimeBadge(runtimeStatus?: string) {
  if (!runtimeStatus) return null
  switch (runtimeStatus) {
    case 'provisioning': return <Badge appearance="filled" color="warning">Provisioning...</Badge>
    case 'running': return <Badge appearance="filled" color="success">Running</Badge>
    case 'failed': return <Badge appearance="filled" color="danger">Failed</Badge>
    case 'deleting': return <Badge appearance="filled" color="warning">Deleting...</Badge>
    default: return null
  }
}

interface SchemaProperty {
  type?: string
  description?: string
  default?: any
  enum?: any[]
  items?: any
  properties?: Record<string, any>
}

function renderFormField(
  name: string,
  schema: SchemaProperty,
  required: boolean,
  value: any,
  onChange: (name: string, value: any) => void,
) {
  const label = `${name}${required ? ' *' : ''}`
  const hint = schema.description || undefined

  if (schema.type === 'boolean') {
    return (
      <Field key={name} label={label} hint={hint}>
        <Switch checked={!!value} onChange={(_, data) => onChange(name, data.checked)} />
      </Field>
    )
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    return (
      <Field key={name} label={label} hint={hint}>
        <Input
          type="number"
          value={value ?? ''}
          onChange={(_, data) => onChange(name, data.value === '' ? undefined : Number(data.value))}
          placeholder={schema.default !== undefined ? `Default: ${schema.default}` : undefined}
        />
      </Field>
    )
  }

  if (schema.type === 'object' || schema.type === 'array') {
    return (
      <Field key={name} label={label} hint={hint || 'Enter valid JSON'}>
        <Textarea
          value={typeof value === 'string' ? value : (value !== undefined ? JSON.stringify(value, null, 2) : '')}
          onChange={(_, data) => onChange(name, data.value)}
          rows={4}
          placeholder={schema.type === 'array' ? '[]' : '{}'}
          style={{ fontFamily: 'monospace', fontSize: '13px' }}
        />
      </Field>
    )
  }

  if (schema.enum && schema.enum.length > 0) {
    return (
      <Field key={name} label={label} hint={hint}>
        <Input
          value={value ?? ''}
          onChange={(_, data) => onChange(name, data.value)}
          placeholder={`Options: ${schema.enum.join(', ')}`}
        />
      </Field>
    )
  }

  return (
    <Field key={name} label={label} hint={hint}>
      <Input
        value={value ?? ''}
        onChange={(_, data) => onChange(name, data.value)}
        placeholder={schema.default !== undefined ? `Default: ${schema.default}` : undefined}
      />
    </Field>
  )
}

function formatResult(result: any): { text: string; isError: boolean } {
  if (!result) return { text: 'No result returned', isError: false }

  const isError = !!result.isError

  if (Array.isArray(result.content)) {
    const textParts = result.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
    if (textParts.length > 0) {
      return { text: textParts.join('\n'), isError }
    }
  }

  return { text: JSON.stringify(result, null, 2), isError }
}

export default function MCPServerDetail() {
  const styles = useStyles()
  const { projectId, serverId } = useParams<{ projectId: string; serverId: string }>()
  const navigate = useNavigate()

  const [server, setServer] = useState<MCPServer | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'overview' | 'tools'>('overview')

  const [tools, setTools] = useState<MCPToolInfo[]>([])
  const [toolsLoading, setToolsLoading] = useState(false)
  const [toolsError, setToolsError] = useState<string | null>(null)
  const [toolsLoaded, setToolsLoaded] = useState(false)

  const [selectedTool, setSelectedTool] = useState<MCPToolInfo | null>(null)
  const [toolArgs, setToolArgs] = useState<Record<string, any>>({})
  const [toolResult, setToolResult] = useState<any>(null)
  const [toolRunning, setToolRunning] = useState(false)
  const [toolError, setToolError] = useState<string | null>(null)
  const [toolSearch, setToolSearch] = useState('')

  const [testingConnection, setTestingConnection] = useState(false)

  const loadServer = useCallback(async () => {
    if (!projectId || !serverId) return
    try {
      setLoading(true)
      setError(null)
      const data = await mcpServerApi.get(projectId, serverId)
      setServer(data)
    } catch (err: any) {
      setError(err.message || 'Failed to load MCP server')
    } finally {
      setLoading(false)
    }
  }, [projectId, serverId])

  useEffect(() => {
    if (projectId && serverId) {
      loadServer()
    }
  }, [projectId, serverId, loadServer])

  useEffect(() => {
    if (server?.runtimeStatus === 'provisioning') {
      const interval = setInterval(async () => {
        if (!projectId || !serverId) return
        try {
          const status = await mcpServerApi.getRuntimeStatus(projectId, serverId)
          setServer(prev => prev ? { ...prev, runtimeStatus: status.runtimeStatus as any } : prev)
          if (status.runtimeStatus === 'running' || status.runtimeStatus === 'failed') {
            loadServer()
          }
        } catch { /* ignore polling errors */ }
      }, 5000)
      return () => clearInterval(interval)
    }
  }, [server?.runtimeStatus, projectId, serverId, loadServer])

  const loadTools = useCallback(async () => {
    if (!projectId || !serverId) return
    try {
      setToolsLoading(true)
      setToolsError(null)
      console.log(`[MCPServerDetail] Loading tools for server=${serverId}`)
      const data = await mcpServerApi.listTools(projectId, serverId)
      console.log(`[MCPServerDetail] Loaded ${data.length} tool(s)`, data.map(t => t.name))
      setTools(data)
      setToolsLoaded(true)
    } catch (err: any) {
      console.error(`[MCPServerDetail] Failed to load tools:`, err)
      setToolsError(err.message || 'Failed to load tools')
    } finally {
      setToolsLoading(false)
    }
  }, [projectId, serverId])

  useEffect(() => {
    if (activeTab === 'tools' && !toolsLoaded && server?.syncStatus === 'synced') {
      loadTools()
    }
  }, [activeTab, toolsLoaded, server?.syncStatus, loadTools])

  const handleTestConnection = async () => {
    if (!projectId || !serverId) return
    try {
      setTestingConnection(true)
      console.log(`[MCPServerDetail] Testing connection for server=${serverId}`)
      const result = await mcpServerApi.testConnection(projectId, serverId)
      console.log(`[MCPServerDetail] Connection test result:`, result)
      setServer(prev => prev ? { ...prev, status: result.status as any } : prev)
    } catch (err) {
      console.error(`[MCPServerDetail] Connection test failed:`, err)
    } finally {
      setTestingConnection(false)
    }
  }

  const handleSelectTool = (tool: MCPToolInfo) => {
    setSelectedTool(tool)
    setToolArgs({})
    setToolResult(null)
    setToolError(null)
  }

  const handleArgChange = (name: string, value: any) => {
    setToolArgs(prev => ({ ...prev, [name]: value }))
  }

  const handleRunTool = async () => {
    if (!projectId || !serverId || !selectedTool) return
    try {
      setToolRunning(true)
      setToolResult(null)
      setToolError(null)

      const processedArgs: Record<string, any> = {}
      const properties = selectedTool.inputSchema?.properties || {}
      for (const [key, val] of Object.entries(toolArgs)) {
        if (val === undefined || val === '') continue
        const propSchema = properties[key]
        if (propSchema && (propSchema.type === 'object' || propSchema.type === 'array')) {
          try {
            processedArgs[key] = JSON.parse(val as string)
          } catch {
            setToolError(`Invalid JSON for field '${key}'`)
            setToolRunning(false)
            return
          }
        } else {
          processedArgs[key] = val
        }
      }

      console.log(`[MCPServerDetail] Calling tool=${selectedTool.name} args=`, processedArgs)
      const result = await mcpServerApi.callTool(projectId, serverId, selectedTool.name, processedArgs)
      console.log(`[MCPServerDetail] Tool call result:`, result)
      setToolResult(result)
    } catch (err: any) {
      console.error(`[MCPServerDetail] Tool call failed:`, err)
      setToolError(err.response?.data?.error || err.message || 'Tool call failed')
    } finally {
      setToolRunning(false)
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
        <Spinner label="Loading MCP server..." />
      </div>
    )
  }

  if (error || !server) {
    return (
      <div className={styles.container}>
        <MessageBar intent="error">
          <MessageBarBody>{error || 'MCP server not found'}</MessageBarBody>
        </MessageBar>
        <Button
          appearance="subtle"
          icon={<ArrowLeft24Regular />}
          onClick={() => navigate(`/projects/${projectId}/mcp-servers`)}
        >
          Back to MCP Servers
        </Button>
      </div>
    )
  }

  const canListTools = server.syncStatus === 'synced' && server.status !== 'error'
  const filteredTools = toolSearch
    ? tools.filter(t => t.name.toLowerCase().includes(toolSearch.toLowerCase()) ||
        t.description?.toLowerCase().includes(toolSearch.toLowerCase()))
    : tools

  const renderOverview = () => (
    <Card className={styles.card}>
      <CardHeader header={<Text weight="semibold">Server Configuration</Text>} />
      <div className={styles.configGrid}>
        <div className={styles.configSection}>
          <div className={styles.sectionTitle}>Status</div>
          <div className={styles.configItem}>
            <span className={styles.configLabel}>Connection</span>
            <div>{getStatusBadge(server.status)}</div>
          </div>
          <div className={styles.configItem}>
            <span className={styles.configLabel}>Sync Status</span>
            <div>{getSyncBadge(server.syncStatus)}</div>
          </div>
          <div className={styles.configItem}>
            <span className={styles.configLabel}>Deployment Type</span>
            <div>{getTypeBadge(server)}</div>
          </div>
          {server.deploymentType === 'managed' && server.runtimeStatus && (
            <div className={styles.configItem}>
              <span className={styles.configLabel}>Runtime Status</span>
              <div>{getRuntimeBadge(server.runtimeStatus)}</div>
            </div>
          )}
        </div>

        <div className={styles.configSection}>
          <div className={styles.sectionTitle}>Connection</div>
          <div className={styles.configItem}>
            <span className={styles.configLabel}>Transport</span>
            <span className={styles.configValue}>{server.transport || '—'}</span>
          </div>
          {server.url && (
            <div className={styles.configItem}>
              <span className={styles.configLabel}>URL</span>
              <span className={styles.configValue}>{server.url}</span>
            </div>
          )}
          {server.command && (
            <div className={styles.configItem}>
              <span className={styles.configLabel}>Command</span>
              <span className={styles.configValue}>{server.command} {server.args?.join(' ')}</span>
            </div>
          )}
          <div className={styles.configItem}>
            <span className={styles.configLabel}>Timeout</span>
            <span className={styles.configValue}>{server.timeout ? `${server.timeout / 1000}s` : '—'}</span>
          </div>
        </div>

        <div className={styles.configSection}>
          <div className={styles.sectionTitle}>Authentication</div>
          <div className={styles.configItem}>
            <span className={styles.configLabel}>Auth Type</span>
            <span className={styles.configValue}>{server.authType || 'none'}</span>
          </div>
          {server.credentialId && (
            <div className={styles.configItem}>
              <span className={styles.configLabel}>Credential ID</span>
              <span className={styles.configValue}>{server.credentialId}</span>
            </div>
          )}
        </div>

        {(server.allowedTools?.length || server.disallowedTools?.length) ? (
          <div className={styles.configSection}>
            <div className={styles.sectionTitle}>Tool Filtering</div>
            {server.allowedTools?.length ? (
              <div className={styles.configItem}>
                <span className={styles.configLabel}>Allowed Tools</span>
                <div className={styles.chipList}>
                  {server.allowedTools.map(t => <span key={t} className={styles.chip}>{t}</span>)}
                </div>
              </div>
            ) : null}
            {server.disallowedTools?.length ? (
              <div className={styles.configItem}>
                <span className={styles.configLabel}>Blocked Tools</span>
                <div className={styles.chipList}>
                  {server.disallowedTools.map(t => <span key={t} className={styles.chip}>{t}</span>)}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {server.deploymentType === 'managed' && (
          <div className={styles.configSection}>
            <div className={styles.sectionTitle}>Managed Configuration</div>
            {server.catalogId && (
              <div className={styles.configItem}>
                <span className={styles.configLabel}>Catalog ID</span>
                <span className={styles.configValue}>{server.catalogId}</span>
              </div>
            )}
            {server.k8sResourceName && (
              <div className={styles.configItem}>
                <span className={styles.configLabel}>K8s Resource</span>
                <span className={styles.configValue}>{server.k8sResourceName}</span>
              </div>
            )}
            {server.managedConfig?.resourcePreset && (
              <div className={styles.configItem}>
                <span className={styles.configLabel}>Resource Preset</span>
                <span className={styles.configValue}>{server.managedConfig.resourcePreset}</span>
              </div>
            )}
            {server.managedConfig?.volumeSize && (
              <div className={styles.configItem}>
                <span className={styles.configLabel}>Volume Size</span>
                <span className={styles.configValue}>{server.managedConfig.volumeSize}</span>
              </div>
            )}
          </div>
        )}

        <div className={styles.configSection}>
          <div className={styles.sectionTitle}>Metadata</div>
          <div className={styles.configItem}>
            <span className={styles.configLabel}>Server ID</span>
            <span className={styles.configValue}>{server.id}</span>
          </div>
          {server.description && (
            <div className={styles.configItem}>
              <span className={styles.configLabel}>Description</span>
              <span className={styles.configValue}>{server.description}</span>
            </div>
          )}
          <div className={styles.configItem}>
            <span className={styles.configLabel}>Created</span>
            <span className={styles.configValue}>{new Date(server.createdAt).toLocaleString()}</span>
          </div>
          <div className={styles.configItem}>
            <span className={styles.configLabel}>Updated</span>
            <span className={styles.configValue}>{new Date(server.updatedAt).toLocaleString()}</span>
          </div>
        </div>
      </div>
    </Card>
  )

  const renderTools = () => {
    if (!canListTools) {
      return (
        <Card className={styles.card}>
          <div style={{ padding: '20px' }}>
            <MessageBar intent="warning" icon={<Warning24Regular />}>
              <MessageBarBody>
                Tools cannot be listed until the server is connected and synced.
                {server.status !== 'connected' && ' The server is not connected.'}
                {server.syncStatus !== 'synced' && ' The server is not synced to the LLM gateway.'}
              </MessageBarBody>
            </MessageBar>
            <div style={{ marginTop: '12px' }}>
              <Button
                appearance="primary"
                icon={<PlugConnected24Regular />}
                onClick={handleTestConnection}
                disabled={testingConnection || server.syncStatus !== 'synced'}
              >
                {testingConnection ? 'Testing...' : 'Test Connection'}
              </Button>
            </div>
          </div>
        </Card>
      )
    }

    if (toolsLoading) {
      return (
        <Card className={styles.card}>
          <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
            <Spinner label="Loading tools..." />
          </div>
        </Card>
      )
    }

    if (toolsError) {
      return (
        <Card className={styles.card}>
          <div style={{ padding: '20px' }}>
            <MessageBar intent="error">
              <MessageBarBody>{toolsError}</MessageBarBody>
            </MessageBar>
            <div style={{ marginTop: '12px' }}>
              <Button appearance="primary" onClick={loadTools}>Retry</Button>
            </div>
          </div>
        </Card>
      )
    }

    if (tools.length === 0) {
      return (
        <Card className={styles.card}>
          <div style={{ padding: '40px', textAlign: 'center', color: tokens.colorNeutralForeground3 }}>
            <Wrench24Regular style={{ fontSize: '32px', marginBottom: '8px' }} />
            <Text block>No tools exposed by this server</Text>
          </div>
        </Card>
      )
    }

    const schema = selectedTool?.inputSchema
    const properties: Record<string, SchemaProperty> = schema?.properties || {}
    const required: string[] = schema?.required || []

    return (
      <Card className={styles.card}>
        <div className={styles.toolsContainer}>
          <div className={styles.toolsList}>
            {tools.length > 5 && (
              <div className={styles.searchBox}>
                <Input
                  placeholder="Filter tools..."
                  value={toolSearch}
                  onChange={(_, data) => setToolSearch(data.value)}
                  contentBefore={<Search24Regular />}
                  size="small"
                />
              </div>
            )}
            {filteredTools.map(tool => (
              <div
                key={tool.name}
                className={`${styles.toolItem} ${selectedTool?.name === tool.name ? styles.toolItemActive : ''}`}
                onClick={() => handleSelectTool(tool)}
              >
                <span className={styles.toolName}>{tool.name}</span>
                {tool.description && (
                  <span className={styles.toolDesc}>{tool.description}</span>
                )}
              </div>
            ))}
            {filteredTools.length === 0 && (
              <Text size={200} style={{ padding: '12px', color: tokens.colorNeutralForeground3 }}>
                No tools match the filter
              </Text>
            )}
          </div>

          <div className={styles.toolDetail}>
            {!selectedTool ? (
              <div className={styles.emptyToolDetail}>
                <Wrench24Regular style={{ fontSize: '32px' }} />
                <Text>Select a tool to view details and invoke it</Text>
              </div>
            ) : (
              <>
                <div className={styles.toolDetailHeader}>
                  <span className={styles.toolDetailName}>{selectedTool.name}</span>
                  {selectedTool.description && (
                    <span className={styles.toolDetailDesc}>{selectedTool.description}</span>
                  )}
                </div>

                <div className={styles.formFields}>
                  {Object.keys(properties).length > 0 ? (
                    Object.entries(properties).map(([name, propSchema]) =>
                      renderFormField(
                        name,
                        propSchema,
                        required.includes(name),
                        toolArgs[name],
                        handleArgChange,
                      )
                    )
                  ) : (
                    <Field label="Arguments (JSON)">
                      <Textarea
                        value={typeof toolArgs._raw === 'string' ? toolArgs._raw : '{}'}
                        onChange={(_, data) => handleArgChange('_raw', data.value)}
                        rows={4}
                        placeholder="{}"
                        style={{ fontFamily: 'monospace', fontSize: '13px' }}
                      />
                    </Field>
                  )}
                </div>

                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <Button
                    appearance="primary"
                    icon={<Play24Regular />}
                    onClick={handleRunTool}
                    disabled={toolRunning}
                  >
                    {toolRunning ? 'Running...' : 'Run'}
                  </Button>
                  {toolRunning && <Spinner size="tiny" />}
                </div>

                {toolError && (
                  <div className={styles.resultContainer}>
                    <MessageBar intent="error">
                      <MessageBarBody>{toolError}</MessageBarBody>
                    </MessageBar>
                  </div>
                )}

                {toolResult !== null && (
                  <div className={styles.resultContainer}>
                    <Text weight="semibold" size={300}>Result</Text>
                    {(() => {
                      const { text, isError } = formatResult(toolResult)
                      return (
                        <>
                          {isError && (
                            <MessageBar intent="error">
                              <MessageBarBody>The tool returned an error</MessageBarBody>
                            </MessageBar>
                          )}
                          <pre className={`${styles.resultBlock} ${isError ? styles.resultError : ''}`}>
                            {text}
                          </pre>
                        </>
                      )
                    })()}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </Card>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Button
            appearance="subtle"
            icon={<ArrowLeft24Regular />}
            onClick={() => navigate(`/projects/${projectId}/mcp-servers`)}
          />
          <h1 className={styles.title}>{server.name}</h1>
          <div className={styles.headerBadges}>
            {getTypeBadge(server)}
            {getStatusBadge(server.status)}
            {getSyncBadge(server.syncStatus)}
            {getRuntimeBadge(server.runtimeStatus)}
          </div>
        </div>
        <div className={styles.headerActions}>
          <Button
            appearance="subtle"
            icon={<PlugConnected24Regular />}
            onClick={handleTestConnection}
            disabled={testingConnection || server.syncStatus !== 'synced'}
          >
            {testingConnection ? 'Testing...' : 'Test Connection'}
          </Button>
          <Button
            appearance="subtle"
            icon={<ArrowSync24Regular />}
            onClick={loadServer}
          >
            Refresh
          </Button>
        </div>
      </div>

      <TabList
        selectedValue={activeTab}
        onTabSelect={(_, data) => setActiveTab(data.value as 'overview' | 'tools')}
      >
        <Tab value="overview">Overview</Tab>
        <Tab value="tools">Tools</Tab>
      </TabList>

      {activeTab === 'overview' && renderOverview()}
      {activeTab === 'tools' && renderTools()}
    </div>
  )
}
