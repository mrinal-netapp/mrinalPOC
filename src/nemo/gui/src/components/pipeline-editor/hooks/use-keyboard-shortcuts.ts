/**
 * Custom hook for keyboard shortcuts in the workflow editor
 */

import { useEffect } from 'react'
import { useReactFlow } from 'reactflow'
import { useWorkflowStore } from '@/stores/workflow/store'

/**
 * Hook that handles keyboard shortcuts for the workflow editor
 */
export function useKeyboardShortcuts() {
  const { getNodes } = useReactFlow()
  const { removeBlock } = useWorkflowStore()

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Ignore when typing/navigating inside editable inputs or editors
      const activeElement = document.activeElement
      const isEditableElement =
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        activeElement?.hasAttribute('contenteditable')

      // Handle Delete/Backspace for removing blocks
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (isEditableElement) {
          return
        }

        const selectedNodes = getNodes().filter((node) => node.selected)
        if (selectedNodes.length === 0) {
          return
        }

        event.preventDefault()

        try {
          const primaryNode = selectedNodes[0]
          removeBlock(primaryNode.id)
        } catch (err) {
          console.error('Failed to delete block via keyboard', { err })
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [getNodes, removeBlock])
}

