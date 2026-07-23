/**
 * Custom hook for workflow event handlers
 */

import { useCallback } from 'react'
import type { Edge, Connection } from 'reactflow'
import { useWorkflowStore } from '@/stores/workflow/store'
import { usePanelStore } from '@/stores/panel/store'
import { useBlockAddition } from '@/hooks/use-block-addition'
import { generateUUID } from '@/lib/uuid'
import { useConnectionValidation } from './use-connection-validation'
import { useToast } from '@/contexts/ToastContext'

/**
 * Hook that provides all event handlers for the workflow editor
 */
export function useWorkflowHandlers() {
  const { addEdge, updateBlockPosition } = useWorkflowStore()
  const { setSelectedBlockId } = usePanelStore()
  const { addBlockAtPosition } = useBlockAddition()
  const { isValidConnection, getValidationResult } = useConnectionValidation()
  const { showToast } = useToast()

  const onNodesChange = useCallback(
    (changes: any[]) => {
      changes.forEach((change) => {
        if (change.type === 'position' && change.position) {
          updateBlockPosition(change.id, change.position)
        }
      })
    },
    [updateBlockPosition]
  )

  const onEdgesChange = useCallback(() => {
    // Handle edge changes if needed
  }, [])

  const onConnect = useCallback(
    (connection: Connection) => {
      // Validate connection before adding
      if (!isValidConnection(connection)) {
        const validationResult = getValidationResult(connection)
        const errorMessage = validationResult.reason || 'Connection is not valid'
        
        // Show helpful error toast to user
        showToast(errorMessage, 'error', 5000)
        console.warn('Connection rejected:', errorMessage)
        return
      }

      const newEdge: Edge = {
        id: generateUUID(),
        source: connection.source || '',
        target: connection.target || '',
        sourceHandle: connection.sourceHandle || 'default',
        targetHandle: connection.targetHandle || 'default',
        type: 'pipelineEdge',
        data: {
          sourceHandleName: connection.sourceHandle,
          targetHandleName: connection.targetHandle,
        },
      }
      addEdge(newEdge)
    },
    [addEdge, isValidConnection, getValidationResult, showToast]
  )

  const onEdgeClick = useCallback(
    (edgeId: string, setSelectedEdgeId: (id: string | null) => void) => {
      setSelectedEdgeId(edgeId)
    },
    []
  )

  const onPaneClick = useCallback(() => {
    setSelectedBlockId(null)
  }, [setSelectedBlockId])

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: any) => {
      setSelectedBlockId(node.id)
    },
    [setSelectedBlockId]
  )

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()

      const blockType = event.dataTransfer.getData('application/reactflow')
      if (!blockType) return

      // Get the position relative to the ReactFlow viewport
      const reactFlowBounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
      const position = {
        x: event.clientX - reactFlowBounds.left,
        y: event.clientY - reactFlowBounds.top,
      }

      addBlockAtPosition(blockType, position)
    },
    [addBlockAtPosition]
  )

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  return {
    onNodesChange,
    onEdgesChange,
    onConnect,
    onEdgeClick,
    onPaneClick,
    onNodeClick,
    onDrop,
    onDragOver,
  }
}

