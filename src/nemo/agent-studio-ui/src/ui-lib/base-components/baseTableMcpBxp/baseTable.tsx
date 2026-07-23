import { Fragment, useEffect, useMemo, useState, type DragEvent } from "react"
import {
    flexRender,
    getCoreRowModel,
    getFilteredRowModel,
    getPaginationRowModel,
    getSortedRowModel,
    useReactTable,
    type ColumnDef,
    type ColumnFiltersState,
    type SortingState,
    type VisibilityState,
    type ColumnSizingState,
    type ColumnSizingInfoState,
    type ColumnPinningState,
} from "@tanstack/react-table"
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "./table/table"
import "./baseTableMcpBxp.scss"
import { cn } from "@/ui-lib/lib/utils"
import type { BaseElement, BaseTableProps } from "./baseTable.types"
import { Typography } from "../typography/typography"
import { Spinner } from "../spinner/spinner"
import { useReorderGuards } from "./hooks/useReorderGuards"
import { useRowExpansion } from "./hooks/useRowExpansion"
import { useRowDnd } from "./hooks/useRowDnd"
import { useColumnDnd } from "./hooks/useColumnDnd"
import { BaseTablePagination } from "./baseTable.pagination"
import { BaseTableTopBar } from "./baseTable.topbar"
import { getSelectColumn, EXPAND_COLUMN } from "./columns/baseTable.columns"
import { createGlobalSearchFn } from "./baseTable.utils"
export type { BaseElement, BaseTableOptions, BaseTableProps, JobTableRow, DataSourceRow, StatusEnumModel } from "./baseTable.types"

export default function BaseTable<T extends BaseElement>({ options, data, columns, isLoading, isError, onRowSelectionChange }: BaseTableProps<T>) {
    // Top bar handles debouncing internally
    const [rows, setRows] = useState<T[]>(data)
    // Apply feature gating based on options
    const allowMultiRowSelection = !!options?.enableRowMultiSelection
    const allowRowSelection = allowMultiRowSelection || !!options?.enableRowSelection
    const enableRowExpansion = !!options?.enableRowExpansion

    // Row expansion hook — isExpanded goes to table.options.meta for the expand column cell,
    // isClosing/isRowVisible are used directly in the accordion row template below.
    const { toggleExpanded, isExpanded, isClosing, isRowVisible } = useRowExpansion()

    // Merge base columns (select, expand) with user-provided columns.
    // EXPAND_COLUMN is a module-level constant — its cell function reads
    // state from table.options.meta at render time, so the function reference
    // never changes and React patches the DOM instead of remounting.
    const effectiveColumns: ColumnDef<T>[] = useMemo(() => [
        ...(allowRowSelection ? [getSelectColumn<T>()] : []),
        ...columns,
        ...(enableRowExpansion ? [EXPAND_COLUMN as ColumnDef<T>] : []),
    ], [allowRowSelection, columns, enableRowExpansion])

    const allowColumnSorting = !!options?.enableColumnSorting
    const allowPagination = !!options?.enablePagination

    const [sorting, setSorting] = useState<SortingState>([])
    const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
    const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
    const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({})
    const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({})
    const [columnSizingInfo, setColumnSizingInfo] = useState<ColumnSizingInfoState>({} as ColumnSizingInfoState)
    const [columnOrder, setColumnOrder] = useState<string[]>([])
    const [columnPinning, setColumnPinning] = useState<ColumnPinningState>({
        left: allowRowSelection ? ["select"] : [],
        right: enableRowExpansion ? ["expand"] : []
    })
    const [searchableColumns, setSearchableColumns] = useState<Set<string>>(new Set())
    const [isBatchDeleteMode, setIsBatchDeleteMode] = useState<boolean>(false)     // Batch delete state
    const [globalFilter, setGlobalFilter] = useState<string>("")

    // Notify parent when row selection changes
    useEffect(() => {
        onRowSelectionChange?.(rowSelection)
    }, [rowSelection, onRowSelectionChange])

    // Keep internal rows in sync with parent data updates (e.g., batch delete)
    useEffect(() => {
        setRows(data)
    }, [data])

    const globalSearchFn = useMemo(
        () => createGlobalSearchFn(effectiveColumns, searchableColumns),
        [effectiveColumns, searchableColumns],
    )

    const table = useReactTable({
        data: rows,
        columns: effectiveColumns,
        getRowId: (row) => row.id,
        onSortingChange: allowColumnSorting ? setSorting : undefined,
        onColumnFiltersChange: setColumnFilters,
        getCoreRowModel: getCoreRowModel(),
        getPaginationRowModel: allowPagination ? getPaginationRowModel() : undefined,
        getSortedRowModel: allowColumnSorting ? getSortedRowModel() : undefined,
        getFilteredRowModel: getFilteredRowModel(),
        onColumnVisibilityChange: setColumnVisibility,
        onGlobalFilterChange: setGlobalFilter,
        onRowSelectionChange: (updater) => {
            /* v8 ignore next 4 -- @preserve defensive guard; TanStack never fires this callback when enableRowSelection is false */
            if (!allowRowSelection) {
                setRowSelection({})
                return
            }
            /* v8 ignore next -- @preserve TanStack type-only branch; always passes a function */
            const next = typeof updater === "function" ? updater(rowSelection) : updater
            if (allowMultiRowSelection) {
                setRowSelection(next)
            } else {
                /* v8 ignore next -- @preserve Defensive fallback; next is never nullish */
                const selectedKeys = Object.keys(next || {}).filter((k) => next[k])
                if (selectedKeys.length <= 1) {
                    setRowSelection(next)
                } else {
                    const prevKeys = new Set(Object.keys(rowSelection).filter((k) => rowSelection[k]))
                    /* v8 ignore next -- @preserve Defensive fallback; find always succeeds */
                    const newKey = selectedKeys.find((k) => !prevKeys.has(k)) ?? selectedKeys[0]
                    /* v8 ignore next -- @preserve Defensive fallback; newKey is always truthy */
                    setRowSelection(newKey ? { [newKey]: true } : {})
                }
            }
        },
        onColumnSizingChange: setColumnSizing,
        onColumnSizingInfoChange: setColumnSizingInfo,
        onColumnPinningChange: setColumnPinning,
        columnResizeMode: "onChange",
        enableRowSelection: typeof options?.enableRowSelection === "function"
            ? (row) => (options.enableRowSelection as (r: T) => boolean)(row.original)
            : allowRowSelection,
        enableMultiRowSelection: allowMultiRowSelection || isBatchDeleteMode,
        enableSorting: allowColumnSorting,
        enableColumnPinning: true,
        globalFilterFn: globalSearchFn,
        meta: {
            enablePagination: allowPagination,
            enableRowExpansion,
            isExpanded,
            toggleExpanded,
        },
        initialState: {
            pagination: {
                pageSize: 10,
            },
        },
        state: {
            sorting: allowColumnSorting ? sorting : [],
            columnFilters,
            columnVisibility,
            rowSelection,
            columnSizing,
            columnSizingInfo,
            columnOrder,
            columnPinning,
            globalFilter,
        },
    })

    // Keep searchable columns in sync when leaf columns change
    useEffect(() => {
        const allIds = table.getAllLeafColumns().map((c) => c.id)
        const currentIds = new Set(allIds)
        setSearchableColumns((prev) => {
            /* v8 ignore next -- @preserve table ref is stable so this effect fires once per mount; the every() callback is unreachable on the initial run where sizes always differ */
            if (prev.size === currentIds.size && allIds.every((id) => prev.has(id))) return prev
            return currentIds
        })
    }, [table])

    // Drag-and-drop and expansion hooks
    const { allowRowDrag, allowColumnDrag } = useReorderGuards({
        sorting,
        columnFilters,
        options,
    })

    const rowDnd = useRowDnd({
        enabled: allowRowDrag,
        rows,
        setRows,
    })

    const columnDnd = useColumnDnd({
        enabled: allowColumnDrag,
        columnOrder,
        setColumnOrder,
        table,
        columnSizingInfo,
    })

    /* v8 ignore next -- @preserve Defensive fallback; columnFilters is always an array */
    const hasActiveFilters = globalFilter || (columnFilters?.length ?? 0) > 0

    return (
        <div className="dt-table">
            {options?.enableTableTopBar && (
                <BaseTableTopBar<T>
                    table={table}
                    options={options}
                    searchableColumns={searchableColumns}
                    setSearchableColumns={setSearchableColumns}
                    setGlobalFilter={setGlobalFilter}
                    setColumnFilters={setColumnFilters}
                    isBatchDeleteMode={isBatchDeleteMode}
                    onSetBatchDeleteMode={setIsBatchDeleteMode}
                    clearSelection={() => setRowSelection({})}
                    onBatchDelete={options?.onBatchDelete}
                />
            )}
            <div className="dt-shadow-wrapper">
                <div className={cn("dt-table-wrapper", options?.enableStickyHeaders && "dt-table-wrapper-sticky")}>
                    <Table style={{ tableLayout: "fixed" }}>
                        <colgroup>
                            {table.getVisibleLeafColumns().map((column) => (
                                <col key={column.id} style={{ width: column.getSize() }} />
                            ))}
                        </colgroup>
                        <TableHeader>
                            {table.getHeaderGroups().map((headerGroup) => (
                                <TableRow key={headerGroup.id}>
                                    {headerGroup.headers.map((header) => {
                                        /* v8 ignore start -- @preserve DnD handlers are thin wrappers; logic tested in useColumnDnd.test.ts */
                                        const handleColDragStart = (e: DragEvent<HTMLTableCellElement>) => columnDnd.onDragStart(e, header.column.id)
                                        const handleColDragOver = (e: DragEvent<HTMLTableCellElement>) => columnDnd.onDragOver(e, header.column.id)
                                        const handleColDrop = (e: DragEvent<HTMLTableCellElement>) => columnDnd.onDrop(e, header.column.id)
                                        /* v8 ignore stop -- @preserve */

                                        /* v8 ignore start -- @preserve resize requires real pointer events; not feasible in jsdom */
                                        const handleResizeMouseDown = (e: React.MouseEvent) => { e.stopPropagation(); header.getResizeHandler()(e) }
                                        const handleResizeTouchStart = (e: React.TouchEvent) => { e.stopPropagation(); header.getResizeHandler()(e) }
                                        /* v8 ignore stop -- @preserve */

                                        /* v8 ignore next -- @preserve DnD condition; jsdom limitation */
                                        const headerClass = cn(
                                            "dt-header",
                                            header.column.id === "actions" && "dt-header--actions",
                                            columnDnd.dragOverColumnId === header.column.id && "drag-over",
                                        )

                                        return (
                                            <TableHead
                                                key={header.id}
                                                className={headerClass}
                                                style={{ width: header.getSize(), cursor: allowColumnDrag ? undefined : "default" }}
                                                draggable={columnDnd.isHeaderDraggable(header.column.id)}
                                                onDragStart={handleColDragStart}
                                                onDragOver={handleColDragOver}
                                                onDrop={handleColDrop}
                                                onDragEnd={columnDnd.onDragEnd}
                                            >
                                                {header.isPlaceholder
                                                    ? null
                                                    : flexRender(
                                                        header.column.columnDef.header,
                                                        header.getContext()
                                                    )}
                                                {options?.enableColumnResizing && header.column.getCanResize() && (
                                                    <div
                                                        className="dt-col-resizer"
                                                        onMouseDown={handleResizeMouseDown}
                                                        onTouchStart={handleResizeTouchStart}
                                                    />
                                                )}
                                            </TableHead>
                                        )
                                    })}
                                </TableRow>
                            ))}
                        </TableHeader>
                        <TableBody>
                            {isLoading ? (
                                <TableRow>
                                    <TableCell colSpan={effectiveColumns.length} className="dt-empty-cell">
                                        <div className="dt-empty-message">
                                            <Spinner size="inline" />
                                            <Typography Component="span" fontSize="fs14" boldness="semibold" className="dt-empty-text">
                                                Loading…
                                            </Typography>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ) : isError ? (
                                <TableRow>
                                    <TableCell colSpan={effectiveColumns.length} className="dt-empty-cell">
                                        <div className="dt-empty-message">
                                            <div className="dt-empty-icon dt-empty-icon--error">
                                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" fill="currentColor" />
                                                </svg>
                                            </div>
                                            <Typography Component="span" fontSize="fs14" boldness="semibold" className="dt-empty-text">
                                                An error has occurred
                                            </Typography>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ) : table.getRowModel().rows?.length ? (
                                table.getRowModel().rows.map((row) => {
                                    /* v8 ignore start -- @preserve DnD handlers are thin wrappers; logic tested in useRowDnd.test.ts */
                                    const handleRowDragStart = (e: React.DragEvent) => rowDnd.onDragStart(e as DragEvent, row.original.id)
                                    const handleRowDragOver = (e: React.DragEvent) => rowDnd.onDragOver(e as DragEvent, row.original.id)
                                    const handleRowDrop = (e: React.DragEvent) => rowDnd.onDrop(e as DragEvent, row.original.id)
                                    /* v8 ignore stop -- @preserve */

                                    /* v8 ignore next -- @preserve DnD condition; jsdom limitation */
                                    const rowClass = cn("dt-row", rowDnd.dragOverId === row.original.id && "drag-over")

                                    return (
                                        <Fragment key={row.id}>
                                            <TableRow
                                                className={rowClass}
                                                data-state={row.getIsSelected() && "selected"}
                                                draggable={allowRowDrag}
                                                onDragStart={handleRowDragStart}
                                                onDragOver={handleRowDragOver}
                                                onDrop={handleRowDrop}
                                                onDragEnd={rowDnd.onDragEnd}
                                            >
                                                {row.getVisibleCells().map((cell) => (
                                                    <TableCell
                                                        key={cell.id}
                                                        style={{ width: cell.column.getSize() }}
                                                    >
                                                        {flexRender(
                                                            cell.column.columnDef.cell,
                                                            cell.getContext()
                                                        )}
                                                    </TableCell>
                                                ))}
                                            </TableRow>
                                            {isRowVisible(row.original.id) && (
                                                <TableRow className="dt-accordion-row">
                                                    <TableCell colSpan={effectiveColumns.length} className="dt-accordion-cell">
                                                        <div
                                                            className="dt-accordion-content"
                                                            {...(isClosing(row.original.id) ? { "data-closing": "" } : {})}
                                                        >
                                                            <Typography Component="div" fontSize="fs14" boldness="semibold" className="dt-accordion-title">
                                                                Details for {row.original.id}
                                                            </Typography>
                                                            <div className="dt-accordion-grid">
                                                                <div><strong>ID:</strong> {row.original.id}</div>
                                                                <div><strong>Status:</strong> place holder</div>
                                                                <div><strong>Amount:</strong> $42.00</div>
                                                            </div>
                                                        </div>
                                                    </TableCell>
                                                </TableRow>
                                            )}
                                        </Fragment>
                                    )
                                })
                            ) : (
                                <TableRow>
                                    <TableCell colSpan={effectiveColumns.length} className="dt-empty-cell">
                                        <div className="dt-empty-message">
                                            <div className="dt-empty-icon">
                                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                    <path d="M6 2C4.9 2 4 2.9 4 4V20C4 21.1 4.9 22 6 22H18C19.1 22 20 21.1 20 20V8L14 2H6ZM13 9V3.5L18.5 9H13Z" fill="currentColor" />
                                                </svg>
                                            </div>
                                            <Typography Component="span" fontSize="fs14" boldness="semibold" className="dt-empty-text">
                                                {hasActiveFilters ? "No rows match your search." : "No Data"}
                                            </Typography>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </div>
                {allowPagination && (
                    <BaseTablePagination
                        pageIndex={table.getState().pagination.pageIndex}
                        pageCount={table.getPageCount()}
                        pageSize={table.getState().pagination.pageSize}
                        totalRows={table.getFilteredRowModel().rows.length}
                        canPreviousPage={table.getCanPreviousPage()}
                        canNextPage={table.getCanNextPage()}
                        onFirstPage={() => table.setPageIndex(0)}
                        onPreviousPage={() => table.previousPage()}
                        onNextPage={() => table.nextPage()}
                        onLastPage={() => table.setPageIndex(table.getPageCount() - 1)}
                    />
                )}
            </div>
        </div >
    )
}
