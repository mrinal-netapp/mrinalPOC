import type { BlockOutput, ParamType } from '@/blocks/types'
import type { Position } from '@/stores/workflow/types'

export interface SerializedWorkflow {
  version: string
  blocks: SerializedBlock[]
  connections: SerializedConnection[]
}

export interface SerializedConnection {
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

export interface SerializedBlock {
  id: string
  position: Position
  config: {
    tool: string
    params: Record<string, any>
  }
  inputs: Record<string, ParamType>
  outputs: Record<string, BlockOutput>
  metadata?: {
    id: string
    name?: string
    description?: string
    category?: string
    color?: string
  }
  enabled: boolean
}

