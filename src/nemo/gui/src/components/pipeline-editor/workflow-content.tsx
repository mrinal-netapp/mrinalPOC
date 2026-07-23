/**
 * PipelineContent component - Main ReactFlow canvas content
 */

import React, { useMemo, useState, useRef, useCallback, useEffect } from 'react'
import ReactFlow, { Controls, Background, MiniMap, ReactFlowProvider, useReactFlow } from 'reactflow'
import 'reactflow/dist/style.css'
import { useWorkflowStore } from '@/stores/workflow/store'
import { useWorkflowHandlers } from './hooks/use-workflow-handlers'
import { useConnectionValidation } from './hooks/use-connection-validation'
import { useKeyboardShortcuts } from './hooks/use-keyboard-shortcuts'
import { useBlockAddition } from '@/hooks/use-block-addition'
import { BlockContextMenu } from '@/components/block-context-menu/block-context-menu'
import {
  nodeTypes,
  edgeTypes,
  defaultEdgeOptions,
  snapGrid,
  reactFlowFitViewOptions,
  connectionLineType,
  backgroundConfig,
  minimapConfig,
} from './constants'
import { getBlock } from '@/blocks'
import styles from './workflow-content.module.css'

/**
 * Calculate padding for fitView based on node count
 * Uses heuristics to provide appropriate zoom level:
 * - Few nodes (1-5): More padding (0.8) for better visibility
 * - Medium nodes (6-15): Moderate padding (0.5)
 * - Many nodes (16-30): Less padding (0.3) to fit more
 * - Very many nodes (31+): Minimal padding (0.2) to fit all
 */
function calculateFitViewPadding(nodeCount: number): number {
  if (nodeCount === 0) return 0.6 // Default for empty
  if (nodeCount <= 5) return 0.8
  if (nodeCount <= 15) return 0.5
  if (nodeCount <= 30) return 0.3
  return 0.2
}

const PipelineContentInner = () => {
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ isOpen: boolean; position: { x: number; y: number }; screenPosition?: { x: number; y: number } }>({
    isOpen: false,
    position: { x: 0, y: 0 },
  })
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const { blocks, edges, removeEdge, removeBlock, lastSaved } = useWorkflowStore()
  const reactFlowInstance = useReactFlow()
  const hasFittedViewRef = useRef(false)
  const previousBlockCountRef = useRef(0)
  const lastSavedRef = useRef<number | undefined>(undefined)
  const {
    onNodesChange,
    onEdgesChange,
    onConnect,
    onPaneClick: originalOnPaneClick,
    onNodeClick,
    onDrop,
    onDragOver,
  } = useWorkflowHandlers()
  const { isValidConnection } = useConnectionValidation()
  const { addBlockAtPosition } = useBlockAddition()

  useKeyboardShortcuts()

  // Wrap onPaneClick to also close context menu
  const onPaneClick = useCallback(() => {
    originalOnPaneClick()
    // Close context menu when clicking on canvas
    if (contextMenu.isOpen) {
      setContextMenu({ isOpen: false, position: { x: 0, y: 0 } })
    }
  }, [originalOnPaneClick, contextMenu.isOpen])

  // Handle right-click on canvas to show context menu
  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      // Get the ReactFlow viewport element to calculate relative position
      const reactFlowElement = (event.currentTarget as HTMLElement).closest('.react-flow')
      if (reactFlowElement) {
        const bounds = reactFlowElement.getBoundingClientRect()
        const screenPosition = {
          x: event.clientX - bounds.left,
          y: event.clientY - bounds.top,
        }
        setContextMenu({
          isOpen: true,
          position: { x: event.clientX, y: event.clientY },
          screenPosition,
        })
      }
    },
    []
  )

  // Handle block selection from context menu
  const handleSelectBlock = useCallback(
    (blockType: string) => {
      // Use the stored screen position to add block at right-click location
      if (contextMenu.screenPosition) {
        addBlockAtPosition(blockType, contextMenu.screenPosition)
      }
      setContextMenu({ isOpen: false, position: { x: 0, y: 0 } })
    },
    [contextMenu.screenPosition, addBlockAtPosition]
  )

  // Close context menu when clicking outside
  const handleCloseContextMenu = useCallback(() => {
    setContextMenu({ isOpen: false, position: { x: 0, y: 0 } })
  }, [])

  // Close context menu on outside click (including canvas and panel clicks)
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      // Close if click is outside the context menu
      if (contextMenuRef.current && !contextMenuRef.current.contains(target)) {
        handleCloseContextMenu()
      }
    }

    if (contextMenu.isOpen) {
      // Use a small delay to prevent immediate close from the same click that opened the menu
      const timeoutId = setTimeout(() => {
        document.addEventListener('mousedown', handleClickOutside, true)
      }, 0)
      
      return () => {
        clearTimeout(timeoutId)
        document.removeEventListener('mousedown', handleClickOutside, true)
      }
    }
  }, [contextMenu.isOpen, handleCloseContextMenu])

  const nodes = useMemo(() => {
    return Object.values(blocks).map((block) => {
      const nodeType = block.type === 'note' ? 'noteBlock' : 'pipelineBlock'
      return {
        id: block.id,
        type: nodeType,
        position: block.position,
        data: {
          type: block.type,
          name: block.name,
          enabled: block.enabled,
          onDelete: (blockId: string) => {
            removeBlock(blockId)
          },
        },
      }
    })
  }, [blocks, removeBlock])

  const edgesWithHandlers = useMemo(() => {
    return edges.map((edge) => ({
      ...edge,
      data: {
        ...edge.data,
        isSelected: edge.id === selectedEdgeId,
        onDelete: (edgeId: string) => {
          removeEdge(edgeId)
          setSelectedEdgeId(null)
        },
      },
    }))
  }, [edges, selectedEdgeId, removeEdge])

  const handleEdgeClick = useMemo(
    () => (_event: React.MouseEvent, edge: any) => {
      setSelectedEdgeId(edge.id)
    },
    []
  )

  const minimapNodeColor = useMemo(
    () => (node: any) => {
      const block = blocks[node.id]
      if (!block) return '#94a3b8'
      const blockConfig = getBlock(block.type)
      return blockConfig?.bgColor || '#94a3b8'
    },
    [blocks]
  )

  // Fit view when blocks are loaded or updated
  // This handles the case when an existing pipeline with many nodes is opened
  useEffect(() => {
    const nodeCount = Object.keys(blocks).length
    const previousCount = previousBlockCountRef.current
    const previousLastSaved = lastSavedRef.current
    
    // Detect if this is a pipeline load (lastSaved changed from undefined to a value, or block count jumped significantly)
    const isPipelineLoad = 
      (previousLastSaved === undefined && lastSaved !== undefined) || // Pipeline was loaded
      (previousCount === 0 && nodeCount > 0) || // Went from empty to having nodes
      (previousCount > 0 && nodeCount > previousCount && nodeCount - previousCount >= 5) // Significant addition (likely a load)
    
    // Only fit view when:
    // 1. Pipeline is being loaded (detected by lastSaved change or significant block count increase)
    // 2. We haven't fitted view yet for this load
    // Don't fit view on every small change to avoid interrupting user interactions
    const shouldFitView = isPipelineLoad && nodeCount > 0 && !hasFittedViewRef.current
    
    if (shouldFitView) {
      // Use a delay to ensure nodes are rendered and ReactFlow instance is ready
      let retryTimeoutId: NodeJS.Timeout | null = null
      const timeoutId = setTimeout(() => {
        try {
          const padding = calculateFitViewPadding(nodeCount)
          reactFlowInstance.fitView({ padding, duration: 300 })
          hasFittedViewRef.current = true
        } catch (error) {
          // ReactFlow instance might not be ready yet, try again after a longer delay
          retryTimeoutId = setTimeout(() => {
            try {
              const padding = calculateFitViewPadding(nodeCount)
              reactFlowInstance.fitView({ padding, duration: 300 })
              hasFittedViewRef.current = true
            } catch (retryError) {
              console.debug('fitView not ready after retry:', retryError)
            }
          }, 300)
        }
      }, 200)
      
      previousBlockCountRef.current = nodeCount
      lastSavedRef.current = lastSaved
      return () => {
        clearTimeout(timeoutId)
        if (retryTimeoutId) {
          clearTimeout(retryTimeoutId)
        }
      }
    } else {
      // Update the refs even if we don't fit view
      previousBlockCountRef.current = nodeCount
      lastSavedRef.current = lastSaved
      
      // Reset hasFittedViewRef when blocks are cleared
      if (nodeCount === 0) {
        hasFittedViewRef.current = false
      }
    }
  }, [blocks, lastSaved, reactFlowInstance])

  return (
    <div className={styles.container}>
      <ReactFlow
        nodes={nodes}
        edges={edgesWithHandlers}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgeClick={handleEdgeClick}
        onPaneClick={onPaneClick}
        onPaneContextMenu={onPaneContextMenu}
        onNodeClick={onNodeClick}
        onDrop={onDrop}
        onDragOver={onDragOver}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        snapToGrid={true}
        snapGrid={snapGrid}
        fitView={false}
        fitViewOptions={reactFlowFitViewOptions}
        connectionLineType={connectionLineType}
        isValidConnection={isValidConnection}
        deleteKeyCode={null}
        className={styles.reactFlowWrapper}
      >
        <Background {...backgroundConfig} />
        <Controls />
        <MiniMap
          nodeColor={minimapNodeColor}
          {...minimapConfig}
          style={{
            backgroundColor: 'var(--surface-2)',
            border: '1px solid var(--border)',
          }}
        />
      </ReactFlow>
      <BlockContextMenu
        isOpen={contextMenu.isOpen}
        position={contextMenu.position}
        menuRef={contextMenuRef}
        onClose={handleCloseContextMenu}
        onSelectBlock={handleSelectBlock}
      />
    </div>
  )
}

export const PipelineContent = React.memo(() => {
  return (
    <ReactFlowProvider>
      <PipelineContentInner />
    </ReactFlowProvider>
  )
})

PipelineContent.displayName = 'PipelineContent'

