import { X } from 'lucide-react'
import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getSmoothStepPath } from 'reactflow'

interface PipelineEdgeProps extends EdgeProps {
  sourceHandle?: string | null
  targetHandle?: string | null
  onDelete?: (edgeId: string) => void
}

export const PipelineEdge = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style,
  sourceHandle,
}: PipelineEdgeProps) => {
  const isHorizontal = sourcePosition === 'right' || sourcePosition === 'left'

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
    offset: isHorizontal ? 30 : 20,
  })

  const isSelected = data?.isSelected ?? false
  const isErrorEdge = (sourceHandle ?? data?.sourceHandle) === 'error'

  const edgeStyle = {
    ...(style ?? {}),
    strokeWidth: isSelected ? 2.5 : 2,
    stroke: isErrorEdge ? '#ef4444' : '#6b7280',
    opacity: isSelected ? 0.8 : 1,
  }

  return (
    <>
      <BaseEdge
        path={edgePath}
        data-testid='pipeline-edge'
        style={edgeStyle}
        interactionWidth={30}
        data-edge-id={id}
      />

      {isSelected && data?.onDelete && (
        <EdgeLabelRenderer>
          <div
            className='nodrag nopan flex h-5 w-5 cursor-pointer items-center justify-center rounded-full bg-red-500 transition-colors hover:bg-red-600'
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'all',
              zIndex: 100,
            }}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (data.onDelete) {
                data.onDelete(id)
              }
            }}
          >
            <X className='h-3 w-3 text-white' />
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

