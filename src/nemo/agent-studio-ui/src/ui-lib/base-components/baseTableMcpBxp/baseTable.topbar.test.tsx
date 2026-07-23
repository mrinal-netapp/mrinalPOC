import { render, screen, fireEvent, act } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { useState } from "react"
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  type ColumnDef,
  type ColumnFiltersState,
} from "@tanstack/react-table"
import { BaseTableTopBar } from "./baseTable.topbar"
import type { BaseElement, BaseTableOptions } from "./baseTable.types"

interface TestRow extends BaseElement {
  name: string
}

const testData: TestRow[] = Array.from({ length: 5 }, (_, i) => ({
  id: `row-${i + 1}`,
  name: `Item ${i + 1}`,
}))

const testColumns: ColumnDef<TestRow>[] = [
  { accessorKey: "id", header: "ID" },
  { accessorKey: "name", header: "Name" },
]

const ALL_SECTIONS_TOP_BAR: BaseTableOptions = {
  enableRowFilter: true,
  enableTableTopBar: true,
  topBarOptions: {
    rowCountLabel: "Items",
    showSearch: true,
    onDownload: () => {},
    showSecondaryAction: true,
    onPrimaryAction: () => {},
    primaryActionLabel: "Primary action",
    secondaryActionLabel: "Secondary action",
  },
}

function Wrapper({
  options = ALL_SECTIONS_TOP_BAR,
  onBatchDelete,
  initialRowSelection = {},
  initialBatchDeleteMode = false,
  columns = testColumns,
}: {
  options?: BaseTableOptions
  onBatchDelete?: (ids: string[]) => void
  initialRowSelection?: Record<string, boolean>
  initialBatchDeleteMode?: boolean
  columns?: ColumnDef<TestRow>[]
}) {
  const [globalFilter, setGlobalFilter] = useState("")
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [searchableColumns, setSearchableColumns] = useState<Set<string>>(new Set())
  const [isBatchDeleteMode, setIsBatchDeleteMode] = useState(initialBatchDeleteMode)
  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>(initialRowSelection)

  const table = useReactTable({
    data: testData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    enableRowSelection: true,
    enableMultiRowSelection: true,
    onRowSelectionChange: setRowSelection,
    state: { rowSelection, globalFilter, columnFilters },
  })

  return (
    <BaseTableTopBar
      table={table}
      options={options}
      searchableColumns={searchableColumns}
      setSearchableColumns={setSearchableColumns}
      setGlobalFilter={setGlobalFilter}
      setColumnFilters={setColumnFilters}
      isBatchDeleteMode={isBatchDeleteMode}
      onSetBatchDeleteMode={setIsBatchDeleteMode}
      clearSelection={() => setRowSelection({})}
      onBatchDelete={onBatchDelete}
      searchDebounceMs={0}
    />
  )
}

describe("BaseTableTopBar", () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it("renders the default row count label with row count", () => {
    render(<Wrapper />)
    expect(screen.getByText(/Items \(5\)/)).toBeInTheDocument()
  })

  it("renders a custom rowCountLabel when provided", () => {
    render(<Wrapper options={{ ...ALL_SECTIONS_TOP_BAR, topBarOptions: { ...ALL_SECTIONS_TOP_BAR.topBarOptions, rowCountLabel: "Jobs" } }} />)
    expect(screen.getByText(/Jobs \(5\)/)).toBeInTheDocument()
  })

  it("renders search toggle", () => {
    render(<Wrapper />)
    expect(screen.getByLabelText("Open search")).toBeInTheDocument()
  })

  it("renders download button", () => {
    render(<Wrapper />)
    expect(screen.getByLabelText("Download")).toBeInTheDocument()
  })

  it("renders primary action and secondary action buttons in normal mode", () => {
    render(<Wrapper />)
    expect(screen.getByText("Primary action")).toBeInTheDocument()
    expect(screen.getByText("Secondary action")).toBeInTheDocument()
  })

  it("renders a refresh button beside the primary action and invokes onRefresh", () => {
    const onRefresh = vi.fn()
    render(
      <Wrapper
        options={{
          ...ALL_SECTIONS_TOP_BAR,
          topBarOptions: {
            ...ALL_SECTIONS_TOP_BAR.topBarOptions,
            primaryActionLabel: "Add",
            onRefresh,
            refreshLabel: "Refresh",
          },
        }}
      />,
    )

    const refreshButton = screen.getByRole("button", { name: "Refresh" })
    expect(refreshButton).toBeInTheDocument()
    fireEvent.click(refreshButton)
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it("disables the refresh button while refreshing", () => {
    render(
      <Wrapper
        options={{
          ...ALL_SECTIONS_TOP_BAR,
          topBarOptions: {
            ...ALL_SECTIONS_TOP_BAR.topBarOptions,
            onRefresh: () => {},
            refreshLabel: "Refresh",
            isRefreshing: true,
          },
        }}
      />,
    )

    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled()
  })

  it("renders a plus icon on the primary action when showPrimaryActionPlusIcon is true", () => {
    render(
      <Wrapper
        options={{
          ...ALL_SECTIONS_TOP_BAR,
          topBarOptions: {
            ...ALL_SECTIONS_TOP_BAR.topBarOptions,
            primaryActionLabel: "Add",
            showPrimaryActionPlusIcon: true,
          },
        }}
      />,
    )

    expect(screen.getByText("Add")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add" }).querySelector("svg")).toBeInTheDocument()
  })

  it("enters batch delete mode when clicking 'Batch Delete…' in dropdown", async () => {
    render(<Wrapper />)

    // Open dropdown
    fireEvent.click(screen.getByText("Secondary action"))
    await act(() => vi.advanceTimersByTime(0))

    // Click batch delete
    const batchItem = screen.getByText("Batch Delete…")
    fireEvent.click(batchItem)
    await act(() => vi.advanceTimersByTime(0))

    // Should see batch mode UI
    expect(screen.getByText(/selected/)).toBeInTheDocument()
    expect(screen.getByText("Cancel")).toBeInTheDocument()
  })

  it("exits batch delete mode when clicking Cancel", async () => {
    render(<Wrapper />)

    // Enter batch mode
    fireEvent.click(screen.getByText("Secondary action"))
    await act(() => vi.advanceTimersByTime(0))
    fireEvent.click(screen.getByText("Batch Delete…"))
    await act(() => vi.advanceTimersByTime(0))

    // Cancel
    fireEvent.click(screen.getByText("Cancel"))
    await act(() => vi.advanceTimersByTime(0))

    expect(screen.getByText("Primary action")).toBeInTheDocument()
  })

  it("shows column visibility toggles in dropdown", async () => {
    render(<Wrapper />)

    fireEvent.click(screen.getByText("Secondary action"))
    await act(() => vi.advanceTimersByTime(0))

    expect(screen.getByText("Column Visibility")).toBeInTheDocument()
    expect(screen.getByText("ID")).toBeInTheDocument()
    expect(screen.getByText("Name")).toBeInTheDocument()
  })

  it("toggles column visibility from the dropdown", async () => {
    render(<Wrapper />)

    fireEvent.click(screen.getByText("Secondary action"))
    await act(() => vi.advanceTimersByTime(0))

    // The checkbox items contain the column names
    const nameCheckbox = screen.getAllByRole("menuitemcheckbox").find(
      (el) => el.textContent?.includes("Name"),
    )!
    expect(nameCheckbox).toBeDefined()
    fireEvent.click(nameCheckbox)
    await act(() => vi.advanceTimersByTime(0))
  })

  it("clears search input when closing the search", () => {
    render(<Wrapper />)

    // Open search
    fireEvent.click(screen.getByLabelText("Open search"))
    const input = screen.getByPlaceholderText("Search...")
    fireEvent.change(input, { target: { value: "hello" } })

    // Close search
    fireEvent.click(screen.getByLabelText("Close search"))

    // Re-open — input should be empty
    fireEvent.click(screen.getByLabelText("Open search"))
    const reopened = screen.getByPlaceholderText("Search...")
    expect((reopened as HTMLInputElement).value).toBe("")
  })

  it("does not filter when enableRowFilter is off", () => {
    render(<Wrapper options={{ ...ALL_SECTIONS_TOP_BAR, enableRowFilter: false }} />)
    expect(screen.getByText(/Items \(5\)/)).toBeInTheDocument()
  })

  it("disables Confirm Delete button when no rows are selected in batch mode", async () => {
    const onBatchDelete = vi.fn()
    render(<Wrapper onBatchDelete={onBatchDelete} />)

    // Enter batch mode
    fireEvent.click(screen.getByText("Secondary action"))
    await act(() => vi.advanceTimersByTime(0))
    fireEvent.click(screen.getByText("Batch Delete…"))
    await act(() => vi.advanceTimersByTime(0))

    // Confirm Delete should be disabled with 0 selected
    const confirmBtn = screen.getByText("Confirm Delete").closest("button")!
    expect(confirmBtn).toBeDisabled()

    // Clicking disabled Confirm Delete should not call onBatchDelete
    fireEvent.click(confirmBtn)
    await act(() => vi.advanceTimersByTime(0))
    expect(onBatchDelete).not.toHaveBeenCalled()
  })

  it("shows 0 selected count initially in batch delete mode", async () => {
    render(<Wrapper />)

    fireEvent.click(screen.getByText("Secondary action"))
    await act(() => vi.advanceTimersByTime(0))
    fireEvent.click(screen.getByText("Batch Delete…"))
    await act(() => vi.advanceTimersByTime(0))

    expect(screen.getByText("0 selected")).toBeInTheDocument()
  })

  it("calls onBatchDelete with selected row IDs when confirming delete", async () => {
    const onBatchDelete = vi.fn()
    render(
      <Wrapper
        onBatchDelete={onBatchDelete}
        initialRowSelection={{ "0": true, "2": true }}
        initialBatchDeleteMode={true}
      />,
    )

    // Should show selected count
    expect(screen.getByText("2 selected")).toBeInTheDocument()

    // Confirm Delete should be enabled
    const confirmBtn = screen.getByText("Confirm Delete").closest("button")!
    expect(confirmBtn).not.toBeDisabled()

    fireEvent.click(confirmBtn)
    await act(() => vi.advanceTimersByTime(0))

    expect(onBatchDelete).toHaveBeenCalledTimes(1)
    expect(onBatchDelete).toHaveBeenCalledWith(["row-1", "row-3"])
  })

  it("exits batch delete mode after successful confirm", async () => {
    const onBatchDelete = vi.fn()
    render(
      <Wrapper
        onBatchDelete={onBatchDelete}
        initialRowSelection={{ "0": true }}
        initialBatchDeleteMode={true}
      />,
    )

    fireEvent.click(screen.getByText("Confirm Delete").closest("button")!)
    await act(() => vi.advanceTimersByTime(0))

    // Should return to normal mode
    expect(screen.getByText("Primary action")).toBeInTheDocument()
    expect(screen.queryByText("Confirm Delete")).toBeNull()
  })

  it("debounce clears globalFilter when search input is emptied", async () => {
    render(<Wrapper />)

    // Open search and type a term
    fireEvent.click(screen.getByLabelText("Open search"))
    const input = screen.getByPlaceholderText("Search...")
    await act(async () => {
      fireEvent.change(input, { target: { value: "Item 1" } })
      vi.advanceTimersByTime(10)
    })

    // Rows should be filtered (only 1 visible)
    expect(screen.getByText(/Items \(1\)/)).toBeInTheDocument()

    // Clear the input — debounce should reset the filter
    await act(async () => {
      fireEvent.change(input, { target: { value: "" } })
      vi.advanceTimersByTime(10)
    })

    // All rows visible again
    expect(screen.getByText(/Items \(5\)/)).toBeInTheDocument()
  })

  it("re-shows all columns when all hideable columns are toggled off", async () => {
    render(<Wrapper />)

    // Hide first column
    fireEvent.click(screen.getByText("Secondary action"))
    await act(() => vi.advanceTimersByTime(100))
    const firstItem = screen.getAllByRole("menuitemcheckbox")[0]
    fireEvent.click(firstItem)
    await act(() => vi.advanceTimersByTime(100))

    // Re-open dropdown — need extra time for base-ui close/re-open cycle
    fireEvent.click(screen.getByText("Secondary action"))
    await act(() => vi.advanceTimersByTime(300))
    fireEvent.click(screen.getByText("Secondary action"))
    await act(() => vi.advanceTimersByTime(300))

    // Hide second column (triggers all-hidden guard)
    const secondItem = screen.getAllByRole("menuitemcheckbox")[1]
    fireEvent.click(secondItem)
    await act(() => vi.advanceTimersByTime(100))

    // Safety guard uses setTimeout(0) to re-show all columns
    await act(() => vi.advanceTimersByTime(100))

    // Re-open dropdown and verify all columns are visible again
    fireEvent.click(screen.getByText("Secondary action"))
    await act(() => vi.advanceTimersByTime(300))
    fireEvent.click(screen.getByText("Secondary action"))
    await act(() => vi.advanceTimersByTime(300))

    const items = screen.getAllByRole("menuitemcheckbox")
    const visibleColumns = items.filter((el) => el.getAttribute("data-checked") !== null)
    expect(visibleColumns.length).toBe(items.length)
  })

  it("falls back to column.id as label when header is a render function", async () => {
    const fnHeaderColumns: ColumnDef<TestRow>[] = [
      { accessorKey: "id", header: () => <span>ID Sort</span> },
      { accessorKey: "name", header: "Name" },
    ]
    render(<Wrapper columns={fnHeaderColumns} />)

    fireEvent.click(screen.getByText("Secondary action"))
    await act(() => vi.advanceTimersByTime(0))

    const checkboxItems = screen.getAllByRole("menuitemcheckbox")
    const labels = checkboxItems.map((el) => el.textContent)
    // "id" column has a function header → label falls back to column.id ("id")
    expect(labels).toContain("id")
    // "Name" column has a string header → label is "Name"
    expect(labels).toContain("Name")
  })
})
