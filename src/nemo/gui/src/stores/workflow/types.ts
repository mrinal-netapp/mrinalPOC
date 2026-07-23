import type { Edge } from 'reactflow'
import type { BlockOutput, SubBlockType } from '@/blocks/types'

export interface Position {
  x: number
  y: number
}

export interface BlockData {
  parentId?: string
  extent?: 'parent'
  width?: number
  height?: number
}

export interface BlockLayoutState {
  measuredWidth?: number
  measuredHeight?: number
}

export interface BlockState {
  id: string
  type: string
  name: string
  position: Position
  subBlocks: Record<string, SubBlockState>
  outputs: Record<string, BlockOutput>
  enabled: boolean
  horizontalHandles?: boolean
  height?: number
  advancedMode?: boolean
  triggerMode?: boolean
  data?: BlockData
  layout?: BlockLayoutState
}

export interface SubBlockState {
  id: string
  type: SubBlockType
  value: string | number | string[][] | null
}

export interface WorkflowState {
  blocks: Record<string, BlockState>
  edges: Edge[]
  lastSaved?: number
  lastUpdate?: number
  metadata?: {
    name?: string
    description?: string
    exportedAt?: string
  }
}

export interface WorkflowActions {
  addBlock: (
    id: string,
    type: string,
    name: string,
    position: Position,
    data?: Record<string, any>,
    parentId?: string,
    extent?: 'parent',
    blockProperties?: {
      enabled?: boolean
      horizontalHandles?: boolean
      advancedMode?: boolean
      triggerMode?: boolean
      height?: number
    }
  ) => void
  updateBlockPosition: (id: string, position: Position) => void
  updateNodeDimensions: (id: string, dimensions: { width: number; height: number }) => void
  updateParentId: (id: string, parentId: string, extent: 'parent') => void
  removeBlock: (id: string) => void
  addEdge: (edge: Edge) => void
  removeEdge: (edgeId: string) => void
  clear: () => Partial<WorkflowState>
  updateLastSaved: () => void
  toggleBlockEnabled: (id: string) => void
  duplicateBlock: (id: string) => void
  toggleBlockHandles: (id: string) => void
  updateBlockName: (id: string, name: string) => void
  setBlockAdvancedMode: (id: string, advancedMode: boolean) => void
  setBlockTriggerMode: (id: string, triggerMode: boolean) => void
  updateSubBlockValue: (blockId: string, subBlockId: string, value: SubBlockState['value']) => void
  updateBlockLayoutMetrics: (id: string, dimensions: { width: number; height: number }) => void
  triggerUpdate: () => void
  getWorkflowState: () => WorkflowState
  replaceWorkflowState: (workflowState: WorkflowState, options?: { updateLastSaved?: boolean }) => void
}

export type WorkflowStore = WorkflowState & WorkflowActions

