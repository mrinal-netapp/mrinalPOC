import { useCallback } from 'react'
import { useReactFlow } from 'reactflow'
import { getBlock } from '@/blocks'
import { getUniqueBlockName } from '@/stores/workflow/utils'
import { useWorkflowStore } from '@/stores/workflow/store'
import { generateUUID } from '@/lib/uuid'

/**
 * Hook for adding blocks to the workflow editor.
 * Handles position conversion and block creation logic.
 */
export function useBlockAddition() {
  const { screenToFlowPosition } = useReactFlow()
  const { blocks, addBlock } = useWorkflowStore()

  const addBlockAtPosition = useCallback(
    (blockType: string, screenPosition: { x: number; y: number }) => {
      const blockConfig = getBlock(blockType)
      if (!blockConfig) {
        console.warn(`Block type "${blockType}" not found`)
        return false
      }

      // Convert screen coordinates to flow coordinates
      const flowPosition = screenToFlowPosition({
        x: screenPosition.x,
        y: screenPosition.y,
      })

      // Generate unique ID and name
      const id = generateUUID()
      const uniqueName = getUniqueBlockName(blockConfig.name, blocks)

      // Add the block
      addBlock(id, blockType, uniqueName, flowPosition)
      return true
    },
    [screenToFlowPosition, blocks, addBlock]
  )

  return { addBlockAtPosition }
}

