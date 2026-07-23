/**
 * Constants for the pipeline editor
 */

import type { EdgeTypes, NodeTypes } from 'reactflow'
import { ConnectionLineType } from 'reactflow'
import { NoteBlock } from '@/components/note-block/note-block'
import { PipelineBlock } from '@/components/pipeline-block/pipeline-block'
import { PipelineEdge } from '@/components/pipeline-edge/pipeline-edge'

/**
 * Node types configuration for ReactFlow
 */
export const nodeTypes: NodeTypes = {
  pipelineBlock: PipelineBlock,
  noteBlock: NoteBlock,
}

/**
 * Edge types configuration for ReactFlow
 */
export const edgeTypes: EdgeTypes = {
  default: PipelineEdge,
  pipelineEdge: PipelineEdge,
}

/**
 * Default edge options
 */
export const defaultEdgeOptions = { type: 'pipelineEdge' as const }

/**
 * Snap grid configuration [x, y]
 */
export const snapGrid: [number, number] = [20, 20]

/**
 * ReactFlow fit view options
 */
export const reactFlowFitViewOptions = { padding: 0.6 } as const

/**
 * Connection line type
 */
export const connectionLineType = ConnectionLineType.SmoothStep

/**
 * Background configuration
 */
export const backgroundConfig = {
  color: '#e5e5e5',
  gap: 20,
  size: 1,
} as const

/**
 * Minimap configuration
 */
export const minimapConfig = {
  nodeStrokeWidth: 3,
  pannable: true,
  zoomable: true,
  maskColor: 'rgba(0, 0, 0, 0.1)',
} as const

