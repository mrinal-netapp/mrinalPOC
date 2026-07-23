import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import ReactFlow, { Controls, Background, MiniMap, ReactFlowProvider } from 'reactflow'
import 'reactflow/dist/style.css'
import {
  MessageBar,
  MessageBarBody,
  MessageBarActions,
  Button,
  ToggleButton,
  Spinner,
  Text,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components'
import { ArrowSync24Regular } from '@fluentui/react-icons'
import { lineageApi, type Facet } from '../services/api'
import {
  layoutGraph,
  LINEAGE_NODE_TYPE,
  OVERFLOW_NODE_TYPE,
  ORPHAN_PLACEHOLDER_TYPE,
  type LineageGraphData,
} from '../components/lineage/layoutGraph'
import {
  LineageNodeComponent,
  ColumnHeaderNode,
  OverflowNode,
  OrphanPlaceholderNode,
} from '../components/lineage/LineageNode'
import { useLineageHighlight } from '../components/lineage/useLineageHighlight'
import { KIND_MAP, COLUMN_ORDER } from '../components/lineage/constants'

const useStyles = makeStyles({
  container: {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 16px',
    gap: '12px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    flexShrink: 0,
    flexWrap: 'wrap',
  },
  toolbarLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  toolbarMiddle: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'wrap',
    flex: 1,
    justifyContent: 'center',
    minWidth: 0,
  },
  filterLabel: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    marginRight: '4px',
  },
  toggleChip: {
    minWidth: 'unset',
  },
  freshness: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  canvas: {
    flex: 1,
  },
  centerMessage: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: '16px',
    color: tokens.colorNeutralForeground3,
  },
  summaryBadges: {
    display: 'flex',
    gap: '12px',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  badge: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '6px 12px',
    borderRadius: '6px',
    backgroundColor: tokens.colorNeutralBackground3,
    fontSize: tokens.fontSizeBase200,
  },
})

const nodeTypes = {
  [LINEAGE_NODE_TYPE]: LineageNodeComponent,
  columnHeader: ColumnHeaderNode,
  [OVERFLOW_NODE_TYPE]: OverflowNode,
  [ORPHAN_PLACEHOLDER_TYPE]: OrphanPlaceholderNode,
}

// Credentials always render inline as a key icon on parent entities, so they
// don't appear in the column toggles.
const TOGGLEABLE_KINDS = COLUMN_ORDER.filter((k) => k !== 'credential')

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function ProjectLineageInner() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const styles = useStyles()

  const [facet, setFacet] = useState<Facet | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(() => new Set())

  const fetchGraph = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    setError(null)
    try {
      const result = await lineageApi.getGraph(projectId)
      setFacet(result)
    } catch (err: any) {
      setError(err?.message || 'Failed to load lineage graph')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    fetchGraph()
  }, [fetchGraph])

  // Auto-refresh when facet doesn't exist yet (404 → null)
  useEffect(() => {
    if (!loading && !error && facet === null) {
      const timer = setTimeout(fetchGraph, 30000)
      return () => clearTimeout(timer)
    }
  }, [loading, error, facet, fetchGraph])

  const graph = facet?.summary as LineageGraphData | undefined

  const toggleKind = useCallback((kind: string) => {
    setHiddenKinds((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }, [])

  const { nodes: baseNodes, edges: baseEdges } = useMemo(() => {
    if (!graph || !graph.nodes || graph.truncated) return { nodes: [], edges: [] }
    return layoutGraph(graph, { hiddenKinds, inlineCredentials: true })
  }, [graph, hiddenKinds])

  const { nodes, edges, onNodeClick: onHighlightToggle, clearHighlight } =
    useLineageHighlight(baseNodes, baseEdges)

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: { id: string; type?: string; data?: { kind?: string; entityId?: string } }) => {
      onHighlightToggle(node as any)
    },
    [onHighlightToggle],
  )

  const handleNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: { id: string; type?: string; data?: { kind?: string; entityId?: string } }) => {
      if (!projectId || !node.data?.kind) return
      // Only real entity nodes navigate. Headers, overflow, and orphan
      // summaries are visual only — double-clicking them would route to a
      // non-existent id like `overflow-agent` and 404.
      if (node.type !== LINEAGE_NODE_TYPE) return
      const entry = KIND_MAP[node.data.kind]
      if (!entry?.guiRoute) return
      const entityId = node.data.entityId || node.id
      navigate(`/projects/${projectId}/${entry.guiRoute}/${entityId}`)
    },
    [projectId, navigate],
  )

  // Loading state
  if (loading) {
    return (
      <div className={styles.centerMessage}>
        <Spinner size="large" />
        <Text>Loading lineage graph...</Text>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className={styles.centerMessage}>
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
          <MessageBarActions>
            <Button appearance="transparent" icon={<ArrowSync24Regular />} onClick={fetchGraph}>
              Retry
            </Button>
          </MessageBarActions>
        </MessageBar>
      </div>
    )
  }

  // Not yet computed (404)
  if (!facet) {
    return (
      <div className={styles.centerMessage}>
        <Text size={400} weight="semibold">Lineage graph will be available shortly</Text>
        <Text size={300}>The dependency graph is computed every few minutes. This page will auto-refresh.</Text>
        <Spinner size="small" />
      </div>
    )
  }

  // Empty graph: no connected nodes AND no orphan entities to show.
  // Credentials don't count as orphans here because they render inline.
  const orphanTotal = graph
    ? Object.entries(graph.counts.unconnectedByKind ?? {})
        .filter(([kind]) => kind !== 'credential')
        .reduce((sum, [, count]) => sum + count, 0)
    : 0
  if (!graph || (graph.counts.nodeCount === 0 && orphanTotal === 0)) {
    return (
      <div className={styles.centerMessage}>
        <Text size={400} weight="semibold">No entity relationships found</Text>
        <Text size={300}>Create entities and connect them to see the dependency lineage here.</Text>
      </div>
    )
  }

  // Truncated (too large)
  if (graph.truncated) {
    return (
      <div className={styles.centerMessage}>
        <Text size={400} weight="semibold">Graph too large for interactive view</Text>
        <Text size={300}>{graph.counts.nodeCount} entities and {graph.counts.edgeCount} relationships</Text>
        <div className={styles.summaryBadges}>
          {COLUMN_ORDER.filter((k) => (graph.counts.byKind[k] ?? 0) > 0).map((kind) => {
            const entry = KIND_MAP[kind]
            const Icon = entry?.icon
            return (
              <div key={kind} className={styles.badge}>
                {Icon && <Icon />}
                <span>{entry?.pluralLabel}: {graph.counts.byKind[kind]}</span>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // Full interactive graph
  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <Text weight="semibold" size={400}>Lineage</Text>
          <Text className={styles.freshness}>
            Updated {formatRelativeTime(facet.lastUpdated)}
          </Text>
        </div>
        <div className={styles.toolbarMiddle} role="group" aria-label="Filter entity types">
          <Text className={styles.filterLabel}>Show:</Text>
          {TOGGLEABLE_KINDS.map((kind) => {
            const entry = KIND_MAP[kind]
            if (!entry) return null
            const Icon = entry.icon
            const checked = !hiddenKinds.has(kind)
            const count = graph.counts.byKind[kind] ?? 0
            const orphans = graph.counts.unconnectedByKind?.[kind] ?? 0
            const total = count + orphans
            return (
              <Tooltip
                key={kind}
                relationship="label"
                content={`${checked ? 'Hide' : 'Show'} ${entry.pluralLabel}${total > 0 ? ` (${total})` : ''}`}
                withArrow
              >
                <ToggleButton
                  size="small"
                  appearance="subtle"
                  checked={checked}
                  icon={<Icon />}
                  onClick={() => toggleKind(kind)}
                  className={styles.toggleChip}
                  aria-pressed={checked}
                  aria-label={entry.pluralLabel}
                >
                  {entry.pluralLabel}
                </ToggleButton>
              </Tooltip>
            )
          })}
        </div>
        <Button appearance="subtle" icon={<ArrowSync24Regular />} onClick={fetchGraph}>
          Refresh
        </Button>
      </div>
      <div className={styles.canvas}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={handleNodeDoubleClick}
          onPaneClick={clearHighlight}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.2}
          maxZoom={2}
          deleteKeyCode={null}
          nodesConnectable={false}
          nodesDraggable={false}
        >
          <Background />
          <Controls showInteractive={false} />
          <MiniMap
            nodeColor={(node) => {
              const kind = node.data?.kind as string
              return KIND_MAP[kind]?.color ?? '#999'
            }}
            style={{ backgroundColor: 'var(--colorNeutralBackground2, #f5f5f5)' }}
          />
        </ReactFlow>
      </div>
    </div>
  )
}

export default function ProjectLineage() {
  return (
    <ReactFlowProvider>
      <ProjectLineageInner />
    </ReactFlowProvider>
  )
}
