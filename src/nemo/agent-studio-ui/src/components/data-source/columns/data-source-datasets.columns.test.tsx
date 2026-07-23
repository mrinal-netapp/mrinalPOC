import { screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
} from "@tanstack/react-table"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import {
  createDataSourceDatasetsColumns,
  type DatasetTableRow,
} from "./data-source-datasets.columns"

// ---------------------------------------------------------------------------
// Section 5 — createDataSourceDatasetsColumns
// ---------------------------------------------------------------------------

const BASE_DATASET: DatasetTableRow = {
  id: "d1",
  dset_id: "d1",
  name: "Alpha Dataset",
  file_scope: 5000,
  synchronization_schedule: "daily",
  status: "Healthy",
  labels: ["prod"],
  created_at: "2024-03-10T08:00:00Z",
}

function TableWrapper({
  rows,
  onNavigateDataset,
}: {
  rows: DatasetTableRow[]
  onNavigateDataset?: (id: string) => void
}) {
  const columns = createDataSourceDatasetsColumns({ onNavigateDataset })

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

describe("createDataSourceDatasetsColumns", () => {
  let roCleanup: () => void
  beforeEach(() => { roCleanup = mockResizeObserver().cleanup })
  afterEach(() => roCleanup?.())

  // 5.11
  it("[tag:ds-datasets-columns] name: onNavigateDataset defined renders link button", async () => {
    const user = userEvent.setup()
    const onNavigateDataset = vi.fn()

    renderWithProviders(
      <TableWrapper rows={[BASE_DATASET]} onNavigateDataset={onNavigateDataset} />,
    )

    const btn = screen.getByRole("button", { name: "Alpha Dataset" })
    expect(btn).toBeInTheDocument()
    await user.click(btn)
    expect(onNavigateDataset).toHaveBeenCalledWith("d1")
  })

  // 5.12
  it("[tag:ds-datasets-columns] name: no onNavigateDataset renders plain text", () => {
    renderWithProviders(<TableWrapper rows={[BASE_DATASET]} />)

    expect(screen.queryByRole("button", { name: "Alpha Dataset" })).not.toBeInTheDocument()
    expect(screen.getByText("Alpha Dataset")).toBeInTheDocument()
  })

  // 5.13
  it("[tag:ds-datasets-columns] synchronization_schedule null renders '—'", () => {
    renderWithProviders(
      <TableWrapper rows={[{ ...BASE_DATASET, synchronization_schedule: null }]} />,
    )

    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  // 5.14
  it("[tag:ds-datasets-columns][tag:empty] labels empty renders '—'", () => {
    renderWithProviders(<TableWrapper rows={[{ ...BASE_DATASET, labels: [] }]} />)

    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  // 5.15
  it("[tag:ds-datasets-columns] status column renders DatasetStatusCell label", () => {
    renderWithProviders(<TableWrapper rows={[BASE_DATASET]} />)

    expect(screen.getByText("Healthy")).toBeInTheDocument()
  })
})
