import { screen } from "@testing-library/react"
import { describe, it, expect } from "vitest"
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
} from "@tanstack/react-table"

import { renderWithProviders } from "@test/render"
import {
  createDataSourceActivityColumns,
  type ActivityTableRow,
} from "./data-source-activity.columns"

// ---------------------------------------------------------------------------
// Section 5 — createDataSourceActivityColumns
// ---------------------------------------------------------------------------

const BASE_ACTIVITY: ActivityTableRow = {
  id: "act-1",
  activity_id: "act-1",
  created_at: "2024-06-01T12:00:00Z",
  status: "Success",
  event: "Scan completed",
  details: "1,000 files indexed",
}

function TableWrapper({ rows }: { rows: ActivityTableRow[] }) {
  const columns = createDataSourceActivityColumns()

  const table = useReactTable({
    data: rows,
    columns,
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

describe("createDataSourceActivityColumns", () => {
  // 5.16
  it("[tag:ds-activity-columns] all 4 column headers are present", () => {
    const columns = createDataSourceActivityColumns()
    const headers = columns.map((c) => c.header)

    expect(headers).toContain("Timestamp")
    expect(headers).toContain("Status")
    expect(headers).toContain("Event")
    expect(headers).toContain("Details")
  })

  // 5.17
  it("[tag:ds-activity-columns] details null renders '—'", () => {
    renderWithProviders(<TableWrapper rows={[{ ...BASE_ACTIVITY, details: null }]} />)

    expect(screen.getByText("—")).toBeInTheDocument()
  })

  // 5.18
  it("[tag:ds-activity-columns] status column renders ActivityStatusCell label", () => {
    renderWithProviders(<TableWrapper rows={[BASE_ACTIVITY]} />)

    expect(screen.getByText("Success")).toBeInTheDocument()
  })

  it("[tag:ds-activity-columns] event and details text render", () => {
    renderWithProviders(<TableWrapper rows={[BASE_ACTIVITY]} />)

    expect(screen.getByText("Scan completed")).toBeInTheDocument()
    expect(screen.getByText("1,000 files indexed")).toBeInTheDocument()
  })
})
