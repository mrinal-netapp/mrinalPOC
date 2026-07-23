import { useState, useEffect, useMemo, useCallback } from 'react'
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
  Divider,
  Tooltip,
  Dropdown,
  Option,
  ProgressBar,
  Switch,
} from '@fluentui/react-components'
import {
  ArrowLeft24Regular,
  ArrowSync24Regular,
  Search24Regular,
  Play24Regular,
  Info24Regular,
  Clock24Regular,
  DocumentBulletList24Regular,
  Dismiss24Regular,
  ChevronDown20Regular,
  ChevronUp20Regular,
} from '@fluentui/react-icons'
import {
  knowledgeBaseApi,
  datasetApi,
  KnowledgeBase,
  DataSet,
  KBSearchResponse,
  KBSearchRequest,
  KBSearchMode,
  RerankerType,
} from '../services/api'
import { WorkUnitsTable } from '../components/WorkUnitsTable'
import {
  EMBEDDING_MODELS,
  CHUNK_STRATEGIES,
  INDEXING_MODES,
  QUANTIZATION_TYPES,
} from '../components/wizard/KnowledgeBaseWizard'
import FilePreviewModal from '../components/FilePreviewModal'

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
  playgroundContainer: {
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
    padding: '20px',
  },
  searchSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  searchInputRow: {
    display: 'flex',
    gap: '12px',
    alignItems: 'flex-end',
  },
  searchInput: {
    flex: 1,
  },
  parametersRow: {
    display: 'flex',
    gap: '24px',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
  },
  parameterField: {
    minWidth: '120px',
  },
  // --- Comparison KB selector ---
  comparisonBar: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  kbChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 10px 4px 12px',
    borderRadius: '16px',
    fontSize: '13px',
    fontWeight: 500,
  },
  kbChipPrimary: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
    border: `1px solid ${tokens.colorBrandStroke1}`,
  },
  kbChipSecondary: {
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  kbChipRemove: {
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: '50%',
    padding: '1px',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  // --- Column layout for comparison results ---
  columnsContainer: {
    display: 'grid',
    gap: '16px',
  },
  columnHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderRadius: '8px 8px 0 0',
    marginBottom: '4px',
  },
  columnHeaderPrimary: {
    backgroundColor: tokens.colorBrandBackground2,
  },
  columnHeaderAlt: {
    backgroundColor: tokens.colorNeutralBackground3,
  },
  // --- Summary card ---
  summaryGrid: {
    display: 'grid',
    gap: '16px',
    marginBottom: '8px',
  },
  summaryCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '16px',
    borderRadius: '8px',
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  summaryRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: '13px',
  },
  resultsSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  metricsBar: {
    display: 'flex',
    gap: '24px',
    padding: '16px',
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: '8px',
    flexWrap: 'wrap',
  },
  metricItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    minWidth: '100px',
  },
  metricValue: {
    fontSize: '20px',
    fontWeight: 600,
    color: tokens.colorBrandForeground1,
  },
  metricLabel: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
  },
  resultCard: {
    padding: '16px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: '8px',
    marginBottom: '12px',
  },
  resultHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '12px',
  },
  resultScore: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  scoreBar: {
    width: '80px',
    height: '8px',
    backgroundColor: tokens.colorNeutralBackground4,
    borderRadius: '4px',
    overflow: 'hidden',
  },
  scoreFill: {
    height: '100%',
    borderRadius: '4px',
  },
  resultText: {
    fontSize: '14px',
    lineHeight: '1.6',
    color: tokens.colorNeutralForeground1,
    whiteSpace: 'pre-wrap',
    backgroundColor: tokens.colorNeutralBackground2,
    padding: '12px',
    borderRadius: '4px',
    maxHeight: '200px',
    overflowY: 'auto',
  },
  resultMeta: {
    display: 'flex',
    gap: '16px',
    marginTop: '12px',
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
  },
  emptyResults: {
    padding: '40px',
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
  },
})

// Per-KB result state used in comparison mode
interface KBComparisonEntry {
  kb: KnowledgeBase
  response: KBSearchResponse | null
  error: string | null
  searching: boolean
}

const MAX_COMPARE_KBS = 3

export default function KnowledgeBaseDetail() {
  const styles = useStyles()
  const { projectId, kbId } = useParams<{ projectId: string; kbId: string }>()
  const navigate = useNavigate()

  const [kb, setKb] = useState<KnowledgeBase | null>(null)
  const [dataset, setDataset] = useState<DataSet | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'overview' | 'playground'>('overview')

  // Playground state — shared parameters
  const [query, setQuery] = useState('')
  const [topK, setTopK] = useState(10)
  const [minScore, setMinScore] = useState(0.0)
  // Advanced: search mode, reranker, custom model (reranker model name)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [searchMode, setSearchMode] = useState<KBSearchMode | ''>('')
  const [distanceMetric, setDistanceMetric] = useState<'cosine' | 'l2' | 'dot'>('cosine')
  const [rerankerType, setRerankerType] = useState<RerankerType>('rrf')
  const [linearWeight, setLinearWeight] = useState(0.7)
  const [rerankerModel, setRerankerModel] = useState('') // cross_encoder / cohere model name

  // File preview state
  const [previewFile, setPreviewFile] = useState<{ url: string; name: string } | null>(null)

  // Comparison state
  const [allKnowledgeBases, setAllKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [compareKbIds, setCompareKbIds] = useState<string[]>([])
  const [comparisonResults, setComparisonResults] = useState<Map<string, KBComparisonEntry>>(new Map())
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)

  const loadKnowledgeBase = useCallback(async () => {
    if (!projectId || !kbId) return

    try {
      setLoading(true)
      setError(null)
      const kbData = await knowledgeBaseApi.get(projectId, kbId)
      setKb(kbData)

      // Try to load the source dataset
      try {
        const datasetData = await datasetApi.get(projectId, kbData.sourceDataset)
        setDataset(datasetData)
      } catch {
        // Dataset might be deleted, continue without it
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load knowledge base')
    } finally {
      setLoading(false)
    }
  }, [projectId, kbId])

  useEffect(() => {
    if (projectId && kbId) {
      loadKnowledgeBase()
    }
  }, [projectId, kbId, loadKnowledgeBase])

  // Poll when KB creation/update is in progress so progress bar updates
  useEffect(() => {
    if (!autoRefresh || kb?.status !== 'in_progress') return
    const interval = setInterval(loadKnowledgeBase, 5000)
    return () => clearInterval(interval)
  }, [autoRefresh, kb?.status, loadKnowledgeBase])

  // Load all project KBs so the user can pick comparison targets
  useEffect(() => {
    if (projectId) {
      knowledgeBaseApi.list(projectId).then(setAllKnowledgeBases).catch(() => {})
    }
  }, [projectId])

  // All KB IDs being searched (primary + comparison)
  const activeKbIds = useMemo(() => [kbId!, ...compareKbIds], [kbId, compareKbIds])

  // KBs available to add for comparison (created status, not already selected)
  const availableForComparison = useMemo(
    () =>
      allKnowledgeBases.filter(
        (k) => k.status === 'ready' && k.id !== kbId && !compareKbIds.includes(k.id)
      ),
    [allKnowledgeBases, kbId, compareKbIds]
  )

  // Stats: prefer embedding facet summary (workflow-populated on completion), then kb.stats, then live progress
  const embeddingSummary = useMemo(() => {
    const facet = kb?.facets?.find((f) => f.facetType === 'embedding');
    const fromFacet = facet?.summary as { documentCount?: number; chunkCount?: number; vectorCount?: number; storageMB?: number } | undefined;
    const fromKbStats = kb?.stats;
    return fromFacet && (fromFacet.documentCount != null || fromFacet.chunkCount != null)
      ? fromFacet
      : fromKbStats;
  }, [kb?.facets, kb?.stats]);

  const addCompareKb = useCallback(
    (id: string) => {
      if (compareKbIds.length < MAX_COMPARE_KBS - 1 && !compareKbIds.includes(id)) {
        setCompareKbIds((prev) => [...prev, id])
      }
    },
    [compareKbIds]
  )

  const removeCompareKb = useCallback((id: string) => {
    setCompareKbIds((prev) => prev.filter((k) => k !== id))
    setComparisonResults((prev) => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  const getKbName = useCallback(
    (id: string) => {
      if (id === kbId) return kb?.name || id
      const found = allKnowledgeBases.find((k) => k.id === id)
      return found?.name || id
    },
    [kbId, kb, allKnowledgeBases]
  )

  const handleSearch = async () => {
    if (!projectId || !query.trim()) return

    setSearching(true)
    setSearchError(null)
    const newResults = new Map<string, KBComparisonEntry>()

    // Initialize all entries as searching
    for (const id of activeKbIds) {
      const kbObj = id === kbId ? kb! : allKnowledgeBases.find((k) => k.id === id)!
      newResults.set(id, { kb: kbObj, response: null, error: null, searching: true })
    }
    setComparisonResults(new Map(newResults))

    const buildSearchRequest = (): KBSearchRequest => {
      const req: KBSearchRequest = {
        query: query.trim(),
        topK,
        minScore,
      }
      if (searchMode) req.searchMode = searchMode as KBSearchMode
      req.distanceMetric = distanceMetric
      if (rerankerType && rerankerType !== 'rrf') {
        req.rerankerType = rerankerType
        if (rerankerType === 'linear') {
          req.rerankerOptions = { weight: linearWeight }
        } else if ((rerankerType === 'cross_encoder' || rerankerType === 'cohere') && rerankerModel.trim()) {
          req.rerankerOptions = { model: rerankerModel.trim() }
        }
      }
      return req
    }

    const searchRequest = buildSearchRequest()

    // Fire searches in parallel
    const promises = activeKbIds.map(async (id) => {
      try {
        const response = await knowledgeBaseApi.search(projectId, id, searchRequest)
        newResults.set(id, { ...newResults.get(id)!, response, searching: false })
      } catch (err: any) {
        newResults.set(id, {
          ...newResults.get(id)!,
          error: err.response?.data?.error || err.message || 'Search failed',
          searching: false,
        })
      }
    })

    await Promise.allSettled(promises)
    setComparisonResults(new Map(newResults))
    setSearching(false)
  }

  // Whether we are in comparison mode (more than 1 KB selected)
  const isComparing = compareKbIds.length > 0

  // Helper to calculate average relevance for a single result set
  const calcAvgRelevance = (resp: KBSearchResponse | null) => {
    if (!resp || resp.results.length === 0) return 0
    const sum = resp.results.reduce((acc, r) => acc + r.score, 0)
    return sum / resp.results.length
  }

  // Get display names for configuration values
  const getEmbeddingModelDisplay = (modelName: string) => {
    const model = EMBEDDING_MODELS.find((m) => m.name === modelName)
    return model ? model.displayName : modelName
  }

  const getChunkStrategyDisplay = (strategy: string) => {
    const s = CHUNK_STRATEGIES.find((c) => c.id === strategy)
    return s ? s.displayName : strategy
  }

  const getIndexingModeDisplay = (mode: string) => {
    const m = INDEXING_MODES.find((i) => i.id === mode)
    return m ? m.displayName : mode
  }

  const getQuantizationDisplay = (type: string) => {
    const q = QUANTIZATION_TYPES.find((qt) => qt.id === type)
    return q ? q.displayName : type || 'None'
  }

  const getScoreColor = (score: number) => {
    if (score >= 0.8) return tokens.colorPaletteGreenBackground3
    if (score >= 0.6) return tokens.colorPaletteYellowBackground3
    if (score >= 0.4) return tokens.colorPaletteMarigoldBackground3
    return tokens.colorPaletteRedBackground3
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
        <Spinner label="Loading knowledge base..." />
      </div>
    )
  }

  if (error || !kb) {
    return (
      <div className={styles.container}>
        <MessageBar intent="error">
          <MessageBarBody>{error || 'Knowledge base not found'}</MessageBarBody>
        </MessageBar>
        <Button
          appearance="secondary"
          icon={<ArrowLeft24Regular />}
          onClick={() => navigate(`/projects/${projectId}/knowledgebases`)}
        >
          Back to Knowledge Bases
        </Button>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Button
            appearance="subtle"
            icon={<ArrowLeft24Regular />}
            onClick={() => navigate(`/projects/${projectId}/knowledgebases`)}
          />
          <div>
            <h1 className={styles.title}>{kb.name}</h1>
            {kb.description && <p className={styles.subtitle}>{kb.description}</p>}
          </div>
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
            {kb.status === 'in_progress' ? 'In Progress' : kb.status === 'ready' ? 'Ready' : kb.status === 'errored' ? 'Errored' : kb.status || 'Ready'}
          </Badge>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {kb.status === 'in_progress' && (
            <Tooltip content="Auto-refresh every 5 seconds while in progress" relationship="description">
              <Switch
                checked={autoRefresh}
                onChange={(_, data) => setAutoRefresh(data.checked)}
                label="Auto-refresh"
              />
            </Tooltip>
          )}
          <Button
            appearance="secondary"
            icon={<ArrowSync24Regular />}
            onClick={loadKnowledgeBase}
          >
            Refresh
          </Button>
        </div>
      </div>

      {kb.status === 'in_progress' && (
        <Card className={styles.card}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <Text weight="semibold">{kb.progress?.phase ?? 'Processing'}</Text>
            {kb.progress != null && typeof kb.progress.percentage === 'number' ? (
              (() => {
                const pct = Math.round(kb.progress.percentage * 100) / 100
                return (
                  <Tooltip content={`${kb.progress.phase ?? 'Processing'}: ${pct}%`} relationship="label">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <ProgressBar
                        value={kb.progress.percentage}
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
            {kb.progress?.currentFile && (
              <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
                Processing: {kb.progress.currentFile}
              </Text>
            )}
            <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
              {typeof kb.progress?.totalUnits === 'number' && (
                <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
                  {(() => {
                    const completed = (kb.progress?.units ?? []).filter((u: { status?: string }) => u.status === 'completed').length
                    return (kb.progress?.totalUnits ?? 0) > 0
                      ? `${completed} of ${kb.progress?.totalUnits ?? 0} units`
                      : `${completed} units completed`
                  })()}
                </Text>
              )}
              {(kb.progress?.processedFiles != null || kb.progress?.documentCount != null) && typeof kb.progress?.totalUnits !== 'number' && (
                <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
                  {(() => {
                    const done = kb.progress?.processedFiles ?? kb.progress?.documentCount ?? 0
                    const total = kb.progress?.totalFiles ?? kb.progress?.totalDocuments
                    return total != null ? `${done} of ${total} files` : `${done} files done`
                  })()}
                </Text>
              )}
              {kb.progress?.chunksCreated != null && (
                <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
                  Chunks: {kb.progress.chunksCreated.toLocaleString()}
                </Text>
              )}
              {kb.progress?.vectorsCreated != null && (
                <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
                  Vectors: {kb.progress.vectorsCreated.toLocaleString()}
                </Text>
              )}
            </div>
            <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
              {kb.progress?.estimatedRemainingFormatted && (
                <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
                  ETA: {kb.progress.estimatedRemainingFormatted}
                </Text>
              )}
              {kb.progress?.elapsedFormatted && (
                <Text size={200} style={{ color: 'var(--colorNeutralForeground3)' }}>
                  Elapsed: {kb.progress.elapsedFormatted}
                </Text>
              )}
            </div>
            {Array.isArray(kb.progress?.units) && (kb.progress?.units?.length ?? 0) > 0 && (
              <WorkUnitsTable
                units={kb.progress!.units as Array<{ unitId?: string; status?: string; metrics?: Record<string, unknown> }>}
              />
            )}
          </div>
        </Card>
      )}

      {/* Tabs */}
      <TabList
        selectedValue={activeTab}
        onTabSelect={(_, data) => setActiveTab(data.value as 'overview' | 'playground')}
      >
        <Tab value="overview" icon={<Info24Regular />}>
          Overview
        </Tab>
        <Tab value="playground" icon={<Search24Regular />}>
          Playground
        </Tab>
      </TabList>

      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <>
          {/* Stats Cards — from embedding facet summary (workflow-populated); progress for in-progress */}
          <Card className={styles.card}>
            <CardHeader header={<Text weight="semibold">Statistics</Text>} />
            <div className={styles.statsGrid}>
              <div className={styles.statCard}>
                <span className={styles.statValue}>
                  {embeddingSummary?.documentCount != null
                    ? embeddingSummary.documentCount.toLocaleString()
                    : kb?.status === 'in_progress'
                      ? (() => {
                          const done = kb.progress?.processedFiles ?? kb.progress?.documentCount
                          const total = kb.progress?.totalFiles ?? kb.progress?.totalDocuments
                          if (done != null && total != null) return `${done.toLocaleString()} / ${total.toLocaleString()}`
                          if (done != null) return done.toLocaleString()
                          if (total != null) return `0 / ${total.toLocaleString()}`
                          return '-'
                        })()
                      : '-'}
                </span>
                <span className={styles.statLabel}>Documents</span>
              </div>
              <div className={styles.statCard}>
                <span className={styles.statValue}>
                  {embeddingSummary?.chunkCount != null
                    ? embeddingSummary.chunkCount.toLocaleString()
                    : kb?.status === 'in_progress'
                      ? (kb.progress?.chunksCreated != null ? kb.progress.chunksCreated.toLocaleString() : '-')
                      : (embeddingSummary?.chunkCount ?? '-')}
                </span>
                <span className={styles.statLabel}>Chunks</span>
              </div>
              <div className={styles.statCard}>
                <span className={styles.statValue}>
                  {embeddingSummary?.vectorCount != null
                    ? embeddingSummary.vectorCount.toLocaleString()
                    : kb?.status === 'in_progress'
                      ? (kb.progress?.vectorsCreated != null ? kb.progress.vectorsCreated.toLocaleString() : '-')
                      : (embeddingSummary?.vectorCount ?? '-')}
                </span>
                <span className={styles.statLabel}>Vectors</span>
              </div>
              <div className={styles.statCard}>
                <span className={styles.statValue}>{kb.vectorSize}</span>
                <span className={styles.statLabel}>Dimensions</span>
              </div>
              <div className={styles.statCard}>
                <span className={styles.statValue}>
                  {embeddingSummary?.storageMB != null && embeddingSummary.storageMB > 0
                    ? `${embeddingSummary.storageMB.toFixed(1)} MB`
                    : '-'}
                </span>
                <span className={styles.statLabel}>Storage Size</span>
              </div>
              <div className={styles.statCard}>
                <span className={styles.statValue}>{kb.chunkSize}</span>
                <span className={styles.statLabel}>Chunk Size</span>
              </div>
            </div>
          </Card>

          {/* Configuration */}
          <Card className={styles.card}>
            <CardHeader header={<Text weight="semibold">Configuration</Text>} />
            <div className={styles.configGrid}>
              {/* Embedding Section */}
              <div className={styles.configSection}>
                <div className={styles.sectionTitle}>
                  <DocumentBulletList24Regular />
                  Embedding
                </div>
                <div className={styles.configItem}>
                  <span className={styles.configLabel}>Model</span>
                  <span className={styles.configValue}>
                    {getEmbeddingModelDisplay(kb.embeddingModel)}
                  </span>
                </div>
                <div className={styles.configItem}>
                  <span className={styles.configLabel}>Vector Size</span>
                  <span className={styles.configValue}>{kb.vectorSize} dimensions</span>
                </div>
              </div>

              {/* Chunking Section */}
              <div className={styles.configSection}>
                <div className={styles.sectionTitle}>
                  <DocumentBulletList24Regular />
                  Chunking
                </div>
                <div className={styles.configItem}>
                  <span className={styles.configLabel}>Strategy</span>
                  <span className={styles.configValue}>
                    {getChunkStrategyDisplay(kb.chunkStrategy)}
                  </span>
                </div>
                <div className={styles.configItem}>
                  <span className={styles.configLabel}>Chunk Size</span>
                  <span className={styles.configValue}>{kb.chunkSize} characters</span>
                </div>
                <div className={styles.configItem}>
                  <span className={styles.configLabel}>Overlap</span>
                  <span className={styles.configValue}>{kb.chunkOverlap ?? 50} characters</span>
                </div>
                {kb.chunkOptions && Object.keys(kb.chunkOptions).length > 0 && (
                  <div className={styles.configItem}>
                    <span className={styles.configLabel}>Options</span>
                    <span className={styles.configValue}>
                      {JSON.stringify(kb.chunkOptions)}
                    </span>
                  </div>
                )}
              </div>

              {/* Indexing Section */}
              <div className={styles.configSection}>
                <div className={styles.sectionTitle}>
                  <Search24Regular />
                  Indexing
                </div>
                <div className={styles.configItem}>
                  <span className={styles.configLabel}>Mode</span>
                  <span className={styles.configValue}>
                    {getIndexingModeDisplay(kb.indexingMode)}
                  </span>
                </div>
                <div className={styles.configItem}>
                  <span className={styles.configLabel}>Vector Index</span>
                  <span className={styles.configValue}>
                    {getQuantizationDisplay(kb.quantizationType || 'none')}
                  </span>
                </div>
                {kb.quantizationType === 'ivf_pq' && kb.quantizationOptions && (
                  <>
                    <div className={styles.configItem}>
                      <span className={styles.configLabel}>Partitions</span>
                      <span className={styles.configValue}>
                        {kb.quantizationOptions.numPartitions ?? 256}
                      </span>
                    </div>
                    <div className={styles.configItem}>
                      <span className={styles.configLabel}>Sub-Vectors</span>
                      <span className={styles.configValue}>
                        {kb.quantizationOptions.numSubVectors ?? 96}
                      </span>
                    </div>
                  </>
                )}
                {kb.quantizationType === 'scalar' && kb.quantizationOptions && (
                  <>
                    <div className={styles.configItem}>
                      <span className={styles.configLabel}>ef_construction</span>
                      <span className={styles.configValue}>
                        {kb.quantizationOptions.efConstruction ?? 150}
                      </span>
                    </div>
                    {kb.quantizationOptions.m && (
                      <div className={styles.configItem}>
                        <span className={styles.configLabel}>m (Connectivity)</span>
                        <span className={styles.configValue}>
                          {kb.quantizationOptions.m}
                        </span>
                      </div>
                    )}
                    {kb.quantizationOptions.numPartitions && (
                      <div className={styles.configItem}>
                        <span className={styles.configLabel}>Partitions</span>
                        <span className={styles.configValue}>
                          {kb.quantizationOptions.numPartitions}
                        </span>
                      </div>
                    )}
                  </>
                )}
                {kb.quantizationType === 'ivf_rq' && kb.quantizationOptions && (
                  <>
                    <div className={styles.configItem}>
                      <span className={styles.configLabel}>Bits per Dimension</span>
                      <span className={styles.configValue}>
                        {kb.quantizationOptions.numBits ?? 1}
                      </span>
                    </div>
                    {kb.quantizationOptions.numPartitions && (
                      <div className={styles.configItem}>
                        <span className={styles.configLabel}>Partitions</span>
                        <span className={styles.configValue}>
                          {kb.quantizationOptions.numPartitions}
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Source Section */}
              <div className={styles.configSection}>
                <div className={styles.sectionTitle}>
                  <Info24Regular />
                  Source
                </div>
                <div className={styles.configItem}>
                  <span className={styles.configLabel}>Dataset</span>
                  <span className={styles.configValue}>
                    {dataset?.name || kb.sourceDataset}
                  </span>
                </div>
                {dataset && (
                  <div className={styles.configItem}>
                    <span className={styles.configLabel}>Dataset Type</span>
                    <span className={styles.configValue}>{dataset.kind}</span>
                  </div>
                )}
                {kb.textColumns && (
                  <div className={styles.configItem}>
                    <span className={styles.configLabel}>Text Columns</span>
                    <span className={styles.configValue}>{kb.textColumns}</span>
                  </div>
                )}
                <div className={styles.configItem}>
                  <span className={styles.configLabel}>Created</span>
                  <span className={styles.configValue}>
                    {new Date(kb.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className={styles.configItem}>
                  <span className={styles.configLabel}>Updated</span>
                  <span className={styles.configValue}>
                    {new Date(kb.updatedAt).toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
          </Card>

          {/* Error Message if KB errored */}
          {kb.status === 'errored' && kb.errorMessage && (
            <MessageBar intent="error">
              <MessageBarBody>
                <strong>Processing Error:</strong> {kb.errorMessage}
              </MessageBarBody>
            </MessageBar>
          )}
        </>
      )}

      {/* Playground Tab */}
      {activeTab === 'playground' && (
        <Card className={styles.card}>
          <CardHeader header={<Text weight="semibold">Search Playground</Text>} />
          <div className={styles.playgroundContainer}>
            {/* Search Input */}
            <div className={styles.searchSection}>
              <div className={styles.searchInputRow}>
                <Field label="Search Query" className={styles.searchInput}>
                  <Textarea
                    value={query}
                    onChange={(_, data) => setQuery(data.value)}
                    placeholder="Enter your search query..."
                    rows={2}
                    disabled={searching || kb.status !== 'ready'}
                  />
                </Field>
              </div>

              {/* Parameters */}
              <div className={styles.parametersRow}>
                <Field label="Top K Results" className={styles.parameterField}>
                  <Input
                    type="number"
                    value={topK.toString()}
                    onChange={(_, data) => setTopK(Math.max(1, Math.min(100, parseInt(data.value) || 10)))}
                    min={1}
                    max={100}
                    disabled={searching}
                  />
                </Field>
                <Field label="Min Score (0-1)" className={styles.parameterField}>
                  <Input
                    type="number"
                    value={minScore.toString()}
                    onChange={(_, data) => setMinScore(Math.max(0, Math.min(1, parseFloat(data.value) || 0)))}
                    min={0}
                    max={1}
                    step={0.1}
                    disabled={searching}
                  />
                </Field>
                <Button
                  appearance="primary"
                  icon={searching ? <Spinner size="tiny" /> : <Play24Regular />}
                  onClick={handleSearch}
                  disabled={searching || !query.trim() || kb.status !== 'ready'}
                >
                  {searching ? 'Searching...' : 'Search'}
                </Button>
              </div>

              {/* Advanced options: search mode, reranker, custom model */}
              <Button
                appearance="subtle"
                size="small"
                onClick={() => setShowAdvanced(!showAdvanced)}
                icon={showAdvanced ? <ChevronUp20Regular /> : <ChevronDown20Regular />}
              >
                Advanced (search mode, reranker, custom model)
              </Button>
              {showAdvanced && (
                <div style={{
                  padding: '16px',
                  backgroundColor: tokens.colorNeutralBackground2,
                  borderRadius: '4px',
                  border: `1px solid ${tokens.colorNeutralStroke1}`,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '16px',
                }}
                >
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '24px', alignItems: 'flex-end' }}>
                    <Field label="Search mode" className={styles.parameterField}>
                      <Dropdown
                        placeholder="Auto (from KB)"
                        value={searchMode === '' ? 'Auto (from KB)' : searchMode}
                        selectedOptions={[searchMode || 'auto']}
                        onOptionSelect={(_, data) => setSearchMode((data.optionValue === 'auto' ? '' : data.optionValue) as KBSearchMode | '')}
                        disabled={searching}
                        style={{ minWidth: '160px' }}
                      >
                        <Option value="auto" text="Auto (from KB)">Auto (from KB)</Option>
                        <Option value="vector" text="Vector">Vector</Option>
                        <Option value="fts" text="Full-text (FTS)">Full-text (FTS)</Option>
                        <Option value="hybrid" text="Hybrid (vector + FTS)">Hybrid (vector + FTS)</Option>
                      </Dropdown>
                    </Field>
                    <Field label="Distance metric" className={styles.parameterField}>
                      <Dropdown
                        value={distanceMetric}
                        selectedOptions={[distanceMetric]}
                        onOptionSelect={(_, data) => setDistanceMetric((data.optionValue as 'cosine' | 'l2' | 'dot') || 'cosine')}
                        disabled={searching}
                        style={{ minWidth: '120px' }}
                      >
                        <Option value="cosine" text="Cosine">Cosine</Option>
                        <Option value="l2" text="L2">L2</Option>
                        <Option value="dot" text="Dot">Dot</Option>
                      </Dropdown>
                    </Field>
                    <Field label="Reranker" className={styles.parameterField}>
                      <Dropdown
                        value={rerankerType}
                        selectedOptions={[rerankerType]}
                        onOptionSelect={(_, data) => setRerankerType((data.optionValue as RerankerType) || 'rrf')}
                        disabled={searching}
                        style={{ minWidth: '180px' }}
                      >
                        <Option value="rrf" text="RRF (default)">RRF (default)</Option>
                        <Option value="cross_encoder" text="Cross encoder">Cross encoder</Option>
                        <Option value="cohere" text="Cohere">Cohere</Option>
                        <Option value="linear" text="Linear combination">Linear combination</Option>
                      </Dropdown>
                    </Field>
                    {rerankerType === 'linear' && (
                      <Field label="Vector weight (0–1)" className={styles.parameterField}>
                        <Input
                          type="number"
                          value={linearWeight.toString()}
                          onChange={(_, data) => {
                            const v = parseFloat(data.value)
                            if (!isNaN(v)) setLinearWeight(Math.max(0, Math.min(1, v)))
                          }}
                          min={0}
                          max={1}
                          step={0.1}
                          disabled={searching}
                          style={{ width: '100px' }}
                        />
                      </Field>
                    )}
                    {(rerankerType === 'cross_encoder' || rerankerType === 'cohere') && (
                      <Field
                        label={rerankerType === 'cross_encoder' ? 'Cross-encoder model' : 'Cohere model'}
                        className={styles.parameterField}
                      >
                        <Input
                          placeholder={rerankerType === 'cross_encoder' ? 'e.g. cross-encoder/ms-marco-TinyBERT-L-6' : 'e.g. rerank-english-v2.0'}
                          value={rerankerModel}
                          onChange={(_, data) => setRerankerModel(data.value)}
                          disabled={searching}
                          style={{ minWidth: '240px' }}
                        />
                      </Field>
                    )}
                  </div>
                </div>
              )}

              {/* Compare KBs selector */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <Text size={200} weight="semibold" style={{ color: tokens.colorNeutralForeground3, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Knowledge Bases ({activeKbIds.length}/{MAX_COMPARE_KBS})
                </Text>
                <div className={styles.comparisonBar}>
                  {/* Primary KB chip */}
                  <span className={`${styles.kbChip} ${styles.kbChipPrimary}`}>
                    {kb.name}
                    <Badge size="small" appearance="filled" color="brand">primary</Badge>
                  </span>

                  {/* Comparison KB chips */}
                  {compareKbIds.map((id) => (
                    <span key={id} className={`${styles.kbChip} ${styles.kbChipSecondary}`}>
                      {getKbName(id)}
                      <span
                        className={styles.kbChipRemove}
                        onClick={() => removeCompareKb(id)}
                        title="Remove from comparison"
                      >
                        <Dismiss24Regular style={{ width: '14px', height: '14px' }} />
                      </span>
                    </span>
                  ))}

                  {/* Add comparison KB dropdown */}
                  {compareKbIds.length < MAX_COMPARE_KBS - 1 && availableForComparison.length > 0 && (
                    <Dropdown
                      placeholder="+ Add KB to compare"
                      value=""
                      selectedOptions={[]}
                      onOptionSelect={(_, data) => {
                        if (data.optionValue) addCompareKb(data.optionValue)
                      }}
                      style={{ minWidth: '180px' }}
                    >
                      {availableForComparison.map((k) => (
                        <Option key={k.id} value={k.id} text={k.name}>
                          <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <Text weight="semibold">{k.name}</Text>
                            <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                              {k.embeddingModel} &middot; {k.chunkSize} chunk size
                            </Text>
                          </div>
                        </Option>
                      ))}
                    </Dropdown>
                  )}
                </div>
              </div>

              {kb.status !== 'ready' && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    Search is only available when the knowledge base is fully processed.
                  </MessageBarBody>
                </MessageBar>
              )}
            </div>

            <Divider />

            {/* Results Section */}
            <div className={styles.resultsSection}>
              {searchError && (
                <MessageBar intent="error">
                  <MessageBarBody>{searchError}</MessageBarBody>
                </MessageBar>
              )}

              {comparisonResults.size > 0 && (
                <>
                  {/* Comparison Summary */}
                  {isComparing && (
                    <>
                      <Text weight="semibold" size={400}>Comparison Summary</Text>
                      <div className={styles.summaryGrid} style={{ gridTemplateColumns: `repeat(${activeKbIds.length}, 1fr)` }}>
                        {activeKbIds.map((id, idx) => {
                          const entry = comparisonResults.get(id)
                          const resp = entry?.response
                          const avg = calcAvgRelevance(resp ?? null)
                          const isPrimary = idx === 0

                          return (
                            <div key={id} className={styles.summaryCard}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <Text weight="semibold" truncate style={{ flex: 1 }}>
                                  {getKbName(id)}
                                </Text>
                                {isPrimary && <Badge size="small" appearance="filled" color="brand">primary</Badge>}
                              </div>
                              {entry?.searching && <Spinner size="tiny" label="Searching..." />}
                              {entry?.error && (
                                <Text size={200} style={{ color: tokens.colorPaletteRedForeground1 }}>
                                  {entry.error}
                                </Text>
                              )}
                              {resp && (
                                <>
                                  <div className={styles.summaryRow}>
                                    <Text style={{ color: tokens.colorNeutralForeground3 }}>Results</Text>
                                    <Text weight="semibold">{resp.resultCount}</Text>
                                  </div>
                                  <div className={styles.summaryRow}>
                                    <Text style={{ color: tokens.colorNeutralForeground3 }}>Avg Relevance</Text>
                                    <Text weight="semibold" style={{ color: getScoreColor(avg) }}>
                                      {(avg * 100).toFixed(1)}%
                                    </Text>
                                  </div>
                                  <div className={styles.summaryRow}>
                                    <Text style={{ color: tokens.colorNeutralForeground3 }}>Latency</Text>
                                    <Text weight="semibold">{resp.processingTimeMs.toFixed(2)} ms</Text>
                                  </div>
                                  <div className={styles.summaryRow}>
                                    <Text style={{ color: tokens.colorNeutralForeground3 }}>Top Score</Text>
                                    <Text weight="semibold">
                                      {resp.results.length > 0
                                        ? `${(resp.results[0].score * 100).toFixed(1)}%`
                                        : '-'}
                                    </Text>
                                  </div>
                                  <div className={styles.summaryRow}>
                                    <Text style={{ color: tokens.colorNeutralForeground3 }}>Search Mode</Text>
                                    <Text weight="semibold">{resp.searchMode}</Text>
                                  </div>
                                  {resp.rerankerType != null && resp.rerankerType !== '' && (
                                    <div className={styles.summaryRow}>
                                      <Text style={{ color: tokens.colorNeutralForeground3 }}>Reranker</Text>
                                      <Text weight="semibold">{resp.rerankerType}</Text>
                                    </div>
                                  )}
                                </>
                              )}
                            </div>
                          )
                        })}
                      </div>
                      <Divider />
                    </>
                  )}

                  {/* Result columns */}
                  <div
                    className={styles.columnsContainer}
                    style={{ gridTemplateColumns: `repeat(${activeKbIds.length}, 1fr)` }}
                  >
                    {activeKbIds.map((id, idx) => {
                      const entry = comparisonResults.get(id)
                      const resp = entry?.response
                      const isPrimary = idx === 0
                      const avg = calcAvgRelevance(resp ?? null)

                      return (
                        <div key={id}>
                          {/* Column header */}
                          <div
                            className={`${styles.columnHeader} ${isPrimary ? styles.columnHeaderPrimary : styles.columnHeaderAlt}`}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                              <Text weight="semibold" truncate>{getKbName(id)}</Text>
                              {isPrimary && <Badge size="small" appearance="filled" color="brand">primary</Badge>}
                            </div>
                            {resp && (
                              <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                                {resp.resultCount} results &middot; {(avg * 100).toFixed(0)}% avg
                              </Text>
                            )}
                          </div>

                          {/* Metrics bar (single KB mode only — comparison uses summary) */}
                          {!isComparing && resp && (
                            <div className={styles.metricsBar} style={{ marginBottom: '12px' }}>
                              <div className={styles.metricItem}>
                                <span className={styles.metricValue}>{resp.resultCount}</span>
                                <span className={styles.metricLabel}>Results</span>
                              </div>
                              <div className={styles.metricItem}>
                                <Tooltip content="Query processing time" relationship="label">
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                    <Clock24Regular style={{ width: '16px', height: '16px' }} />
                                    <span className={styles.metricValue}>{resp.processingTimeMs.toFixed(2)}</span>
                                  </div>
                                </Tooltip>
                                <span className={styles.metricLabel}>Latency (ms)</span>
                              </div>
                              <div className={styles.metricItem}>
                                <span className={styles.metricValue}>{(avg * 100).toFixed(1)}%</span>
                                <span className={styles.metricLabel}>Avg Relevance</span>
                              </div>
                              <div className={styles.metricItem}>
                                <span className={styles.metricValue}>{resp.searchMode}</span>
                                <span className={styles.metricLabel}>Search Mode</span>
                              </div>
                              {resp.rerankerType != null && resp.rerankerType !== '' && (
                                <div className={styles.metricItem}>
                                  <span className={styles.metricValue}>{resp.rerankerType}</span>
                                  <span className={styles.metricLabel}>Reranker</span>
                                </div>
                              )}
                            </div>
                          )}

                          {/* Loading */}
                          {entry?.searching && (
                            <div className={styles.emptyResults}>
                              <Spinner size="small" label="Searching..." />
                            </div>
                          )}

                          {/* Error */}
                          {entry?.error && (
                            <MessageBar intent="error" style={{ marginBottom: '8px' }}>
                              <MessageBarBody>{entry.error}</MessageBarBody>
                            </MessageBar>
                          )}

                          {/* Result cards */}
                          {resp && resp.results.length === 0 && (
                            <div className={styles.emptyResults}>
                              <Text>No results found.</Text>
                            </div>
                          )}

                          {resp &&
                            resp.results.map((result, rIdx) => {
                              const documentSource =
                                result.source ||
                                result.metadata?.file_name ||
                                result.metadata?.file_path?.split('/').pop() ||
                                result.metadata?.table_ref ||
                                result.documentId

                              return (
                                <div key={result.id} className={styles.resultCard}>
                                  <div className={styles.resultHeader}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                      <Text weight="semibold">#{rIdx + 1}</Text>
                                      <Badge appearance="outline" size="small" color="informative">
                                        {documentSource}
                                      </Badge>
                                    </div>
                                    <div className={styles.resultScore}>
                                      <div className={styles.scoreBar}>
                                        <div
                                          className={styles.scoreFill}
                                          style={{
                                            width: `${result.score * 100}%`,
                                            backgroundColor: getScoreColor(result.score),
                                          }}
                                        />
                                      </div>
                                      <Text size={200}>{(result.score * 100).toFixed(1)}%</Text>
                                    </div>
                                  </div>
                                  <div className={styles.resultText}>{result.text}</div>
                                  <div className={styles.resultMeta}>
                                    <span>
                                      Chunk {result.chunkIndex + 1}
                                      {result.metadata?.total_chunks
                                        ? ` of ${result.metadata.total_chunks}`
                                        : ''}
                                    </span>
                                    {result.metadata?.file_path &&
                                      result.metadata.file_path !== documentSource &&
                                      (() => {
                                        const filePath = result.metadata.file_path
                                        const fileName = filePath.split('/').pop() || filePath
                                        return result.downloadUrl ? (
                                          <a
                                            href="#"
                                            title={filePath}
                                            onClick={(e) => {
                                              e.preventDefault()
                                              setPreviewFile({ url: result.downloadUrl!, name: fileName })
                                            }}
                                            style={{ color: tokens.colorBrandForeground1, textDecoration: 'none', cursor: 'pointer' }}
                                          >
                                            {fileName}
                                          </a>
                                        ) : (
                                          <span title={filePath}>{fileName}</span>
                                        )
                                      })()}
                                    <span>ID: {result.documentId.slice(0, 12)}...</span>
                                  </div>
                                </div>
                              )
                            })}
                        </div>
                      )
                    })}
                  </div>
                </>
              )}

              {comparisonResults.size === 0 && !searchError && (
                <div className={styles.emptyResults}>
                  <Text>Enter a query and click Search to test retrieval.</Text>
                  {availableForComparison.length > 0 && (
                    <Text size={200} style={{ display: 'block', marginTop: '8px', color: tokens.colorNeutralForeground3 }}>
                      You can add up to {MAX_COMPARE_KBS - 1} additional knowledge bases to compare results side-by-side.
                    </Text>
                  )}
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {previewFile && (
        <FilePreviewModal
          url={previewFile.url}
          fileName={previewFile.name}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  )
}
