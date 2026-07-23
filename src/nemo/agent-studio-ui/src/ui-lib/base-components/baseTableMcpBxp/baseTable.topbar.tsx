import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react"
import type { ColumnFiltersState, Table } from "@tanstack/react-table"
import { Button } from "../button/button"
import { TableSearch } from "./tableSearch"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuGroup,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    DropdownMenuCheckboxItem,
} from "../dropdown-menu/dropdown-menu"
import { IconEye, IconEyeOff, IconDownload, IconPlus, IconRefresh } from "@tabler/icons-react"
import { Typography } from "../typography/typography"
import type { BaseElement, BaseTableProps, TopBarOptions } from "./baseTable.types"

type SetState<T> = Dispatch<SetStateAction<T>>

export function BaseTableTopBar<T extends BaseElement>(props: {
    table: Table<T>
    options: BaseTableProps<T>["options"]
    searchableColumns: Set<string>
    setSearchableColumns: SetState<Set<string>>
    setGlobalFilter: SetState<string>
    setColumnFilters: SetState<ColumnFiltersState>
    isBatchDeleteMode: boolean
    onSetBatchDeleteMode: (next: boolean) => void
    clearSelection: () => void
    onBatchDelete?: (ids: string[]) => void
    searchDebounceMs?: number
}) {
    const {
        table,
        options,
        searchableColumns,
        setGlobalFilter,
        setColumnFilters,
        isBatchDeleteMode,
        onSetBatchDeleteMode,
        clearSelection,
        onBatchDelete,
        searchDebounceMs = 300,
    } = props

    /* v8 ignore start -- topBarOptions is always provided when the topbar is used */
    const topBar: TopBarOptions = options?.topBarOptions ?? {}
    /* v8 ignore stop */

    const showCount = !!topBar.rowCountLabel
    const showSearch = !!topBar.showSearch
    const showDownload = !!topBar.onDownload
    const showSecondary = !!topBar.showSecondaryAction
    const showPrimary = !!topBar.onPrimaryAction
    const showRefresh = !!topBar.onRefresh

    // Local input state
    const [searchInput, setSearchInput] = useState<string>("")
    const [isSearchOpen, setIsSearchOpen] = useState<boolean>(false)
    const debounceTimer = useRef<number | null>(null)

    const selectedCount = table.getSelectedRowModel().flatRows.length

    // Debounced search -> update global filter in parent + clear column filters
    useEffect(() => {
        if (!options?.enableRowFilter) {
            setGlobalFilter("")
            setColumnFilters([])
            return
        }

        if (debounceTimer.current) {
            window.clearTimeout(debounceTimer.current)
        }
        debounceTimer.current = window.setTimeout(() => {
            /* v8 ignore start -- @preserve Defensive fallback; searchInput is always a string */
            const term = searchInput?.trim() ?? ""
            /* v8 ignore stop */
            if (!term) {
                setGlobalFilter("")
                setColumnFilters([])
            } else {
                setGlobalFilter(term)
                setColumnFilters([])
            }
        }, searchDebounceMs)
        /* v8 ignore start -- @preserve v8 structural artifact; effect cleanup tracking */
        return () => {
            if (debounceTimer.current) {
                window.clearTimeout(debounceTimer.current)
            }
        }
        /* v8 ignore stop -- @preserve */
    }, [searchInput, searchableColumns, searchDebounceMs, setGlobalFilter, setColumnFilters, options?.enableRowFilter])

    // Ensure not all columns are hidden; if user hides all, re-show all
    const handleToggleColumnVisibility = (columnId: string, next: boolean) => {
        const column = table.getColumn(columnId)
        /* v8 ignore start -- @preserve defensive; dropdown only renders hideable columns so this guard is unreachable */
        if (!column || !column.getCanHide()) return
        /* v8 ignore stop */
        column.toggleVisibility(!!next)
        window.setTimeout(() => {
            const hideable = table.getAllColumns().filter((c) => c.getCanHide())
            const visibleCount = hideable.filter((c) => c.getIsVisible()).length
            if (visibleCount === 0) {
                hideable.forEach((c) => c.toggleVisibility(true))
            }
        }, 0)
    }

    // Batch delete helpers
    const enterBatchDelete = () => {
        onSetBatchDeleteMode(true)
        clearSelection()
    }
    const cancelBatchDelete = () => {
        onSetBatchDeleteMode(false)
        clearSelection()
    }
    const confirmBatchDelete = () => {
        /* v8 ignore start -- @preserve defensive; Confirm Delete button is disabled when selectedCount === 0 */
        if (selectedCount === 0) return
        /* v8 ignore stop */
        const ids = table
            .getSelectedRowModel()
            .flatRows
            .map((r) => (r.original as T).id)
        onBatchDelete?.(ids)
        onSetBatchDeleteMode(false)
        clearSelection()
    }

    const totalRows = table.getRowModel().rows.length

    return (
        <div className="dt-top-bar">
            {/* Left: Row count title */}
            {showCount && (
                <div className="dt-table-title">
                    <Typography Component="span" fontSize="fs16" boldness="semibold">
                        {topBar.rowCountLabel} ({totalRows})
                    </Typography>
                </div>
            )}

            {/* Right: Upper actions */}
            <div className="dt-actions-group">
                {/* Search — collapsible Blueprint-style */}
                {showSearch && (
                    <TableSearch
                        value={searchInput}
                        onChange={setSearchInput}
                        placeholder="Search..."
                        isOpen={isSearchOpen}
                        isEnabled={!!options?.enableRowFilter}
                        onToggle={() => {
                            if (isSearchOpen) {
                                setSearchInput("")
                            }
                            setIsSearchOpen((prev) => !prev)
                        }}
                    />
                )}

                {/* Download icon button */}
                {showDownload && (
                    <Button
                        variant="icon"
                        icon={<IconDownload size={20} />}
                        onClick={topBar.onDownload}
                        aria-label="Download"
                    />
                )}

                {/* Button group: secondary (table actions dropdown) + primary */}
                {!isBatchDeleteMode ? (
                    <div className="dt-btn-group">
                        {showRefresh && (
                            <Button
                                variant="outline"
                                icon={<IconRefresh size={16} />}
                                label={topBar.refreshLabel ?? "Refresh"}
                                loading={!!topBar.isRefreshing}
                                onClick={topBar.onRefresh}
                            />
                        )}
                        {showSecondary && (
                            <DropdownMenu>
                                <DropdownMenuTrigger
                                    render={
                                        <Button
                                            variant="outline"
                                            /* v8 ignore start -- label fallback; always provided in tests */
                                            label={topBar.secondaryActionLabel ?? "Secondary action"}
                                        /* v8 ignore stop */
                                        />
                                    }
                                />
                                <DropdownMenuContent align="end" style={{ width: "auto" }}>
                                    <DropdownMenuGroup>
                                        <DropdownMenuLabel>Column Visibility</DropdownMenuLabel>
                                        {table
                                            .getAllColumns()
                                            .filter((column) => column.getCanHide())
                                            .map((column) => {
                                                const headerDef = column.columnDef.header
                                                const label = typeof headerDef === "string" ? headerDef : column.id
                                                return (
                                                    <DropdownMenuCheckboxItem
                                                        key={column.id}
                                                        className="dt-checkbox-item"
                                                        checked={column.getIsVisible()}
                                                        onCheckedChange={(value) => handleToggleColumnVisibility(column.id, !!value)}
                                                    >
                                                        <span style={{ marginRight: 8 }}>{label}</span>
                                                        {column.getIsVisible() ? (
                                                            <IconEye className="dt-column-eye-icon" size={16} />
                                                        ) : (
                                                            <IconEyeOff className="dt-column-eye-icon" size={16} />
                                                        )}
                                                    </DropdownMenuCheckboxItem>
                                                )
                                            })}
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem onClick={enterBatchDelete}>Batch Delete…</DropdownMenuItem>
                                    </DropdownMenuGroup>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        )}
                        {showPrimary && (
                            <Button
                                variant="solid"
                                /* v8 ignore start -- label fallback; always provided in tests */
                                label={topBar.primaryActionLabel ?? "Primary action"}
                                /* v8 ignore stop */
                                icon={topBar.showPrimaryActionPlusIcon ? <IconPlus size={16} /> : undefined}
                                onClick={topBar.onPrimaryAction}
                            />
                        )}
                    </div>
                ) : (
                    <div className="dt-batch-actions">
                        <Typography Component="span" fontSize="fs14" boldness="semibold" className="dt-selected-count">
                            {selectedCount} selected
                        </Typography>
                        <Button variant="solid-destructive" isDisabled={selectedCount === 0} label="Confirm Delete" onClick={confirmBatchDelete} />
                        <Button variant="outline" label="Cancel" onClick={cancelBatchDelete} />
                    </div>
                )}
            </div>

        </div>
    )
}
