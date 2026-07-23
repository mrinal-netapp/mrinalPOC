import { useState } from "react"
import { arrayMove } from "@/utils/array"
import { createElementGhost, clearDragGhost } from "@/utils/drag-ghost"

/**
 * Row drag-and-drop state and handlers.
 * The drag ghost is a visual clone of the dragged `<tr>`.
 */
export function useRowDnd<T extends { id: string }>(params: {
    enabled: boolean
    rows: T[]
    setRows: React.Dispatch<React.SetStateAction<T[]>>
    dataTransferKey?: string
}) {
    const {
        enabled,
        rows,
        setRows,
        dataTransferKey = "text/plain",
    } = params

    const [dragOverId, setDragOverId] = useState<string | null>(null)

    const onDragStart = (e: React.DragEvent, sourceId: string) => {
        if (!enabled) return

        e.dataTransfer.setData(dataTransferKey, sourceId)
        e.dataTransfer.effectAllowed = "move"

        const ghost = createElementGhost(e.currentTarget as HTMLElement)
        e.dataTransfer.setDragImage(ghost, 12, 12)
    }

    const onDragOver = (e: React.DragEvent, targetId: string) => {
        if (!enabled) return

        e.preventDefault()
        setDragOverId(targetId)
    }

    const onDrop = (e: React.DragEvent, targetId: string) => {
        if (!enabled) return

        e.preventDefault()

        const sourceId = e.dataTransfer.getData(dataTransferKey)
        if (!sourceId || sourceId === targetId) return

        const fromIndex = rows.findIndex((r) => r.id === sourceId)
        const toIndex = rows.findIndex((r) => r.id === targetId)

        if (fromIndex === -1 || toIndex === -1) return

        setRows((prev) => arrayMove(prev, fromIndex, toIndex))
        setDragOverId(null)
    }

    const onDragEnd = () => {
        setDragOverId(null)
        clearDragGhost()
    }

    return {
        dragOverId,
        onDragStart,
        onDragOver,
        onDrop,
        onDragEnd,
    }
}
