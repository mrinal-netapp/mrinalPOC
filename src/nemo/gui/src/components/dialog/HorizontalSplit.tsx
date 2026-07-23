import { ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { makeStyles, tokens } from '@fluentui/react-components'

/**
 * Two-pane layout with a draggable vertical divider.
 *
 * **`pinnedSide: 'left'`** — left column has a fixed width (px), right column
 * takes the remainder (`1fr`). Dragging the splitter resizes the left pane.
 *
 * **`pinnedSide: 'right'`** — right column has a fixed width; the **tree /
 * primary list on the left grows with the window** (`1fr`). Use this when the
 * left side shows long labels (SVM names, volumes) and the right side is a
 * narrow details panel — extra modal width goes to the tree, not empty space
 * on the right.
 */

const useStyles = makeStyles({
  container: {
    display: 'grid',
    height: '100%',
    width: '100%',
    minHeight: 0,
    minWidth: 0,
    overflow: 'hidden',
  },
  pane: {
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  splitter: {
    cursor: 'col-resize',
    backgroundColor: tokens.colorNeutralStroke2,
    width: '4px',
    transition: 'background-color 120ms ease',
    position: 'relative',
    flexShrink: 0,
    '&:hover': {
      backgroundColor: tokens.colorBrandStroke1,
    },
    '&:focus-visible': {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '-1px',
    },
  },
  splitterDragging: {
    backgroundColor: tokens.colorBrandStroke1,
  },
  splitterGrip: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: '2px',
    height: '24px',
    borderLeft: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    pointerEvents: 'none',
  },
})

export interface HorizontalSplitProps {
  left: ReactNode
  right?: ReactNode | null
  /**
   * Which side keeps a fixed pixel width. `'right'` is best for tree + narrow
   * details: the tree column absorbs extra horizontal space.
   */
  pinnedSide?: 'left' | 'right'
  /** Fixed width of the left column when `pinnedSide` is `'left'`. */
  initialLeftPx?: number
  /** Fixed width of the right column when `pinnedSide` is `'right'`. */
  initialRightPx?: number
  minLeftPx?: number
  minRightPx?: number
  storageKey?: string
}

const readPersistedWidth = (key?: string): number | null => {
  if (!key || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

const persistWidth = (key: string | undefined, width: number) => {
  if (!key || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, String(Math.round(width)))
  } catch {
    // ignore
  }
}

export function HorizontalSplit({
  left,
  right,
  pinnedSide = 'left',
  initialLeftPx = 560,
  initialRightPx = 360,
  minLeftPx = 320,
  minRightPx = 240,
  storageKey,
}: HorizontalSplitProps) {
  const styles = useStyles()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const initialFixed =
    pinnedSide === 'right'
      ? readPersistedWidth(storageKey) ?? initialRightPx
      : readPersistedWidth(storageKey) ?? initialLeftPx
  const [fixedPx, setFixedPx] = useState<number>(initialFixed)
  const [dragging, setDragging] = useState(false)
  const hasRight = right !== null && right !== undefined && right !== false

  useEffect(() => {
    if (!containerRef.current || !hasRight) return
    const total = containerRef.current.clientWidth
    if (pinnedSide === 'left') {
      const maxLeft = Math.max(minLeftPx, total - minRightPx - 4)
      setFixedPx((prev) => Math.min(Math.max(prev, minLeftPx), maxLeft))
    } else {
      const maxRight = Math.max(minRightPx, total - minLeftPx - 4)
      setFixedPx((prev) => Math.min(Math.max(prev, minRightPx), maxRight))
    }
  }, [hasRight, minLeftPx, minRightPx, pinnedSide])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)
  }, [])

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      const c = containerRef.current
      if (!c) return
      const rect = c.getBoundingClientRect()
      const total = rect.width
      if (pinnedSide === 'left') {
        const proposed = e.clientX - rect.left
        const maxLeft = Math.max(minLeftPx, total - minRightPx - 4)
        setFixedPx(Math.min(Math.max(proposed, minLeftPx), maxLeft))
      } else {
        const rightW = Math.round(rect.right - e.clientX)
        const maxRight = Math.max(minRightPx, total - minLeftPx - 4)
        setFixedPx(Math.min(Math.max(rightW, minRightPx), maxRight))
      }
    }
    const onUp = () => setDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [dragging, minLeftPx, minRightPx, pinnedSide])

  useEffect(() => {
    if (dragging) return
    persistWidth(storageKey, fixedPx)
  }, [dragging, fixedPx, storageKey])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      const c = containerRef.current
      const total = c?.clientWidth ?? 0
      const step = e.shiftKey ? 32 : 8
      if (pinnedSide === 'left') {
        const maxLeft = Math.max(minLeftPx, total - minRightPx - 4)
        setFixedPx((prev) => {
          const proposed = prev + (e.key === 'ArrowLeft' ? -step : step)
          return Math.min(Math.max(proposed, minLeftPx), maxLeft)
        })
      } else {
        const maxRight = Math.max(minRightPx, total - minLeftPx - 4)
        setFixedPx((prev) => {
          // ArrowRight widens the right (details) pane; ArrowLeft narrows it.
          const delta = e.key === 'ArrowRight' ? step : -step
          const proposed = prev + delta
          return Math.min(Math.max(proposed, minRightPx), maxRight)
        })
      }
    },
    [minLeftPx, minRightPx, pinnedSide]
  )

  if (!hasRight) {
    return (
      <div ref={containerRef} className={styles.container} style={{ gridTemplateColumns: '1fr' }}>
        <div className={styles.pane}>{left}</div>
      </div>
    )
  }

  const columns =
    pinnedSide === 'left'
      ? `${fixedPx}px 4px 1fr`
      : `1fr 4px ${fixedPx}px`

  return (
    <div
      ref={containerRef}
      className={styles.container}
      style={{ gridTemplateColumns: columns }}
    >
      <div className={styles.pane}>{left}</div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={fixedPx}
        tabIndex={0}
        className={`${styles.splitter}${dragging ? ` ${styles.splitterDragging}` : ''}`}
        onMouseDown={onMouseDown}
        onKeyDown={onKeyDown}
        title="Drag to resize"
      >
        <div className={styles.splitterGrip} />
      </div>
      <div className={styles.pane}>{right}</div>
    </div>
  )
}
