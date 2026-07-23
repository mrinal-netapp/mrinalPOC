import type { ColumnDef, RowData } from "@tanstack/react-table"

// Module augmentation — gives `table.options.meta` proper types everywhere
declare module "@tanstack/react-table" {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    interface TableMeta<TData extends RowData> {
        enablePagination?: boolean
        enableRowExpansion?: boolean
        isExpanded?: (id: string) => boolean
        toggleExpanded?: (id: string) => void
    }
}

/**
 * Base table component props
 */
export interface BaseTableProps<T extends BaseElement> {
    options: BaseTableOptions
    data: T[]
    columns: ColumnDef<T>[]
    /** When true the table body shows a centered spinner instead of rows */
    isLoading?: boolean
    /** When true the table body shows an error message instead of rows */
    isError?: boolean
    /** Fires whenever the internal row‑selection map changes.
     *  Keys are row `id` strings; values are booleans. */
    onRowSelectionChange?: (selection: Record<string, boolean>) => void
}

/**
 * Configuration for the top bar sections.
 * Callback fields double as visibility toggles — providing a callback shows
 * the section, omitting it hides it.  Booleans are used for sections that
 * don't need a callback (row count, search).
 */
export interface TopBarOptions {
    /** Left-side row count label (e.g. "Data sources"). Shown when provided. */
    rowCountLabel?: string
    /** Show the collapsible search input. Defaults to false. */
    showSearch?: boolean
    /** Called when the download button is clicked. Omit to hide the button. */
    onDownload?: () => void
    /** Show the secondary action dropdown (column visibility, batch delete). Defaults to false. */
    showSecondaryAction?: boolean
    /** Label for the secondary action dropdown trigger. Defaults to "Secondary action". */
    secondaryActionLabel?: string
    /** Called when the primary action button is clicked. Omit to hide it. */
    onPrimaryAction?: () => void
    /** Label for the primary action button. Defaults to "Primary action". */
    primaryActionLabel?: string
    /** When true, renders a plus icon before the primary action label. */
    showPrimaryActionPlusIcon?: boolean
    /** Called when the refresh button is clicked. Omit to hide the button. Rendered just before the primary action. */
    onRefresh?: () => void
    /** Label for the refresh button. Defaults to "Refresh". */
    refreshLabel?: string
    /** When true, the refresh button shows a spinner and is disabled. */
    isRefreshing?: boolean
}

/**
 * Table feature options
 */
export interface BaseTableOptions {
    enableRowFilter?: boolean
    enableRowSelection?: boolean | ((row: BaseElement) => boolean)
    enableRowMultiSelection?: boolean
    enableRowExpansion?: boolean
    enableRowDrag?: boolean
    enablePagination?: boolean
    enableInfiniteScroll?: boolean // not yet implemented
    enableColumnFilter?: boolean
    enableColumnSorting?: boolean
    enableColumnResizing?: boolean
    enableColumnDrag?: boolean
    enableStickyHeaders?: boolean
    enableTableTopBar?: boolean
    topBarOptions?: TopBarOptions
    onBatchDelete?: (selectedRowIds: string[]) => void
}

/**
 * Base element interface - all table rows must have an id
 */
export interface BaseElement {
    id: string
}

/**
 * Element with creation metadata
 */
export interface CreatedElement extends BaseElement {
    createdAt: string
    createdBy: string
}

/**
 * Element with creation and update metadata
 */
export interface UpdateableElement extends CreatedElement {
    updatedAt: string
    updatedBy: string
}

/**
 * Job status enumeration
 */
export type StatusEnumModel = "Initialized" | "Pending" | "In Progress" | "Done" | "Failed" | "Error"

/**
 * Job step interface
 */
export interface JobStep extends UpdateableElement {
    jobId: string
    stepId: string
    status: StatusEnumModel
    executionMap: string
    metadata: string
}

/**
 * Job table row interface
 */
export interface JobTableRow extends UpdateableElement {
    status: [StatusEnumModel]
    executionMap: string
    metadata: string
    steps: JobStep[]
}


export interface DataSourceRow extends UpdateableElement {
    name: string,
    description: string
    volumes: Volume[],
    interval: string,
    filters: Filter,
    tags: string[]
}

export interface Volume {
    type: "NFS" | "SMB",
    nfsSmb: {
        protocol: "NFS" | "SMB",
        host: string
        exportPath: string,
        directories: { path: string }[]
    },
    schedule: string,
}

export interface Filter {
    fileExtensions: string[]
    regularExpressions: string[]
}
