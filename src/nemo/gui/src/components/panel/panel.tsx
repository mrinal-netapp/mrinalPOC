import { useRef, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Pencil } from 'lucide-react'
import { usePanelStore } from '@/stores/panel/store'
import { usePanelResize } from '@/components/panel/hooks/use-panel-resize'
import { useWorkflowStore } from '@/stores/workflow/store'
import { getBlock } from '@/blocks'
import { PropertyEditor } from './property-editor'
import type { SubBlockConfig } from '@/blocks/types'
import type { BlockState } from '@/stores/workflow/types'

/**
 * Panel component with resizable width.
 * Displays block properties in a side panel on the right side of the pipeline editor.
 */
export function Panel() {
  const panelRef = useRef<HTMLElement>(null)
  const { panelWidth, _hasHydrated, setHasHydrated } = usePanelStore()
  const { handleMouseDown } = usePanelResize()
  const { selectedBlockId } = usePanelStore()
  const blocks = useWorkflowStore((state) => state.blocks)
  const block = selectedBlockId ? blocks[selectedBlockId] : null
  const blockConfig = block ? getBlock(block.type) : null
  const { projectId } = useParams<{ projectId: string }>()
  const { updateBlockName } = useWorkflowStore()
  const [isEditingName, setIsEditingName] = useState(false)
  const [editedName, setEditedName] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)

  /**
   * Mark hydration as complete on mount
   */
  useEffect(() => {
    setHasHydrated(true)
  }, [setHasHydrated])

  // Initialize CSS variable on mount (after hydration)
  useEffect(() => {
    if (typeof window !== 'undefined' && _hasHydrated) {
      document.documentElement.style.setProperty('--panel-width', `${panelWidth}px`)
    }
  }, [panelWidth, _hasHydrated])

  // Reset edit state when block changes
  useEffect(() => {
    setIsEditingName(false)
    setEditedName('')
  }, [selectedBlockId])

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus()
      nameInputRef.current.select()
    }
  }, [isEditingName])

  // Handle starting edit mode
  const handleStartEdit = () => {
    if (block) {
      setEditedName(block.name)
      setIsEditingName(true)
    }
  }

  // Handle saving the name
  const handleSaveName = () => {
    if (block && editedName.trim() !== '') {
      updateBlockName(block.id, editedName.trim())
    } else if (block) {
      // Reset to original name if empty
      setEditedName(block.name)
    }
    setIsEditingName(false)
  }

  // Handle canceling edit
  const handleCancelEdit = () => {
    if (block) {
      setEditedName(block.name)
    }
    setIsEditingName(false)
  }

  // Handle key events in input
  const handleNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSaveName()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleCancelEdit()
    }
  }

  // Helper function to evaluate condition
  const evaluateCondition = (condition: SubBlockConfig['condition'], blockState: BlockState | null): boolean => {
    if (!condition || !blockState) return true

    const conditionObj = typeof condition === 'function' ? condition() : condition
    if (!conditionObj) return true

    const fieldValue = blockState.subBlocks[conditionObj.field]?.value
    const expectedValue = conditionObj.value

    // Check if value matches
    let matches = false
    if (Array.isArray(expectedValue)) {
      matches = expectedValue.includes(fieldValue as any)
    } else {
      matches = fieldValue === expectedValue
    }

    // Apply NOT logic if specified
    if (conditionObj.not) {
      matches = !matches
    }

    // Check AND condition if specified
    if (conditionObj.and) {
      const andFieldValue = blockState.subBlocks[conditionObj.and.field]?.value
      const andExpectedValue = conditionObj.and.value
      let andMatches = false

      if (Array.isArray(andExpectedValue)) {
        andMatches = andExpectedValue.includes(andFieldValue as any)
      } else {
        andMatches = andFieldValue === andExpectedValue
      }

      if (conditionObj.and.not) {
        andMatches = !andMatches
      }

      matches = matches && andMatches
    }

    return matches
  }

  // Filter visible subBlocks based on conditions
  const visibleSubBlocks = useMemo(() => {
    if (!blockConfig || !block) return []
    return blockConfig.subBlocks.filter((subBlock) => {
      // Skip hidden subBlocks
      if (subBlock.hidden) return false

      // Evaluate condition if present
      if (subBlock.condition) {
        return evaluateCondition(subBlock.condition, block)
      }

      return true
    })
  }, [blockConfig, block])

  return (
    <>
      <aside
        ref={panelRef}
        className='panel-container h-full relative z-10 overflow-hidden dark:bg-[var(--surface-1)] flex-shrink-0'
        aria-label='Properties panel'
      >
        <div className='flex h-full flex-col border-l pt-[14px] dark:border-[var(--border)]'>
          {/* Header */}
          <div className='flex flex-shrink-0 items-center justify-between px-[8px]'>
            <h2 className='font-medium text-[14px] text-[var(--text-primary)] dark:text-[var(--text-primary)]'>
              Properties
            </h2>
          </div>

          {/* Content */}
          <div className='flex-1 overflow-y-auto pt-[12px] px-[8px]'>
            {_hasHydrated && block && blockConfig ? (
              <div className='space-y-4'>
                <div>
                  <label className='block text-sm font-medium text-[var(--text-primary)] mb-1'>
                    Block Name
                  </label>
                  {isEditingName ? (
                    <input
                      ref={nameInputRef}
                      type='text'
                      value={editedName}
                      onChange={(e) => setEditedName(e.target.value)}
                      onBlur={handleSaveName}
                      onKeyDown={handleNameKeyDown}
                      className='w-full rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)] focus:outline-none'
                      placeholder='Enter block name...'
                    />
                  ) : (
                    <div className='flex items-center gap-2 group'>
                      <span className='text-sm text-[var(--text-secondary)] flex-1'>{block.name}</span>
                      <button
                        type='button'
                        onClick={handleStartEdit}
                        className='opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-[var(--surface-3)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
                        title='Edit block name'
                      >
                        <Pencil className='h-3.5 w-3.5' />
                      </button>
                    </div>
                  )}
                </div>
                <div>
                  <label className='block text-sm font-medium text-[var(--text-primary)] mb-1'>
                    Block Type
                  </label>
                  <div className='text-sm text-[var(--text-secondary)]'>{block.type}</div>
                </div>
                {visibleSubBlocks.length > 0 && (
                  <div>
                    <label className='block text-sm font-medium text-[var(--text-primary)] mb-2'>
                      Configuration
                    </label>
                    <div className='space-y-4'>
                      {visibleSubBlocks.map((subBlock) => {
                        const value = block.subBlocks[subBlock.id]?.value
                        return (
                          <div key={subBlock.id} className='border-b border-[var(--border)] pb-3 last:border-b-0'>
                            <PropertyEditor
                              blockId={block.id}
                              subBlock={subBlock}
                              value={value}
                              projectId={projectId}
                            />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className='text-sm text-[var(--text-muted)] text-center py-8'>
                Select a block to view properties
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Resize Handle */}
      <div
        className='absolute top-0 right-[calc(var(--panel-width)-4px)] bottom-0 z-20 w-[8px] cursor-ew-resize'
        style={{ right: `${panelWidth - 4}px` }}
        onMouseDown={handleMouseDown}
        role='separator'
        aria-orientation='vertical'
        aria-label='Resize panel'
      />
    </>
  )
}

