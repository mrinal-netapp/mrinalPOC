import { useState, useMemo, useRef, useEffect } from 'react'
import { Search } from 'lucide-react'
import { getAllBlocks } from '@/blocks'

/**
 * Allowed block types for the pipeline editor
 */
const ALLOWED_BLOCK_TYPES = [
  'agent',
  'api',
  'apply_func',
  'browser_use',
  'condition',
  'dataset_reader',
  'dataset_writer',
  'file',
  'filter',
  'function',
  'generate_embedding',
  'groupby_agg',
  'guardrails',
  'human_in_the_loop',
  'join',
  'knowledge',
  'mcp',
  'note',
  'openai', // Embeddings
  'memory',
  'publish_to_kb',
  'response',
  'router',
  'schedule',
  'sql',
  'start_trigger', // Start
  'variables',
  'wait',
  'workflow',
]

/**
 * Filters blocks to only show allowed blocks and those not hidden from toolbar
 */
const getVisibleBlocks = (allBlocks: ReturnType<typeof getAllBlocks>) => {
  return allBlocks.filter(
    (block) => !block.hideFromToolbar && ALLOWED_BLOCK_TYPES.includes(block.type)
  )
}

interface BlockContextMenuProps {
  isOpen: boolean
  position: { x: number; y: number }
  menuRef: React.RefObject<HTMLDivElement | null>
  onClose: () => void
  onSelectBlock: (blockType: string) => void
}

/**
 * Context menu component for adding blocks to the pipeline editor.
 * Appears on right-click and allows searching and selecting blocks.
 */
export function BlockContextMenu({
  isOpen,
  position,
  menuRef,
  onClose,
  onSelectBlock,
}: BlockContextMenuProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const blocks = useMemo(() => {
    const allBlocks = getAllBlocks()
    return getVisibleBlocks(allBlocks)
  }, [])

  // Focus search input when menu opens
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus()
    }
  }, [isOpen])

  // Filter blocks based on search query
  const filteredBlocks = useMemo(() => {
    if (!searchQuery.trim()) {
      return blocks
    }

    const query = searchQuery.toLowerCase()
    return blocks.filter((block) => {
      const nameMatch = block.name.toLowerCase().includes(query)
      const descriptionMatch = block.description?.toLowerCase().includes(query)
      const typeMatch = block.type.toLowerCase().includes(query)

      return nameMatch || descriptionMatch || typeMatch
    })
  }, [blocks, searchQuery])

  const handleBlockClick = (blockType: string, event: React.MouseEvent) => {
    // Prevent event from bubbling to parent (which would close the menu)
    event.stopPropagation()
    event.preventDefault()

    // Call the selection handler
    onSelectBlock(blockType)

    // Close menu and reset search
    onClose()
    setSearchQuery('')
  }

  if (!isOpen) {
    return null
  }

  // Calculate menu position to keep it within viewport
  const menuWidth = 320
  const maxHeight = 400
  
  // Get background color based on theme (light or dark mode)
  const isDarkMode = document.documentElement.classList.contains('dark')
  const backgroundColor = isDarkMode ? '#0a0a0a' : '#ffffff'
  
  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left: `${Math.max(0, Math.min(position.x, window.innerWidth - menuWidth))}px`,
    top: `${Math.max(0, Math.min(position.y, window.innerHeight - maxHeight))}px`,
    zIndex: 10000,
    backgroundColor: backgroundColor,
  }

  return (
    <div
      ref={menuRef as React.RefObject<HTMLDivElement>}
      data-context-menu
      className='w-[320px] rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] shadow-lg dark:border-[var(--border)] dark:bg-[var(--surface-1)]'
      style={menuStyle}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Search Header */}
      <div className='flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 dark:border-[var(--border)]'>
        <Search className='h-4 w-4 text-[var(--text-muted)]' />
        <input
          ref={searchInputRef}
          type='text'
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder='Search blocks...'
          className='flex-1 bg-transparent text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none dark:text-[var(--text-primary)]'
        />
      </div>

      {/* Blocks List */}
      <div className='max-h-[400px] overflow-y-auto p-2'>
        {filteredBlocks.length === 0 ? (
          <div className='py-8 text-center text-[13px] text-[var(--text-muted)]'>
            No blocks found matching &quot;{searchQuery}&quot;
          </div>
        ) : (
          <div className='space-y-1'>
            {filteredBlocks.map((block) => (
              <button
                key={block.type}
                onClick={(e) => handleBlockClick(block.type, e)}
                className='flex w-full cursor-pointer items-center gap-2 rounded-[4px] px-2 py-2 text-left transition-colors hover:bg-[var(--surface-9)] dark:hover:bg-[var(--surface-9)]'
                type='button'
              >
                <div
                  className='flex h-[24px] w-[24px] flex-shrink-0 items-center justify-center rounded-[6px]'
                  style={{ backgroundColor: block.bgColor }}
                >
                  <block.icon className='h-[16px] w-[16px] text-white' />
                </div>
                <div className='min-w-0 flex-1'>
                  <div className='font-medium text-[14px] text-[var(--text-primary)] dark:text-[var(--text-primary)]'>
                    {block.name}
                  </div>
                  <div className='truncate text-[12px] text-[var(--text-tertiary)] dark:text-[var(--text-tertiary)]'>
                    {block.description}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
