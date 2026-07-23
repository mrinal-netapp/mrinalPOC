import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type VisibilityState,
} from '@tanstack/react-table'
import {
  makeStyles,
  tokens,
  Table,
  TableBody,
  TableCell,
  TableRow,
  TableHeader,
  TableHeaderCell,
  Text,
  Button,
  Input,
  Spinner,
  Dropdown,
  Option,
  Popover,
  PopoverTrigger,
  PopoverSurface,
  Checkbox,
} from '@fluentui/react-components'
import {
  ArrowUp24Regular,
  ArrowDown24Regular,
  ArrowSort24Regular,
  Search24Regular,
  ChevronLeft20Regular,
  ChevronRight20Regular,
  ColumnTriple24Regular,
} from '@fluentui/react-icons'

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    gap: '8px',
  },
  toolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    gap: '12px',
  },
  searchInput: {
    flex: '0 1 300px',
    minWidth: '200px',
  },
  tableContainer: {
    flex: '1 1 auto',
    overflow: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  table: {
    width: 'max-content',
    minWidth: '100%',
    borderCollapse: 'collapse',
    tableLayout: 'auto',
  },
  tableHeader: {
    position: 'sticky',
    top: 0,
    zIndex: 10,
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `2px solid ${tokens.colorNeutralStroke1}`,
  },
  tableHeaderCell: {
    padding: '12px 16px',
    fontWeight: 600,
    fontSize: '13px',
    color: tokens.colorNeutralForeground1,
    userSelect: 'none',
    cursor: 'pointer',
    position: 'relative',
    minWidth: '120px',
    whiteSpace: 'nowrap',
    '&:hover': {
      backgroundColor: tokens.colorNeutralBackground3,
    },
  },
  sortableHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    justifyContent: 'space-between',
  },
  sortIcon: {
    display: 'flex',
    alignItems: 'center',
    color: tokens.colorNeutralForeground3,
    fontSize: '16px',
  },
  tableCell: {
    padding: '10px 16px',
    fontSize: '13px',
    color: tokens.colorNeutralForeground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    minWidth: '120px',
    maxWidth: '300px',
  },
  tableRow: {
    '&:hover': {
      backgroundColor: tokens.colorNeutralBackground2,
    },
  },
  nullCell: {
    fontStyle: 'italic',
    opacity: 0.5,
    color: tokens.colorNeutralForeground3,
  },
  pagination: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderTop: 'none',
    borderRadius: `0 0 ${tokens.borderRadiusMedium} ${tokens.borderRadiusMedium}`,
    gap: '12px',
  },
  paginationInfo: {
    fontSize: '13px',
    color: tokens.colorNeutralForeground2,
  },
  paginationControls: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  pageSizeSelect: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '48px',
    color: tokens.colorNeutralForeground3,
    textAlign: 'center',
  },
  loadingState: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '48px',
  },
  statsRowCell: {
    padding: '4px 8px',
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    verticalAlign: 'top',
  },
  pageSizeDropdown: {
    minWidth: '80px',
  },
  columnTogglePanel: {
    maxHeight: '320px',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: '4px 0',
    minWidth: '180px',
  },
})

export interface DataGridColumn {
  id: string
  header: string
  accessorKey?: string
  cell?: (value: any) => React.ReactNode
  enableSorting?: boolean
  enableFiltering?: boolean
  minSize?: number
  maxSize?: number
  size?: number
}

export interface DataGridProps {
  data: any[]
  columns: DataGridColumn[]
  loading?: boolean
  rowCount?: number
  defaultPageSize?: number
  enableSorting?: boolean
  enableFiltering?: boolean
  enablePagination?: boolean
  enableColumnResizing?: boolean
  onRowClick?: (row: any) => void
  onPageChange?: (pageIndex: number, pageSize: number) => void
  onSortChange?: (sorting: SortingState) => void
  manualSorting?: boolean
  statsRow?: (columnId: string) => React.ReactNode
  columnFilterRenderer?: (columnId: string) => React.ReactNode
}

export function DataGrid({
  data,
  columns,
  loading = false,
  rowCount,
  defaultPageSize = 50,
  enableSorting = true,
  enableFiltering = true,
  enablePagination = true,
  enableColumnResizing = false,
  onRowClick,
  onPageChange,
  onSortChange,
  manualSorting = false,
  statsRow,
  columnFilterRenderer,
}: DataGridProps) {
  const styles = useStyles()
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  const [globalFilter, setGlobalFilter] = useState('')
  const [pagination, setPagination] = useState({
    pageIndex: 0,
    pageSize: defaultPageSize,
  })

  const handleSortingChange = useCallback(
    (updater: SortingState | ((old: SortingState) => SortingState)) => {
      setSorting((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater
        onSortChange?.(next)
        return next
      })
    },
    [onSortChange],
  )

  const handlePaginationChange = useCallback(
    (updater: typeof pagination | ((old: typeof pagination) => typeof pagination)) => {
      setPagination((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater
        if (next.pageIndex !== prev.pageIndex || next.pageSize !== prev.pageSize) {
          onPageChange?.(next.pageIndex, next.pageSize)
        }
        return next
      })
    },
    [onPageChange],
  )

  useEffect(() => {
    setPagination((prev) => ({ ...prev, pageSize: defaultPageSize }))
  }, [defaultPageSize])

  // Convert columns to TanStack Table format
  const tableColumns = useMemo<ColumnDef<any>[]>(() => {
    return columns.map((col) => ({
      id: col.id,
      header: col.header,
      accessorKey: col.accessorKey || col.id,
      enableSorting: col.enableSorting !== false && enableSorting,
      enableColumnFilter: col.enableFiltering !== false && enableFiltering,
      minSize: col.minSize || 100,
      maxSize: col.maxSize || 500,
      size: col.size || 150,
      cell: col.cell
        ? (info: { getValue: () => any }) => col.cell!(info.getValue())
        : (info: { getValue: () => any }) => {
            const value = info.getValue()
            if (value === null || value === undefined) {
              return (
                <Text className={styles.nullCell}>NULL</Text>
              )
            }
            const str = String(value)
            return (
              <Text title={str.length > 50 ? str : undefined}>
                {str.length > 50 ? `${str.substring(0, 50)}...` : str}
              </Text>
            )
          },
    }))
  }, [columns, enableSorting, enableFiltering, styles.nullCell])

  const table = useReactTable({
    data,
    columns: tableColumns,
    pageCount: rowCount ? Math.ceil(rowCount / pagination.pageSize) : undefined,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      globalFilter,
      pagination,
    },
    onSortingChange: handleSortingChange,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: handlePaginationChange,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: manualSorting ? undefined : getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: enablePagination ? getPaginationRowModel() : undefined,
    manualPagination: !!rowCount,
    manualSorting,
    enableSorting,
    enableColumnResizing,
  })

  const getSortIcon = (column: { getCanSort: () => boolean; getIsSorted: () => false | 'asc' | 'desc' }) => {
    if (!column.getCanSort()) return null
    const sorted = column.getIsSorted()
    if (sorted === 'asc') {
      return <ArrowUp24Regular className={styles.sortIcon} />
    }
    if (sorted === 'desc') {
      return <ArrowDown24Regular className={styles.sortIcon} />
    }
    return <ArrowSort24Regular className={styles.sortIcon} style={{ opacity: 0.5 }} />
  }

  if (loading) {
    return (
      <div className={styles.loadingState}>
        <Spinner label="Loading data..." size="large" />
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        {enableFiltering && (
          <Input
            className={styles.searchInput}
            placeholder="Search all columns..."
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            contentBefore={<Search24Regular />}
          />
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' }}>
          <Popover>
            <PopoverTrigger disableButtonEnhancement>
              <Button appearance="subtle" icon={<ColumnTriple24Regular />} size="small">
                Columns ({table.getVisibleLeafColumns().length}/{table.getAllLeafColumns().length})
              </Button>
            </PopoverTrigger>
            <PopoverSurface>
              <div className={styles.columnTogglePanel}>
                {table.getAllLeafColumns().map((column) => (
                  <Checkbox
                    key={column.id}
                    label={String(column.columnDef.header || column.id)}
                    checked={column.getIsVisible()}
                    onChange={(_e, data) => column.toggleVisibility(!!data.checked)}
                  />
                ))}
              </div>
            </PopoverSurface>
          </Popover>
          <Text className={styles.paginationInfo}>
            {table.getFilteredRowModel().rows.length} of {rowCount || data.length} rows
          </Text>
        </div>
      </div>

      <div className={styles.tableContainer}>
        <Table className={styles.table}>
          <TableHeader className={styles.tableHeader}>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHeaderCell
                    key={header.id}
                    className={styles.tableHeaderCell}
                    style={{
                      ...(header.column.getIsSorted() ? { backgroundColor: tokens.colorNeutralBackground3 } : {}),
                    }}
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    <div className={styles.sortableHeader}>
                      {header.isPlaceholder ? null : (
                        <>
                          <Text>
                            {flexRender(header.column.columnDef.header, header.getContext())}
                          </Text>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                            {getSortIcon(header.column)}
                            {columnFilterRenderer && (
                              <span onClick={(e) => e.stopPropagation()}>
                                {columnFilterRenderer(header.column.id)}
                              </span>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  </TableHeaderCell>
                ))}
              </TableRow>
            ))}
            {statsRow && (
              <TableRow>
                {table.getVisibleLeafColumns().map((col) => (
                  <TableCell key={`stats-${col.id}`} className={styles.statsRowCell}>
                    {statsRow(col.id)}
                  </TableCell>
                ))}
              </TableRow>
            )}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className={styles.emptyState}>
                  <Text>No data available</Text>
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={styles.tableRow}
                  onClick={() => onRowClick?.(row.original)}
                  style={onRowClick ? { cursor: 'pointer' } : undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={styles.tableCell}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {enablePagination && (
        <div className={styles.pagination}>
          <div className={styles.paginationInfo}>
            <Text>
              Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
              {' | '}
              Showing {table.getRowModel().rows.length} of {rowCount ?? table.getFilteredRowModel().rows.length} rows
              {sorting.length > 0 && ` | Sorted by ${sorting[0].id} ${sorting[0].desc ? 'desc' : 'asc'}`}
            </Text>
          </div>
          <div className={styles.paginationControls}>
            <div className={styles.pageSizeSelect}>
              <Text>Rows per page:</Text>
              <Dropdown
                className={styles.pageSizeDropdown}
                value={String(table.getState().pagination.pageSize)}
                selectedOptions={[String(table.getState().pagination.pageSize)]}
                onOptionSelect={(_e, data) => {
                  table.setPageSize(Number(data.optionValue))
                }}
                size="small"
              >
                {[10, 25, 50, 100, 200, 500].map((size) => (
                  <Option key={size} value={String(size)}>
                    {String(size)}
                  </Option>
                ))}
              </Dropdown>
            </div>
            <Button
              appearance="subtle"
              icon={<ChevronLeft20Regular />}
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              size="small"
            >
              Previous
            </Button>
            <Button
              appearance="subtle"
              icon={<ChevronRight20Regular />}
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              size="small"
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

