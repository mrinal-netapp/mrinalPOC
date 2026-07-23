import { useState, useEffect, useCallback, useRef } from 'react'
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
  Input,
  Divider,
  Tooltip,
  ProgressBar,
  Switch,
} from '@fluentui/react-components'
import {
  ArrowLeft24Regular,
  ArrowSync24Regular,
  Search24Regular,
  Clock24Regular,
  Info24Regular,
  ErrorCircle24Regular,
  CheckmarkCircle24Regular,
  Dismiss24Regular,
  Open24Regular,
  Play24Regular,
  Stop24Regular,
  ArrowClockwise24Regular,
  TextBulletList24Regular,
} from '@fluentui/react-icons'
import {
  workflowApi,
  WorkflowStatus,
  WorkflowLogEntry,
} from '../services/api'
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
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  title: {
    fontSize: '24px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  subtitle: {
    fontSize: '14px',
    color: tokens.colorNeutralForeground3,
    fontFamily: 'monospace',
  },
  card: {
    marginTop: '8px',
  },
  metadataGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: '24px',
    padding: '20px',
  },
  metadataItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  metadataLabel: {
    fontSize: '12px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  metadataValue: {
    fontSize: '14px',
    color: tokens.colorNeutralForeground1,
  },
  errorCard: {
    backgroundColor: tokens.colorPaletteRedBackground1,
    borderLeft: `4px solid ${tokens.colorPaletteRedBorder2}`,
  },
  errorContent: {
    padding: '16px',
  },
  errorTitle: {
    fontSize: '16px',
    fontWeight: 600,
    color: tokens.colorPaletteRedForeground1,
    marginBottom: '8px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  errorMessage: {
    fontSize: '14px',
    color: tokens.colorNeutralForeground1,
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    backgroundColor: tokens.colorNeutralBackground3,
    padding: '12px',
    borderRadius: '4px',
    marginTop: '8px',
  },
  logsContainer: {
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  logsToolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    flexWrap: 'wrap',
  },
  searchInput: {
    minWidth: '250px',
    flexGrow: 1,
  },
  logsTable: {
    width: '100%',
    fontFamily: 'monospace',
    fontSize: '13px',
    borderCollapse: 'collapse',
  },
  logRow: {
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    '&:hover': {
      backgroundColor: tokens.colorNeutralBackground2,
    },
  },
  logRowFailed: {
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorPaletteRedBackground1,
    '&:hover': {
      backgroundColor: tokens.colorPaletteRedBackground1,
    },
  },
  logCell: {
    padding: '6px 12px',
    verticalAlign: 'top',
    whiteSpace: 'nowrap',
  },
  logCellDetails: {
    padding: '6px 12px',
    verticalAlign: 'top',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  logTimestamp: {
    color: tokens.colorNeutralForeground3,
    fontSize: '12px',
  },
  logEventType: {
    color: tokens.colorBrandForeground1,
    fontSize: '12px',
    fontWeight: 600,
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '48px',
    gap: '12px',
    color: tokens.colorNeutralForeground3,
  },
  temporalLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    color: tokens.colorBrandForeground1,
    cursor: 'pointer',
    textDecoration: 'none',
    '&:hover': {
      textDecoration: 'underline',
    },
  },
  statusBadgeLarge: {
    fontSize: tokens.fontSizeBase300,
    padding: '4px 12px',
  },
  categoryBadge: {
    fontSize: tokens.fontSizeBase200,
    textTransform: 'capitalize',
  },
})

/** Human-readable label for a workflow category derived from the workflowId prefix. */
const categoryLabels: Record<string, string> = {
  'kb-creation': 'KB Creation',
  'kb-delete': 'KB Deletion',
  'dataset-import': 'Dataset Import',
  'dataset-delete': 'Dataset Deletion',
  'table-processing': 'Table Processing',
  'project-init': 'Project Init',
  'project-delete': 'Project Deletion',
  'pipeline': 'Pipeline Execution',
}

const statusColors: Record<string, 'success' | 'warning' | 'danger' | 'brand' | 'informative' | 'important'> = {
  running: 'brand',
  completed: 'success',
  failed: 'danger',
  cancelled: 'warning',
  terminated: 'danger',
  timed_out: 'danger',
  continued_as_new: 'informative',
  unknown: 'important',
}

const statusIcons: Record<string, React.ReactElement> = {
  running: <Play24Regular />,
  completed: <CheckmarkCircle24Regular />,
  failed: <ErrorCircle24Regular />,
  cancelled: <Dismiss24Regular />,
  terminated: <ErrorCircle24Regular />,
  timed_out: <Clock24Regular />,
}

function formatTimestamp(iso?: string): string {
  if (!iso) return '-'
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return iso
  }
}

function formatEventType(eventType: string): string {
  // Convert EVENT_TYPE_WORKFLOW_EXECUTION_STARTED -> Workflow Execution Started
  return eventType
    .replace(/^EVENT_TYPE_/, '')
    .split('_')
    .map(word => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ')
}

export default function WorkflowDetail() {
  const { workflowId } = useParams<{ projectId: string; workflowId: string }>()
  const navigate = useNavigate()
  const styles = useStyles()
  const { showToast } = useToast()

  const [status, setStatus] = useState<WorkflowStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)

  const [selectedTab, setSelectedTab] = useState<string>('overview')

  // Logs state
  const [logs, setLogs] = useState<WorkflowLogEntry[]>([])
  const [logsLoading, setLogsLoading] = useState(false)
  const [logsError, setLogsError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(false)
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Fetch workflow status
  const fetchStatus = useCallback(async () => {
    if (!workflowId) return
    try {
      setError(null)
      const data = await workflowApi.getStatus(workflowId)
      setStatus(data)
    } catch (err: any) {
      const message = err.response?.data?.error || err.message || 'Failed to load workflow status'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [workflowId])

  // Fetch workflow logs
  const fetchLogs = useCallback(async () => {
    if (!workflowId) return
    try {
      setLogsError(null)
      setLogsLoading(true)
      const data = await workflowApi.getLogs(workflowId, {
        search: searchQuery || undefined,
      })
      setLogs(data.entries)
    } catch (err: any) {
      const message = err.response?.data?.error || err.message || 'Failed to load workflow logs'
      setLogsError(message)
    } finally {
      setLogsLoading(false)
    }
  }, [workflowId, searchQuery])

  // Initial load
  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  // Load logs when switching to logs tab
  useEffect(() => {
    if (selectedTab === 'logs') {
      fetchLogs()
    }
  }, [selectedTab, fetchLogs])

  // Auto-refresh for logs
  useEffect(() => {
    if (autoRefresh && selectedTab === 'logs') {
      autoRefreshRef.current = setInterval(() => {
        fetchLogs()
        // Also refresh status if workflow is still running
        if (status?.isRunning) {
          fetchStatus()
        }
      }, 5000) // 5-second interval
    }
    return () => {
      if (autoRefreshRef.current) {
        clearInterval(autoRefreshRef.current)
        autoRefreshRef.current = null
      }
    }
  }, [autoRefresh, selectedTab, fetchLogs, fetchStatus, status?.isRunning])

  // Build Temporal UI link
  const temporalLink = workflowId
    ? `${window.location.protocol}//workflows.${window.location.hostname.replace(/^[^.]+\./, '')}/namespaces/default/workflows/${encodeURIComponent(workflowId)}`
    : null

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '64px' }}>
        <Spinner size="large" label="Loading workflow details..." />
      </div>
    )
  }

  if (error && !status) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <Button
              appearance="subtle"
              icon={<ArrowLeft24Regular />}
              onClick={() => navigate(-1)}
            />
            <Text className={styles.title}>Workflow Details</Text>
          </div>
        </div>
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
        <Button appearance="primary" onClick={fetchStatus}>Retry</Button>
      </div>
    )
  }

  if (!status) return null

  const categoryLabel = categoryLabels[status.workflowCategory] || status.workflowCategory
  const statusColor = statusColors[status.status] || 'important'

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Tooltip content="Go back" relationship="label">
            <Button
              appearance="subtle"
              icon={<ArrowLeft24Regular />}
              onClick={() => navigate(-1)}
            />
          </Tooltip>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <Text className={styles.title}>Workflow Details</Text>
              <Badge
                color={statusColor}
                className={styles.statusBadgeLarge}
                icon={statusIcons[status.status]}
              >
                {status.status}
              </Badge>
              <Badge
                appearance="outline"
                className={styles.categoryBadge}
              >
                {categoryLabel}
              </Badge>
            </div>
            <Text className={styles.subtitle}>{status.workflowId}</Text>
          </div>
        </div>
        <div className={styles.headerRight}>
          {status?.isRunning && (
            <Tooltip content="Cancel workflow" relationship="label">
              <Button
                appearance="subtle"
                icon={<Stop24Regular />}
                disabled={cancelling}
                onClick={async () => {
                  if (!workflowId) return
                  setCancelling(true)
                  try {
                    await workflowApi.cancel(workflowId, status?.runId)
                    showToast('Cancel requested. Workflow will stop at the next opportunity.', 'success')
                    await fetchStatus()
                    if (selectedTab === 'logs') fetchLogs()
                  } catch (err: any) {
                    const message = err.response?.data?.error || err.message || 'Failed to cancel workflow'
                    showToast(message, 'error')
                  } finally {
                    setCancelling(false)
                  }
                }}
              >
                Cancel
              </Button>
            </Tooltip>
          )}
          {temporalLink && (
            <Tooltip content="Open in Temporal UI" relationship="label">
              <Button
                appearance="subtle"
                icon={<Open24Regular />}
                as="a"
                href={temporalLink}
                target="_blank"
                rel="noopener noreferrer"
              >
                Temporal
              </Button>
            </Tooltip>
          )}
          <Tooltip content="Refresh" relationship="label">
            <Button
              appearance="subtle"
              icon={<ArrowSync24Regular />}
              onClick={() => {
                fetchStatus()
                if (selectedTab === 'logs') fetchLogs()
              }}
            />
          </Tooltip>
        </div>
      </div>

      {/* Running indicator */}
      {status.isRunning && (
        <ProgressBar />
      )}

      {/* Error banner for failed workflows */}
      {(status.status === 'failed' || status.status === 'terminated' || status.status === 'timed_out') && status.failureMessage && (
        <Card className={styles.errorCard}>
          <div className={styles.errorContent}>
            <div className={styles.errorTitle}>
              <ErrorCircle24Regular />
              Workflow {status.status === 'failed' ? 'Failed' : status.status === 'timed_out' ? 'Timed Out' : 'Terminated'}
            </div>
            <Text>The workflow encountered an error during execution.</Text>
            <div className={styles.errorMessage}>
              {status.failureMessage}
            </div>
          </div>
        </Card>
      )}

      {/* Tabs */}
      <TabList
        selectedValue={selectedTab}
        onTabSelect={(_, data) => setSelectedTab(data.value as string)}
      >
        <Tab value="overview" icon={<Info24Regular />}>Overview</Tab>
        <Tab value="logs" icon={<TextBulletList24Regular />}>Logs</Tab>
      </TabList>

      {/* Overview tab */}
      {selectedTab === 'overview' && (
        <Card className={styles.card}>
          <CardHeader
            header={<Text weight="semibold">Workflow Metadata</Text>}
          />
          <Divider />
          <div className={styles.metadataGrid}>
            <div className={styles.metadataItem}>
              <Text className={styles.metadataLabel}>Workflow ID</Text>
              <Text className={styles.metadataValue} style={{ fontFamily: 'monospace', fontSize: '13px' }}>
                {status.workflowId}
              </Text>
            </div>
            <div className={styles.metadataItem}>
              <Text className={styles.metadataLabel}>Run ID</Text>
              <Text className={styles.metadataValue} style={{ fontFamily: 'monospace', fontSize: '13px' }}>
                {status.runId}
              </Text>
            </div>
            <div className={styles.metadataItem}>
              <Text className={styles.metadataLabel}>Workflow Type</Text>
              <Text className={styles.metadataValue}>{status.workflowType}</Text>
            </div>
            <div className={styles.metadataItem}>
              <Text className={styles.metadataLabel}>Category</Text>
              <Text className={styles.metadataValue}>{categoryLabel}</Text>
            </div>
            <div className={styles.metadataItem}>
              <Text className={styles.metadataLabel}>Status</Text>
              <Badge color={statusColor} icon={statusIcons[status.status]}>
                {status.status}
              </Badge>
            </div>
            <div className={styles.metadataItem}>
              <Text className={styles.metadataLabel}>Task Queue</Text>
              <Text className={styles.metadataValue}>{status.taskQueue || '-'}</Text>
            </div>
            <div className={styles.metadataItem}>
              <Text className={styles.metadataLabel}>Start Time</Text>
              <Text className={styles.metadataValue}>{formatTimestamp(status.startTime)}</Text>
            </div>
            <div className={styles.metadataItem}>
              <Text className={styles.metadataLabel}>End Time</Text>
              <Text className={styles.metadataValue}>{formatTimestamp(status.endTime)}</Text>
            </div>
            <div className={styles.metadataItem}>
              <Text className={styles.metadataLabel}>Duration</Text>
              <Text className={styles.metadataValue}>{status.executionDuration || (status.isRunning ? 'In progress...' : '-')}</Text>
            </div>
            <div className={styles.metadataItem}>
              <Text className={styles.metadataLabel}>History Events</Text>
              <Text className={styles.metadataValue}>{status.historyLength}</Text>
            </div>
            {temporalLink && (
              <div className={styles.metadataItem}>
                <Text className={styles.metadataLabel}>Temporal Link</Text>
                <a
                  href={temporalLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.temporalLink}
                >
                  <Open24Regular style={{ width: 16, height: 16 }} />
                  View in Temporal UI
                </a>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Logs tab */}
      {selectedTab === 'logs' && (
        <Card className={styles.card}>
          <div className={styles.logsContainer}>
            {/* Toolbar */}
            <div className={styles.logsToolbar}>
              <Input
                className={styles.searchInput}
                placeholder="Search logs by event type or details..."
                contentBefore={<Search24Regular />}
                value={searchQuery}
                onChange={(_, data) => setSearchQuery(data.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') fetchLogs()
                }}
              />
              <Button
                appearance="subtle"
                icon={<Search24Regular />}
                onClick={fetchLogs}
              >
                Search
              </Button>
              <Tooltip content="Refresh logs" relationship="label">
                <Button
                  appearance="subtle"
                  icon={<ArrowClockwise24Regular />}
                  onClick={fetchLogs}
                />
              </Tooltip>
              <Switch
                label="Auto-refresh (5s)"
                checked={autoRefresh}
                onChange={(_, data) => setAutoRefresh(data.checked)}
              />
            </div>

            <Divider />

            {/* Logs content */}
            {logsLoading && logs.length === 0 ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '32px' }}>
                <Spinner size="medium" label="Loading logs..." />
              </div>
            ) : logsError ? (
              <MessageBar intent="error">
                <MessageBarBody>{logsError}</MessageBarBody>
              </MessageBar>
            ) : logs.length === 0 ? (
              <div className={styles.emptyState}>
                <TextBulletList24Regular style={{ width: 48, height: 48 }} />
                <Text size={400}>No log entries found</Text>
                <Text size={200}>
                  {searchQuery
                    ? 'Try a different search term.'
                    : 'This workflow has no history events yet.'}
                </Text>
              </div>
            ) : (
              <>
                <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                  Showing {logs.length} event{logs.length !== 1 ? 's' : ''}
                  {logsLoading && <Spinner size="tiny" style={{ marginLeft: '8px' }} />}
                </Text>
                <div style={{ overflowX: 'auto' }}>
                  <table className={styles.logsTable}>
                    <thead>
                      <tr>
                        <th className={styles.logCell} style={{ textAlign: 'left', fontWeight: 600 }}>#</th>
                        <th className={styles.logCell} style={{ textAlign: 'left', fontWeight: 600 }}>Timestamp</th>
                        <th className={styles.logCell} style={{ textAlign: 'left', fontWeight: 600 }}>Event</th>
                        <th className={styles.logCellDetails} style={{ textAlign: 'left', fontWeight: 600 }}>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.map((entry) => {
                        const isFailed = entry.eventType.includes('FAILED') || entry.eventType.includes('TIMED_OUT')
                        return (
                          <tr
                            key={entry.eventId}
                            className={isFailed ? styles.logRowFailed : styles.logRow}
                          >
                            <td className={styles.logCell}>
                              <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                                {entry.eventId}
                              </Text>
                            </td>
                            <td className={styles.logCell}>
                              <span className={styles.logTimestamp}>
                                {formatTimestamp(entry.timestamp)}
                              </span>
                            </td>
                            <td className={styles.logCell}>
                              <span className={styles.logEventType}>
                                {formatEventType(entry.eventType)}
                              </span>
                            </td>
                            <td className={styles.logCellDetails}>
                              {entry.details || '-'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </Card>
      )}
    </div>
  )
}
