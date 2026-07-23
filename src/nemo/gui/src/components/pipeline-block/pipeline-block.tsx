import React, { memo, useMemo, useState, useEffect } from 'react'
import { Handle, type NodeProps, Position } from 'reactflow'
import { useParams } from 'react-router-dom'
import { X } from 'lucide-react'
import { getBlock } from '@/blocks'
import { cn } from '@/lib/utils'
import { BLOCK_DIMENSIONS, useBlockDimensions } from '@/hooks/use-block-dimensions'
import { useWorkflowStore } from '@/stores/workflow/store'
import { getAllHandles, getHandleStyle, calculateHandlePosition } from '@/utils/handle-system'
import { datasetApi, type DataSet } from '@/services/api'
import type { HandleConfig } from '@/types/handle-system'

interface PipelineBlockData {
  type: string
  name: string
  enabled?: boolean
  onDelete?: (blockId: string) => void
}

export const PipelineBlock = memo(function PipelineBlock({
  id,
  data,
  selected,
}: NodeProps<PipelineBlockData>) {
  const { type, name, enabled = true, onDelete } = data
  const blockConfig = getBlock(type)

  if (!blockConfig) {
    return null
  }

  const block = useWorkflowStore((state) => state.blocks[id])
  const isEnabled = enabled && (block?.enabled ?? true)
  const { projectId } = useParams<{ projectId: string }>()
  const [datasets, setDatasets] = useState<DataSet[]>([])

  // Load datasets for dataset_id field lookup (only for dataset_reader)
  useEffect(() => {
    if (projectId && type === 'dataset_reader') {
      datasetApi
        .list(projectId)
        .then((data) => {
          setDatasets(data)
        })
        .catch((err) => {
          console.error('Failed to load datasets:', err)
          setDatasets([])
        })
    }
  }, [projectId, type])

  // Memoize display values to ensure they update when datasets or block values change
  const displayValues = useMemo(() => {
    const values: Record<string, string> = {}
    if (!block) return values

    Object.keys(block.subBlocks).forEach((subBlockId) => {
      const subBlock = block.subBlocks[subBlockId]
      if (!subBlock || subBlock.value === null || subBlock.value === undefined) {
        values[subBlockId] = '-'
        return
      }

      // Special handling for dataset_id field - show dataset name instead of ID
      if (subBlockId === 'dataset_id' && typeof subBlock.value === 'string' && subBlock.value.trim().length > 0) {
        const dataset = datasets.find((d) => d.id === subBlock.value)
        if (dataset) {
          values[subBlockId] = dataset.name || dataset.id
          return
        }
        // If dataset not found, still show the ID
        values[subBlockId] = subBlock.value
        return
      }

      if (typeof subBlock.value === 'string') {
        values[subBlockId] = subBlock.value.trim().length > 0 ? subBlock.value : '-'
        return
      }

      if (typeof subBlock.value === 'number') {
        values[subBlockId] = String(subBlock.value)
        return
      }

      if (Array.isArray(subBlock.value)) {
        values[subBlockId] = `${subBlock.value.length} items`
        return
      }

      values[subBlockId] = String(subBlock.value)
    })

    return values
  }, [block, datasets])

  const getDisplayValue = (subBlockId: string): string => {
    return displayValues[subBlockId] ?? '-'
  }

  const visibleSubBlocks = useMemo(
    () => blockConfig.subBlocks.filter((sb) => !sb.hidden),
    [blockConfig.subBlocks]
  )

  // Get all handles for this block
  const allHandles = useMemo(() => getAllHandles(blockConfig), [blockConfig])
  
  // Filter handles based on block state (e.g., for SQL block with dynamic input count)
  const handles = useMemo(() => {
    // For SQL blocks, filter input handles based on inputCount
    if (type === 'sql' && block?.subBlocks?.inputCount) {
      const inputCountValue = block.subBlocks.inputCount.value
      const inputCount = typeof inputCountValue === 'string' 
        ? parseInt(inputCountValue, 10) 
        : typeof inputCountValue === 'number' 
        ? inputCountValue 
        : 1
      
      // Ensure inputCount is between 1 and 10
      const validInputCount = Math.max(1, Math.min(10, inputCount || 1))
      
      // Filter input handles to only show the first N handles
      const filteredInputs = allHandles.inputs
        .filter(handle => {
          // Extract the number from handle ID (e.g., "input-1" -> 1)
          const match = handle.id.match(/^input-(\d+)$/)
          if (match) {
            const handleNum = parseInt(match[1], 10)
            return handleNum <= validInputCount
          }
          // Keep non-input handles (like required handles)
          return true
        })
      
      return {
        inputs: filteredInputs,
        outputs: allHandles.outputs,
      }
    }
    
    // For other blocks, return all handles
    return allHandles
  }, [allHandles, type, block?.subBlocks?.inputCount])

  // Calculate dimensions based on visible subblocks
  useBlockDimensions({
    blockId: id,
    calculateDimensions: () => {
      const hasContent = visibleSubBlocks.length > 0
      const contentHeight = hasContent
        ? BLOCK_DIMENSIONS.WORKFLOW_CONTENT_PADDING +
          visibleSubBlocks.length * BLOCK_DIMENSIONS.WORKFLOW_ROW_HEIGHT
        : 0
      const calculatedHeight = Math.max(
        BLOCK_DIMENSIONS.HEADER_HEIGHT + contentHeight,
        BLOCK_DIMENSIONS.MIN_HEIGHT
      )

      return { width: BLOCK_DIMENSIONS.FIXED_WIDTH, height: calculatedHeight }
    },
    dependencies: [visibleSubBlocks.length],
  })

  // Render a single handle
  const renderHandle = (handle: HandleConfig, _index: number, allHandles: HandleConfig[]) => {
    const positionMap: Record<string, Position> = {
      top: Position.Top,
      bottom: Position.Bottom,
      left: Position.Left,
      right: Position.Right,
    }

    const position = positionMap[handle.position] || Position.Top
    const styleConfig = getHandleStyle(handle)
    const positionStyle = calculateHandlePosition(
      handle,
      allHandles.filter(h => h.position === handle.position && h.type === handle.type).length,
      handle.position
    )

    // Base classes for handle
    const baseClasses = cn(
      '!z-[10] !cursor-crosshair !border-none !transition-all !duration-150',
      '!bg-[var(--surface-12)]',
      handle.position === 'top' && '!top-[-7px] !h-[7px] !w-5 !rounded-t-[2px] !rounded-b-none hover:!top-[-10px] hover:!h-[10px] hover:!rounded-t-full',
      handle.position === 'bottom' && '!bottom-[-7px] !h-[7px] !w-5 !rounded-b-[2px] !rounded-t-none hover:!bottom-[-10px] hover:!h-[10px] hover:!rounded-b-full',
      handle.position === 'left' && '!left-[-7px] !w-[7px] !h-5 !rounded-l-[2px] !rounded-r-none hover:!left-[-10px] hover:!w-[10px] hover:!rounded-l-full',
      handle.position === 'right' && '!right-[-7px] !w-[7px] !h-5 !rounded-r-[2px] !rounded-l-none hover:!right-[-10px] hover:!w-[10px] hover:!rounded-r-full',
      // Style variants
      handle.style === 'error' && '!bg-red-500 hover:!bg-red-600',
      handle.style === 'success' && '!bg-green-500 hover:!bg-green-600',
      handle.style === 'warning' && '!bg-yellow-500 hover:!bg-yellow-600',
      handle.style === 'primary' && '!bg-blue-500 hover:!bg-blue-600'
    )

    // Calculate label position based on handle position
    const getLabelStyle = (): React.CSSProperties => {
      const baseStyle: React.CSSProperties = {
        pointerEvents: 'none',
        zIndex: 1000,
      }

      if (handle.position === 'top') {
        return {
          ...baseStyle,
          bottom: '-20px',
          left: '50%',
          transform: 'translateX(-50%)',
        }
      } else if (handle.position === 'bottom') {
        return {
          ...baseStyle,
          top: '-20px',
          left: '50%',
          transform: 'translateX(-50%)',
        }
      } else if (handle.position === 'left') {
        return {
          ...baseStyle,
          right: '-60px',
          top: '50%',
          transform: 'translateY(-50%)',
        }
      } else {
        // right
        return {
          ...baseStyle,
          left: '-60px',
          top: '50%',
          transform: 'translateY(-50%)',
        }
      }
    }

    return (
      <div
        key={handle.id}
        className="handle-wrapper group/handle relative"
        style={{
          position: 'absolute',
          ...positionStyle,
        }}
      >
        <Handle
          type={handle.type}
          position={position}
          id={handle.id}
          className={baseClasses}
          style={{
            backgroundColor: styleConfig.color,
          }}
          title={handle.description || handle.name}
        />
        {/* Show label only on hover */}
        {handle.name && (
          <span
            className="absolute text-[10px] text-[var(--text-tertiary)] whitespace-nowrap opacity-0 group-hover/handle:opacity-100 transition-opacity duration-150 bg-[var(--surface-1)] px-1.5 py-0.5 rounded border border-[var(--border)] shadow-sm"
            style={getLabelStyle()}
          >
            {handle.name}
          </span>
        )}
      </div>
    )
  }

  return (
    <div className='group relative'>
      <div
        className={cn(
          'relative z-[20] w-[250px] cursor-default select-none rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)]',
          !isEnabled && 'opacity-50'
        )}
      >
        <div
          className='workflow-drag-handle flex cursor-grab items-center justify-between border-[var(--divider)] border-b p-[8px] [&:active]:cursor-grabbing'
          onMouseDown={(e) => {
            e.stopPropagation()
          }}
        >
          <div className='flex min-w-0 flex-1 items-center gap-[10px]'>
            <div
              className='flex h-[24px] w-[24px] flex-shrink-0 items-center justify-center rounded-[6px]'
              style={{
                backgroundColor: isEnabled ? blockConfig.bgColor : 'gray',
              }}
            >
              <blockConfig.icon className='h-[16px] w-[16px] text-white' />
            </div>
            <span
              className={cn(
                'font-medium text-[16px]',
                !isEnabled && 'truncate text-[#808080]'
              )}
              title={name}
            >
              {name}
            </span>
          </div>
          {selected && onDelete && (
            <button
              className='nodrag nopan flex h-6 w-6 flex-shrink-0 cursor-pointer items-center justify-center rounded transition-colors hover:bg-[var(--surface-9)]'
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onDelete(id)
              }}
              title='Delete block'
            >
              <X className='h-4 w-4 text-red-500' />
            </button>
          )}
        </div>

        {visibleSubBlocks.length > 0 && (
          <div className='px-[12px] py-[8px]'>
            <div className='space-y-[4px]'>
              {visibleSubBlocks.map((subBlock, index) => (
                <div
                  key={`${subBlock.id}-${index}`}
                  className='flex items-center gap-[8px]'
                >
                  <span
                    className='min-w-0 truncate text-[14px] text-[var(--text-tertiary)] capitalize'
                    title={subBlock.title || subBlock.id}
                  >
                    {subBlock.title || subBlock.id}
                  </span>
                  {getDisplayValue(subBlock.id) !== '-' && (
                    <span
                      className='flex-1 truncate text-right text-[14px] text-[var(--text-primary)]'
                      title={getDisplayValue(subBlock.id)}
                    >
                      {getDisplayValue(subBlock.id)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Render all input handles */}
        {handles.inputs.map((handle, index) => 
          renderHandle(handle, index, handles.inputs)
        )}
        
        {/* Render all output handles */}
        {handles.outputs.map((handle, index) => 
          renderHandle(handle, index, handles.outputs)
        )}
      </div>
    </div>
  )
})

