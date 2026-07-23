import { useCallback, useEffect, useState, useRef } from 'react'

export interface UseHorizontalResizeOptions {
  initialWidth?: number // Initial width in pixels for the left panel
  minLeftWidth?: number // Minimum width for left panel
  minRightWidth?: number // Minimum width for right panel
  containerRef?: React.RefObject<HTMLElement>
}

export function useHorizontalResize({
  initialWidth = 60, // Percentage
  minLeftWidth = 30, // Percentage
  minRightWidth = 20, // Percentage
  containerRef,
}: UseHorizontalResizeOptions = {}) {
  const [leftWidth, setLeftWidth] = useState(initialWidth)
  const [isResizing, setIsResizing] = useState(false)
  const startXRef = useRef<number>(0)
  const startWidthRef = useRef<number>(initialWidth)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
    startXRef.current = e.clientX
    startWidthRef.current = leftWidth
  }, [leftWidth])

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - startXRef.current
      const container = containerRef?.current
      
      if (!container) {
        return
      }
      
      // Get container's bounding rect to calculate available width
      const containerRect = container.getBoundingClientRect()
      const containerWidth = containerRect.width
      
      // Calculate new width percentage
      const deltaPercent = (deltaX / containerWidth) * 100
      let newWidth = startWidthRef.current + deltaPercent
      
      // Enforce minimum widths
      newWidth = Math.max(minLeftWidth, Math.min(newWidth, 100 - minRightWidth))
      
      setLeftWidth(newWidth)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizing, minLeftWidth, minRightWidth, containerRef])

  return {
    leftWidth,
    isResizing,
    handleMouseDown,
  }
}

