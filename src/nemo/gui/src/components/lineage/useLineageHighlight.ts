import { useCallback, useMemo, useState } from 'react'
import type { Node, Edge } from 'reactflow'

interface HighlightState {
  activeNodeId: string | null
  highlightedNodes: Set<string>
  highlightedEdges: Set<string>
}

const EMPTY: HighlightState = {
  activeNodeId: null,
  highlightedNodes: new Set(),
  highlightedEdges: new Set(),
}

/**
 * BFS from a starting node in both directions (ancestors via incoming edges,
 * descendants via outgoing edges) to compute the full transitive lineage.
 */
function computeLineage(nodeId: string, edges: Edge[]): { nodes: Set<string>; edges: Set<string> } {
  const outgoing = new Map<string, Edge[]>()
  const incoming = new Map<string, Edge[]>()
  for (const e of edges) {
    const src = outgoing.get(e.source) ?? []
    src.push(e)
    outgoing.set(e.source, src)
    const tgt = incoming.get(e.target) ?? []
    tgt.push(e)
    incoming.set(e.target, tgt)
  }

  const visitedNodes = new Set<string>([nodeId])
  const visitedEdges = new Set<string>()

  // Descendants (follow outgoing edges: source → target)
  const downQueue = [nodeId]
  while (downQueue.length > 0) {
    const current = downQueue.shift()!
    for (const e of outgoing.get(current) ?? []) {
      visitedEdges.add(e.id)
      if (!visitedNodes.has(e.target)) {
        visitedNodes.add(e.target)
        downQueue.push(e.target)
      }
    }
  }

  // Ancestors (follow incoming edges: target ← source)
  const upQueue = [nodeId]
  while (upQueue.length > 0) {
    const current = upQueue.shift()!
    for (const e of incoming.get(current) ?? []) {
      visitedEdges.add(e.id)
      if (!visitedNodes.has(e.source)) {
        visitedNodes.add(e.source)
        upQueue.push(e.source)
      }
    }
  }

  return { nodes: visitedNodes, edges: visitedEdges }
}

/**
 * Hook for click-to-highlight lineage on the React Flow canvas. Returns
 * styled node/edge arrays (dimmed opacity for non-lineage items when an
 * entity is selected), an `onNodeClick` toggler, and a `clearHighlight`
 * handler wired to the pane's onPaneClick.
 */
export function useLineageHighlight(baseNodes: Node[], baseEdges: Edge[]) {
  const [state, setState] = useState<HighlightState>(EMPTY)

  // Click-to-highlight: clicking an entity node toggles lineage view.
  // Placeholder nodes (column headers, "+N more" overflow, orphan
  // summaries) have no edges, so they don't participate in highlighting.
  const onNodeClick = useCallback(
    (node: Node) => {
      if (node.type !== 'lineageNode') return
      setState((prev) => {
        if (prev.activeNodeId === node.id) return EMPTY
        const lineage = computeLineage(node.id, baseEdges)
        return {
          activeNodeId: node.id,
          highlightedNodes: lineage.nodes,
          highlightedEdges: lineage.edges,
        }
      })
    },
    [baseEdges],
  )

  const clearHighlight = useCallback(() => {
    setState(EMPTY)
  }, [])

  const styledNodes = useMemo(() => {
    if (!state.activeNodeId) return baseNodes
    return baseNodes.map((node) => {
      const inLineage = state.highlightedNodes.has(node.id)
      return {
        ...node,
        style: {
          ...node.style,
          opacity: inLineage ? 1 : 0.15,
          transition: 'opacity 0.15s ease',
        },
      }
    })
  }, [baseNodes, state.activeNodeId, state.highlightedNodes])

  const styledEdges = useMemo(() => {
    if (!state.activeNodeId) return baseEdges
    return baseEdges.map((edge) => {
      const inLineage = state.highlightedEdges.has(edge.id)
      return {
        ...edge,
        style: {
          ...edge.style,
          opacity: inLineage ? 1 : 0.1,
          transition: 'opacity 0.15s ease',
        },
        animated: inLineage,
      }
    })
  }, [baseEdges, state.activeNodeId, state.highlightedEdges])

  return {
    nodes: styledNodes,
    edges: styledEdges,
    onNodeClick,
    clearHighlight,
  }
}
