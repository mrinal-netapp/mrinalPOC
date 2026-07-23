import type { ColumnFiltersState, SortingState } from "@tanstack/react-table"
import type { BaseTableOptions } from "../baseTable.types"

/**
 * Compute reorder guards based on active sorting/filtering
 * Row drag is disabled when sorting or filtering is active
 * Column drag is always allowed (independent of sorting)
 */
export function useReorderGuards(params: {
    sorting: SortingState
    columnFilters: ColumnFiltersState
    options: Pick<BaseTableOptions, "enableRowDrag" | "enableColumnDrag">
}) {
    const { sorting, columnFilters, options } = params

    const canReorderRows = sorting.length === 0 && columnFilters.length === 0
    const allowRowDrag = !!options?.enableRowDrag && canReorderRows
    const allowColumnDrag = !!options?.enableColumnDrag

    return {
        canReorderRows,
        allowRowDrag,
        allowColumnDrag,
    }
}
