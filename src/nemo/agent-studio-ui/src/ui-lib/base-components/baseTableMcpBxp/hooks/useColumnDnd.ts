import { useState } from "react"
import type { Table, ColumnSizingInfoState } from "@tanstack/react-table"
import { arrayMove } from "@/utils/array"
import { createElementGhost, clearDragGhost } from "@/utils/drag-ghost"

/**
 * Column drag-and-drop state and handlers.
 * The drag ghost is a visual clone of the dragged `<th>`.
 */
export function useColumnDnd<TData>(params: {
    enabled: boolean
    columnOrder: string[]
    setColumnOrder: React.Dispatch<React.SetStateAction<string[]>>
    table: Table<TData>
    columnSizingInfo?: ColumnSizingInfoState
    dataTransferKey?: string
}) {
    const {
        enabled,
        columnOrder,
        setColumnOrder,
        table,
        columnSizingInfo,
        dataTransferKey = "text/column-id",
    } = params

    const [dragOverColumnId, setDragOverColumnId] = useState<string | null>(null)

    const isHeaderDraggable = (colId: string): boolean => {
        if (!enabled) return false
        if (columnSizingInfo?.isResizingColumn === colId) return false
        return true
    }

    const onDragStart = (e: React.DragEvent, sourceColId: string) => {
        if (!isHeaderDraggable(sourceColId)) return

        e.dataTransfer.setData(dataTransferKey, sourceColId)
        e.dataTransfer.effectAllowed = "move"

        const ghost = createElementGhost(e.currentTarget as HTMLElement)
        e.dataTransfer.setDragImage(ghost, 12, 12)
    }

    const onDragOver = (e: React.DragEvent, targetColId: string) => {
        if (!enabled) return

        e.preventDefault()
        setDragOverColumnId(targetColId)
    }

    const onDrop = (e: React.DragEvent, targetColId: string) => {
        if (!enabled) return

        e.preventDefault()

        const sourceColId = e.dataTransfer.getData(dataTransferKey)
        if (!sourceColId || sourceColId === targetColId) return

        // Get current order or derive from table
        const currentOrder =
            columnOrder && columnOrder.length
                ? columnOrder.slice()
                : table.getAllLeafColumns().map((c) => c.id)

        const fromIndex = currentOrder.indexOf(sourceColId)
        const toIndex = currentOrder.indexOf(targetColId)

        if (fromIndex === -1 || toIndex === -1) return

        const nextOrder = arrayMove(currentOrder, fromIndex, toIndex)
        setColumnOrder(nextOrder)
        setDragOverColumnId(null)
    }

    const onDragEnd = () => {
        setDragOverColumnId(null)
        clearDragGhost()
    }

    return {
        dragOverColumnId,
        isHeaderDraggable,
        onDragStart,
        onDragOver,
        onDrop,
        onDragEnd,
    }
}
