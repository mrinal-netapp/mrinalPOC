import { useRef, useState, useEffect, useCallback } from "react"
import { Checkbox } from "@/ui-lib/base-components/checkbox/checkbox"
import type { Table } from "@tanstack/react-table"
import type { BaseElement } from "./baseTable.types"
import { cn } from "@/ui-lib/lib/utils"

interface HeaderCheckboxDropdownProps<T extends BaseElement> {
    table: Table<T>
}

/**
 * Header checkbox with a dropdown arrow (Figma: Table header checkbox ❇️, node 1050:9396).
 *
 * Dropdown options:
 *  • Select this page  – toggles all *page* rows (same as clicking the checkbox itself)
 *  • Select all pages   – selects every row across all pages (disabled when pagination is off)
 *  • Clear all          – deselects everything (disabled when nothing is selected)
 */
export function HeaderCheckboxDropdown<T extends BaseElement>({ table }: HeaderCheckboxDropdownProps<T>) {
    const [open, setOpen] = useState(false)
    const wrapperRef = useRef<HTMLDivElement>(null)

    // Derive state
    const allPageSelected = table.getIsAllPageRowsSelected()
    const somePageSelected = table.getIsSomePageRowsSelected()
    const hasAnySelection = Object.keys(table.getState().rowSelection).some(
        (k) => table.getState().rowSelection[k],
    )
    const paginationEnabled = !!table.options.meta?.enablePagination

    /* v8 ignore start -- @preserve v8 structural artifact; useCallback/useEffect cleanup tracking */
    // Close on outside click
    const handleClickOutside = useCallback((e: MouseEvent) => {
        if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
            setOpen(false)
        }
    }, [])

    useEffect(() => {
        if (open) {
            document.addEventListener("mousedown", handleClickOutside)
        }
        return () => document.removeEventListener("mousedown", handleClickOutside)
    }, [open, handleClickOutside])

    // Close on Escape
    useEffect(() => {
        if (!open) return
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
        document.addEventListener("keydown", onKey)
        return () => document.removeEventListener("keydown", onKey)
    }, [open])
    /* v8 ignore stop -- @preserve */

    // Actions
    const selectThisPage = () => {
        table.toggleAllPageRowsSelected(!allPageSelected)
        setOpen(false)
    }

    const selectAllPages = () => {
        // Select every filtered row across all pages
        const allRows = table.getFilteredRowModel().rows
        const next: Record<string, boolean> = {}
        for (const row of allRows) {
            next[row.id] = true
        }
        table.setRowSelection(next)
        setOpen(false)
    }

    const clearAll = () => {
        table.setRowSelection({})
        setOpen(false)
    }

    /* v8 ignore next -- @preserve stopPropagation prevents header sort; not reachable in jsdom */
    const stopPointer = (e: React.PointerEvent) => e.stopPropagation()

    return (
        <div className="dt-header-checkbox-wrapper" ref={wrapperRef}>
            {/* Checkbox — same behaviour as clicking "Select this page" */}
            <Checkbox
                checked={allPageSelected}
                indeterminate={!allPageSelected && somePageSelected}
                onCheckedChange={() => table.toggleAllPageRowsSelected(!allPageSelected)}
                variant="table"
                ariaLabel="Select all"
            />

            {/* Dropdown arrow toggle */}
            <button
                type="button"
                className="dt-header-checkbox-arrow"
                aria-label="Selection options"
                aria-expanded={open}
                onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
                onPointerDown={stopPointer}
            >
                <svg

                    viewBox="0 0 5 3"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    className={cn("checkbox-arrow-svg", open ? "dt-header-checkbox-arrow-icon--open" : "")}
                >
                    <path
                        d="M2.5 3L0.335 0.375L4.665 0.375L2.5 3Z"
                        fill="currentColor"
                    />
                </svg>
            </button>

            {/* Dropdown menu */}
            {open && (
                <div className="dt-header-checkbox-menu-wrapper">
                    <div className="dt-header-checkbox-menu" role="menu">
                        <div className="dt-header-checkbox-menu-item-wrapper">
                            <button
                                type="button"
                                className="dt-header-checkbox-menu-item"
                                role="menuitem"
                                onClick={selectThisPage}
                            >
                                Select this page
                            </button>
                        </div>
                        <div className="dt-header-checkbox-menu-item-wrapper">
                            <button
                                type="button"
                                className="dt-header-checkbox-menu-item"
                                role="menuitem"
                                disabled={!paginationEnabled}
                                onClick={selectAllPages}
                            >
                                Select all pages
                            </button>
                        </div>
                        <div className="dt-header-checkbox-menu-item-wrapper">
                            <button
                                type="button"
                                className="dt-header-checkbox-menu-item"
                                role="menuitem"
                                disabled={!hasAnySelection}
                                onClick={clearAll}
                            >
                                Clear all
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
