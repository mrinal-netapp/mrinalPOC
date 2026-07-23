import { screen } from "@testing-library/react"
import { describe, it, expect } from "vitest"
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
} from "@tanstack/react-table"

import { renderWithProviders } from "@test/render"
import {
  createKBActivityColumns,
  formatDurationMinutes,
  type KBActivityTableRow,
} from "./kb-activity.columns"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULL_ROW: KBActivityTableRow = {
  id: "act-1",
  event: "Synchronization started",
  status: "ready",
  duration: 5,
  timestamp: "2026-02-10T07:15:06Z",
}

const EMPTY_ROW: KBActivityTableRow = {
  id: "act-2",
}

// ---------------------------------------------------------------------------
// Table wrapper
// ---------------------------------------------------------------------------

function TableWrapper({ rows }: { rows: KBActivityTableRow[] }) {
  const columns = createKBActivityColumns()
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })

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

// ---------------------------------------------------------------------------
// formatDurationMinutes
// ---------------------------------------------------------------------------

describe("formatDurationMinutes", () => {
  it("[tag:kb][tag:activity-columns] returns '—' for undefined", () => {
    expect(formatDurationMinutes(undefined)).toBe("—")
  })

  it("[tag:kb][tag:activity-columns] returns '1 minute' for 1", () => {
    expect(formatDurationMinutes(1)).toBe("1 minute")
  })

  it("[tag:kb][tag:activity-columns] returns '5 minutes' for 5", () => {
    expect(formatDurationMinutes(5)).toBe("5 minutes")
  })

  it("[tag:kb][tag:activity-columns] returns '0 minutes' for 0", () => {
    expect(formatDurationMinutes(0)).toBe("0 minutes")
  })
})

// ---------------------------------------------------------------------------
// Column cells
// ---------------------------------------------------------------------------

describe("createKBActivityColumns", () => {
  it("[tag:kb][tag:activity-columns] event cell renders event text", () => {
    renderWithProviders(<TableWrapper rows={[FULL_ROW]} />)
    expect(screen.getByText("Synchronization started")).toBeInTheDocument()
  })

  it("[tag:kb][tag:activity-columns] event cell renders '—' when undefined", () => {
    renderWithProviders(<TableWrapper rows={[EMPTY_ROW]} />)
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:kb][tag:activity-columns] status cell renders status text", () => {
    renderWithProviders(<TableWrapper rows={[FULL_ROW]} />)
    expect(screen.getByText("ready")).toBeInTheDocument()
  })

  it("[tag:kb][tag:activity-columns] status cell renders '—' when status is undefined", () => {
    renderWithProviders(<TableWrapper rows={[EMPTY_ROW]} />)
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:kb][tag:activity-columns] duration cell renders formatted duration", () => {
    renderWithProviders(<TableWrapper rows={[FULL_ROW]} />)
    expect(screen.getByText("5 minutes")).toBeInTheDocument()
  })

  it("[tag:kb][tag:activity-columns] timestamp cell renders formatted date", () => {
    renderWithProviders(<TableWrapper rows={[FULL_ROW]} />)
    expect(screen.getByText(/Feb/)).toBeInTheDocument()
  })

  it("[tag:kb][tag:activity-columns] timestamp cell renders '—' when undefined", () => {
    renderWithProviders(<TableWrapper rows={[EMPTY_ROW]} />)
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:kb][tag:activity-columns] status cell falls back to default visual for unrecognised status", () => {
    const unknownStatusRow: KBActivityTableRow = {
      id: "act-3",
      status: "SomethingUnknown",
    }
    renderWithProviders(<TableWrapper rows={[unknownStatusRow]} />)
    expect(screen.getByText("SomethingUnknown")).toBeInTheDocument()
  })
})
