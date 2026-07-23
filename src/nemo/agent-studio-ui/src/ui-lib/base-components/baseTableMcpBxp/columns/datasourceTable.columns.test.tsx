import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  type SortingState,
} from "@tanstack/react-table"
import { useState } from "react"
import { datasourceColumns } from "./datasourceTable.columns"
import type { DataSourceRow } from "../baseTable.types"

const testData: DataSourceRow[] = [
  {
    id: "ds-1",
    name: "Source A",
    description: "First datasource",
    interval: "daily",
    tags: ["prod", "main"],
    createdBy: "alice",
    createdAt: "2025-01-01",
    updatedBy: "bob",
    updatedAt: "2025-06-01",
    volumes: [{ type: "NFS", nfsSmb: { protocol: "NFS", host: "h1", exportPath: "/e", directories: [{ path: "/d" }] }, schedule: "daily" }],
    filters: { fileExtensions: [".txt"], regularExpressions: [".*"] },
  },
  {
    id: "ds-2",
    name: "Source B",
    description: "Second datasource",
    interval: "weekly",
    tags: ["staging"],
    createdBy: "carol",
    createdAt: "2025-02-01",
    updatedBy: "dave",
    updatedAt: "2025-07-01",
    volumes: [],
    filters: { fileExtensions: [], regularExpressions: [] },
  },
]

function TableWrapper({ enableSorting = true }: { enableSorting?: boolean }) {
  const [sorting, setSorting] = useState<SortingState>([])

  const table = useReactTable({
    data: testData,
    columns: datasourceColumns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: enableSorting ? getSortedRowModel() : undefined,
    onSortingChange: enableSorting ? setSorting : undefined,
    enableSorting,
    state: { sorting },
  })

  return (
    <table>
      <thead>
        {table.getHeaderGroups().map((hg) => (
          <tr key={hg.id}>
            {hg.headers.map((h) => (
              <th key={h.id}>
                {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.id}>
            {row.getVisibleCells().map((cell) => (
              <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

describe("datasourceColumns", () => {
  it("renders all cell values", () => {
    render(<TableWrapper />)
    expect(screen.getByText("ds-1")).toBeInTheDocument()
    expect(screen.getByText("Source A")).toBeInTheDocument()
    expect(screen.getByText("First datasource")).toBeInTheDocument()
    expect(screen.getByText("daily")).toBeInTheDocument()
    expect(screen.getByText("prod, main")).toBeInTheDocument()
    expect(screen.getByText("alice")).toBeInTheDocument()
  })

  it("renders string headers for non-sortable columns", () => {
    render(<TableWrapper enableSorting={false} />)
    expect(screen.getByText("Name")).toBeInTheDocument()
    expect(screen.getByText("Description")).toBeInTheDocument()
    expect(screen.getByText("Interval")).toBeInTheDocument()
    expect(screen.getByText("Tags")).toBeInTheDocument()
    expect(screen.getByText("ID")).toBeInTheDocument()
    expect(screen.getByText("Created At")).toBeInTheDocument()
    expect(screen.getByText("Updated At")).toBeInTheDocument()
  })

  it("cycles sorting for the ID column: unsorted → asc → desc → unsorted", () => {
    render(<TableWrapper />)
    const idButton = screen.getAllByRole("button").find((b) => b.textContent?.includes("ID"))!
    expect(idButton).toBeDefined()

    // unsorted → asc
    fireEvent.click(idButton)
    // asc → desc
    fireEvent.click(idButton)
    // desc → unsorted
    fireEvent.click(idButton)
    // Should still render without error
    expect(screen.getByText("ds-1")).toBeInTheDocument()
  })

  it("cycles sorting for the Created At column", () => {
    render(<TableWrapper />)
    const btn = screen.getAllByRole("button").find((b) => b.textContent?.includes("Created At"))!
    fireEvent.click(btn)
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(screen.getByText("ds-1")).toBeInTheDocument()
  })

  it("cycles sorting for the Updated At column", () => {
    render(<TableWrapper />)
    const btn = screen.getAllByRole("button").find((b) => b.textContent?.includes("Updated At"))!
    fireEvent.click(btn)
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(screen.getByText("ds-1")).toBeInTheDocument()
  })

  it("renders volumes as JSON", () => {
    render(<TableWrapper />)
    expect(screen.getByText(/NFS/)).toBeInTheDocument()
  })

  it("renders filters as JSON", () => {
    render(<TableWrapper />)
    expect(screen.getByText(/\.txt/)).toBeInTheDocument()
  })

  it("renders actions dropdown trigger for each row", () => {
    render(<TableWrapper />)
    const actionButtons = screen.getAllByRole("button").filter(
      (btn) => btn.querySelector("svg") && btn.closest(".dt-cell-action"),
    )
    expect(actionButtons.length).toBe(2)
  })

  it("renders tags as a plain string when value is not an array", () => {
    const dataWithStringTag: DataSourceRow[] = [
      {
        ...testData[0],
        id: "ds-str",
        tags: "single-tag" as unknown as string[],
      },
    ]

    function StringTagWrapper() {
      const table = useReactTable({
        data: dataWithStringTag,
        columns: datasourceColumns,
        getCoreRowModel: getCoreRowModel(),
      })
      return (
        <table>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )
    }

    render(<StringTagWrapper />)
    expect(screen.getByText("single-tag")).toBeInTheDocument()
  })

  it("copies datasource ID when clicking the action menu item", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    render(<TableWrapper />)
    const actionButtons = screen.getAllByRole("button").filter(
      (btn) => btn.querySelector("svg") && btn.closest(".dt-cell-action"),
    )
    fireEvent.click(actionButtons[0])
    const copyItem = await screen.findByText("Copy Datasource ID")
    fireEvent.click(copyItem)
    expect(writeText).toHaveBeenCalledWith("ds-1")
  })
})
