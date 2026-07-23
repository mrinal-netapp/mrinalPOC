import { useState, useCallback, useRef, useEffect, useMemo, KeyboardEvent, forwardRef, useImperativeHandle } from 'react'
import {
  makeStyles,
  mergeClasses,
  tokens,
  Spinner,
  Button,
  Text,
  Badge,
  MessageBar,
  MessageBarBody,
  Dropdown,
  Option,
  Input,
  Checkbox,
} from '@fluentui/react-components'
import {
  ChevronRight16Regular,
  ChevronDown16Regular,
  Folder24Regular,
  Document24Regular,
  Database24Regular,
  Table24Regular,
  Column24Regular,
  ArrowClockwise16Regular,
  Dismiss16Regular,
  Server24Regular,
  HardDrive24Regular,
  Storage24Regular,
  Cloud24Regular,
  AppGeneric24Regular,
  History24Regular,
  BuildingMultiple24Regular,
  Search16Regular,
  DataTrending24Regular,
} from '@fluentui/react-icons'
import { explorerApi, ExplorerNode, ExplorerResponse } from '../../services/api'

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  containerStandalone: {
    minHeight: '300px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    padding: '8px 12px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground3,
    flexWrap: 'wrap',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
    minWidth: 0,
  },
  filterInput: {
    minWidth: '160px',
    maxWidth: '220px',
  },
  treeContainer: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    padding: '4px 0',
    outline: 'none',
  },
  node: {
    display: 'flex',
    alignItems: 'center',
    padding: '5px 8px',
    cursor: 'pointer',
    borderRadius: tokens.borderRadiusSmall,
    marginLeft: '4px',
    marginRight: '4px',
    borderLeft: '3px solid transparent',
    '&:hover': {
      backgroundColor: tokens.colorNeutralBackground2,
    },
    '&:focus-visible': {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '-2px',
    },
  },
  nodeSelected: {
    backgroundColor: tokens.colorBrandBackground2,
    borderLeftColor: tokens.colorBrandStroke1,
    '&:hover': {
      backgroundColor: tokens.colorBrandBackground2Hover,
    },
  },
  nodeContent: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flex: 1,
    minWidth: 0,
  },
  nodeIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    flexShrink: 0,
  },
  nodeLabel: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: tokens.fontSizeBase200,
  },
  nodeMeta: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    rowGap: '2px',
    columnGap: '4px',
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    marginLeft: 'auto',
    paddingLeft: '8px',
    flexShrink: 0,
    maxWidth: '48%',
  },
  children: {
    marginLeft: '12px',
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingLeft: '4px',
  },
  emptyMessage: {
    padding: '8px 16px',
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    fontStyle: 'italic',
  },
  errorInline: {
    margin: '4px 8px',
  },
  statusBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 12px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground3,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
})

interface NodeState {
  expanded: boolean
  loading: boolean
  loaded: boolean
  children: ExplorerNode[]
  error?: string
  nextToken?: string
}

interface ConnectorExplorerProps {
  projectId: string
  connectorId: string
  connectorScope?: 'account' | 'resource'
  initialAction?: string
  hasRegionSelector?: boolean
  defaultRegion?: string
  /** NetApp ONTAP: storage icon for root service nodes + product badge in header */
  productTag?: 'ontap'
  onSelectNode?: (node: ExplorerNode) => void
  selectedNodeId?: string
  style?: React.CSSProperties
  /**
   * When true, omits the standalone `minHeight` so the explorer fits a flex
   * parent (e.g. dialog split pane). The tree still scrolls inside this
   * component (`overflow-y: auto` on the tree region) so tall trees stay
   * reachable beside a sibling details column.
   */
  embedded?: boolean
  /** Selection mode: 'single' (default) uses highlight, 'multi' renders checkboxes. */
  selectionMode?: 'single' | 'multi'
  /** Node types eligible for checkbox selection in multi mode. */
  selectableTypes?: string[]
  /** Controlled set of checked node IDs (multi mode). */
  selectedNodeIds?: Set<string>
  /** Fires when a checkbox is toggled in multi mode. */
  onToggleNode?: (node: ExplorerNode) => void
}

const NODE_ICON_MAP: Record<string, React.ComponentType> = {
  folder: Folder24Regular,
  file: Document24Regular,
  schema: Database24Regular,
  table: Table24Regular,
  view: Table24Regular,
  column: Column24Regular,
  service: Cloud24Regular,
  instance: Server24Regular,
  cluster: AppGeneric24Regular,
  storagePool: Storage24Regular,
  volume: HardDrive24Regular,
  resource: Database24Regular,
  /** ONTAP FlexVol */
  svm: BuildingMultiple24Regular,
  /** ONTAP snapshot (child of a volume) */
  snapshot: History24Regular,
  lun: HardDrive24Regular,
  aggregate: Storage24Regular,
  networkInterface: Server24Regular,
  /** Metric category leaf — shown under the unified ONTAP/GCP "Performance Metrics" service. */
  metric_category: DataTrending24Regular,
}

function getNodeIcon(type: string, productTag?: 'ontap') {
  if (productTag === 'ontap' && type === 'service') {
    return <Storage24Regular />
  }
  const IconComponent = NODE_ICON_MAP[type]
  if (IconComponent) return <IconComponent />
  return <Document24Regular />
}

function ontapNfsProtocolBadge(meta: Record<string, unknown> | undefined): string {
  const p = meta?.nfs_protocols as { v3?: boolean; v40?: boolean; v41?: boolean } | undefined
  if (!p) return ''
  const parts: string[] = []
  if (p.v3) parts.push('v3')
  if (p.v41) parts.push('v4.1')
  else if (p.v40) parts.push('v4.0')
  if (parts.length === 0) return ''
  return parts.join('+')
}

function volumeMountDotColor(node: ExplorerNode): 'green' | 'yellow' | 'red' {
  const mp = node.metadata?.mount_preflight as { can_mount?: boolean; blocking?: unknown[] } | undefined
  if (!mp) return 'yellow'
  const blocking = Array.isArray(mp.blocking) ? mp.blocking : []
  if (mp.can_mount === true && blocking.length === 0) return 'green'
  if (blocking.length) return 'red'
  return 'yellow'
}

function svmLifChipTone(meta: Record<string, unknown> | undefined): 'green' | 'yellow' | 'red' {
  const lif = typeof meta?.nfs_data_lif === 'string' && meta.nfs_data_lif.trim()
  if (!lif) return 'red'
  const up = meta?.nfs_data_lif_state === 'up'
  const tcp = meta?.tcp_2049_ok === true
  if (up && tcp) return 'green'
  if (lif) return 'yellow'
  return 'red'
}

function getLifTcpForDisplay(
  node: ExplorerNode,
  overrides: Record<string, { tcp_2049?: Record<string, unknown> }>
): Record<string, unknown> | undefined {
  const o = overrides[node.id]?.tcp_2049
  const base = node.metadata?.tcp_2049 as Record<string, unknown> | undefined
  return (o || base) as Record<string, unknown> | undefined
}

function lifRowTcpDotColor(
  meta: Record<string, unknown> | undefined,
  tcp: Record<string, unknown> | undefined
): 'green' | 'yellow' | 'red' {
  const isData = meta?.is_data_nfs === true
  if (!isData) return 'yellow'
  if (tcp?.ok === true) return 'green'
  if (tcp?.ok === false) return 'red'
  return 'yellow'
}

function formatFileSize(bytes: unknown): string {
  if (typeof bytes !== 'number') return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** Short display for ONTAP snapshot create_time (ISO or API string). */
function formatSnapshotTime(t: unknown): string {
  if (typeof t !== 'string' || !t.trim()) return ''
  const d = Date.parse(t)
  if (!Number.isNaN(d)) {
    try {
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d))
    } catch {
      return t
    }
  }
  return t
}

export interface ConnectorExplorerHandle {
  getVisibleNodes(typeFilter?: string): ExplorerNode[]
}

export const ConnectorExplorer = forwardRef<ConnectorExplorerHandle, ConnectorExplorerProps>(function ConnectorExplorer({
  projectId,
  connectorId,
  connectorScope = 'resource',
  initialAction,
  hasRegionSelector = false,
  defaultRegion,
  productTag,
  onSelectNode,
  selectedNodeId,
  style,
  embedded = false,
  selectionMode = 'single',
  selectableTypes,
  selectedNodeIds,
  onToggleNode,
}, ref) {
  const styles = useStyles()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [filterText, setFilterText] = useState<string>('')
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null)
  /**
   * When set, the next render will programmatically move DOM focus to this
   * node id. Cleared as soon as focus is applied. Only keyboard navigation
   * (arrow keys, Home/End, Enter) sets this — mouse clicks rely on the
   * browser's natural focus behavior, which avoids any scroll side-effects
   * from `el.focus()` while React is mid-rerender from selection state churn.
   */
  const pendingFocusIdRef = useRef<string | null>(null)
  const treeRef = useRef<HTMLDivElement | null>(null)
  const [rootNodes, setRootNodes] = useState<ExplorerNode[]>([])
  const [rootLoading, setRootLoading] = useState(false)
  const [rootError, setRootError] = useState<string | null>(null)
  const [nodeStates, setNodeStates] = useState<Record<string, NodeState>>({})
  const sessionRef = useRef<string | null>(null)
  /** After manual TCP re-probe on a LIF row, merge fresh `tcp_2049` for display. */
  const [lifTcpOverrides, setLifTcpOverrides] = useState<
    Record<string, { tcp_2049?: Record<string, unknown> }>
  >({})
  const [lifProbeBusyId, setLifProbeBusyId] = useState<string | null>(null)
  const [contextPayload, setContextPayload] = useState<Record<string, unknown>>({})
  const [regions, setRegions] = useState<Array<{ id: string; label: string }>>([])
  const [selectedRegion, setSelectedRegion] = useState<string>(defaultRegion || '')
  const [regionsLoading, setRegionsLoading] = useState(false)

  const fetchNodes = useCallback(async (
    sid: string,
    action: string,
    payload: Record<string, unknown> = {},
    opts?: { refresh?: boolean },
  ): Promise<ExplorerResponse | null> => {
    try {
      return await explorerApi.list(sid, action, payload, {
        projectId,
        connectorId,
        refresh: opts?.refresh,
      })
    } catch (err: any) {
      return {
        nodes: [],
        error: {
          code: 'REQUEST_ERROR',
          message: err?.response?.data?.error?.message || err.message || 'Request failed',
        },
      }
    }
  }, [projectId, connectorId])

  const loadRoot = useCallback(async (opts?: { refresh?: boolean; ctx?: Record<string, unknown> }) => {
    const sid = sessionRef.current || `direct-${connectorId}`
    if (!sessionRef.current) {
      sessionRef.current = sid
      setSessionId(sid)
    }

    setRootLoading(true)
    setRootError(null)
    if (opts?.refresh) {
      setNodeStates({})
    }

    const mergedCtx = opts?.ctx ?? contextPayload
    const action = initialAction || (connectorScope === 'account' ? 'listServices' : 'listPath')
    const resp = await fetchNodes(sid, action, { ...mergedCtx }, opts)

    if (resp?.error) {
      setRootError(`${resp.error.code}: ${resp.error.message}`)
      setRootNodes([])
    } else if (resp) {
      setRootNodes(resp.nodes)
    }
    setRootLoading(false)
  }, [connectorId, fetchNodes, initialAction, connectorScope, contextPayload])

  const loadRegions = useCallback(async () => {
    const sid = sessionRef.current || `direct-${connectorId}`
    if (!sessionRef.current) {
      sessionRef.current = sid
      setSessionId(sid)
    }
    setRegionsLoading(true)
    const resp = await fetchNodes(sid, 'listRegions', {})
    if (resp && !resp.error) {
      const regionList = resp.nodes.map((n) => ({ id: n.resource?.region as string || n.label, label: n.label }))
      setRegions(regionList)
      const initial = defaultRegion && regionList.find((r) => r.id === defaultRegion)
        ? defaultRegion
        : regionList[0]?.id || ''
      setSelectedRegion(initial)
      const ctx = { region: initial }
      setContextPayload(ctx)
      setRegionsLoading(false)
      return ctx
    }
    setRegionsLoading(false)
    return {}
  }, [connectorId, fetchNodes, defaultRegion])

  const handleRegionChange = useCallback(async (region: string) => {
    setSelectedRegion(region)
    const ctx = { region }
    setContextPayload(ctx)
    setNodeStates({})
    setRootNodes([])
    const sid = sessionRef.current || `direct-${connectorId}`
    const action = initialAction || 'listServices'
    setRootLoading(true)
    const resp = await fetchNodes(sid, action, { ...ctx })
    if (resp?.error) {
      setRootError(`${resp.error.code}: ${resp.error.message}`)
      setRootNodes([])
    } else if (resp) {
      setRootError(null)
      setRootNodes(resp.nodes)
    }
    setRootLoading(false)
  }, [connectorId, fetchNodes, initialAction])

  useEffect(() => {
    if (hasRegionSelector) {
      loadRegions().then((ctx) => {
        loadRoot({ ctx })
      })
    } else {
      loadRoot()
    }
    return () => {
      sessionRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const getDefaultAction = (node: ExplorerNode): string | null => {
    if (node.actions && node.actions.length > 0) return node.actions[0]
    switch (node.type) {
      case 'database': return 'listSchemas'
      case 'folder': return 'listPath'
      case 'schema': return 'listTables'
      case 'table': case 'view': return 'describeTable'
      case 'service': return 'listResources'
      case 'resource': return 'listPath'
      case 'storagePool': return 'listVolumes'
      case 'cluster': return 'listInstances'
      case 'instance': return 'listDatabases'
      case 'volume': return 'listSnapshots'
      case 'snapshot': return null
      case 'svm': return 'listVolumes'
      default: return null
    }
  }

  const buildPayload = (node: ExplorerNode): Record<string, unknown> => {
    return node.resource ? { ...node.resource } : {}
  }

  const reprobeLifTcp = useCallback(
    async (e: React.MouseEvent, node: ExplorerNode) => {
      e.stopPropagation()
      const addr = node.metadata?.address ?? node.metadata?.ip_address
      if (typeof addr !== 'string' || !addr.trim()) return
      const sid = sessionRef.current
      if (!sid) return
      setLifProbeBusyId(node.id)
      try {
        const resp = await explorerApi.list(
          sid,
          'testNetworkInterfaceReachability',
          { address: addr.trim() },
          { projectId, connectorId, refresh: true }
        )
        const tcp = resp.nodes?.[0]?.metadata?.tcp_2049 as Record<string, unknown> | undefined
        if (tcp) {
          setLifTcpOverrides((prev) => ({ ...prev, [node.id]: { tcp_2049: tcp } }))
        }
      } finally {
        setLifProbeBusyId(null)
      }
    },
    [projectId, connectorId]
  )

  const toggleNode = useCallback(async (node: ExplorerNode) => {
    const existing = nodeStates[node.id]

    if (existing?.expanded) {
      setNodeStates((prev) => ({
        ...prev,
        [node.id]: { ...prev[node.id], expanded: false },
      }))
      return
    }

    if (existing?.loaded) {
      setNodeStates((prev) => ({
        ...prev,
        [node.id]: { ...prev[node.id], expanded: true },
      }))
      return
    }

    const action = getDefaultAction(node)
    if (!action) return

    setNodeStates((prev) => ({
      ...prev,
      [node.id]: {
        expanded: true,
        loading: true,
        loaded: false,
        children: [],
      },
    }))

    const sid = sessionRef.current
    if (!sid) return

    const payload = { ...contextPayload, ...buildPayload(node) }

    if (productTag === 'ontap' && node.type === 'svm') {
      const [volResp, lifResp] = await Promise.all([
        fetchNodes(sid, 'listVolumes', payload),
        fetchNodes(sid, 'listSvmInterfaces', payload).catch(() => ({ nodes: [] as ExplorerNode[], error: undefined })),
      ])
      const ifaces = (lifResp?.nodes || []).map((n) => ({
        ...n,
        label: n.label?.startsWith('LIF') ? n.label : `LIF · ${n.label}`,
      }))
      const vols = volResp?.nodes || []
      const err = volResp?.error || lifResp?.error
      const mergedChildren = [...ifaces, ...vols]
      setNodeStates((prev) => ({
        ...prev,
        [node.id]: {
          expanded: true,
          loading: false,
          loaded: true,
          children: mergedChildren,
          error: err ? `${err.code}: ${err.message}` : undefined,
          nextToken: volResp?.nextToken,
        },
      }))
      return
    }

    const resp = await fetchNodes(sid, action, payload)
    setNodeStates((prev) => ({
      ...prev,
      [node.id]: {
        expanded: true,
        loading: false,
        loaded: true,
        children: resp?.nodes || [],
        error: resp?.error ? `${resp.error.code}: ${resp.error.message}` : undefined,
        nextToken: resp?.nextToken,
      },
    }))
  }, [nodeStates, fetchNodes, contextPayload, productTag])

  const handleSelect = useCallback((node: ExplorerNode) => {
    onSelectNode?.(node)
    setFocusedNodeId(node.id)
  }, [onSelectNode])

  /** Visible root nodes after applying the (case-insensitive) filter. */
  const visibleRootNodes = useMemo(() => {
    const q = filterText.trim().toLowerCase()
    if (!q) return rootNodes
    return rootNodes.filter((n) => n.label?.toLowerCase().includes(q))
  }, [rootNodes, filterText])

  /**
   * Flat ordered list of currently-visible nodes (root + expanded descendants).
   * Drives keyboard navigation and "where am I" focus tracking.
   */
  const flatVisibleNodes = useMemo(() => {
    const out: { node: ExplorerNode; level: number; parentId: string | null }[] = []
    const walk = (nodes: ExplorerNode[], level: number, parentId: string | null) => {
      for (const n of nodes) {
        out.push({ node: n, level, parentId })
        const st = nodeStates[n.id]
        if (st?.expanded && st.children?.length) {
          walk(st.children, level + 1, n.id)
        }
      }
    }
    walk(visibleRootNodes, 0, null)
    return out
  }, [visibleRootNodes, nodeStates])

  useImperativeHandle(ref, () => ({
    getVisibleNodes(typeFilter?: string): ExplorerNode[] {
      return flatVisibleNodes
        .filter((x) => !typeFilter || x.node.type === typeFilter)
        .map((x) => x.node)
    },
  }), [flatVisibleNodes])

  const handleTreeKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (flatVisibleNodes.length === 0) return
      const idx = flatVisibleNodes.findIndex((x) => x.node.id === focusedNodeId)
      const current = idx >= 0 ? flatVisibleNodes[idx] : null

      const requestFocus = (id: string) => {
        pendingFocusIdRef.current = id
        setFocusedNodeId(id)
      }

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault()
          const next = idx < 0 ? 0 : Math.min(idx + 1, flatVisibleNodes.length - 1)
          requestFocus(flatVisibleNodes[next].node.id)
          break
        }
        case 'ArrowUp': {
          e.preventDefault()
          const prev = idx <= 0 ? 0 : idx - 1
          requestFocus(flatVisibleNodes[prev].node.id)
          break
        }
        case 'ArrowRight': {
          if (!current) return
          e.preventDefault()
          const st = nodeStates[current.node.id]
          const isLeaf = current.node.childrenHint === 'leaf' || !getDefaultAction(current.node)
          if (isLeaf) return
          if (!st?.expanded) {
            toggleNode(current.node)
          } else if (st.children?.length) {
            requestFocus(st.children[0].id)
          }
          break
        }
        case 'ArrowLeft': {
          if (!current) return
          e.preventDefault()
          const st = nodeStates[current.node.id]
          if (st?.expanded) {
            toggleNode(current.node)
          } else if (current.parentId) {
            requestFocus(current.parentId)
          }
          break
        }
        case 'Enter':
        case ' ': {
          if (!current) return
          e.preventDefault()
          handleSelect(current.node)
          const isLeaf = current.node.childrenHint === 'leaf' || !getDefaultAction(current.node)
          if (!isLeaf) toggleNode(current.node)
          break
        }
        case 'Home': {
          e.preventDefault()
          requestFocus(flatVisibleNodes[0].node.id)
          break
        }
        case 'End': {
          e.preventDefault()
          requestFocus(flatVisibleNodes[flatVisibleNodes.length - 1].node.id)
          break
        }
      }
    },
    [flatVisibleNodes, focusedNodeId, nodeStates, toggleNode, handleSelect]
  )

  const renderNode = (node: ExplorerNode, level: number) => {
    const state = nodeStates[node.id]
    const isExpanded = state?.expanded || false
    const isLoading = state?.loading || false
    const isLeaf = node.childrenHint === 'leaf' || (!getDefaultAction(node))
    const isSelected = selectedNodeId === node.id
    const isFocused = focusedNodeId === node.id

    return (
      <div
        key={node.id}
        role="treeitem"
        aria-expanded={isLeaf ? undefined : isExpanded}
        aria-level={level + 1}
        aria-selected={isSelected}
        aria-label={node.label}
      >
        <div
          className={mergeClasses(styles.node, isSelected && styles.nodeSelected)}
          style={{ paddingLeft: `${level * 16 + 8}px` }}
          tabIndex={isFocused ? 0 : -1}
          ref={(el) => {
            // Only move DOM focus when keyboard navigation explicitly asked
            // for it (pendingFocusIdRef is set by Arrow/Home/End/Enter
            // handlers). Mouse clicks intentionally do NOT trigger this —
            // the browser already focuses the clicked element, and a manual
            // el.focus() during a React re-render driven by parent state
            // churn (e.g. updating formData.resourceSelector) is exactly
            // what was causing the tree to scroll back to the previously
            // focused row when toggling selection further down the list.
            if (!el) return
            if (pendingFocusIdRef.current !== node.id) return
            pendingFocusIdRef.current = null
            el.focus({ preventScroll: true })
          }}
          onClick={() => {
            handleSelect(node)
            if (!isLeaf) {
              toggleNode(node)
            }
          }}
        >
          <div className={styles.nodeIcon}>
            {isLeaf ? (
              <div style={{ width: '16px' }} />
            ) : isLoading ? (
              <Spinner size="tiny" style={{ width: '16px', height: '16px' }} />
            ) : isExpanded ? (
              <ChevronDown16Regular />
            ) : (
              <ChevronRight16Regular />
            )}
          </div>
          {selectionMode === 'multi' && selectableTypes?.includes(node.type) && (
            <Checkbox
              checked={selectedNodeIds?.has(node.id) ?? false}
              onChange={(e) => {
                e.stopPropagation()
                onToggleNode?.(node)
              }}
              onClick={(e) => e.stopPropagation()}
              style={{ marginRight: '2px' }}
            />
          )}
          <div className={styles.nodeContent}>
            <div className={styles.nodeIcon}>{getNodeIcon(node.type, productTag)}</div>
            {productTag === 'ontap' && node.type === 'volume' && (
              <span
                title={(() => {
                  const mp = node.metadata?.mount_preflight as { blocking?: string[] } | undefined
                  const b = mp?.blocking
                  return Array.isArray(b) && b.length ? b.join('; ') : 'NFS mount preflight'
                })()}
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor:
                    volumeMountDotColor(node) === 'green'
                      ? tokens.colorPaletteGreenBackground3
                      : volumeMountDotColor(node) === 'red'
                        ? tokens.colorPaletteRedBackground3
                        : tokens.colorPaletteYellowBackground3,
                  flexShrink: 0,
                }}
              />
            )}
            <div className={styles.nodeLabel}>
              {node.label}
            </div>
            {productTag === 'ontap' && node.type === 'svm' && node.metadata && (
              <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' }}>
                {typeof node.metadata.nfs_data_lif === 'string' && node.metadata.nfs_data_lif ? (
                  <Badge
                    appearance="outline"
                    size="small"
                    color={
                      svmLifChipTone(node.metadata as Record<string, unknown>) === 'green'
                        ? 'success'
                        : svmLifChipTone(node.metadata as Record<string, unknown>) === 'red'
                          ? 'danger'
                          : 'warning'
                    }
                  >
                    NFS LIF: {node.metadata.nfs_data_lif}
                  </Badge>
                ) : (
                  <Badge appearance="outline" color="danger" size="small">
                    No data NFS LIF
                  </Badge>
                )}
                {ontapNfsProtocolBadge(node.metadata as Record<string, unknown>) ? (
                  <Badge appearance="outline" size="small" color="informative">
                    {ontapNfsProtocolBadge(node.metadata as Record<string, unknown>)}
                  </Badge>
                ) : null}
              </div>
            )}
          </div>
          <div className={styles.nodeMeta}>
            {node.kind ? (
              <Badge appearance="outline" size="small" color="informative" style={{ marginRight: '6px' }}>
                {node.kind}
              </Badge>
            ) : null}
            {node.type === 'snapshot' && !node.kind ? (
              <Badge appearance="outline" size="small" color="subtle" style={{ marginRight: '6px' }}>
                Snapshot
              </Badge>
            ) : null}
            {node.type === 'snapshot' && node.metadata?.create_time != null ? (
              <span title="Snapshot create time">{formatSnapshotTime(node.metadata.create_time)}</span>
            ) : null}
            {node.metadata?.size !== undefined && typeof node.metadata.size === 'number' ? (
              <span>
                {node.type === 'snapshot' && node.metadata?.create_time != null ? ' · ' : ''}
                {formatFileSize(node.metadata.size)}
              </span>
            ) : null}
            {node.metadata?.dataType ? (
              <span style={{ marginLeft: '4px' }}>{String(node.metadata.dataType)}</span>
            ) : null}
            {node.type === 'volume' && typeof node.metadata?.junction_path === 'string' && node.metadata.junction_path ? (
              <span title="NAS junction path" style={{ marginLeft: '6px', maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {node.metadata.junction_path}
              </span>
            ) : null}
            {node.type === 'volume' && typeof node.metadata?.nfs_data_lif === 'string' && node.metadata.nfs_data_lif ? (
              <span
                title={typeof node.metadata?.nfs_data_lif_name === 'string' ? `NFS data LIF: ${node.metadata.nfs_data_lif_name}` : 'NFS data LIF (from ONTAP REST)'}
                style={{ marginLeft: '6px', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis' }}
              >
                · NFS {node.metadata.nfs_data_lif}
              </span>
            ) : null}
            {productTag === 'ontap' && node.type === 'networkInterface' && node.metadata && (
              <span
                style={{
                  marginLeft: '6px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  flexWrap: 'wrap',
                  maxWidth: '420px',
                }}
              >
                {(() => {
                  const meta = node.metadata as Record<string, unknown>
                  const tcp = getLifTcpForDisplay(node, lifTcpOverrides)
                  const dot =
                    lifRowTcpDotColor(meta, tcp) === 'green'
                      ? tokens.colorPaletteGreenBackground3
                      : lifRowTcpDotColor(meta, tcp) === 'red'
                        ? tokens.colorPaletteRedBackground3
                        : tokens.colorPaletteYellowBackground3
                  const addr = typeof meta.address === 'string' ? meta.address : meta.ip_address
                  const svc = Array.isArray(meta.services) ? meta.services.join(', ') : ''
                  const probeHint =
                    typeof tcp?.error === 'string'
                      ? tcp.error
                      : tcp?.ok === true
                        ? 'TCP 2049 reachable (connector worker)'
                        : 'TCP 2049'
                  return (
                    <>
                      <span
                        title={probeHint}
                        style={{
                          width: '8px',
                          height: '8px',
                          borderRadius: '50%',
                          backgroundColor: dot,
                          flexShrink: 0,
                        }}
                      />
                      {typeof addr === 'string' && addr ? (
                        <Text size={100} style={{ fontFamily: 'monospace' }}>
                          {addr}
                        </Text>
                      ) : null}
                      {svc ? (
                        <Text size={100} title="Advertised services">
                          {svc}
                        </Text>
                      ) : null}
                      {typeof meta.state === 'string' ? (
                        <Badge appearance="outline" size="small">
                          {meta.state}
                        </Badge>
                      ) : null}
                      <Button
                        size="small"
                        appearance="subtle"
                        disabled={lifProbeBusyId === node.id || typeof addr !== 'string'}
                        onClick={(e) => reprobeLifTcp(e, node)}
                      >
                        {lifProbeBusyId === node.id ? '…' : 'Re-probe'}
                      </Button>
                    </>
                  )
                })()}
              </span>
            )}
          </div>
        </div>

        {state?.error && (
          <div className={styles.errorInline}>
            <MessageBar intent="error" style={{ marginLeft: `${level * 16 + 24}px` }}>
              <MessageBarBody>{state.error}</MessageBarBody>
            </MessageBar>
          </div>
        )}

        {isExpanded && !isLeaf && (
          <div className={styles.children}>
            {isLoading && (
              <div className={styles.emptyMessage} style={{ paddingLeft: `${(level + 1) * 16}px` }}>
                Loading...
              </div>
            )}
            {!isLoading && state?.loaded && state.children.length === 0 && !state.error && (
              <div className={styles.emptyMessage} style={{ paddingLeft: `${(level + 1) * 16}px` }}>
                Empty
              </div>
            )}
            {!isLoading && state?.children?.map((child) => renderNode(child, level + 1))}
          </div>
        )}
      </div>
    )
  }

  const visibleCount = visibleRootNodes.length
  const totalCount = rootNodes.length
  const filtered = filterText.trim().length > 0
  const itemLabel = visibleCount === 1 ? 'item' : 'items'

  return (
    <div
      className={mergeClasses(styles.container, !embedded && styles.containerStandalone)}
      style={style}
    >
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Text size={200} weight="semibold">Explorer</Text>
          {productTag === 'ontap' && (
            <>
              <Storage24Regular style={{ width: 20, height: 20, color: tokens.colorPaletteGreenForeground1 }} />
              <Badge appearance="outline" size="small" color="brand">
                NetApp ONTAP
              </Badge>
            </>
          )}
          {hasRegionSelector && (
            regionsLoading ? (
              <Spinner size="tiny" />
            ) : (
              <Dropdown
                size="small"
                placeholder="Choose region"
                value={selectedRegion || ''}
                style={{ minWidth: '140px', maxWidth: 'min(220px, 40vw)' }}
                onOptionSelect={(_, data) => {
                  if (data.optionValue) handleRegionChange(data.optionValue)
                }}
              >
                {regions.map((r) => (
                  <Option key={r.id} value={r.id}>{r.label}</Option>
                ))}
              </Dropdown>
            )
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Input
            size="small"
            className={styles.filterInput}
            placeholder="Filter by name…"
            value={filterText}
            onChange={(_, data) => setFilterText(data.value)}
            contentBefore={<Search16Regular />}
            contentAfter={
              filterText ? (
                <Button
                  size="small"
                  appearance="transparent"
                  icon={<Dismiss16Regular />}
                  aria-label="Clear filter"
                  onClick={() => setFilterText('')}
                />
              ) : undefined
            }
            aria-label="Filter explorer items"
          />
          <Button
            appearance="subtle"
            size="small"
            icon={<ArrowClockwise16Regular />}
            onClick={() => loadRoot({ refresh: true })}
            title="Refresh (reload from source, clear cache)"
            aria-label="Refresh"
          />
          {sessionId && (
            <Button
              appearance="subtle"
              size="small"
              icon={<Dismiss16Regular />}
              onClick={() => {
                sessionRef.current = null
                setSessionId(null)
                setRootNodes([])
                setNodeStates({})
              }}
              title="Close session"
              aria-label="Close session"
            />
          )}
        </div>
      </div>

      <div
        ref={treeRef}
        className={styles.treeContainer}
        role="tree"
        aria-label="Connector explorer"
        tabIndex={focusedNodeId ? -1 : 0}
        onKeyDown={handleTreeKeyDown}
        onFocus={() => {
          if (!focusedNodeId && flatVisibleNodes[0]) {
            setFocusedNodeId(flatVisibleNodes[0].node.id)
          }
        }}
      >
        {rootLoading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '16px' }}>
            <Spinner size="tiny" />
            <Text size={200}>Loading...</Text>
          </div>
        )}
        {rootError && (
          <div style={{ padding: '8px' }}>
            <MessageBar intent="error">
              <MessageBarBody>{rootError}</MessageBarBody>
            </MessageBar>
            <Button
              appearance="secondary"
              size="small"
              icon={<ArrowClockwise16Regular />}
              onClick={() => loadRoot()}
              style={{ marginTop: '8px' }}
            >
              Retry
            </Button>
          </div>
        )}
        {!rootLoading && !rootError && rootNodes.length === 0 && sessionId && (
          <div className={styles.emptyMessage}>No items found</div>
        )}
        {!rootLoading && filtered && rootNodes.length > 0 && visibleCount === 0 && (
          <div className={styles.emptyMessage}>No items match "{filterText.trim()}"</div>
        )}
        {!rootLoading && visibleRootNodes.map((node) => renderNode(node, 0))}
      </div>

      <div className={styles.statusBar}>
        <span>
          {sessionId ? `Session: ${sessionId.split('-').pop()}` : 'No session'}
        </span>
        <span>
          {filtered
            ? `${visibleCount} of ${totalCount} ${itemLabel}`
            : `${totalCount} ${totalCount === 1 ? 'item' : 'items'}`}
        </span>
      </div>
    </div>
  )
})
