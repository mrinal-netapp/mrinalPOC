import type { Edge } from 'reactflow'
import { create } from 'zustand'
import { getBlock } from '@/blocks'
import type { SubBlockConfig } from '@/blocks/types'
import { getUniqueBlockName } from '@/stores/workflow/utils'
import { generateUUID } from '@/lib/uuid'
import type {
  Position,
  SubBlockState,
  WorkflowState,
  WorkflowStore,
} from '@/stores/workflow/types'

/**
 * Creates a deep clone of an initial sub-block value to avoid shared references.
 */
function cloneInitialSubblockValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneInitialSubblockValue(item))
  }

  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>(
      (acc, [key, entry]) => {
        acc[key] = cloneInitialSubblockValue(entry)
        return acc
      },
      {}
    )
  }

  return value ?? null
}

/**
 * Resolves the initial value for a sub-block based on its configuration.
 */
function resolveInitialSubblockValue(config: SubBlockConfig): unknown {
  if (typeof config.value === 'function') {
    try {
      const resolved = config.value({})
      return cloneInitialSubblockValue(resolved)
    } catch (error) {
      console.warn('Failed to resolve dynamic sub-block default value', {
        subBlockId: config.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (config.defaultValue !== undefined) {
    return cloneInitialSubblockValue(config.defaultValue)
  }

  if (config.type === 'table') {
    return []
  }

  return null
}

const initialState: WorkflowState = {
  blocks: {},
  edges: [],
  lastSaved: undefined,
}

export const useWorkflowStore = create<WorkflowStore>()((set, get) => ({
  ...initialState,

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
  ) => {
    const blockConfig = getBlock(type)
    if (!blockConfig) return

    const nodeData = {
      ...data,
      ...(parentId && { parentId, extent: extent || 'parent' }),
    }

    const subBlocks: Record<string, SubBlockState> = {}

    blockConfig.subBlocks.forEach((subBlock) => {
      const subBlockId = subBlock.id
      const initialValue = resolveInitialSubblockValue(subBlock)
      const normalizedValue =
        initialValue !== undefined && initialValue !== null ? initialValue : null

      subBlocks[subBlockId] = {
        id: subBlockId,
        type: subBlock.type,
        value: normalizedValue as SubBlockState['value'],
      }
    })

    const newState = {
      blocks: {
        ...get().blocks,
        [id]: {
          id,
          type,
          name,
          position,
          subBlocks,
          outputs: {},
          enabled: blockProperties?.enabled ?? true,
          horizontalHandles: blockProperties?.horizontalHandles ?? true,
          advancedMode: blockProperties?.advancedMode ?? false,
          triggerMode: blockProperties?.triggerMode ?? false,
          height: blockProperties?.height ?? 0,
          layout: {},
          data: nodeData,
        },
      },
      edges: [...get().edges],
    }

    set(newState)
    get().updateLastSaved()
  },

  updateBlockPosition: (id: string, position: Position) => {
    set((state) => ({
      blocks: {
        ...state.blocks,
        [id]: {
          ...state.blocks[id],
          position,
        },
      },
      edges: [...state.edges],
    }))
    get().updateLastSaved()
  },

  updateNodeDimensions: (id: string, dimensions: { width: number; height: number }) => {
    set((state) => {
      const block = state.blocks[id]
      if (!block) {
        return state
      }

      return {
        blocks: {
          ...state.blocks,
          [id]: {
            ...block,
            data: {
              ...block.data,
              width: dimensions.width,
              height: dimensions.height,
            },
            layout: {
              ...block.layout,
              measuredWidth: dimensions.width,
              measuredHeight: dimensions.height,
            },
          },
        },
        edges: [...state.edges],
      }
    })
    get().updateLastSaved()
  },

  updateParentId: (id: string, parentId: string, extent: 'parent') => {
    const block = get().blocks[id]
    if (!block) {
      return
    }

    const newData = !parentId
      ? {}
      : {
          ...block.data,
          parentId,
          extent,
        }

    set({
      blocks: {
        ...get().blocks,
        [id]: {
          ...block,
          data: newData,
        },
      },
      edges: [...get().edges],
    })
    get().updateLastSaved()
  },

  removeBlock: (id: string) => {
    const newState = {
      blocks: { ...get().blocks },
      edges: [...get().edges].filter((edge) => edge.source !== id && edge.target !== id),
    }

    const blocksToRemove = new Set([id])

    const findAllDescendants = (parentId: string) => {
      Object.entries(newState.blocks).forEach(([blockId, block]) => {
        if (block.data?.parentId === parentId) {
          blocksToRemove.add(blockId)
          findAllDescendants(blockId)
        }
      })
    }

    findAllDescendants(id)

    blocksToRemove.forEach((blockId) => {
      delete newState.blocks[blockId]
    })

    set(newState)
    get().updateLastSaved()
  },

  addEdge: (edge: Edge) => {
    set((state) => ({
      blocks: { ...state.blocks },
      edges: [...state.edges.filter((e) => e.id !== edge.id), edge],
    }))
    get().updateLastSaved()
  },

  removeEdge: (edgeId: string) => {
    set((state) => ({
      blocks: { ...state.blocks },
      edges: state.edges.filter((edge) => edge.id !== edgeId),
    }))
    get().updateLastSaved()
  },

  clear: () => {
    const cleared = { ...initialState }
    set(cleared)
    return cleared
  },

  updateLastSaved: () => {
    set({ lastSaved: Date.now(), lastUpdate: Date.now() })
  },

  toggleBlockEnabled: (id: string) => {
    set((state) => {
      const block = state.blocks[id]
      if (!block) return state

      return {
        blocks: {
          ...state.blocks,
          [id]: {
            ...block,
            enabled: !block.enabled,
          },
        },
        edges: [...state.edges],
      }
    })
    get().updateLastSaved()
  },

  duplicateBlock: (id: string) => {
    const block = get().blocks[id]
    if (!block) return

    const newId = generateUUID()
    const uniqueName = getUniqueBlockName(block.name, get().blocks)

    get().addBlock(
      newId,
      block.type,
      uniqueName,
      { x: block.position.x + 50, y: block.position.y + 50 },
      block.data,
      block.data?.parentId,
      block.data?.extent,
      {
        enabled: block.enabled,
        horizontalHandles: block.horizontalHandles,
        advancedMode: block.advancedMode,
        triggerMode: block.triggerMode,
        height: block.height,
      }
    )
  },

  toggleBlockHandles: (id: string) => {
    set((state) => {
      const block = state.blocks[id]
      if (!block) return state

      return {
        blocks: {
          ...state.blocks,
          [id]: {
            ...block,
            horizontalHandles: !block.horizontalHandles,
          },
        },
        edges: [...state.edges],
      }
    })
    get().updateLastSaved()
  },

  updateBlockName: (id: string, name: string) => {
    set((state) => {
      const block = state.blocks[id]
      if (!block) return state

      return {
        blocks: {
          ...state.blocks,
          [id]: {
            ...block,
            name,
          },
        },
        edges: [...state.edges],
      }
    })
    get().updateLastSaved()
  },

  setBlockAdvancedMode: (id: string, advancedMode: boolean) => {
    set((state) => {
      const block = state.blocks[id]
      if (!block) return state

      return {
        blocks: {
          ...state.blocks,
          [id]: {
            ...block,
            advancedMode,
          },
        },
        edges: [...state.edges],
      }
    })
    get().updateLastSaved()
  },

  setBlockTriggerMode: (id: string, triggerMode: boolean) => {
    set((state) => {
      const block = state.blocks[id]
      if (!block) return state

      return {
        blocks: {
          ...state.blocks,
          [id]: {
            ...block,
            triggerMode,
          },
        },
        edges: [...state.edges],
      }
    })
    get().updateLastSaved()
  },

  updateSubBlockValue: (blockId: string, subBlockId: string, value: SubBlockState['value']) => {
    set((state) => {
      const block = state.blocks[blockId]
      if (!block) return state

      return {
        blocks: {
          ...state.blocks,
          [blockId]: {
            ...block,
            subBlocks: {
              ...block.subBlocks,
              [subBlockId]: {
                ...block.subBlocks[subBlockId],
                value,
              },
            },
          },
        },
        edges: [...state.edges],
      }
    })
    get().updateLastSaved()
  },

  updateBlockLayoutMetrics: (id: string, dimensions: { width: number; height: number }) => {
    get().updateNodeDimensions(id, dimensions)
  },

  triggerUpdate: () => {
    set({ lastUpdate: Date.now() })
  },

  getWorkflowState: () => {
    return get()
  },

  replaceWorkflowState: (workflowState: WorkflowState, options?: { updateLastSaved?: boolean }) => {
    set(workflowState)
    if (options?.updateLastSaved) {
      get().updateLastSaved()
    }
  },
}))

