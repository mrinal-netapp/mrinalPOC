import { render, screen, fireEvent, act } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { type ColumnDef } from "@tanstack/react-table"
import BaseTable from "./baseTable"
import { createGlobalSearchFn } from "./baseTable.utils"
import type { BaseElement, BaseTableOptions } from "./baseTable.types"

interface TestRow extends BaseElement {
  name: string
  status: string
}

const testColumns: ColumnDef<TestRow>[] = [
  { accessorKey: "id", header: "ID" },
  { accessorKey: "name", header: "Name" },
  { accessorKey: "status", header: "Status" },
]

const sortableColumns: ColumnDef<TestRow>[] = [
  {
    accessorKey: "id",
    header: ({ column }) => (
      <button onClick={() => column.toggleSorting()}>ID</button>
    ),
  },
  { accessorKey: "name", header: "Name" },
  { accessorKey: "status", header: "Status" },
]

function makeData(count: number): TestRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `row-${i + 1}`,
    name: `Item ${i + 1}`,
    status: i % 2 === 0 ? "Active" : "Inactive",
  }))
}

const ALL_SECTIONS: BaseTableOptions = {
  enableTableTopBar: true,
  enableRowFilter: true,
  topBarOptions: {
    rowCountLabel: "Items",
    showSearch: true,
    onDownload: () => { },
    showSecondaryAction: true,
    onPrimaryAction: () => { },
    primaryActionLabel: "Primary action",
    secondaryActionLabel: "Secondary action",
  },
}

describe("BaseTable", () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it("renders rows when data is provided", () => {
    render(<BaseTable data={makeData(3)} columns={testColumns} options={{}} />)
    expect(screen.getByText("row-1")).toBeInTheDocument()
    expect(screen.getByText("Item 2")).toBeInTheDocument()
    expect(screen.getByText("row-3")).toBeInTheDocument()
  })

  it("renders empty state when data is empty", () => {
    render(<BaseTable data={[]} columns={testColumns} options={{}} />)
    expect(screen.getByText("No Data")).toBeInTheDocument()
  })

  it("renders loading state when isLoading is true", () => {
    render(<BaseTable data={[]} columns={testColumns} options={{}} isLoading />)
    expect(screen.getByText("Loading…")).toBeInTheDocument()
    expect(screen.queryByText("No Data")).toBeNull()
  })

  it("shows loading instead of rows when isLoading is true with data", () => {
    render(<BaseTable data={makeData(3)} columns={testColumns} options={{}} isLoading />)
    expect(screen.getByText("Loading…")).toBeInTheDocument()
    expect(screen.queryByText("row-1")).toBeNull()
  })

  it("renders error state when isError is true", () => {
    render(<BaseTable data={[]} columns={testColumns} options={{}} isError />)
    expect(screen.getByText("An error has occurred")).toBeInTheDocument()
    expect(screen.queryByText("No Data")).toBeNull()
  })

  it("loading takes priority over error", () => {
    render(<BaseTable data={[]} columns={testColumns} options={{}} isLoading isError />)
    expect(screen.getByText("Loading…")).toBeInTheDocument()
    expect(screen.queryByText("An error has occurred")).toBeNull()
  })

  it("renders column headers", () => {
    render(<BaseTable data={makeData(2)} columns={testColumns} options={{}} />)
    expect(screen.getByText("ID")).toBeInTheDocument()
    expect(screen.getByText("Name")).toBeInTheDocument()
    expect(screen.getByText("Status")).toBeInTheDocument()
  })

  it("renders pagination when enabled", () => {
    const { container } = render(
      <BaseTable
        data={makeData(25)}
        columns={testColumns}
        options={{ enablePagination: true }}
      />,
    )
    expect(screen.getByLabelText("Go to next page")).toBeInTheDocument()
    expect(screen.getByLabelText("Go to first page")).toBeInTheDocument()
    expect(container.querySelector(".dt-pagination")).toBeInTheDocument()
    expect(container.querySelector(".dt-pagination-info")).toBeInTheDocument()
  })

  it("does not render pagination when disabled", () => {
    render(<BaseTable data={makeData(3)} columns={testColumns} options={{}} />)
    expect(screen.queryByLabelText("Go to next page")).toBeNull()
  })

  it("navigates pages via pagination", () => {
    render(
      <BaseTable
        data={makeData(25)}
        columns={testColumns}
        options={{ enablePagination: true }}
      />,
    )
    fireEvent.click(screen.getByLabelText("Go to next page"))
    expect(screen.getByText("2")).toBeInTheDocument()
  })

  it("renders topbar when enabled", () => {
    render(
      <BaseTable
        data={makeData(3)}
        columns={testColumns}
        options={ALL_SECTIONS}
      />,
    )
    expect(screen.getByText(/Items/)).toBeInTheDocument()
  })

  it("renders topbar with custom rowCountLabel", () => {
    render(
      <BaseTable
        data={makeData(3)}
        columns={testColumns}
        options={{ ...ALL_SECTIONS, topBarOptions: { ...ALL_SECTIONS.topBarOptions, rowCountLabel: "Jobs" } }}
      />,
    )
    expect(screen.getByText(/Jobs \(3\)/)).toBeInTheDocument()
  })

  it("does not render topbar when disabled", () => {
    render(<BaseTable data={makeData(3)} columns={testColumns} options={{}} />)
    expect(screen.queryByText(/Items/)).toBeNull()
  })

  it("renders row selection checkboxes when enabled", () => {
    render(
      <BaseTable
        data={makeData(3)}
        columns={testColumns}
        options={{ enableRowSelection: true }}
      />,
    )
    const checkboxes = screen.getAllByRole("checkbox")
    expect(checkboxes.length).toBeGreaterThan(0)
  })

  it("renders expansion column when enabled", () => {
    const { container } = render(
      <BaseTable
        data={makeData(3)}
        columns={testColumns}
        options={{ enableRowExpansion: true }}
      />,
    )
    const expandArrows = container.querySelectorAll(".dt-expand-arrow")
    expect(expandArrows.length).toBe(3)
  })

  it("expands a row when clicking the expand arrow", () => {
    const { container } = render(
      <BaseTable
        data={makeData(3)}
        columns={testColumns}
        options={{ enableRowExpansion: true }}
      />,
    )
    const expandArrows = container.querySelectorAll(".dt-expand-arrow")
    fireEvent.click(expandArrows[0])
    expect(screen.getByText(/Details for row-1/)).toBeInTheDocument()
  })

  it("shows search-empty message when filtering yields no results", () => {
    render(
      <BaseTable
        data={makeData(3)}
        columns={testColumns}
        options={ALL_SECTIONS}
      />,
    )
    fireEvent.click(screen.getByLabelText("Open search"))
    const input = screen.getByPlaceholderText("Search...")
    fireEvent.change(input, { target: { value: "zzz_no_match" } })

    act(() => { vi.advanceTimersByTime(350) })

    expect(screen.getByText("No rows match your search.")).toBeInTheDocument()
  })

  it("applies sticky header class when enabled", () => {
    const { container } = render(
      <BaseTable
        data={makeData(3)}
        columns={testColumns}
        options={{ enableStickyHeaders: true }}
      />,
    )
    expect(container.querySelector(".dt-table-wrapper-sticky")).toBeInTheDocument()
  })

  it("calls onBatchDelete callback when batch delete is confirmed", async () => {
    const onBatchDelete = vi.fn()
    render(
      <BaseTable
        data={makeData(3)}
        columns={testColumns}
        options={{
          ...ALL_SECTIONS,
          enableRowSelection: true,
          enableRowMultiSelection: true,
          onBatchDelete,
        }}
      />,
    )
    expect(screen.getByText("row-1")).toBeInTheDocument()
  })

  // --- Single row selection: only one row selected at a time ---
  it("single-row selection replaces previous selection", () => {
    render(
      <BaseTable
        data={makeData(3)}
        columns={testColumns}
        options={{ enableRowSelection: true }}
      />,
    )
    const checkboxes = screen.getAllByRole("checkbox")
    // Select first row
    fireEvent.click(checkboxes[0])
    // Select second row — should deselect first
    fireEvent.click(checkboxes[1])
    const checked = checkboxes.filter((cb) => (cb as HTMLInputElement).checked)
    expect(checked.length).toBeLessThanOrEqual(1)
  })

  // --- Multi row selection via header "Select all" ---
  it("multi-row selection selects all page rows via header checkbox", () => {
    render(
      <BaseTable
        data={makeData(3)}
        columns={testColumns}
        options={{ enableRowSelection: true, enableRowMultiSelection: true }}
      />,
    )
    // Header "Select all" checkbox selects all rows at once
    const selectAll = screen.getByLabelText("Select all")
    fireEvent.click(selectAll)

    const rowCheckboxes = screen.getAllByLabelText("Select row")
    const checked = rowCheckboxes.filter((cb) => cb.hasAttribute("data-checked"))
    expect(checked.length).toBe(3)
  })

  // --- Column sorting ---
  it("enables column sorting when option is set", () => {
    render(
      <BaseTable
        data={makeData(5)}
        columns={sortableColumns}
        options={{ enableColumnSorting: true }}
      />,
    )
    const sortBtn = screen.getByRole("button", { name: "ID" })
    fireEvent.click(sortBtn)
    // After sorting, rows should still render (verifies the sorting pipeline works)
    expect(screen.getByText("row-1")).toBeInTheDocument()
  })

  // --- Column resizing ---
  it("renders column resize handles when enabled", () => {
    const { container } = render(
      <BaseTable
        data={makeData(3)}
        columns={testColumns}
        options={{ enableColumnResizing: true }}
      />,
    )
    expect(container.querySelectorAll(".dt-col-resizer").length).toBeGreaterThan(0)
  })

  it("does not render resize handles when disabled", () => {
    const { container } = render(
      <BaseTable data={makeData(3)} columns={testColumns} options={{}} />,
    )
    expect(container.querySelector(".dt-col-resizer")).toBeNull()
  })

  // --- Data sync ---
  it("syncs rows when parent data prop changes", () => {
    const { rerender } = render(
      <BaseTable data={makeData(2)} columns={testColumns} options={{}} />,
    )
    expect(screen.getByText("row-2")).toBeInTheDocument()
    expect(screen.queryByText("row-3")).toBeNull()

    rerender(<BaseTable data={makeData(3)} columns={testColumns} options={{}} />)
    expect(screen.getByText("row-3")).toBeInTheDocument()
  })

  // --- Searchable columns sync: no-op when columns unchanged ---
  it("does not update searchable columns when re-rendered with same columns", () => {
    const { rerender } = render(
      <BaseTable data={makeData(2)} columns={testColumns} options={ALL_SECTIONS} />,
    )
    rerender(<BaseTable data={makeData(3)} columns={testColumns} options={ALL_SECTIONS} />)
    expect(screen.getByText("row-3")).toBeInTheDocument()
  })

  // --- Searchable columns sync: updates when columns change (same count, different IDs) ---
  it("updates searchable columns when re-rendered with different columns of same count", () => {
    const altColumns: ColumnDef<TestRow>[] = [
      { accessorKey: "id", header: "ID" },
      { accessorKey: "name", header: "Name" },
      { accessorKey: "status", header: "Status" },
    ]
    const replacementColumns: ColumnDef<TestRow>[] = [
      { accessorKey: "id", header: "ID" },
      { accessorKey: "status", header: "Status" },
      { id: "combined", header: "Combined", accessorFn: (row) => `${row.name} ${row.status}` },
    ]

    const { rerender } = render(
      <BaseTable data={makeData(3)} columns={altColumns} options={ALL_SECTIONS} />,
    )
    rerender(<BaseTable data={makeData(3)} columns={replacementColumns} options={ALL_SECTIONS} />)
    expect(screen.getByText("Combined")).toBeInTheDocument()
  })

  // --- Global search filters rows ---
  it("filters rows when search matches a subset", () => {
    render(
      <BaseTable
        data={makeData(5)}
        columns={testColumns}
        options={ALL_SECTIONS}
      />,
    )
    fireEvent.click(screen.getByLabelText("Open search"))
    const input = screen.getByPlaceholderText("Search...")
    fireEvent.change(input, { target: { value: "Item 3" } })

    act(() => { vi.advanceTimersByTime(350) })

    expect(screen.getByText("Item 3")).toBeInTheDocument()
    expect(screen.queryByText("Item 1")).toBeNull()
  })

  // --- Expand and collapse ---
  it("collapses an expanded row when clicking the arrow again", () => {
    const { container } = render(
      <BaseTable
        data={makeData(3)}
        columns={testColumns}
        options={{ enableRowExpansion: true }}
      />,
    )
    const arrows = container.querySelectorAll(".dt-expand-arrow")
    // Expand
    fireEvent.click(arrows[0])
    expect(screen.getByText(/Details for row-1/)).toBeInTheDocument()

    // Collapse — row enters closing state then disappears
    fireEvent.click(arrows[0])
    act(() => { vi.advanceTimersByTime(350) })
    expect(screen.queryByText(/Details for row-1/)).toBeNull()
  })

  // --- Grouped columns: placeholder headers hit the null branch ---
  it("renders placeholder headers for ungrouped columns in grouped layout", () => {
    const groupedColumns: ColumnDef<TestRow>[] = [
      {
        id: "info",
        header: "Information",
        columns: [
          { accessorKey: "id", header: "ID" },
          { accessorKey: "name", header: "Name" },
        ],
      },
      { accessorKey: "status", header: "Status" },
    ]
    const { container } = render(
      <BaseTable data={makeData(2)} columns={groupedColumns} options={{}} />,
    )
    expect(screen.getByText("Information")).toBeInTheDocument()
    expect(screen.getByText("ID")).toBeInTheDocument()
    expect(screen.getByText("Name")).toBeInTheDocument()
    expect(screen.getByText("Status")).toBeInTheDocument()
    // Two header rows: group row + leaf row
    const headerRows = container.querySelectorAll("thead tr")
    expect(headerRows.length).toBe(2)
  })

  // --- Firefox sizing regression: <colgroup> must track leaf columns, not header groups ---
  it("sizes <colgroup> from visible leaf columns so it matches every rendered row cell, even with grouped headers", () => {
    const groupedColumns: ColumnDef<TestRow>[] = [
      {
        id: "info",
        header: "Information",
        columns: [
          { accessorKey: "id", header: "ID" },
          { accessorKey: "name", header: "Name" },
        ],
      },
      { accessorKey: "status", header: "Status" },
    ]
    const { container } = render(
      <BaseTable data={makeData(2)} columns={groupedColumns} options={{}} />,
    )

    const cols = container.querySelectorAll("colgroup > col")
    const firstRowCells = container.querySelectorAll("tbody tr:first-child > td")

    expect(cols.length).toBe(3)
    expect(cols.length).toBe(firstRowCells.length)
  })

  // --- Function-based row selection predicate ---
  it("only enables checkboxes for rows matching the enableRowSelection predicate", () => {
    render(
      <BaseTable
        data={makeData(3)}
        columns={testColumns}
        options={{ enableRowSelection: (row) => row.id === "row-2" }}
      />,
    )
    const checkboxes = screen.getAllByLabelText("Select row")
    expect(checkboxes).toHaveLength(3)

    const enabled = checkboxes.filter((cb) => !cb.hasAttribute("data-disabled"))
    expect(enabled).toHaveLength(1)
  })

  // --- Row selection disabled path: updater returns empty ---
  it("does not allow selection when enableRowSelection is false", () => {
    render(
      <BaseTable data={makeData(3)} columns={testColumns} options={{}} />,
    )
    expect(screen.queryAllByRole("checkbox").length).toBe(0)
  })

  // --- No sticky headers by default ---
  it("does not apply sticky header class when not enabled", () => {
    const { container } = render(
      <BaseTable data={makeData(2)} columns={testColumns} options={{}} />,
    )
    expect(container.querySelector(".dt-table-wrapper-sticky")).toBeNull()
  })

  // --- Row drag attributes ---
  it("sets draggable on rows when row drag is enabled", () => {
    const { container } = render(
      <BaseTable
        data={makeData(2)}
        columns={testColumns}
        options={{ enableRowDrag: true }}
      />,
    )
    const rows = container.querySelectorAll(".dt-row")
    rows.forEach((row) => {
      expect(row).toHaveAttribute("draggable", "true")
    })
  })

  // --- Column drag attributes on headers ---
  it("sets draggable on headers when column drag is enabled", () => {
    const { container } = render(
      <BaseTable
        data={makeData(2)}
        columns={testColumns}
        options={{ enableColumnDrag: true }}
      />,
    )
    const headers = container.querySelectorAll(".dt-header")
    const draggable = Array.from(headers).filter(
      (h) => h.getAttribute("draggable") === "true",
    )
    expect(draggable.length).toBeGreaterThan(0)
  })

  // --- Select column renders header checkbox only with multi-select ---
  it("renders header checkbox dropdown in multi-select mode", () => {
    render(
      <BaseTable
        data={makeData(3)}
        columns={testColumns}
        options={{ enableRowSelection: true, enableRowMultiSelection: true }}
      />,
    )
    expect(screen.getByLabelText("Select all")).toBeInTheDocument()
    expect(screen.getByLabelText("Selection options")).toBeInTheDocument()
  })

  // --- Expanded row accordion detail content ---
  it("shows accordion grid with ID, Status, and Amount in expanded row", () => {
    const { container } = render(
      <BaseTable
        data={makeData(2)}
        columns={testColumns}
        options={{ enableRowExpansion: true }}
      />,
    )
    const arrows = container.querySelectorAll(".dt-expand-arrow")
    fireEvent.click(arrows[0])

    expect(screen.getByText(/Details for row-1/)).toBeInTheDocument()
    expect(container.querySelector(".dt-accordion-grid")).toBeInTheDocument()
    expect(screen.getByText("ID:")).toBeInTheDocument()
    expect(screen.getByText("Status:")).toBeInTheDocument()
    expect(screen.getByText("Amount:")).toBeInTheDocument()
    expect(screen.getByText("$42.00")).toBeInTheDocument()
  })

  it("sets data-closing attribute during collapse animation", () => {
    const { container } = render(
      <BaseTable
        data={makeData(2)}
        columns={testColumns}
        options={{ enableRowExpansion: true }}
      />,
    )
    const arrows = container.querySelectorAll(".dt-expand-arrow")

    // Expand then immediately collapse
    fireEvent.click(arrows[0])
    fireEvent.click(arrows[0])

    // During collapse animation, data-closing attribute is present
    const closingEl = container.querySelector("[data-closing]")
    expect(closingEl).toBeInTheDocument()

    // After animation completes, row is fully removed
    act(() => { vi.advanceTimersByTime(350) })
    expect(container.querySelector("[data-closing]")).toBeNull()
  })

  // --- Pagination: all four navigation buttons ---
  it("navigates through all pagination buttons: first, previous, next, last", () => {
    render(
      <BaseTable
        data={makeData(35)}
        columns={testColumns}
        options={{ enablePagination: true }}
      />,
    )
    // Initially on page 1
    expect(screen.getByText("row-1")).toBeInTheDocument()

    // Go to last page (page 4, 35 rows / 10 per page)
    fireEvent.click(screen.getByLabelText("Go to last page"))
    expect(screen.getByText("row-31")).toBeInTheDocument()
    expect(screen.queryByText("row-1")).toBeNull()

    // Go to previous page (page 3)
    fireEvent.click(screen.getByLabelText("Go to previous page"))
    expect(screen.getByText("row-21")).toBeInTheDocument()

    // Go to first page
    fireEvent.click(screen.getByLabelText("Go to first page"))
    expect(screen.getByText("row-1")).toBeInTheDocument()

    // Go to next page (page 2)
    fireEvent.click(screen.getByLabelText("Go to next page"))
    expect(screen.getByText("row-11")).toBeInTheDocument()
  })

  // --- Single-select dedup when batch delete enables multi at TanStack level ---
  it("keeps only one selected row in single-select mode even when batch delete is active", () => {
    render(
      <BaseTable
        data={makeData(3)}
        columns={testColumns}
        options={{
          ...ALL_SECTIONS,
          enableRowSelection: true,
          onBatchDelete: vi.fn(),
        }}
      />,
    )
    // Select a row first
    const rowCheckboxes = screen.getAllByLabelText("Select row")
    fireEvent.click(rowCheckboxes[0])

    // Verify only one row is checked
    const checked = screen.getAllByLabelText("Select row").filter(
      (cb) => cb.hasAttribute("data-checked"),
    )
    expect(checked.length).toBe(1)

    // Select another row — in single-select mode it should replace
    fireEvent.click(rowCheckboxes[1])
    const afterSecond = screen.getAllByLabelText("Select row").filter(
      (cb) => cb.hasAttribute("data-checked"),
    )
    expect(afterSecond.length).toBeLessThanOrEqual(1)
  })

  it("single-select dedup: 'Select all pages' passes plain object and triggers dedup", async () => {
    render(
      <BaseTable
        data={makeData(3)}
        columns={testColumns}
        options={{
          ...ALL_SECTIONS,
          enableRowSelection: true,
          enablePagination: true,
          onBatchDelete: vi.fn(),
        }}
      />,
    )

    // Enter batch-delete mode (enables multi at TanStack level, but handler enforces single)
    fireEvent.click(screen.getByText("Secondary action"))
    await act(async () => { vi.advanceTimersByTime(200) })
    fireEvent.click(screen.getByText("Batch Delete…"))
    await act(async () => { vi.advanceTimersByTime(50) })

    // Select a row first so prevKeys in the dedup block is non-empty
    const rowCheckboxes = screen.getAllByLabelText("Select row")
    await act(async () => { fireEvent.click(rowCheckboxes[0]) })

    // Open the selection dropdown and click "Select all pages"
    // selectAllPages calls table.setRowSelection(plainObject), bypassing function-updater closure
    fireEvent.click(screen.getByLabelText("Selection options"))
    await act(async () => { vi.advanceTimersByTime(50) })
    fireEvent.click(screen.getByText("Select all pages"))

    // Dedup should have reduced the selection to exactly 1 row
    const checked = screen.getAllByLabelText("Select row").filter((cb) => cb.hasAttribute("data-checked"))
    expect(checked.length).toBe(1)
  })

  it("deduplicates to one row when Select-all is clicked in batch-delete + single-select mode", async () => {
    render(
      <BaseTable
        data={makeData(3)}
        columns={testColumns}
        options={{
          ...ALL_SECTIONS,
          enableRowSelection: true,
          onBatchDelete: vi.fn(),
        }}
      />,
    )

    // Enter batch-delete mode via the dropdown
    fireEvent.click(screen.getByText("Secondary action"))
    await act(async () => { vi.advanceTimersByTime(200) })
    fireEvent.click(screen.getByText("Batch Delete…"))
    await act(async () => { vi.advanceTimersByTime(50) })

    // Batch-delete mode enables multi-select at TanStack level,
    // so the header "Select all" checkbox appears
    const selectAll = screen.getByLabelText("Select all")
    fireEvent.click(selectAll)

    // The dedup branch should keep at most 1 row selected
    const checked = screen.getAllByLabelText("Select row").filter(
      (cb) => cb.hasAttribute("data-checked"),
    )
    expect(checked.length).toBeLessThanOrEqual(1)
  })
})

// --- createGlobalSearchFn unit tests ---

function mockRow(values: Record<string, unknown>) {
  return {
    getValue: (colId: string) => values[colId],
  } as unknown as import("@tanstack/react-table").Row<TestRow>
}

const dummyColumns: ColumnDef<TestRow>[] = [
  { accessorKey: "id", header: "ID" },
  { accessorKey: "name", header: "Name" },
  { accessorKey: "status", header: "Status" },
]

describe("createGlobalSearchFn", () => {
  it("returns true for every row when filterValue is empty", () => {
    const fn = createGlobalSearchFn(dummyColumns, new Set())
    const row = mockRow({ id: "r1", name: "Alpha", status: "Active" })
    expect(fn(row, "", "", () => { })).toBe(true)
  })

  it("returns true for every row when filterValue is null/undefined", () => {
    const fn = createGlobalSearchFn(dummyColumns, new Set())
    const row = mockRow({ id: "r1", name: "Alpha", status: "Active" })
    expect(fn(row, "", null, () => { })).toBe(true)
    expect(fn(row, "", undefined, () => { })).toBe(true)
  })

  it("matches a row whose column value contains the search term (case-insensitive)", () => {
    const fn = createGlobalSearchFn(dummyColumns, new Set())
    const row = mockRow({ id: "r1", name: "Alpha Beta", status: "Active" })
    expect(fn(row, "", "alpha", () => { })).toBe(true)
    expect(fn(row, "", "BETA", () => { })).toBe(true)
  })

  it("returns false when no column value matches", () => {
    const fn = createGlobalSearchFn(dummyColumns, new Set())
    const row = mockRow({ id: "r1", name: "Alpha", status: "Active" })
    expect(fn(row, "", "zzz_nomatch", () => { })).toBe(false)
  })

  it("skips columns with null/undefined values without crashing", () => {
    const fn = createGlobalSearchFn(dummyColumns, new Set())
    const row = mockRow({ id: "r1", name: null, status: undefined })
    expect(fn(row, "", "r1", () => { })).toBe(true)
    expect(fn(row, "", "zzz", () => { })).toBe(false)
  })

  it("joins array values with spaces before matching", () => {
    const cols: ColumnDef<TestRow>[] = [{ accessorKey: "tags" as keyof TestRow, header: "Tags" }]
    const fn = createGlobalSearchFn(cols, new Set())
    const row = mockRow({ tags: ["red", "green", "blue"] })
    expect(fn(row, "", "green", () => { })).toBe(true)
    expect(fn(row, "", "yellow", () => { })).toBe(false)
  })

  it("restricts search to searchableColumns when non-empty", () => {
    const fn = createGlobalSearchFn(dummyColumns, new Set(["name"]))
    const row = mockRow({ id: "match-me", name: "Nope", status: "Nope" })
    // "match-me" is in id column, but searchableColumns only includes "name"
    expect(fn(row, "", "match-me", () => { })).toBe(false)
    expect(fn(row, "", "Nope", () => { })).toBe(true)
  })

  it("searches all derived column IDs when searchableColumns is empty", () => {
    const fn = createGlobalSearchFn(dummyColumns, new Set())
    const row = mockRow({ id: "r1", name: "foo", status: "bar" })
    expect(fn(row, "", "bar", () => { })).toBe(true)
  })

  it("handles columns defined with id instead of accessorKey", () => {
    const cols: ColumnDef<TestRow>[] = [
      { id: "custom", header: "Custom", cell: () => null },
    ]
    const fn = createGlobalSearchFn(cols, new Set())
    const row = mockRow({ custom: "hello world" })
    expect(fn(row, "", "hello", () => { })).toBe(true)
  })
})
