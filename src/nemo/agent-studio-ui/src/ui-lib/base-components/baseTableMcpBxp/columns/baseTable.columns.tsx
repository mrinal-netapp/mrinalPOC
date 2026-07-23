import { type ColumnDef } from "@tanstack/react-table"
import { Checkbox } from "@/ui-lib/base-components/checkbox/checkbox"
import { HeaderCheckboxDropdown } from "../headerCheckboxDropdown"
import type { BaseElement } from "../baseTable.types"
import ExpandArrow from "./expandArrow"

/**
 * Select column - shown when row selection is enabled
 */
export function getSelectColumn<T extends BaseElement>(): ColumnDef<T> {
    return {
        id: "select",
        size: 72,
        minSize: 72,
        enableResizing: false,
        enableSorting: false,
        enablePinning: true,
        header: ({ table }) => {
            if (!table.options.enableMultiRowSelection) return null
            return <HeaderCheckboxDropdown table={table} />
        },
        cell: ({ row }) => (
            <div className="dt-cell-checkbox">
                <Checkbox
                    checked={row.getIsSelected()}
                    isDisabled={!row.getCanSelect()}
                    onCheckedChange={(checked) => row.toggleSelected(!!checked)}
                    variant="table"
                    ariaLabel="Select row"
                />
            </div>
        ),
        enableHiding: false,
    }
}

/**
 * Expand column — module-level constant.
 *
 * The cell function reads `isExpanded` / `toggleExpanded` from
 * `table.options.meta` at render time, so the column definition object
 * (and crucially its `cell` function reference) never changes.
 *
 * Why this matters:
 *   flexRender treats `cell` as a React component via createElement.
 *   If the function reference changes between renders, React sees a
 *   different component type → unmounts the old DOM → mounts a new one,
 *   which kills any in-flight CSS transition (like the chevron rotation).
 *   By keeping the reference stable, React patches the existing DOM and
 *   CSS transitions work in both directions.
 */
export const EXPAND_COLUMN: ColumnDef<BaseElement> = {
    id: "expand",
    size: 72,
    minSize: 72,
    enableResizing: false,
    enableSorting: false,
    enableHiding: false,
    enablePinning: true,
    header: () => null,
    cell: ({ row, table }) => {
        /* v8 ignore start -- @preserve meta.isExpanded & meta.toggleExpanded are always provided by BaseTable; guards are defensive only */
        const isExpanded = table.options.meta?.isExpanded?.(row.original.id) ?? false
        const toggleExpanded = table.options.meta?.toggleExpanded
        if (!toggleExpanded) return null
        /* v8 ignore stop */

        return (
            <ExpandArrow
                isExpanded={isExpanded}
                rowId={row.original.id}
                toggleExpanded={toggleExpanded}
            />
        )
    },
}
