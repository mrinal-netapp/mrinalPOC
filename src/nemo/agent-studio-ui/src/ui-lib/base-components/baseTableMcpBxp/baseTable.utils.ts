import type { ColumnDef, FilterFn } from "@tanstack/react-table"

/**
 * Factory that builds a global-search filter function for TanStack Table.
 * Extracted so it can be unit-tested with plain mock rows.
 */
export function createGlobalSearchFn<T>(
    effectiveColumns: ColumnDef<T>[],
    searchableColumns: Set<string>,
): FilterFn<T> {
    return (row, _columnId, filterValue) => {
        const term = String(filterValue ?? "").toLowerCase()
        if (!term) return true
        const columnIds = effectiveColumns
            .filter(col => 'accessorKey' in col || 'id' in col)
            /* v8 ignore start -- @preserve Dead-code defensive fallback */
            .map(col => ('id' in col ? col.id : 'accessorKey' in col ? String(col.accessorKey) : ''))
            /* v8 ignore stop -- @preserve */
            .filter((id): id is string => Boolean(id))
        const effectiveIds = searchableColumns.size === 0
            ? new Set(columnIds)
            : searchableColumns
        for (const colId of effectiveIds) {
            const v = row.getValue(colId)
            if (v == null) continue
            const s = Array.isArray(v) ? v.join(" ") : String(v)
            if (s.toLowerCase().includes(term)) return true
        }
        return false
    }
}
