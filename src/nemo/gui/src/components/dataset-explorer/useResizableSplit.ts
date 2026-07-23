import { useCallback, useEffect, useState, useRef } from 'react'

export interface UseResizableSplitOptions {
  initialHeight?: number // Initial height in pixels for the top panel
  minTopHeight?: number // Minimum height for top panel
  minBottomHeight?: number // Minimum height for bottom panel
  containerRef?: React.RefObject<HTMLElement>
}

export function useResizableSplit({
  initialHeight = 400,
  minTopHeight = 300,
  minBottomHeight = 200,
  containerRef,
}: UseResizableSplitOptions = {}) {
  const [topHeight, setTopHeight] = useState(initialHeight)
  const [isResizing, setIsResizing] = useState(false)
  const startYRef = useRef<number>(0)
  const startHeightRef = useRef<number>(initialHeight)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
    startYRef.current = e.clientY
    startHeightRef.current = topHeight
  }, [topHeight])

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const deltaY = e.clientY - startYRef.current
      const container = containerRef?.current
      
      if (!container) {
        // Fallback to window if no container ref
        const containerHeight = window.innerHeight
        let newHeight = startHeightRef.current + deltaY
        const maxHeight = containerHeight - minBottomHeight - 300
        newHeight = Math.max(minTopHeight, Math.min(newHeight, maxHeight))
        setTopHeight(newHeight)
        return
      }
      
      // Get container's bounding rect to calculate available height
      const containerRect = container.getBoundingClientRect()
      const containerHeight = containerRect.height
      
      // Calculate new height using delta
      let newHeight = startHeightRef.current + deltaY
      
      // Enforce minimum heights - account for resize handle (6px)
      const maxHeight = containerHeight - minBottomHeight - 6
      newHeight = Math.max(minTopHeight, Math.min(newHeight, maxHeight))
      
      setTopHeight(newHeight)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizing, minTopHeight, minBottomHeight, containerRef])

  return {
    topHeight,
    isResizing,
    handleMouseDown,
  }
}

