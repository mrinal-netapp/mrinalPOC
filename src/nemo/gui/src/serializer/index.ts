import type { Edge } from 'reactflow'
import { getBlock } from '@/blocks'
import type { SubBlockConfig } from '@/blocks/types'
import type { SerializedBlock, SerializedWorkflow } from '@/serializer/types'
import type { BlockState } from '@/stores/workflow/types'
import { generateUUID } from '@/lib/uuid'

/**
 * Helper function to check if a subblock should be included in serialization based on current mode
 */
function shouldIncludeField(subBlockConfig: SubBlockConfig, isAdvancedMode: boolean): boolean {
  const fieldMode = subBlockConfig.mode

  if (fieldMode === 'advanced' && !isAdvancedMode) {
    return false
  }

  return true
}

export class Serializer {
  serializeWorkflow(blocks: Record<string, BlockState>, edges: Edge[]): SerializedWorkflow {
    return {
      version: '1.0',
      blocks: Object.values(blocks).map((block) => this.serializeBlock(block)),
      connections: edges.map((edge) => ({
        source: edge.source,
        target: edge.target,
        // Default to 'default' for backward compatibility
        sourceHandle: edge.sourceHandle || 'default',
        targetHandle: edge.targetHandle || 'default',
      })),
    }
  }

  private serializeBlock(block: BlockState): SerializedBlock {
    const blockConfig = getBlock(block.type)
    if (!blockConfig) {
      throw new Error(`Invalid block type: ${block.type}`)
    }

    const params = this.extractParams(block, blockConfig)

    const toolId = blockConfig.tools.config?.tool
      ? blockConfig.tools.config.tool(params)
      : blockConfig.tools.access[0] || ''

    const inputs: Record<string, any> = {}
    if (blockConfig.inputs) {
      Object.entries(blockConfig.inputs).forEach(([key, config]) => {
        inputs[key] = config.type
      })
    }

    return {
      id: block.id,
      position: block.position,
      config: {
        tool: toolId,
        params,
      },
      inputs,
      outputs: {
        ...block.outputs,
      },
      metadata: {
        id: block.type,
        name: block.name,
        description: blockConfig.description,
        category: blockConfig.category,
        color: blockConfig.bgColor,
      },
      enabled: block.enabled,
    }
  }

  private extractParams(block: BlockState, blockConfig: any): Record<string, any> {
    const params: Record<string, any> = {}
    const isAdvancedMode = block.advancedMode ?? false

    Object.entries(block.subBlocks).forEach(([id, subBlock]) => {
      const subBlockConfig = blockConfig.subBlocks.find((config: SubBlockConfig) => config.id === id)

      if (subBlockConfig && shouldIncludeField(subBlockConfig, isAdvancedMode)) {
        params[id] = subBlock.value
      }
    })

    blockConfig.subBlocks.forEach((subBlockConfig: SubBlockConfig) => {
      const id = subBlockConfig.id
      if (
        (params[id] === null || params[id] === undefined) &&
        subBlockConfig.value &&
        shouldIncludeField(subBlockConfig, isAdvancedMode)
      ) {
        params[id] = subBlockConfig.value(params)
      }
    })

    return params
  }

  deserializeWorkflow(workflow: SerializedWorkflow): {
    blocks: Record<string, BlockState>
    edges: Edge[]
  } {
    const blocks: Record<string, BlockState> = {}
    const edges: Edge[] = []

    workflow.blocks.forEach((serializedBlock) => {
      const block = this.deserializeBlock(serializedBlock)
      blocks[block.id] = block
    })

    workflow.connections.forEach((connection) => {
      edges.push({
        id: generateUUID(),
        source: connection.source,
        target: connection.target,
        // Default to 'default' for backward compatibility
        sourceHandle: connection.sourceHandle || 'default',
        targetHandle: connection.targetHandle || 'default',
        type: 'pipelineEdge',
      })
    })

    return { blocks, edges }
  }

  private deserializeBlock(serializedBlock: SerializedBlock): BlockState {
    const blockType = serializedBlock.metadata?.id
    if (!blockType) {
      throw new Error(`Invalid block type: ${serializedBlock.metadata?.id}`)
    }

    const blockConfig = getBlock(blockType)
    if (!blockConfig) {
      throw new Error(`Invalid block type: ${blockType}`)
    }

    const subBlocks: Record<string, any> = {}
    blockConfig.subBlocks.forEach((subBlock) => {
      subBlocks[subBlock.id] = {
        id: subBlock.id,
        type: subBlock.type,
        value: serializedBlock.config.params[subBlock.id] ?? null,
      }
    })

    return {
      id: serializedBlock.id,
      type: blockType,
      name: serializedBlock.metadata?.name || blockConfig.name,
      position: serializedBlock.position,
      subBlocks,
      outputs: serializedBlock.outputs,
      enabled: serializedBlock.enabled ?? true,
      triggerMode: serializedBlock.config?.params?.triggerMode === true,
      advancedMode: serializedBlock.config?.params?.advancedMode === true,
    }
  }
}

