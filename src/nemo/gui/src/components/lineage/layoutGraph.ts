import type { Node, Edge } from 'reactflow'
import { tokens } from '@fluentui/react-components'
import {
  COLUMN_ORDER,
  COLUMN_WIDTH,
  ROW_HEIGHT,
  HEADER_HEIGHT,
  MAX_NODES_PER_COLUMN,
  KIND_MAP,
} from './constants'

export interface LineageGraphData {
  nodes: Array<{ id: string; name: string; kind: string }>
  edges: Array<{
    sourceType: string
    sourceId: string
    targetType: string
    targetId: string
    relation: string
  }>
  counts: {
    nodeCount: number
    edgeCount: number
    byKind: Record<string, number>
    unconnectedByKind?: Record<string, number>
  }
  truncated: boolean
}

const COLUMN_HEADER_TYPE = 'columnHeader'
export const LINEAGE_NODE_TYPE = 'lineageNode'
export const OVERFLOW_NODE_TYPE = 'overflowNode'
export const ORPHAN_PLACEHOLDER_TYPE = 'orphanPlaceholderNode'

export interface CredentialRef {
  id: string
  name: string
}

export interface LayoutOptions {
  hiddenKinds?: Set<string>
  /** Render credentials as inline key icons on parent entities instead of as nodes. */
  inlineCredentials?: boolean
}

const BARYCENTER_PASSES = 8

type RawNode = LineageGraphData['nodes'][number]

/**
 * Convert a LineageGraph payload into React Flow nodes and edges with
 * column-based positioning. Within-column order uses a barycenter heuristic
 * (Sugiyama-style) to reduce edge crossings.
 */
export function layoutGraph(
  graph: LineageGraphData,
  opts: LayoutOptions = {},
): { nodes: Node[]; edges: Edge[] } {
  const hidden = opts.hiddenKinds ?? new Set<string>()
  const inlineCreds = opts.inlineCredentials ?? true

  // Credentials are treated as hidden columns when shown inline.
  const effectiveHidden = new Set(hidden)
  if (inlineCreds) effectiveHidden.add('credential')

  // Build credential lookup so we can attach them to parent entities.
  const credentialNames = new Map<string, string>()
  if (inlineCreds) {
    for (const node of graph.nodes) {
      if (node.kind === 'credential') credentialNames.set(node.id, node.name)
    }
  }

  // For each non-credential entity, collect the credentials it references.
  const nodeCredentials = new Map<string, CredentialRef[]>()
  if (inlineCreds) {
    for (const edge of graph.edges) {
      if (edge.targetType === 'credential' && credentialNames.has(edge.targetId)) {
        const list = nodeCredentials.get(edge.sourceId) ?? []
        if (!list.some((c) => c.id === edge.targetId)) {
          list.push({ id: edge.targetId, name: credentialNames.get(edge.targetId)! })
        }
        nodeCredentials.set(edge.sourceId, list)
      }
    }
  }

  const visibleKinds = COLUMN_ORDER.filter((k) => !effectiveHidden.has(k))
  const columnIndex = new Map<string, number>()
  visibleKinds.forEach((kind, i) => columnIndex.set(kind, i))

  // Group entity nodes by kind, skipping hidden kinds.
  const byKind = new Map<string, RawNode[]>()
  for (const node of graph.nodes) {
    if (effectiveHidden.has(node.kind)) continue
    const list = byKind.get(node.kind) ?? []
    list.push(node)
    byKind.set(node.kind, list)
  }

  const orphanCounts = graph.counts.unconnectedByKind ?? {}

  // Reorder within each column to minimize edge crossings.
  const ordered = barycenterOrder(byKind, graph.edges, visibleKinds, effectiveHidden)

  const rfNodes: Node[] = []

  // Column headers — only for kinds that have content or orphans to show.
  for (const kind of visibleKinds) {
    const colIdx = columnIndex.get(kind)!
    const entry = KIND_MAP[kind]
    if (!entry) continue
    const items = ordered.get(kind) ?? []
    const orphans = orphanCounts[kind] ?? 0
    if (items.length === 0 && orphans === 0) continue

    rfNodes.push({
      id: `header-${kind}`,
      type: COLUMN_HEADER_TYPE,
      position: { x: colIdx * COLUMN_WIDTH, y: 0 },
      data: { label: entry.pluralLabel, count: items.length + orphans },
      draggable: false,
      selectable: false,
    })
  }

  // Entity, overflow, and orphan-summary nodes.
  for (const kind of visibleKinds) {
    const colIdx = columnIndex.get(kind)!
    const items = ordered.get(kind) ?? []
    const orphans = orphanCounts[kind] ?? 0
    const visibleCount = Math.min(items.length, MAX_NODES_PER_COLUMN - 1)
    const hasOverflow = items.length > MAX_NODES_PER_COLUMN - 1

    for (let row = 0; row < visibleCount; row++) {
      const node = items[row]
      rfNodes.push({
        id: node.id,
        type: LINEAGE_NODE_TYPE,
        position: {
          x: colIdx * COLUMN_WIDTH,
          y: HEADER_HEIGHT + (row + 1) * ROW_HEIGHT,
        },
        data: {
          label: node.name,
          kind: node.kind,
          entityId: node.id,
          credentials: nodeCredentials.get(node.id) ?? [],
        },
      })
    }

    let nextRow = visibleCount

    if (hasOverflow) {
      const remaining = items.length - visibleCount
      rfNodes.push({
        id: `overflow-${kind}`,
        type: OVERFLOW_NODE_TYPE,
        position: {
          x: colIdx * COLUMN_WIDTH,
          y: HEADER_HEIGHT + (nextRow + 1) * ROW_HEIGHT,
        },
        data: { label: `+ ${remaining} more`, kind },
        selectable: false,
      })
      nextRow += 1
    }

    if (orphans > 0) {
      rfNodes.push({
        id: `orphans-${kind}`,
        type: ORPHAN_PLACEHOLDER_TYPE,
        position: {
          x: colIdx * COLUMN_WIDTH,
          y: HEADER_HEIGHT + (nextRow + 1) * ROW_HEIGHT,
        },
        data: { kind, count: orphans },
        selectable: false,
      })
    }
  }

  const visibleIds = new Set(rfNodes.map((n) => n.id))

  const rfEdges: Edge[] = graph.edges
    .filter((e) => visibleIds.has(e.sourceId) && visibleIds.has(e.targetId))
    .map((e, i) => ({
      id: `e-${i}`,
      source: e.sourceId,
      target: e.targetId,
      type: 'default',
      animated: false,
      data: { relation: e.relation },
      label: '',
      style: {
        strokeWidth: 1.5,
        stroke: tokens.colorNeutralStroke1,
      },
    }))

  return { nodes: rfNodes, edges: rfEdges }
}

/**
 * Sugiyama barycenter heuristic for layered graphs: each pass sorts a
 * column's nodes by the average row index of their neighbours in adjacent
 * columns. Alternating forward and backward passes converges towards a
 * layout with fewer edge crossings.
 */
function barycenterOrder(
  byKind: Map<string, RawNode[]>,
  edges: LineageGraphData['edges'],
  visibleKinds: readonly string[],
  hidden: Set<string>,
): Map<string, RawNode[]> {
  const ordered = new Map<string, RawNode[]>()
  for (const kind of visibleKinds) {
    ordered.set(kind, [...(byKind.get(kind) ?? [])])
  }

  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  for (const e of edges) {
    if (hidden.has(e.sourceType) || hidden.has(e.targetType)) continue
    const inc = incoming.get(e.targetId) ?? []
    inc.push(e.sourceId)
    incoming.set(e.targetId, inc)
    const out = outgoing.get(e.sourceId) ?? []
    out.push(e.targetId)
    outgoing.set(e.sourceId, out)
  }

  const positions = new Map<string, number>()
  const refreshPositions = () => {
    positions.clear()
    for (const kind of visibleKinds) {
      ordered.get(kind)!.forEach((n, i) => positions.set(n.id, i))
    }
  }

  for (let pass = 0; pass < BARYCENTER_PASSES; pass++) {
    refreshPositions()
    const forward = pass % 2 === 0
    const order = forward ? visibleKinds : [...visibleKinds].reverse()
    for (let i = 1; i < order.length; i++) {
      const kind = order[i]
      const list = ordered.get(kind)!
      const neighborMap = forward ? incoming : outgoing
      const scored = list.map((node, idx) => {
        const neighbors = neighborMap.get(node.id) ?? []
        const ranks = neighbors
          .map((nid) => positions.get(nid))
          .filter((v): v is number => v !== undefined)
        const score =
          ranks.length > 0 ? ranks.reduce((a, b) => a + b, 0) / ranks.length : idx
        return { node, score, idx }
      })
      // Stable sort: ties keep prior order so disconnected nodes stay put.
      scored.sort((a, b) => a.score - b.score || a.idx - b.idx)
      ordered.set(kind, scored.map((s) => s.node))
    }
  }

  return ordered
}
