import { useState, useCallback } from 'react'

/**
 * Hook for tracking the position where the context menu was opened.
 * This position is used to place blocks when they are selected from the menu.
 */
export function useContextMenuPosition() {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)

  const setMenuPosition = useCallback((x: number, y: number) => {
    setPosition({ x, y })
  }, [])

  const clearPosition = useCallback(() => {
    setPosition(null)
  }, [])

  return {
    position,
    setMenuPosition,
    clearPosition,
  }
}

