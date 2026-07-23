import { useEffect, useRef } from 'react'
import { useUpdateNodeInternals } from 'reactflow'
import { useWorkflowStore } from '@/stores/workflow/store'

interface BlockDimensions {
  width: number
  height: number
}

interface UseBlockDimensionsOptions {
  blockId: string
  calculateDimensions: () => BlockDimensions
  dependencies: React.DependencyList
}

/**
 * Shared block dimension constants
 */
export const BLOCK_DIMENSIONS = {
  FIXED_WIDTH: 250 as number,
  HEADER_HEIGHT: 40 as number,
  MIN_HEIGHT: 100 as number,

  // Workflow blocks
  WORKFLOW_CONTENT_PADDING: 16 as number,
  WORKFLOW_ROW_HEIGHT: 29 as number,

  // Note blocks
  NOTE_CONTENT_PADDING: 14 as number,
  NOTE_MIN_CONTENT_HEIGHT: 20 as number,
  NOTE_BASE_CONTENT_HEIGHT: 60 as number,
} as const

/**
 * Hook to manage deterministic block dimensions without ResizeObserver.
 * Calculates dimensions based on content structure and updates the store.
 */
export function useBlockDimensions({
  blockId,
  calculateDimensions,
  dependencies,
}: UseBlockDimensionsOptions) {
  const updateNodeInternals = useUpdateNodeInternals()
  const updateNodeDimensions = useWorkflowStore((state) => state.updateNodeDimensions)
  const previousDimensions = useRef<BlockDimensions | null>(null)

  useEffect(() => {
    const dimensions = calculateDimensions()
    const previous = previousDimensions.current

    if (!previous || previous.width !== dimensions.width || previous.height !== dimensions.height) {
      previousDimensions.current = dimensions
      updateNodeDimensions(blockId, dimensions)
      updateNodeInternals(blockId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId, updateNodeDimensions, updateNodeInternals, ...dependencies])
}

