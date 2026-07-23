import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import { type NodeProps } from 'reactflow'
import remarkGfm from 'remark-gfm'
import { X } from 'lucide-react'
import { getBlock } from '@/blocks'
import { cn } from '@/lib/utils'
import { BLOCK_DIMENSIONS, useBlockDimensions } from '@/hooks/use-block-dimensions'
import { useWorkflowStore } from '@/stores/workflow/store'

interface NoteBlockData {
  type: string
  name: string
  enabled?: boolean
  onDelete?: (blockId: string) => void
}

export const NoteBlock = memo(function NoteBlock({
  id,
  data,
  selected,
}: NodeProps<NoteBlockData>) {
  const { type, name, enabled = true, onDelete } = data
  const blockConfig = getBlock(type)

  if (!blockConfig) {
    return null
  }

  const block = useWorkflowStore((state) => state.blocks[id])
  const isEnabled = enabled && (block?.enabled ?? true)

  const noteValues = useMemo(() => {
    const format = block?.subBlocks.format?.value
    const content = block?.subBlocks.content?.value

    return {
      format: typeof format === 'string' ? format : 'plain',
      content: typeof content === 'string' ? content : '',
    }
  }, [block])

  const content = noteValues.content ?? ''
  const isEmpty = content.trim().length === 0
  const showMarkdown = noteValues.format === 'markdown' && !isEmpty

  // Calculate dimensions based on content
  useBlockDimensions({
    blockId: id,
    calculateDimensions: () => {
      let contentHeight = Number(BLOCK_DIMENSIONS.NOTE_MIN_CONTENT_HEIGHT)

      if (!isEmpty) {
        // Estimate height based on content length and line breaks
        const lineCount = content.split('\n').length
        const estimatedLines = Math.max(lineCount, Math.ceil(content.length / 50))
        // Each line is approximately 20px, minimum 3 lines
        contentHeight = Math.max(
          estimatedLines * 20,
          Number(BLOCK_DIMENSIONS.NOTE_BASE_CONTENT_HEIGHT)
        )
      }

      const calculatedHeight =
        Number(BLOCK_DIMENSIONS.HEADER_HEIGHT) +
        Number(BLOCK_DIMENSIONS.NOTE_CONTENT_PADDING) +
        contentHeight

      return {
        width: Number(BLOCK_DIMENSIONS.FIXED_WIDTH),
        height: calculatedHeight,
      }
    },
    dependencies: [isEmpty, content.length, content.split('\n').length],
  })

  return (
    <div className='group relative'>
      <div
        className={cn(
          'relative z-[20] w-[250px] cursor-default select-none rounded-[8px] bg-[var(--surface-2)]',
          !isEnabled && 'opacity-50'
        )}
      >
        <div
          className='note-drag-handle flex cursor-grab items-center justify-between border-[var(--divider)] border-b p-[8px] [&:active]:cursor-grabbing'
          onMouseDown={(event) => {
            event.stopPropagation()
          }}
        >
          <div className='flex min-w-0 flex-1 items-center gap-[10px]'>
            <div
              className='flex h-[24px] w-[24px] flex-shrink-0 items-center justify-center rounded-[6px]'
              style={{ backgroundColor: isEnabled ? blockConfig.bgColor : 'gray' }}
            >
              <blockConfig.icon className='h-[16px] w-[16px] text-white' />
            </div>
            <span
              className={cn('font-medium text-[16px]', !isEnabled && 'truncate text-[#808080]')}
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

        <div className='relative px-[12px] pt-[6px] pb-[8px]'>
          <div className='relative break-words'>
            {isEmpty ? (
              <p className='text-[#868686] text-sm italic'>Add a note...</p>
            ) : showMarkdown ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  p: ({ children }: any) => (
                    <p className='mb-2 break-words text-[#E5E5E5] text-sm'>{children}</p>
                  ),
                  h1: ({ children }: any) => (
                    <h1 className='mt-3 mb-1 break-words font-semibold text-[#E5E5E5] text-lg first:mt-0'>
                      {children}
                    </h1>
                  ),
                  h2: ({ children }: any) => (
                    <h2 className='mt-3 mb-1 break-words font-semibold text-[#E5E5E5] text-base first:mt-0'>
                      {children}
                    </h2>
                  ),
                  ul: ({ children }: any) => (
                    <ul className='mt-1 mb-2 list-disc break-words pl-4 text-[#E5E5E5] text-sm'>
                      {children}
                    </ul>
                  ),
                  code: ({ inline, children }: any) => {
                    if (inline) {
                      return (
                        <code className='whitespace-normal rounded bg-gray-200 px-1 py-0.5 font-mono text-[#F59E0B] text-xs dark:bg-[var(--surface-11)] dark:text-[#F59E0B]'>
                          {children}
                        </code>
                      )
                    }
                    return (
                      <code className='block whitespace-pre-wrap rounded bg-gray-200 p-2 font-mono text-[#F59E0B] text-xs dark:bg-[var(--surface-11)] dark:text-[#F59E0B]'>
                        {children}
                      </code>
                    )
                  },
                }}
              >
                {content}
              </ReactMarkdown>
            ) : (
              <p className='break-words text-[#E5E5E5] text-sm whitespace-pre-wrap'>{content}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})

