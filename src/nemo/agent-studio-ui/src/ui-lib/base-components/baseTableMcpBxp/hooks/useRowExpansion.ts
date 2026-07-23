import { useState, useCallback, useRef, useEffect } from "react"

/** Duration of the collapse animation (ms). Must match SCSS. */
const COLLAPSE_DURATION = 300

/**
 * Manage row expansion state.
 * toggleExpanded and isExpanded are wrapped in useCallback so they keep
 * a stable reference across renders — critical for avoiding column-def
 * recreation that would cause React to unmount/remount cell components.
 *
 * closingIds tracks rows that are playing the collapse animation.
 * The row stays in the DOM during the animation, then is fully removed.
 */
export function useRowExpansion(initial?: Iterable<string>) {
    const [expandedIds, setExpandedIds] = useState<Set<string>>(
        initial ? new Set(initial) : new Set()
    )
    const [closingIds, setClosingIds] = useState<Set<string>>(new Set())
    const closingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

    /** Immutably add/remove an id from the closingIds set. */
    const updateClosing = (action: 'add' | 'delete', id: string) =>
        setClosingIds((prev) => {
            const next = new Set(prev)
            next[action](id)
            return next
        })

    /** Cancel a pending close timer for the given id (if any). */
    const clearTimer = (id: string) => {
        const timer = closingTimers.current.get(id)
        if (timer) {
            clearTimeout(timer)
            closingTimers.current.delete(id)
        }
    }

    const toggleExpanded = useCallback((id: string) => {
        setExpandedIds((prev) => {
            const next = new Set(prev)
            if (next.has(id)) {
                // Collapsing — keep in DOM via closingIds, remove after animation
                next.delete(id)
                updateClosing('add', id)
                clearTimer(id)
                const timer = setTimeout(() => {
                    updateClosing('delete', id)
                    closingTimers.current.delete(id)
                }, COLLAPSE_DURATION)
                closingTimers.current.set(id, timer)
            } else {
                // Expanding — cancel any in-flight close animation
                next.add(id)
                clearTimer(id)
                updateClosing('delete', id)
            }
            return next
        })
    }, [])

    const isExpanded = useCallback(
        (id: string) => expandedIds.has(id),
        [expandedIds]
    )

    const isClosing = useCallback(
        (id: string) => closingIds.has(id),
        [closingIds]
    )

    /** Row should be rendered if expanded OR still animating closed */
    const isRowVisible = useCallback(
        (id: string) => expandedIds.has(id) || closingIds.has(id),
        [expandedIds, closingIds]
    )

    useEffect(() => {
        const timers = closingTimers.current
        return () => {
            timers.forEach((timer) => clearTimeout(timer))
            timers.clear()
        }
    }, [])

    const expandAll = useCallback((ids: string[]) => {
        setExpandedIds(new Set(ids))
    }, [])

    const collapseAll = useCallback(() => {
        closingTimers.current.forEach((timer) => clearTimeout(timer))
        closingTimers.current.clear()
        setClosingIds(new Set())
        setExpandedIds(new Set())
    }, [])

    return {
        toggleExpanded,
        isExpanded,
        isClosing,
        isRowVisible,
        expandAll,
        collapseAll,
    }
}
