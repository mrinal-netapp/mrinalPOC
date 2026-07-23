import { useMemo, useState } from 'react'
import { getAllBlocks } from '@/blocks'
import { SearchIcon } from '@/components/icons'

/**
 * Filters out blocks that should be hidden from toolbar
 */
const getVisibleBlocks = (allBlocks: ReturnType<typeof getAllBlocks>) => {
  return allBlocks.filter((block) => !block.hideFromToolbar)
}

export const BlockPalette = () => {
  const [searchQuery, setSearchQuery] = useState('')

  const blocks = useMemo(() => {
    const allBlocks = getAllBlocks()
    const visibleBlocks = getVisibleBlocks(allBlocks)

    if (!searchQuery.trim()) {
      return visibleBlocks
    }

    const query = searchQuery.toLowerCase()
    return visibleBlocks.filter(
      (block) =>
        block.name.toLowerCase().includes(query) ||
        block.description?.toLowerCase().includes(query) ||
        block.type.toLowerCase().includes(query)
    )
  }, [searchQuery])

  const onDragStart = (event: React.DragEvent, blockType: string) => {
    event.dataTransfer.setData('application/reactflow', blockType)
    event.dataTransfer.effectAllowed = 'move'
  }

  return (
    <div className='flex h-full w-64 flex-col border-r border-[var(--divider)] bg-[var(--surface-2)]'>
      <div className='border-b border-[var(--divider)] p-4'>
        <h2 className='mb-3 text-sm font-semibold text-[var(--text-primary)]'>Blocks</h2>
        <div className='relative'>
          <SearchIcon className='absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-tertiary)]' />
          <input
            type='text'
            placeholder='Search blocks...'
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className='w-full rounded border border-[var(--border)] bg-[var(--surface-1)] py-1.5 pl-8 pr-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:border-[var(--border-focus)] focus:outline-none'
          />
        </div>
      </div>
      <div className='flex-1 overflow-y-auto p-4'>
        {blocks.length === 0 ? (
          <div className='py-8 text-center text-sm text-[var(--text-tertiary)]'>
            No blocks found
          </div>
        ) : (
          <div className='space-y-2'>
            {blocks.map((block) => (
              <div
                key={block.type}
                draggable
                onDragStart={(e) => onDragStart(e, block.type)}
                className='flex cursor-move items-center gap-2 rounded border border-[var(--border)] bg-[var(--surface-1)] p-2 transition-colors hover:border-[var(--border-focus)] hover:bg-[var(--surface-3)] active:scale-[0.98]'
                title={block.description}
              >
                <div
                  className='flex h-[24px] w-[24px] flex-shrink-0 items-center justify-center rounded-[6px]'
                  style={{ backgroundColor: block.bgColor }}
                >
                  <block.icon className='h-[16px] w-[16px] text-white' />
                </div>
                <div className='min-w-0 flex-1'>
                  <div className='font-medium text-[14px] text-[var(--text-primary)]'>
                    {block.name}
                  </div>
                  <div className='truncate text-[12px] text-[var(--text-tertiary)]'>
                    {block.description}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

