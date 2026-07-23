import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect } from "vitest"
import { useState } from "react"
import {
  useReactTable,
  getCoreRowModel,
  getPaginationRowModel,
  getFilteredRowModel,
  type ColumnDef,
} from "@tanstack/react-table"
import { HeaderCheckboxDropdown } from "./headerCheckboxDropdown"
import type { BaseElement } from "./baseTable.types"

interface TestRow extends BaseElement {
  name: string
}

const testData: TestRow[] = Array.from({ length: 25 }, (_, i) => ({
  id: `row-${i + 1}`,
  name: `Item ${i + 1}`,
}))

const testColumns: ColumnDef<TestRow>[] = [
  { accessorKey: "id", header: "ID" },
  { accessorKey: "name", header: "Name" },
]

function Wrapper({ enablePagination = true }: { enablePagination?: boolean }) {
  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({})

  const table = useReactTable({
    data: testData,
    columns: testColumns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: enablePagination ? getPaginationRowModel() : undefined,
    getFilteredRowModel: getFilteredRowModel(),
    enableRowSelection: true,
    enableMultiRowSelection: true,
    onRowSelectionChange: setRowSelection,
    state: { rowSelection },
    meta: { enablePagination },
    initialState: { pagination: { pageSize: 10 } },
  })

  return <HeaderCheckboxDropdown table={table} />
}

function openDropdown() {
  fireEvent.click(screen.getByLabelText("Selection options"))
}

describe("HeaderCheckboxDropdown", () => {
  it("renders checkbox and dropdown arrow", () => {
    render(<Wrapper />)
    expect(screen.getByLabelText("Select all")).toBeInTheDocument()
    expect(screen.getByLabelText("Selection options")).toBeInTheDocument()
  })

  it("opens dropdown on arrow click", () => {
    render(<Wrapper />)
    openDropdown()
    expect(screen.getByRole("menu")).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Select this page" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Select all pages" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Clear all" })).toBeInTheDocument()
  })

  it("closes dropdown on second click", () => {
    render(<Wrapper />)
    openDropdown()
    expect(screen.getByRole("menu")).toBeInTheDocument()
    openDropdown()
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("closes dropdown on outside click", () => {
    render(<Wrapper />)
    openDropdown()
    expect(screen.getByRole("menu")).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("closes dropdown on Escape key", () => {
    render(<Wrapper />)
    openDropdown()
    expect(screen.getByRole("menu")).toBeInTheDocument()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("'Select this page' selects page rows and closes menu", () => {
    render(<Wrapper />)
    openDropdown()
    fireEvent.click(screen.getByRole("menuitem", { name: "Select this page" }))
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("'Select all pages' selects all rows and closes menu", () => {
    render(<Wrapper />)
    openDropdown()
    fireEvent.click(screen.getByRole("menuitem", { name: "Select all pages" }))
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("'Clear all' is disabled when no rows are selected", () => {
    render(<Wrapper />)
    openDropdown()
    expect(screen.getByRole("menuitem", { name: "Clear all" })).toBeDisabled()
  })

  it("'Clear all' is enabled after selecting rows", () => {
    render(<Wrapper />)

    // Select this page first
    openDropdown()
    fireEvent.click(screen.getByRole("menuitem", { name: "Select this page" }))

    // Re-open and check Clear all
    openDropdown()
    expect(screen.getByRole("menuitem", { name: "Clear all" })).toBeEnabled()
  })

  it("'Clear all' deselects everything and closes menu", () => {
    render(<Wrapper />)

    // Select, then clear
    openDropdown()
    fireEvent.click(screen.getByRole("menuitem", { name: "Select this page" }))
    openDropdown()
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear all" }))
    expect(screen.queryByRole("menu")).toBeNull()

    // Clear all should be disabled again
    openDropdown()
    expect(screen.getByRole("menuitem", { name: "Clear all" })).toBeDisabled()
  })

  it("'Select all pages' is disabled when pagination is off", () => {
    render(<Wrapper enablePagination={false} />)
    openDropdown()
    expect(screen.getByRole("menuitem", { name: "Select all pages" })).toBeDisabled()
  })
})
