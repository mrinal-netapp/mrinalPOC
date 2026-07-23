import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
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
  Table,
  TableBody,
  TableCell,
  TableRow,
  TableHeader,
  TableHeaderCell,
  Tooltip,
  Dialog,
  DialogTrigger,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogActions,
  DialogContent,
  ProgressBar,
} from '@fluentui/react-components'
import {
  ArrowLeft24Regular,
  ArrowSync24Regular,
  ArrowClockwise24Regular,
  ShieldCheckmark24Regular,
  Document24Regular,
  Table24Regular,
  Info24Regular,
  Warning24Regular,
  ChevronLeft20Regular,
  ChevronRight20Regular,
  ArrowUp16Regular,
  ArrowDown16Regular,
} from '@fluentui/react-icons'
import {
  datasetApi,
  datasourceApi,
  DataSet,
  Facet,
  workflowApi,
  type FilterCriteria,
  type OrderBy,
  type PreviewResponse,
  type ColumnStat,
  type FileStatsFacet,
  type WorkflowEngineProgress,
} from '../services/api'
import { WorkUnitsTable } from '../components/WorkUnitsTable'
import { DataGrid } from '../components/dataset-explorer/DataGrid'
import { FilterBuilder } from '../components/dataset-explorer/FilterBuilder'
import { ColumnStatsHeader } from '../components/dataset-explorer/ColumnStatsHeader'
import { FileDistributionCharts } from '../components/dataset-explorer/FileDistributionCharts'
import { ColumnStatsSummary } from '../components/dataset-explorer/ColumnStatsSummary'
import { ColumnFilterPopover } from '../components/dataset-explorer/ColumnFilterPopover'
import { SQLMonacoEditor } from '../components/dataset-explorer/SQLMonacoEditor'
import type { SortingState } from '@tanstack/react-table'

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
  title: {
    fontSize: '24px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  subtitle: {
    fontSize: '14px',
    color: tokens.colorNeutralForeground3,
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
  },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: '16px',
    padding: '20px',
  },
  statCard: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '20px',
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: '8px',
    textAlign: 'center',
  },
  statValue: {
    fontSize: '28px',
    fontWeight: 700,
    color: tokens.colorBrandForeground1,
  },
  statLabel: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    marginTop: '4px',
    textTransform: 'uppercase',
  },
  piiTable: {
    width: '100%',
    tableLayout: 'fixed',
  },
  piiHeaderCell: {
    whiteSpace: 'nowrap',
  },
  piiCell: {
    verticalAlign: 'top',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
  },
  piiFileNameText: {
    fontFamily: 'monospace',
    fontSize: '12px',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
  },
  piiRiskCountText: {
    fontSize: '12px',
    fontFamily: 'monospace',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
  },
  piiEntitiesList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px',
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '60px 20px',
    gap: '12px',
    textAlign: 'center',
  },
  schemaTable: {
    width: '100%',
    marginTop: '12px',
  },
  previewToolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px 20px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  previewTableWrapper: {
    overflowX: 'auto',
    maxHeight: '500px',
    overflowY: 'auto',
  },
  previewTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '13px',
  },
  previewTh: {
    position: 'sticky' as const,
    top: 0,
    backgroundColor: tokens.colorNeutralBackground3,
    padding: '8px 10px',
    textAlign: 'left',
    fontWeight: 600,
    borderBottom: `2px solid ${tokens.colorNeutralStroke1}`,
    whiteSpace: 'nowrap',
  },
  previewTd: {
    padding: '6px 10px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    whiteSpace: 'nowrap',
    maxWidth: '300px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  previewFooter: {
    padding: '8px 12px',
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    backgroundColor: tokens.colorNeutralBackground2,
    borderTop: `1px solid ${tokens.colorNeutralStroke3}`,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
})

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`
}

function formatDurationSec(sec?: number): string {
  if (!sec || sec <= 0) return '-'
  if (sec < 60) return `${sec.toFixed(1)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec - m * 60)
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  const mr = m - h * 60
  return `${h}h ${mr}m`
}

export default function DatasetDetail() {
  const styles = useStyles()
  const { projectId, datasetId } = useParams<{ projectId: string; datasetId: string }>()
  const navigate = useNavigate()

  const [dataset, setDataset] = useState<DataSet | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'overview' | 'details' | 'pii' | 'preview'>('overview')

  // SQL mode state for Data Preview
  const [previewMode, setPreviewMode] = useState<'visual' | 'sql'>('visual')
  const [sqlQuery, setSqlQuery] = useState('')
  const [sqlResult, setSqlResult] = useState<PreviewResponse | null>(null)
  const [sqlLoading, setSqlLoading] = useState(false)
  const [sqlError, setSqlError] = useState<string | null>(null)

  // Preview state
  const [previewData, setPreviewData] = useState<PreviewResponse | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewLimit, setPreviewLimit] = useState(50)
  const [previewLoadAttempted, setPreviewLoadAttempted] = useState(false)
  const [previewPage, setPreviewPage] = useState(0)
  const [previewFilters, setPreviewFilters] = useState<FilterCriteria[]>([])
  const [previewOrderBy, setPreviewOrderBy] = useState<OrderBy | null>(null)
  const [columnStats, setColumnStats] = useState<Record<string, ColumnStat> | null>(null)
  const previewLoadInFlightRef = useRef(false)
  const previewFiltersRef = useRef(previewFilters)
  previewFiltersRef.current = previewFilters
  const previewPageRef = useRef(previewPage)
  previewPageRef.current = previewPage
  const previewLimitRef = useRef(previewLimit)
  previewLimitRef.current = previewLimit
  const previewOrderByRef = useRef(previewOrderBy)
  previewOrderByRef.current = previewOrderBy

  // PII tab state (paginated from Iceberg via analytics-engine preview)
  const [piiData, setPiiData] = useState<PreviewResponse | null>(null)
  const [piiLoading, setPiiLoading] = useState(false)
  const [piiError, setPiiError] = useState<string | null>(null)
  const [piiLoadAttempted, setPiiLoadAttempted] = useState(false)
  const [piiPage, setPiiPage] = useState(0)
  const [piiLimit] = useState(50)
  const [piiOrderBy, setPiiOrderBy] = useState<OrderBy>({ column: 'pii_count', direction: 'desc' })
  const [piiFilters, setPiiFilters] = useState<FilterCriteria[]>([])
  const piiLoadInFlightRef = useRef(false)

  // Reprocess state
  const [reprocessing, setReprocessing] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  // Retry import state
  const [retrying, setRetrying] = useState(false)

  /** Live acquisition metrics from workflow-engine while the acquisition facet is running. */
  const [acquisitionEngineProgress, setAcquisitionEngineProgress] = useState<WorkflowEngineProgress | null>(null)

  // Resolved volume data source name (avoids displaying raw UUID)
  const [volumeName, setVolumeName] = useState<string | null>(null)
  useEffect(() => {
    if (!dataset?.originVolume || !projectId) {
      setVolumeName(null)
      return
    }
    let cancelled = false
    datasourceApi.get(projectId, dataset.originVolume).then((ds) => {
      if (!cancelled) setVolumeName(ds.name)
    }).catch(() => {
      if (!cancelled) setVolumeName(null)
    })
    return () => { cancelled = true }
  }, [dataset?.originVolume, projectId])

  const loadDataset = useCallback(async () => {
    if (!projectId || !datasetId) return

    try {
      setLoading(true)
      setError(null)
      const data = await datasetApi.get(projectId, datasetId)
      setDataset(data)
    } catch (err: any) {
      setError(err.message || 'Failed to load dataset')
    } finally {
      setLoading(false)
    }
  }, [projectId, datasetId])

  const loadPiiPage = useCallback(async (opts?: {
    page?: number; limit?: number; filters?: FilterCriteria[]; orderBy?: OrderBy | null
  }) => {
    if (!projectId || !datasetId || !dataset?.namespace || !dataset?.catalogTableName) return
    if (!dataset.enablePiiAnalysis) return
    if (piiLoadInFlightRef.current) return
    piiLoadInFlightRef.current = true
    setPiiLoadAttempted(true)
    const page = opts?.page ?? piiPage
    const limit = opts?.limit ?? piiLimit
    const filters = opts?.filters ?? piiFilters
    const orderBy = opts?.orderBy !== undefined ? opts.orderBy : piiOrderBy

    try {
      setPiiLoading(true)
      setPiiError(null)
      const data = await datasetApi.preview(
        projectId,
        datasetId,
        dataset.namespace,
        dataset.catalogTableName,
        { limit, offset: page * limit, filters, orderBy: orderBy ?? undefined },
      )
      setPiiData(data)
      if (!data || (data.totalCount === 0 && !data.rows?.length)) {
        setPiiError('No PII data found. The analysis may not have completed yet.')
      }
    } catch (err: any) {
      const msg = err.response?.data?.detail || err.response?.data?.error || err.message || 'Failed to load PII data'
      if (msg.includes('Analytics engine is not available') || err.response?.status === 502) {
        setPiiError('PII data preview requires the Analytics Engine to be running. Please contact your administrator.')
      } else {
        setPiiError(msg)
      }
    } finally {
      setPiiLoading(false)
      piiLoadInFlightRef.current = false
    }
  }, [projectId, datasetId, dataset?.namespace, dataset?.catalogTableName, dataset?.enablePiiAnalysis, piiPage, piiLimit, piiFilters, piiOrderBy])

  useEffect(() => {
    loadDataset()
  }, [loadDataset])

  // Poll when dataset import or acquisition is in progress so progress bar updates
  const acqInProgress = dataset?.facets?.some(f => f.facetType === 'acquisition' && f.state === 'in_progress')
  useEffect(() => {
    if (dataset?.status !== 'in_progress' && !acqInProgress) return
    const interval = setInterval(loadDataset, 5000)
    return () => clearInterval(interval)
  }, [dataset?.status, acqInProgress, loadDataset])

  useEffect(() => {
    const facet = dataset?.facets?.find((f: Facet) => f.facetType === 'acquisition')
    if (!facet?.jobId || facet.state !== 'in_progress') {
      setAcquisitionEngineProgress(null)
      return
    }
    let cancelled = false
    const tick = async () => {
      try {
        const p = await workflowApi.getProgress(facet.jobId as string)
        if (!cancelled) setAcquisitionEngineProgress(p)
      } catch {
        if (!cancelled) setAcquisitionEngineProgress(null)
      }
    }
    void tick()
    const id = setInterval(tick, 2000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [dataset?.facets])

  useEffect(() => {
    if (activeTab === 'pii' && dataset?.namespace && dataset?.catalogTableName && !piiLoadAttempted && !piiLoading) {
      loadPiiPage()
    }
  }, [activeTab, dataset?.namespace, dataset?.catalogTableName, piiLoadAttempted, piiLoading, loadPiiPage])

  const loadPreviewData = useCallback(async (opts?: {
    page?: number; limit?: number; filters?: FilterCriteria[]; orderBy?: OrderBy | null
  }) => {
    if (!projectId || !datasetId || !dataset?.namespace || !dataset?.catalogTableName) return
    if (previewLoadInFlightRef.current) return
    previewLoadInFlightRef.current = true
    setPreviewLoadAttempted(true)
    const page = opts?.page ?? previewPageRef.current
    const limit = opts?.limit ?? previewLimitRef.current
    const filters = opts?.filters ?? previewFiltersRef.current
    const orderBy = opts?.orderBy !== undefined ? opts.orderBy : previewOrderByRef.current

    try {
      setPreviewLoading(true)
      setPreviewError(null)
      const data = await datasetApi.preview(
        projectId,
        datasetId,
        dataset.namespace,
        dataset.catalogTableName,
        { limit, offset: page * limit, filters, orderBy: orderBy ?? undefined },
      )
      setPreviewData(data)
    } catch (err: any) {
      const msg = err.response?.data?.detail || err.response?.data?.error || err.message || 'Failed to load preview'
      if (msg.includes('Analytics engine is not available') || err.response?.status === 502) {
        setPreviewError('Data preview requires the Analytics Engine to be running. Please contact your administrator.')
      } else {
        setPreviewError(msg)
      }
    } finally {
      setPreviewLoading(false)
      previewLoadInFlightRef.current = false
    }
  }, [projectId, datasetId, dataset?.namespace, dataset?.catalogTableName])

  // Extract pre-computed column stats from the column_stats facet
  const facetColumnStats = useMemo((): Record<string, ColumnStat> | null => {
    const facet = dataset?.facets?.find((f: Facet) => f.facetType === 'column_stats')
    if (!facet || facet.state !== 'ready' || !facet.summary?.columns) return null
    return facet.summary.columns as Record<string, ColumnStat>
  }, [dataset?.facets])

  // Trigger initial load when opening preview tab (stable deps to avoid retrigger from dataset ref churn)
  const datasetNamespace = dataset?.namespace
  const datasetTableName = dataset?.catalogTableName
  useEffect(() => {
    if (activeTab === 'preview' && datasetNamespace && datasetTableName && !previewLoadAttempted && !previewLoading) {
      loadPreviewData()
    }
  }, [activeTab, datasetNamespace, datasetTableName, previewLoadAttempted, previewLoading, loadPreviewData])

  // Load column stats from the facet when preview data arrives
  useEffect(() => {
    if (activeTab === 'preview' && previewData && facetColumnStats) {
      setColumnStats(facetColumnStats)
    }
  }, [activeTab, previewData, facetColumnStats])

  const handlePageChange = useCallback((pageIndex: number, pageSize: number) => {
    if (pageIndex === previewPageRef.current && pageSize === previewLimitRef.current) return
    setPreviewPage(pageIndex)
    setPreviewLimit(pageSize)
    loadPreviewData({ page: pageIndex, limit: pageSize })
  }, [loadPreviewData])

  const handleSortChange = useCallback((sorting: SortingState) => {
    if (sorting.length > 0) {
      const s = sorting[0]
      setPreviewOrderBy({ column: s.id, direction: s.desc ? 'desc' : 'asc' })
      setPreviewPage(0)
      loadPreviewData({ page: 0, orderBy: { column: s.id, direction: s.desc ? 'desc' : 'asc' } })
    } else {
      setPreviewOrderBy(null)
      setPreviewPage(0)
      loadPreviewData({ page: 0, orderBy: null })
    }
  }, [loadPreviewData])

  const handleApplyFilters = useCallback((filters: FilterCriteria[]) => {
    setPreviewFilters(filters)
    setPreviewPage(0)
    setColumnStats(null)
    loadPreviewData({ page: 0, filters })
  }, [loadPreviewData])

  const handleClearFilters = useCallback(() => {
    setPreviewFilters([])
    setPreviewPage(0)
    setColumnStats(null)
    loadPreviewData({ page: 0, filters: [] })
  }, [loadPreviewData])

  const handleColumnFilter = useCallback((filter: FilterCriteria) => {
    const next = [...previewFiltersRef.current.filter((f) => f.column !== filter.column), filter]
    setPreviewFilters(next)
    setPreviewPage(0)
    setColumnStats(null)
    loadPreviewData({ page: 0, filters: next })
  }, [loadPreviewData])

  const handleClearColumnFilter = useCallback((columnName: string) => {
    const next = previewFiltersRef.current.filter((f) => f.column !== columnName)
    setPreviewFilters(next)
    setPreviewPage(0)
    setColumnStats(null)
    loadPreviewData({ page: 0, filters: next })
  }, [loadPreviewData])

  const gridData = useMemo(() => {
    if (!previewData) return []
    const rows = previewData.rows ?? []
    const columns = previewData.columns ?? []
    return rows.map((row) =>
      Object.fromEntries(columns.map((c, i) => [c, row[i]])),
    )
  }, [previewData])

  const gridColumns = useMemo(() => {
    if (!previewData) return []
    const columns = previewData.columns ?? []
    return columns.map((c) => ({ id: c, header: c, accessorKey: c }))
  }, [previewData?.columns])

  const effectiveRowCount = useMemo(() => {
    if (!previewData || previewData.totalCount == null) return undefined
    return Math.min(previewData.totalCount, 5000)
  }, [previewData])

  // PII tab: extract per-file rows from the Iceberg preview response
  const piiColIdx = useCallback((name: string): number => {
    return piiData?.columns?.indexOf(name) ?? -1
  }, [piiData?.columns])

  const piiCellVal = useCallback((row: unknown[], col: string): any => {
    const idx = piiColIdx(col)
    return idx >= 0 ? row[idx] : undefined
  }, [piiColIdx])

  const parsePiiEntities = useCallback((raw: unknown): string[] => {
    if (!raw) return []
    if (Array.isArray(raw)) return raw as string[]
    if (typeof raw === 'string') {
      try { return JSON.parse(raw) as string[] } catch { return [] }
    }
    return []
  }, [])

  const handlePiiApplyFilters = useCallback((filters: FilterCriteria[]) => {
    setPiiFilters(filters)
    setPiiPage(0)
    loadPiiPage({ page: 0, filters })
  }, [loadPiiPage])

  const handlePiiClearFilters = useCallback(() => {
    setPiiFilters([])
    setPiiPage(0)
    loadPiiPage({ page: 0, filters: [] })
  }, [loadPiiPage])

  const handleReprocessPii = async () => {
    if (!projectId || !datasetId) return
    setConfirmOpen(false)

    try {
      setReprocessing(true)
      await datasetApi.actions.reprocessPii(projectId, datasetId)
      setPiiData(null)
      setPiiError(null)
      setPiiLoadAttempted(false)
      setPiiPage(0)
      setPiiFilters([])
      // Reload dataset to reflect new status
      await loadDataset()
    } catch (err: any) {
      setError(err.message || 'Failed to trigger PII reprocessing')
    } finally {
      setReprocessing(false)
    }
  }

  const handleRetryImport = async () => {
    if (!projectId || !datasetId) return

    try {
      setRetrying(true)
      setError(null)
      await datasetApi.import(projectId, datasetId)
      // Reload dataset to reflect new status (will be 'in_progress')
      await loadDataset()
    } catch (err: any) {
      setError(err.message || 'Failed to trigger dataset import')
    } finally {
      setRetrying(false)
    }
  }

  const handleRefresh = () => {
    loadDataset()
    if (activeTab === 'pii') {
      setPiiData(null)
      setPiiError(null)
      setPiiLoadAttempted(false)
      setPiiPage(0)
      setPiiFilters([])
    }
  }

  const handleExecuteSql = useCallback(async () => {
    if (!sqlQuery.trim()) return
    setSqlLoading(true)
    setSqlError(null)
    try {
      const result = await datasetApi.query(sqlQuery)
      setSqlResult(result)
    } catch (err: any) {
      setSqlError(err?.response?.data?.detail || err.message || 'Query failed')
      setSqlResult(null)
    } finally {
      setSqlLoading(false)
    }
  }, [sqlQuery])

  const sqlGridColumns = useMemo(() => {
    if (!sqlResult?.columns) return []
    return sqlResult.columns.map((col: string) => ({
      id: col,
      header: col,
      accessorKey: col,
    }))
  }, [sqlResult])

  const sqlGridData = useMemo(() => {
    if (!sqlResult?.rows || !sqlResult?.columns) return []
    return (sqlResult.rows as unknown[][]).map((row) => {
      const obj: Record<string, unknown> = {}
      sqlResult.columns.forEach((col: string, i: number) => {
        obj[col] = row[i]
      })
      return obj
    })
  }, [sqlResult])

  const acquisitionFacetForMerge = dataset?.facets?.find((f) => f.facetType === 'acquisition')
  const acquisitionSummaryForMerge = acquisitionFacetForMerge?.summary as {
    filesCopied?: number
    filesDiscovered?: number
    filesFiltered?: number
    totalBytes?: number
    errorCount?: number
    consumerCount?: number
    durationSec?: number
    throughputMBps?: number
    sourceEndpoint?: string
    sourceBucket?: string
    sourcePrefix?: string
    completedAt?: string
    startedAt?: string
    sourceType?: string
    mountPath?: string
  } | undefined

  const mergedAcquisition = useMemo(() => {
    const s = acquisitionSummaryForMerge
    const live = acquisitionEngineProgress
    if (acquisitionFacetForMerge?.state !== 'in_progress' || !live) {
      return s
    }
    const ex = live.extra ?? {}
    const num = (k: string): number | undefined => {
      const v = ex[k]
      if (v == null) return undefined
      if (typeof v === 'number' && !Number.isNaN(v)) return v
      if (typeof v === 'string') {
        const p = parseFloat(v)
        return Number.isNaN(p) ? undefined : p
      }
      return undefined
    }
    const fileCount = num('fileCount')
    const bytesCopied = num('bytesCopied')
    const errC = num('errorCount')
    const discovered = num('filesDiscovered')
    const filtered = num('filesFiltered')
    let durationSec = s?.durationSec
    let throughputMBps = s?.throughputMBps
    const started = s?.startedAt
    if (started && bytesCopied != null && bytesCopied > 0) {
      const elapsed = (Date.now() - new Date(started).getTime()) / 1000
      if (elapsed > 0.5) {
        durationSec = durationSec ?? elapsed
        if (throughputMBps == null) {
          throughputMBps = (bytesCopied / (1024 * 1024)) / elapsed
        }
      }
    }
    return {
      ...s,
      filesCopied: fileCount ?? s?.filesCopied,
      totalBytes: bytesCopied ?? s?.totalBytes,
      filesDiscovered: discovered ?? s?.filesDiscovered,
      filesFiltered: filtered ?? s?.filesFiltered,
      consumerCount: live.totalUnits ?? s?.consumerCount,
      errorCount: errC ?? s?.errorCount,
      throughputMBps: throughputMBps ?? s?.throughputMBps,
      durationSec: durationSec ?? s?.durationSec,
    }
  }, [acquisitionFacetForMerge?.state, acquisitionSummaryForMerge, acquisitionEngineProgress])

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '400px' }}>
        <Spinner label="Loading dataset..." />
      </div>
    )
  }

  if (error || !dataset) {
    return (
      <div className={styles.container}>
        <MessageBar intent="error">
          <MessageBarBody>{error || 'Dataset not found'}</MessageBarBody>
        </MessageBar>
        <Button
          icon={<ArrowLeft24Regular />}
          onClick={() => navigate(`/projects/${projectId}/datasets`)}
        >
          Back to Datasets
        </Button>
      </div>
    )
  }

  const isPreviewable = dataset.status === 'ready' && !!dataset.catalogTableName

  const statusBadge = () => {
    switch (dataset.status) {
      case 'ready':
        return <Badge appearance="filled" color="success">Ready</Badge>
      case 'in_progress':
        return <Badge appearance="filled" color="warning">In Progress</Badge>
      case 'errored':
        return <Badge appearance="filled" color="danger">Errored</Badge>
      case 'deprecated':
        return <Badge appearance="filled" color="brand">Deprecated</Badge>
      default:
        return <Badge appearance="filled" color="informative">{dataset.status || 'Unknown'}</Badge>
    }
  }

  // Shared facet data and helpers used by both Overview and Details tabs
  const catalogSchema = dataset.catalogTable?.metadata?.schemas
  const currentSchema = catalogSchema?.length > 0
    ? catalogSchema[catalogSchema.length - 1]
    : null

  const piiFacet = dataset.facets?.find(f => f.facetType === 'pii')
  const piiSummary = piiFacet?.summary as { filesWithPii?: number; totalFiles?: number } | undefined
  const statsFacet = dataset.facets?.find(f => f.facetType === 'stats')
  const statsSummary = statsFacet?.summary as { sourceFileCount?: number; rowCount?: number; columnCount?: number } | undefined
  const acquisitionFacet = dataset.facets?.find(f => f.facetType === 'acquisition')
  const acquisitionSummary = acquisitionFacet?.summary as {
    filesCopied?: number;
    filesDiscovered?: number;
    filesFiltered?: number;
    totalBytes?: number;
    errorCount?: number;
    consumerCount?: number;
    durationSec?: number;
    throughputMBps?: number;
    sourceEndpoint?: string;
    sourceBucket?: string;
    sourcePrefix?: string;
    completedAt?: string;
    startedAt?: string;
    sourceType?: string;
    mountPath?: string;
  } | undefined

  const renderOverviewTab = () => {
    const totalFiles = statsSummary?.sourceFileCount ?? acquisitionSummary?.filesCopied ?? piiSummary?.totalFiles ?? dataset.files?.length ?? '-'
    const fieldCount = statsSummary?.columnCount ?? currentSchema?.fields?.length ?? '-'
    const rowCount = statsSummary?.rowCount ?? '-'

    return (
      <>
        {/* Stats Cards */}
        <div className={styles.statsGrid}>
          <div className={styles.statCard}>
            <Text className={styles.statValue}>
              {totalFiles}
            </Text>
            <Text className={styles.statLabel}>Total Files</Text>
          </div>
          <div className={styles.statCard}>
            <Text className={styles.statValue}>
              {fieldCount}
            </Text>
            <Text className={styles.statLabel}>Fields</Text>
          </div>
          <div className={styles.statCard}>
            <Text className={styles.statValue}>
              {rowCount}
            </Text>
            <Text className={styles.statLabel}>Rows</Text>
          </div>
          {dataset.enablePiiAnalysis ? (
            <div className={styles.statCard}>
              <Text className={styles.statValue}>
                {piiSummary?.filesWithPii ?? '-'}
              </Text>
              <Text className={styles.statLabel}>Files with PII</Text>
            </div>
          ) : (
            <div className={styles.statCard}>
              <Text className={styles.statValue}>
                {dataset.kind === 'unstructured' ? 'Unstructured' : 'Structured'}
              </Text>
              <Text className={styles.statLabel}>Kind</Text>
            </div>
          )}
        </div>

        {/* Acquisition one-liner (compact summary with link to Details tab) */}
        {acquisitionFacet && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px',
            backgroundColor: tokens.colorNeutralBackground2, borderRadius: '8px',
          }}>
            {renderFacetBadge(acquisitionFacet)}
            {acquisitionFacet.state === 'in_progress' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Spinner size="extra-small" />
                <Text style={{ fontSize: '13px' }}>
                  {acquisitionFacet.progress?.message || 'Acquisition in progress...'}
                </Text>
              </div>
            ) : (
              <Text style={{ fontSize: '13px' }}>
                {acquisitionSummary?.mountPath || acquisitionSummary?.sourceBucket || 'Source'}
                {' | '}{(acquisitionSummary?.filesCopied ?? 0).toLocaleString()} files
                {' | '}{formatBytes(acquisitionSummary?.totalBytes)}
                {acquisitionSummary?.durationSec ? ` | ${formatDurationSec(acquisitionSummary.durationSec)}` : ''}
              </Text>
            )}
            <Button
              size="small"
              appearance="subtle"
              style={{ marginLeft: 'auto' }}
              onClick={() => setActiveTab('details')}
            >
              View details
            </Button>
          </div>
        )}

        {/* Distribution charts (kind-dependent) */}
        {dataset.kind === 'unstructured' && (
          <FileDistributionCharts
            stats={(dataset.facets?.find(f => f.facetType === 'file_stats')?.summary as FileStatsFacet) ?? null}
          />
        )}
        {dataset.kind === 'structured' && (
          <ColumnStatsSummary
            columnStats={(dataset.facets?.find(f => f.facetType === 'column_stats')?.summary as { columns: Record<string, ColumnStat> } | undefined)?.columns ?? null}
          />
        )}

        {/* Iceberg Schema */}
        {currentSchema && currentSchema.fields && currentSchema.fields.length > 0 && (
          <Card className={styles.card}>
            <CardHeader header={<Text weight="semibold">Iceberg Table Schema</Text>} />
            <div style={{ padding: '0 20px 20px' }}>
              <Table className={styles.schemaTable} size="small">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Field Name</TableHeaderCell>
                    <TableHeaderCell>Type</TableHeaderCell>
                    <TableHeaderCell>Required</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {currentSchema.fields.map((field: any, idx: number) => (
                    <TableRow key={idx}>
                      <TableCell>
                        <Text style={{ fontFamily: 'monospace', fontSize: '13px' }}>
                          {field.name}
                        </Text>
                      </TableCell>
                      <TableCell>
                        <Text style={{ fontSize: '13px' }}>
                          {typeof field.type === 'string' ? field.type : field.type?.type || 'unknown'}
                        </Text>
                      </TableCell>
                      <TableCell>
                        <Text style={{ fontSize: '13px' }}>
                          {field.required ? 'Yes' : 'No'}
                        </Text>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
        )}

        {/* Error Message */}
        {dataset.errorMessage && (
          <MessageBar intent="error">
            <MessageBarBody>{dataset.errorMessage}</MessageBarBody>
          </MessageBar>
        )}
      </>
    )
  }

  const renderDetailsTab = () => (
    <>
      {/* Acquisition card -- full detail */}
      {acquisitionFacet && (
        <Card className={styles.card}>
          <CardHeader
            header={
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Text weight="semibold">Acquisition</Text>
                {renderFacetBadge(acquisitionFacet)}
              </div>
            }
          />
          <div style={{ padding: '0 20px 20px' }}>
            {acquisitionFacet.state === 'in_progress' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <Spinner size="extra-small" />
                  <Text>
                    {acquisitionFacet.progress?.message ||
                      `${acquisitionFacet.progress?.phase || 'Running'}…`}
                  </Text>
                  {typeof acquisitionFacet.progress?.percentage === 'number' && (
                    <Text style={{ color: tokens.colorNeutralForeground3 }}>
                      {Math.round(acquisitionFacet.progress.percentage)}%
                    </Text>
                  )}
                </div>
              </div>
            )}
            {acquisitionFacet.state === 'errored' && acquisitionFacet.errorMessage && (
              <MessageBar intent="error" style={{ marginBottom: '12px' }}>
                <MessageBarBody>{acquisitionFacet.errorMessage}</MessageBarBody>
              </MessageBar>
            )}
            <div className={styles.configGrid}>
              <div className={styles.configSection}>
                <Text className={styles.sectionTitle}>Throughput</Text>
                <div className={styles.configItem}>
                  <Text className={styles.configLabel}>
                    {mergedAcquisition?.sourceType === 'volume' ? 'Files registered' : 'Files copied'}
                  </Text>
                  <Text className={styles.configValue}>
                    {mergedAcquisition?.filesCopied?.toLocaleString() ?? '-'}
                  </Text>
                </div>
                <div className={styles.configItem}>
                  <Text className={styles.configLabel}>Total bytes</Text>
                  <Text className={styles.configValue}>
                    {formatBytes(mergedAcquisition?.totalBytes)}
                  </Text>
                </div>
                <div className={styles.configItem}>
                  <Text className={styles.configLabel}>Throughput</Text>
                  <Text className={styles.configValue}>
                    {mergedAcquisition?.throughputMBps != null
                      ? `${mergedAcquisition.throughputMBps.toFixed(1)} MB/s`
                      : '-'}
                  </Text>
                </div>
                <div className={styles.configItem}>
                  <Text className={styles.configLabel}>Duration</Text>
                  <Text className={styles.configValue}>
                    {formatDurationSec(mergedAcquisition?.durationSec)}
                  </Text>
                </div>
              </div>
              <div className={styles.configSection}>
                <Text className={styles.sectionTitle}>Source</Text>
                {mergedAcquisition?.sourceEndpoint && (
                  <div className={styles.configItem}>
                    <Text className={styles.configLabel}>Endpoint</Text>
                    <Text className={styles.configValue}>{mergedAcquisition.sourceEndpoint}</Text>
                  </div>
                )}
                {mergedAcquisition?.sourceBucket && (
                  <div className={styles.configItem}>
                    <Text className={styles.configLabel}>Bucket</Text>
                    <Text className={styles.configValue}>{mergedAcquisition.sourceBucket}</Text>
                  </div>
                )}
                {mergedAcquisition?.sourcePrefix && (
                  <div className={styles.configItem}>
                    <Text className={styles.configLabel}>Prefix</Text>
                    <Text className={styles.configValue}>{mergedAcquisition.sourcePrefix}</Text>
                  </div>
                )}
                {mergedAcquisition?.mountPath && (
                  <div className={styles.configItem}>
                    <Text className={styles.configLabel}>Mount path</Text>
                    <Text className={styles.configValue}>{mergedAcquisition.mountPath}</Text>
                  </div>
                )}
                <div className={styles.configItem}>
                  <Text className={styles.configLabel}>Files discovered</Text>
                  <Text className={styles.configValue}>
                    {mergedAcquisition?.filesDiscovered?.toLocaleString() ?? '-'}
                  </Text>
                </div>
                <div className={styles.configItem}>
                  <Text className={styles.configLabel}>Files filtered</Text>
                  <Text className={styles.configValue}>
                    {mergedAcquisition?.filesFiltered?.toLocaleString() ?? '-'}
                  </Text>
                </div>
              </div>
              <div className={styles.configSection}>
                <Text className={styles.sectionTitle}>Pipeline</Text>
                <div className={styles.configItem}>
                  <Text className={styles.configLabel}>Consumers</Text>
                  <Text className={styles.configValue}>
                    {mergedAcquisition?.consumerCount ?? '-'}
                  </Text>
                </div>
                <div className={styles.configItem}>
                  <Text className={styles.configLabel}>Errors</Text>
                  <Text className={styles.configValue}>
                    {mergedAcquisition?.errorCount?.toLocaleString() ?? '0'}
                  </Text>
                </div>
                {mergedAcquisition?.completedAt && (
                  <div className={styles.configItem}>
                    <Text className={styles.configLabel}>Completed at</Text>
                    <Text className={styles.configValue}>
                      {new Date(mergedAcquisition.completedAt).toLocaleString()}
                    </Text>
                  </div>
                )}
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Configuration card */}
      <Card className={styles.card}>
        <CardHeader header={<Text weight="semibold">Configuration</Text>} />
        <div className={styles.configGrid}>
          <div className={styles.configSection}>
            <Text className={styles.sectionTitle}>
              <Info24Regular />
              General
            </Text>
            <div className={styles.configItem}>
              <Text className={styles.configLabel}>Name</Text>
              <Text className={styles.configValue}>{dataset.name}</Text>
            </div>
            <div className={styles.configItem}>
              <Text className={styles.configLabel}>Description</Text>
              <Text className={styles.configValue}>{dataset.description || '-'}</Text>
            </div>
            <div className={styles.configItem}>
              <Text className={styles.configLabel}>Type</Text>
              <Text className={styles.configValue}>{dataset.type}</Text>
            </div>
            <div className={styles.configItem}>
              <Text className={styles.configLabel}>Kind</Text>
              <Text className={styles.configValue}>{dataset.kind}</Text>
            </div>
            {dataset.originConnector && (
              <div className={styles.configItem}>
                <Text className={styles.configLabel}>Origin Connector</Text>
                <Text className={styles.configValue}>{dataset.originConnector}</Text>
              </div>
            )}
            {dataset.originVolume && (
              <div className={styles.configItem}>
                <Text className={styles.configLabel}>Origin Volume</Text>
                <Text className={styles.configValue}>{volumeName || dataset.originVolume}</Text>
              </div>
            )}
          </div>

          <div className={styles.configSection}>
            <Text className={styles.sectionTitle}>
              <Document24Regular />
              Storage & Catalog
            </Text>
            {dataset.catalogTableRef && (
              <div className={styles.configItem}>
                <Text className={styles.configLabel}>Catalog Table</Text>
                <Text className={styles.configValue}>{dataset.catalogTableRef}</Text>
              </div>
            )}
            {dataset.namespace && (
              <div className={styles.configItem}>
                <Text className={styles.configLabel}>Namespace</Text>
                <Text className={styles.configValue}>{dataset.namespace}</Text>
              </div>
            )}
            {dataset.catalogTableName && (
              <div className={styles.configItem}>
                <Text className={styles.configLabel}>Table Name</Text>
                <Text className={styles.configValue}>{dataset.catalogTableName}</Text>
              </div>
            )}
            {dataset.warehouseName && (
              <div className={styles.configItem}>
                <Text className={styles.configLabel}>Warehouse</Text>
                <Text className={styles.configValue}>{dataset.warehouseName}</Text>
              </div>
            )}
          </div>

          <div className={styles.configSection}>
            <Text className={styles.sectionTitle}>
              <ShieldCheckmark24Regular />
              Processing
            </Text>
            <div className={styles.configItem}>
              <Text className={styles.configLabel}>PII Analysis</Text>
              <Text className={styles.configValue}>
                {dataset.enablePiiAnalysis ? 'Enabled' : 'Disabled'}
              </Text>
            </div>
            {dataset.enablePiiAnalysis && (
              <div className={styles.configItem}>
                <Text className={styles.configLabel}>Image Only Mode</Text>
                <Text className={styles.configValue}>
                  {dataset.piiAnalysisImageOnly ? 'Yes' : 'No'}
                </Text>
              </div>
            )}
            {dataset.jobId && (
              <div className={styles.configItem}>
                <Text className={styles.configLabel}>Job ID</Text>
                <Text className={styles.configValue} style={{ fontSize: '12px', fontFamily: 'monospace' }}>
                  {dataset.jobId}
                </Text>
              </div>
            )}
            <div className={styles.configItem}>
              <Text className={styles.configLabel}>Created</Text>
              <Text className={styles.configValue}>
                {new Date(dataset.createdAt).toLocaleString()}
              </Text>
            </div>
            <div className={styles.configItem}>
              <Text className={styles.configLabel}>Updated</Text>
              <Text className={styles.configValue}>
                {new Date(dataset.updatedAt).toLocaleString()}
              </Text>
            </div>
          </div>
        </div>
      </Card>
    </>
  )

  // Helper to get a facet from the dataset's facets array
  const getFacet = (facetType: string): Facet | undefined => {
    return dataset.facets?.find(f => f.facetType === facetType)
  }

  const renderFacetBadge = (facet: Facet | undefined) => {
    if (!facet) return null
    switch (facet.state) {
      case 'in_progress':
        return <Badge appearance="filled" color="warning">In Progress</Badge>
      case 'ready':
        return <Badge appearance="filled" color="success">Ready</Badge>
      case 'errored':
        return <Badge appearance="filled" color="danger">Errored</Badge>
      default:
        return null
    }
  }

  const renderPiiTab = () => {
    const piiFacet = getFacet('pii')

    // PII facet is in_progress (PII reprocess running, dataset stays ready)
    if (piiFacet?.state === 'in_progress') {
      return (
        <Card className={styles.card}>
          <div className={styles.emptyState}>
            <Spinner size="large" />
            <Text size={500} weight="semibold">PII Analysis In Progress</Text>
            <Text style={{ color: tokens.colorNeutralForeground3 }}>
              Only the PII analysis is re-running. The dataset remains available.
            </Text>
            {renderFacetBadge(piiFacet)}
          </div>
        </Card>
      )
    }

    // PII facet errored
    if (piiFacet?.state === 'errored') {
      return (
        <Card className={styles.card}>
          <div className={styles.emptyState}>
            <Warning24Regular style={{ fontSize: '48px', color: tokens.colorPaletteRedForeground1 }} />
            <Text size={500} weight="semibold">PII Analysis Failed</Text>
            <Text style={{ color: tokens.colorNeutralForeground3, maxWidth: '400px' }}>
              {piiFacet.errorMessage || 'PII analysis encountered an error.'}
            </Text>
            <Button
              appearance="primary"
              icon={<ShieldCheckmark24Regular />}
              onClick={() => setConfirmOpen(true)}
              disabled={reprocessing}
            >
              Retry PII Analysis
            </Button>
          </div>
        </Card>
      )
    }

    // PII analysis not enabled
    if (!dataset.enablePiiAnalysis) {
      return (
        <Card className={styles.card}>
          <div className={styles.emptyState}>
            <ShieldCheckmark24Regular style={{ fontSize: '48px', color: tokens.colorNeutralForeground3 }} />
            <Text size={500} weight="semibold">PII Analysis Not Enabled</Text>
            <Text style={{ color: tokens.colorNeutralForeground3, maxWidth: '400px' }}>
              PII analysis was not enabled for this dataset. You can enable it by triggering a PII reprocessing job.
            </Text>
            <Button
              appearance="primary"
              icon={<ShieldCheckmark24Regular />}
              onClick={() => setConfirmOpen(true)}
              disabled={dataset.status === 'in_progress' || reprocessing}
            >
              Enable & Reprocess PII
            </Button>
          </div>
        </Card>
      )
    }

    // Dataset is being processed
    if (dataset.status === 'in_progress') {
      return (
        <Card className={styles.card}>
          <div className={styles.emptyState}>
            <Spinner size="large" />
            <Text size={500} weight="semibold">Processing in Progress</Text>
            <Text style={{ color: tokens.colorNeutralForeground3 }}>
              The dataset is currently being processed. PII details will be available once processing completes.
            </Text>
          </div>
        </Card>
      )
    }

    // PII load attempted but error and no data
    if (piiError && piiLoadAttempted && !piiData) {
      return (
        <Card className={styles.card}>
          <div className={styles.emptyState}>
            <Warning24Regular style={{ fontSize: '48px', color: tokens.colorNeutralForeground3 }} />
            <Text size={500} weight="semibold">No PII Data Available</Text>
            <Text style={{ color: tokens.colorNeutralForeground3, maxWidth: '400px' }}>
              {piiError}
            </Text>
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <Button
                appearance="secondary"
                icon={<ArrowSync24Regular />}
                onClick={() => {
                  setPiiLoadAttempted(false)
                  setPiiError(null)
                  setPiiData(null)
                  setPiiPage(0)
                  setPiiFilters([])
                }}
              >
                Retry
              </Button>
              <Button
                appearance="primary"
                icon={<ShieldCheckmark24Regular />}
                onClick={() => setConfirmOpen(true)}
                disabled={reprocessing}
              >
                Reprocess PII
              </Button>
            </div>
          </div>
        </Card>
      )
    }

    const piiSummary = piiFacet?.summary as {
      totalFiles?: number; filesWithPii?: number;
      filesWithHighRisk?: number; filesWithMediumRisk?: number; filesWithLowRisk?: number;
    } | undefined
    const totalFiles = piiSummary?.totalFiles ?? 0
    const filesWithPii = piiSummary?.filesWithPii ?? 0

    return (
      <>
        {/* Summary Cards from PII facet */}
        <div className={styles.statsGrid}>
          <div className={styles.statCard}>
            <Text className={styles.statValue}>{totalFiles}</Text>
            <Text className={styles.statLabel}>Total Files Analyzed</Text>
          </div>
          <div className={styles.statCard}>
            <Text className={styles.statValue} style={{ color: tokens.colorPaletteRedForeground1 }}>
              {piiSummary?.filesWithHighRisk ?? 0}
            </Text>
            <Text className={styles.statLabel}>High Risk Files</Text>
          </div>
          <div className={styles.statCard}>
            <Text className={styles.statValue} style={{ color: tokens.colorPaletteDarkOrangeForeground1 }}>
              {piiSummary?.filesWithMediumRisk ?? 0}
            </Text>
            <Text className={styles.statLabel}>Medium Risk Files</Text>
          </div>
          <div className={styles.statCard}>
            <Text className={styles.statValue}>
              {piiSummary?.filesWithLowRisk ?? 0}
            </Text>
            <Text className={styles.statLabel}>Low Risk Files</Text>
          </div>
          <div className={styles.statCard}>
            <Text className={styles.statValue}>
              {totalFiles - filesWithPii}
            </Text>
            <Text className={styles.statLabel}>Clean Files</Text>
          </div>
        </div>

        {/* Filters for PII table */}
        {piiData && (
          <FilterBuilder
            columns={piiData.columns ?? []}
            columnTypes={piiData.columnTypes ?? []}
            onApply={handlePiiApplyFilters}
            onClear={handlePiiClearFilters}
          />
        )}

        {/* Per-file PII Table (original Fluent UI table, paginated from Iceberg) */}
        <Card className={styles.card}>
          <CardHeader header={<Text weight="semibold">Per-File PII Breakdown</Text>}
            action={piiData && (
              <Text style={{ fontSize: '12px', color: tokens.colorNeutralForeground3 }}>
                {(piiData.totalCount ?? 0) > 0 && `${(piiData.totalCount ?? 0).toLocaleString()} total files`}
              </Text>
            )}
          />
          <div style={{ padding: '0 20px 20px', overflowX: 'auto' }}>
            {piiLoading && !piiData ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '40px' }}>
                <Spinner label="Loading PII details..." />
              </div>
            ) : (
              <>
                <Table className={styles.piiTable} size="small">
                  <TableHeader>
                    <TableRow>
                      {[
                        { col: 'file_name', label: 'File Name' },
                        { col: 'file_size', label: 'Size' },
                        { col: 'pii_risk_level', label: 'Risk Level' },
                        { col: 'pii_count', label: 'PII Count' },
                        { col: 'sensitivity_class', label: 'Sensitivity' },
                        { col: null, label: 'PII Entities' },
                      ].map(({ col, label }) => (
                        <TableHeaderCell
                          key={label}
                          className={styles.piiHeaderCell}
                          style={col ? { cursor: 'pointer', userSelect: 'none' } : undefined}
                          onClick={col ? () => {
                            const isCurrentCol = piiOrderBy.column === col
                            const newDir = isCurrentCol && piiOrderBy.direction === 'desc' ? 'asc' : 'desc'
                            const newOrderBy: OrderBy = { column: col, direction: newDir }
                            setPiiOrderBy(newOrderBy)
                            setPiiPage(0)
                            loadPiiPage({ page: 0, orderBy: newOrderBy })
                          } : undefined}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                            {label}
                            {col && piiOrderBy.column === col && (
                              piiOrderBy.direction === 'desc'
                                ? <ArrowDown16Regular />
                                : <ArrowUp16Regular />
                            )}
                          </span>
                        </TableHeaderCell>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {piiLoading ? (
                      <TableRow>
                        <TableCell colSpan={6} className={styles.piiCell}>
                          <div style={{ display: 'flex', justifyContent: 'center', padding: '20px' }}>
                            <Spinner size="small" label="Loading..." />
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : (piiData?.rows ?? []).map((row, idx) => {
                      const fileName = piiCellVal(row as unknown[], 'file_name') ?? ''
                      const filePath = piiCellVal(row as unknown[], 'file_path') ?? ''
                      const fileSize = piiCellVal(row as unknown[], 'file_size') ?? 0
                      const riskLevel = piiCellVal(row as unknown[], 'pii_risk_level') ?? 'none'
                      const piiCount = piiCellVal(row as unknown[], 'pii_count')
                      const sensitivityClass = piiCellVal(row as unknown[], 'sensitivity_class') ?? ''
                      const rawEntities = piiCellVal(row as unknown[], 'pii_entities')
                      const entities = parsePiiEntities(rawEntities)
                      return (
                        <TableRow key={idx}>
                          <TableCell className={styles.piiCell}>
                            <Tooltip content={filePath || fileName} relationship="description">
                              <Text className={styles.piiFileNameText}>{fileName}</Text>
                            </Tooltip>
                          </TableCell>
                          <TableCell className={styles.piiCell}>
                            <Text style={{ fontSize: '12px' }}>{formatFileSize(fileSize)}</Text>
                          </TableCell>
                          <TableCell className={styles.piiCell}>
                            <RiskLevelBadge value={riskLevel} />
                          </TableCell>
                          <TableCell className={styles.piiCell}>
                            <Text style={{ fontSize: '12px' }}>{piiCount ?? '-'}</Text>
                          </TableCell>
                          <TableCell className={styles.piiCell}>
                            <SensitivityBadge value={sensitivityClass} />
                          </TableCell>
                          <TableCell className={styles.piiCell}>
                            <div className={styles.piiEntitiesList}>
                              {entities.length > 0 ? (
                                entities.map((entity, eidx) => (
                                  <Badge key={eidx} appearance="outline" size="small" color={entityRiskColor(entity)}>
                                    {entity}
                                  </Badge>
                                ))
                              ) : (
                                <Text style={{ fontSize: '12px', color: tokens.colorNeutralForeground3 }}>-</Text>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>

                {/* Pagination controls */}
                {piiData && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0 0' }}>
                    <Text style={{ fontSize: '12px', color: tokens.colorNeutralForeground3 }}>
                      Showing {piiPage * piiLimit + 1}–{Math.min((piiPage + 1) * piiLimit, piiData.totalCount ?? 0)} of {(piiData.totalCount ?? 0).toLocaleString()} files
                    </Text>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<ChevronLeft20Regular />}
                        disabled={piiPage === 0 || piiLoading}
                        onClick={() => {
                          const newPage = piiPage - 1
                          setPiiPage(newPage)
                          loadPiiPage({ page: newPage })
                        }}
                      >
                        Previous
                      </Button>
                      <Text style={{ fontSize: '12px' }}>
                        Page {piiPage + 1} of {Math.ceil((piiData.totalCount ?? 0) / piiLimit)}
                      </Text>
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<ChevronRight20Regular />}
                        iconPosition="after"
                        disabled={(piiPage + 1) * piiLimit >= (piiData.totalCount ?? 0) || piiLoading}
                        onClick={() => {
                          const newPage = piiPage + 1
                          setPiiPage(newPage)
                          loadPiiPage({ page: newPage })
                        }}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </Card>
      </>
    )
  }

  const renderPreviewTab = () => {
    if (previewMode === 'visual' && previewError && !previewData) {
      return (
        <>
          <div className={styles.previewToolbar}>
            <div style={{ display: 'flex', gap: '4px' }}>
              <Button size="small" appearance="primary" onClick={() => setPreviewMode('visual')}>Visual</Button>
              <Button size="small" appearance="subtle" onClick={() => {
                setPreviewMode('sql')
                if (!sqlQuery && dataset.namespace && dataset.catalogTableName) {
                  setSqlQuery(`SELECT * FROM iceberg."${dataset.namespace}"."${dataset.catalogTableName}" LIMIT 100`)
                }
              }}>SQL</Button>
            </div>
          </div>
          <Card className={styles.card}>
            <div className={styles.emptyState}>
              <Warning24Regular style={{ fontSize: '48px', color: tokens.colorPaletteRedForeground1 }} />
              <Text weight="semibold">Preview unavailable</Text>
              <Text style={{ color: tokens.colorNeutralForeground3 }}>{previewError}</Text>
              <Button
                appearance="primary"
                icon={<ArrowClockwise24Regular />}
                onClick={() => { setPreviewLoadAttempted(false); setPreviewError(null) }}
              >
                Retry
              </Button>
            </div>
          </Card>
        </>
      )
    }

    return (
      <>
        {/* Mode toggle toolbar */}
        <div className={styles.previewToolbar}>
          <div style={{ display: 'flex', gap: '4px' }}>
            <Button size="small" appearance={previewMode === 'visual' ? 'primary' : 'subtle'} onClick={() => setPreviewMode('visual')}>Visual</Button>
            <Button size="small" appearance={previewMode === 'sql' ? 'primary' : 'subtle'} onClick={() => {
              setPreviewMode('sql')
              if (!sqlQuery && dataset.namespace && dataset.catalogTableName) {
                setSqlQuery(`SELECT * FROM iceberg."${dataset.namespace}"."${dataset.catalogTableName}" LIMIT 100`)
              }
            }}>SQL</Button>
          </div>
          {previewMode === 'visual' && (
            <>
              <Button
                size="small"
                appearance="subtle"
                icon={<ArrowClockwise24Regular />}
                onClick={() => { setPreviewLoadAttempted(false); setPreviewData(null); setColumnStats(null) }}
              >
                Refresh
              </Button>
              {previewData && (
                <Text style={{ fontSize: '12px', color: tokens.colorNeutralForeground3, marginLeft: 'auto' }}>
                  {previewData.executionTime != null && `Query time: ${previewData.executionTime}ms`}
                  {(previewData.totalCount ?? 0) > 0 && ` | ${(previewData.totalCount ?? 0).toLocaleString()} total rows`}
                </Text>
              )}
            </>
          )}
          {previewMode === 'sql' && sqlResult && (
            <Text style={{ fontSize: '12px', color: tokens.colorNeutralForeground3, marginLeft: 'auto' }}>
              {sqlResult.executionTime != null && `Query time: ${sqlResult.executionTime}ms`}
              {` | ${sqlResult.rowCount ?? 0} rows returned`}
            </Text>
          )}
        </div>

        {previewMode === 'sql' ? (
          <>
            <div style={{ marginBottom: '8px' }}>
              <SQLMonacoEditor
                value={sqlQuery}
                onChange={(v) => setSqlQuery(v)}
                onExecute={handleExecuteSql}
                height="150px"
                tables={dataset.catalogTableName ? [{
                  name: `iceberg."${dataset.namespace}"."${dataset.catalogTableName}"`,
                  columns: previewData?.columns ?? [],
                }] : undefined}
              />
            </div>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
              <Button
                size="small"
                appearance="primary"
                onClick={handleExecuteSql}
                disabled={sqlLoading || !sqlQuery.trim()}
              >
                {sqlLoading ? 'Running...' : 'Run Query'}
              </Button>
              <Text style={{ fontSize: '11px', color: tokens.colorNeutralForeground3, alignSelf: 'center' }}>
                Cmd/Ctrl + Enter to execute
              </Text>
            </div>
            {sqlError && (
              <MessageBar intent="error" style={{ marginBottom: '8px' }}>
                <MessageBarBody>{sqlError}</MessageBarBody>
              </MessageBar>
            )}
            <Card className={styles.card} style={{ padding: 0, overflow: 'hidden' }}>
              <DataGrid
                data={sqlGridData}
                columns={sqlGridColumns}
                loading={sqlLoading}
                defaultPageSize={50}
                enableSorting
                enablePagination
                enableFiltering={false}
              />
            </Card>
          </>
        ) : (
          <>
            {previewData && (
              <FilterBuilder
                columns={previewData.columns ?? []}
                columnTypes={previewData.columnTypes ?? []}
                onApply={handleApplyFilters}
                onClear={handleClearFilters}
              />
            )}
            {previewFilters.length > 0 && (
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', padding: '4px 0' }}>
                {previewFilters.map((f) => (
                  <Badge
                    key={f.column}
                    appearance="outline"
                    style={{ cursor: 'pointer', fontSize: '12px' }}
                    onClick={() => handleClearColumnFilter(f.column)}
                  >
                    {f.column} {f.op} {f.value ? (f.value.length > 30 ? `${f.value.slice(0, 30)}...` : f.value) : ''} ×
                  </Badge>
                ))}
              </div>
            )}
            <Card className={styles.card} style={{ padding: 0, overflow: 'hidden' }}>
              <DataGrid
                data={gridData}
                columns={gridColumns}
                loading={previewLoading}
                rowCount={effectiveRowCount}
                defaultPageSize={previewLimit}
                enableSorting
                enablePagination
                enableFiltering={false}
                manualSorting
                onPageChange={handlePageChange}
                onSortChange={handleSortChange}
                statsRow={columnStats ? (colId) => (
                  <ColumnStatsHeader
                    stats={columnStats[colId]}
                  />
                ) : undefined}
                columnFilterRenderer={dataset.namespace && dataset.catalogTableName ? (colId) => (
                  <ColumnFilterPopover
                    namespace={dataset.namespace!}
                    tableName={dataset.catalogTableName!}
                    column={colId}
                    columnType={previewData?.columnTypes?.[previewData?.columns?.indexOf(colId) ?? -1] ?? 'VARCHAR'}
                    activeFilter={previewFilters.find((f) => f.column === colId)}
                    onApply={handleColumnFilter}
                    onClear={() => handleClearColumnFilter(colId)}
                  />
                ) : undefined}
              />
            </Card>
            {previewData?.offsetCapped && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  Dataset exceeds 5,000 rows. Use filters to narrow results.
                </MessageBarBody>
              </MessageBar>
            )}
          </>
        )}
      </>
    )
  }

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Button
            icon={<ArrowLeft24Regular />}
            appearance="subtle"
            onClick={() => navigate(`/projects/${projectId}/datasets`)}
          />
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              {dataset.kind === 'unstructured' ? <Document24Regular /> : <Table24Regular />}
              <Text className={styles.title}>{dataset.name}</Text>
              {statusBadge()}
            </div>
            {dataset.description && (
              <Text className={styles.subtitle}>{dataset.description}</Text>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button
            icon={<ArrowSync24Regular />}
            appearance="subtle"
            onClick={handleRefresh}
          >
            Refresh
          </Button>
          {dataset.status === 'errored' && (
            <Button
              icon={<ArrowClockwise24Regular />}
              appearance="primary"
              disabled={retrying}
              onClick={handleRetryImport}
            >
              {retrying ? 'Retrying...' : 'Retry Import'}
            </Button>
          )}
          {dataset.kind === 'unstructured' && (dataset.status === 'ready' || dataset.status === 'errored') && (
            <Dialog open={confirmOpen} onOpenChange={(_e, data) => setConfirmOpen(data.open)}>
              <DialogTrigger disableButtonEnhancement>
                <Button
                  icon={<ShieldCheckmark24Regular />}
                  appearance={dataset.status === 'errored' ? 'secondary' : 'primary'}
                  disabled={reprocessing || retrying}
                >
                  {reprocessing ? 'Reprocessing...' : 'Reprocess PII'}
                </Button>
              </DialogTrigger>
              <DialogSurface>
                <DialogBody>
                  <DialogTitle>Reprocess PII Analysis</DialogTitle>
                  <DialogContent>
                    This will re-run PII analysis on all files in this dataset. The existing PII data will be replaced with fresh analysis results. Only the PII analysis will be re-run. The dataset remains available.
                  </DialogContent>
                  <DialogActions>
                    <DialogTrigger disableButtonEnhancement>
                      <Button appearance="secondary">Cancel</Button>
                    </DialogTrigger>
                    <Button appearance="primary" onClick={handleReprocessPii}>
                      Confirm Reprocess
                    </Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>
          )}
        </div>
      </div>

      {dataset.status === 'in_progress' && (
        <Card className={styles.card}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <Text weight="semibold">
              {dataset.progress?.phase === 'pii_analysis' ? 'PII Analysis' : 'Importing'}
            </Text>
            {dataset.progress != null ? (
              (() => {
                const pct = Math.round((dataset.progress.percentage ?? 0) * 100) / 100
                return (
                  <Tooltip content={`${dataset.progress.phase || 'Processing'}: ${pct}%`} relationship="label">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <ProgressBar
                        value={dataset.progress.percentage ?? 0}
                        max={100}
                        thickness="medium"
                        style={{ flex: 1 }}
                      />
                      <Text>{pct}%</Text>
                    </div>
                  </Tooltip>
                )
              })()
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <ProgressBar value={undefined} max={100} thickness="medium" style={{ flex: 1 }} />
                <Text>Processing...</Text>
              </div>
            )}
            {dataset.progress?.currentFile && (
              <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
                Processing: {dataset.progress.currentFile}
              </Text>
            )}
            <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
              {typeof dataset.progress?.totalUnits === 'number' && (
                <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
                  {(() => {
                    const units = dataset.progress?.units ?? []
                    const completed = units.filter((u: { status?: string }) => u.status === 'completed').length
                    return (dataset.progress?.totalUnits ?? 0) > 0
                      ? `${completed} of ${dataset.progress?.totalUnits ?? 0} units`
                      : `${completed} units completed`
                  })()}
                </Text>
              )}
              {dataset.progress?.processedFiles != null && dataset.progress?.totalFiles != null && typeof dataset.progress?.totalUnits !== 'number' && (
                <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
                  File {dataset.progress.processedFiles} of {dataset.progress.totalFiles}
                </Text>
              )}
              {dataset.progress?.estimatedRemainingFormatted && (
                <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
                  ETA: {dataset.progress.estimatedRemainingFormatted}
                </Text>
              )}
              {dataset.progress?.elapsedFormatted && (
                <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
                  Elapsed: {dataset.progress.elapsedFormatted}
                </Text>
              )}
            </div>
            {Array.isArray(dataset.progress?.units) && dataset.progress.units.length > 0 && (
              <WorkUnitsTable
                units={dataset.progress.units as Array<{ unitId?: string; status?: string; metrics?: Record<string, unknown> }>}
              />
            )}
          </div>
        </Card>
      )}

      {/* Tabs */}
      <TabList
        selectedValue={activeTab}
        onTabSelect={(_e, data) => setActiveTab(data.value as 'overview' | 'details' | 'pii' | 'preview')}
      >
        <Tab value="overview">Overview</Tab>
        <Tab value="details">Details</Tab>
        <Tab value="pii">PII Analysis</Tab>
        {isPreviewable && <Tab value="preview">Data Preview</Tab>}
      </TabList>

      {/* Tab Content */}
      {activeTab === 'overview' && renderOverviewTab()}
      {activeTab === 'details' && renderDetailsTab()}
      {activeTab === 'pii' && renderPiiTab()}
      {activeTab === 'preview' && isPreviewable && renderPreviewTab()}
    </div>
  )
}

function SensitivityBadge({ value }: { value: string }) {
  switch (value) {
    case 'sensitive':
      return <Badge appearance="filled" color="danger">Sensitive</Badge>
    case 'public':
      return <Badge appearance="filled" color="success">Public</Badge>
    case 'not_applicable':
      return <Badge appearance="filled" color="informative">N/A</Badge>
    default:
      return <Badge appearance="filled" color="informative">{value || 'Unknown'}</Badge>
  }
}

function RiskLevelBadge({ value }: { value: string }) {
  switch (value) {
    case 'high':
      return <Badge appearance="filled" color="danger">High</Badge>
    case 'medium':
      return <Badge appearance="filled" color="warning">Medium</Badge>
    case 'low':
      return <Badge appearance="filled" color="informative">Low</Badge>
    default:
      return <Badge appearance="filled" color="success">None</Badge>
  }
}

const PII_ENTITY_RISK: Record<string, string> = {
  US_SSN: 'high', US_DRIVER_LICENSE: 'high', US_PASSPORT: 'high',
  US_BANK_NUMBER: 'high', CREDIT_CARD: 'high', IBAN_CODE: 'high',
  US_ITIN: 'high', MEDICAL_LICENSE: 'high', UK_NHS: 'high',
  SG_NRIC_FIN: 'high', AU_TFN: 'high', AU_MEDICARE: 'high',
  IN_AADHAAR: 'high', IN_PAN: 'high', IP_ADDRESS: 'high', CRYPTO: 'high',
  PERSON: 'medium', EMAIL_ADDRESS: 'medium', PHONE_NUMBER: 'medium',
  LOCATION: 'medium', NRP: 'medium',
  DATE_TIME: 'low', URL: 'low', DOMAIN_NAME: 'low',
  ORGANIZATION: 'low', TITLE: 'low',
}

function entityRiskColor(entity: string): 'danger' | 'warning' | 'informative' {
  const risk = PII_ENTITY_RISK[entity] || 'medium'
  if (risk === 'high') return 'danger'
  if (risk === 'medium') return 'warning'
  return 'informative'
}

function formatFileSize(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}
