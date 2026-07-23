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
import { jobColumns } from "./jobTable.columns"
import type { JobTableRow } from "../baseTable.types"

const testData: JobTableRow[] = [
  {
    id: "job-1",
    status: ["Done"],
    executionMap: "map-a",
    metadata: "meta-a",
    steps: [],
    createdBy: "alice",
    createdAt: "2025-01-01",
    updatedBy: "bob",
    updatedAt: "2025-06-01",
  },
  {
    id: "job-2",
    status: ["Failed"],
    executionMap: "map-b",
    metadata: "meta-b",
    steps: [],
    createdBy: "carol",
    createdAt: "2025-02-01",
    updatedBy: "dave",
    updatedAt: "2025-07-01",
  },
  {
    id: "job-3",
    status: ["Pending"],
    executionMap: "map-c",
    metadata: "meta-c",
    steps: [],
    createdBy: "eve",
    createdAt: "2025-03-01",
    updatedBy: "frank",
    updatedAt: "2025-08-01",
  },
  {
    id: "job-4",
    status: ["Initialized"],
    executionMap: "map-d",
    metadata: "meta-d",
    steps: [],
    createdBy: "grace",
    createdAt: "2025-04-01",
    updatedBy: "hank",
    updatedAt: "2025-09-01",
  },
]

function TableWrapper({ enableSorting = true }: { enableSorting?: boolean }) {
  const [sorting, setSorting] = useState<SortingState>([])

  const table = useReactTable({
    data: testData,
    columns: jobColumns,
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

describe("jobColumns", () => {
  it("renders all cell values", () => {
    render(<TableWrapper />)
    expect(screen.getByText("job-1")).toBeInTheDocument()
    expect(screen.getByText("map-a")).toBeInTheDocument()
    expect(screen.getByText("meta-a")).toBeInTheDocument()
    expect(screen.getByText("alice")).toBeInTheDocument()
    expect(screen.getByText("bob")).toBeInTheDocument()
  })

  it("renders status badge with success dot for Done", () => {
    const { container } = render(<TableWrapper />)
    const dots = container.querySelectorAll(".dt-cell-badge-dot")
    const successDots = container.querySelectorAll(".dt-cell-badge-dot--success")
    expect(dots.length).toBeGreaterThan(0)
    expect(successDots.length).toBeGreaterThan(0)
  })

  it("renders status badge with error dot for Failed", () => {
    const { container } = render(<TableWrapper />)
    expect(container.querySelector(".dt-cell-badge-dot--error")).toBeInTheDocument()
  })

  it("renders status badge with primary dot for Pending", () => {
    const { container } = render(<TableWrapper />)
    expect(container.querySelector(".dt-cell-badge-dot--primary")).toBeInTheDocument()
  })

  it("renders status badge with muted dot for Initialized", () => {
    const { container } = render(<TableWrapper />)
    expect(container.querySelector(".dt-cell-badge-dot--muted")).toBeInTheDocument()
  })

  it("renders string headers when sorting is disabled", () => {
    render(<TableWrapper enableSorting={false} />)
    expect(screen.getByText("ID")).toBeInTheDocument()
    expect(screen.getByText("Created At")).toBeInTheDocument()
    expect(screen.getByText("Updated At")).toBeInTheDocument()
  })

  it("cycles sorting for the ID column", () => {
    render(<TableWrapper />)
    const idButton = screen.getAllByRole("button").find((b) => b.textContent?.includes("ID"))!
    fireEvent.click(idButton)
    fireEvent.click(idButton)
    fireEvent.click(idButton)
    expect(screen.getByText("job-1")).toBeInTheDocument()
  })

  it("cycles sorting for the Created At column", () => {
    render(<TableWrapper />)
    const btn = screen.getAllByRole("button").find((b) => b.textContent?.includes("Created At"))!
    fireEvent.click(btn)
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(screen.getByText("job-1")).toBeInTheDocument()
  })

  it("cycles sorting for the Updated At column", () => {
    render(<TableWrapper />)
    const btn = screen.getAllByRole("button").find((b) => b.textContent?.includes("Updated At"))!
    fireEvent.click(btn)
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(screen.getByText("job-1")).toBeInTheDocument()
  })

  it("renders actions dropdown trigger for each row", () => {
    render(<TableWrapper />)
    const actionButtons = screen.getAllByRole("button").filter(
      (btn) => btn.querySelector("svg") && btn.closest(".dt-cell-action"),
    )
    expect(actionButtons.length).toBe(4)
  })

  it("renders status from a plain string when status is not an array", () => {
    const dataWithStringStatus: JobTableRow[] = [
      {
        ...testData[0],
        id: "job-str",
        status: "In Progress" as unknown as JobTableRow["status"],
      },
    ]

    function StringStatusWrapper() {
      const table = useReactTable({
        data: dataWithStringStatus,
        columns: jobColumns,
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

    render(<StringStatusWrapper />)
    expect(screen.getByText("In Progress")).toBeInTheDocument()
  })

  it("copies job ID when clicking the copy action", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })

    render(<TableWrapper />)
    const actionButtons = screen.getAllByRole("button").filter(
      (btn) => btn.querySelector("svg") && btn.closest(".dt-cell-action"),
    )
    fireEvent.click(actionButtons[0])
    const copyItem = await screen.findByText("Copy Job ID")
    fireEvent.click(copyItem)
    expect(writeText).toHaveBeenCalledWith("job-1")
  })
})
