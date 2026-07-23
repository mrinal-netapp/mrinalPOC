import { screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
} from "@tanstack/react-table"

import { renderWithProviders } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import {
  createKBDatasetsColumns,
  type KBDatasetTableRow,
  type KBDatasetColumnsCallbacks,
} from "./kb-datasets.columns"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULL_ROW: KBDatasetTableRow = {
  id: "ds-1",
  dset_id: "ds-1",
  name: "Training Data",
  status: "Healthy",
  synchronization_status: "Completed",
  file_scope: "1,234 files",
  labels: ["production", "v2"],
  active_version: 7,
  refresh_config: {
    auto_refresh_enabled: true,
    schedule_type: "daily",
    time_of_day: "08:30",
    day_of_week: null,
    day_of_month: null,
    timezone: "UTC",
    cron_expression: null,
    paused: false,
  },
}

const MINIMAL_ROW: KBDatasetTableRow = {
  id: "ds-2",
  dset_id: undefined,
  name: undefined,
  status: undefined,
  synchronization_status: undefined,
  file_scope: undefined,
  labels: undefined,
  active_version: undefined,
}

const NO_LABELS_ROW: KBDatasetTableRow = {
  ...FULL_ROW,
  id: "ds-nl",
  labels: [],
}

// ---------------------------------------------------------------------------
// Table wrapper
// ---------------------------------------------------------------------------

function TableWrapper({
  rows,
  callbacks,
}: {
  rows: KBDatasetTableRow[]
  callbacks: KBDatasetColumnsCallbacks
}) {
  const columns = createKBDatasetsColumns(callbacks)
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
// Tests
// ---------------------------------------------------------------------------

describe("createKBDatasetsColumns", () => {
  let roCleanup: () => void
  beforeEach(() => { roCleanup = mockResizeObserver().cleanup })
  afterEach(() => roCleanup?.())

  it("[tag:kb-datasets-columns] name cell: navigable link when callback and dset_id present", () => {
    const onNavigateDataset = vi.fn()
    renderWithProviders(
      <TableWrapper rows={[FULL_ROW]} callbacks={{ onNavigateDataset }} />,
    )

    const btn = screen.getByRole("button", { name: "Training Data" })
    fireEvent.click(btn)
    expect(onNavigateDataset).toHaveBeenCalledWith("ds-1")
  })

  it("[tag:kb-datasets-columns] name cell: plain text when no callback", () => {
    renderWithProviders(
      <TableWrapper rows={[FULL_ROW]} callbacks={{}} />,
    )
    expect(screen.getByText("Training Data")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Training Data" })).not.toBeInTheDocument()
  })

  it("[tag:kb-datasets-columns] name cell: shows '—' when name is undefined", () => {
    renderWithProviders(
      <TableWrapper rows={[MINIMAL_ROW]} callbacks={{}} />,
    )
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:kb-datasets-columns] status cell: renders DatasetStatusCell when status present", () => {
    renderWithProviders(
      <TableWrapper rows={[FULL_ROW]} callbacks={{}} />,
    )
    expect(screen.getByText("Healthy")).toBeInTheDocument()
  })

  it("[tag:kb-datasets-columns] status cell: shows '—' when status is undefined", () => {
    renderWithProviders(
      <TableWrapper rows={[MINIMAL_ROW]} callbacks={{}} />,
    )
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:kb-datasets-columns] file scope cell: shows value", () => {
    renderWithProviders(
      <TableWrapper rows={[FULL_ROW]} callbacks={{}} />,
    )
    expect(screen.getByText("1,234 files")).toBeInTheDocument()
  })

  it("[tag:kb-datasets-columns] file scope cell: shows '—' when undefined", () => {
    renderWithProviders(
      <TableWrapper rows={[MINIMAL_ROW]} callbacks={{}} />,
    )
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:kb-datasets-columns] sync schedule cell: shows schedule label from refresh_config", () => {
    renderWithProviders(
      <TableWrapper rows={[FULL_ROW]} callbacks={{}} />,
    )
    expect(screen.getByText(/Runs every day/)).toBeInTheDocument()
  })

  it("[tag:kb-datasets-columns] sync status cell: renders SyncStatusCell when present", () => {
    renderWithProviders(
      <TableWrapper rows={[FULL_ROW]} callbacks={{}} />,
    )
    expect(screen.getByText("Completed")).toBeInTheDocument()
  })

  it("[tag:kb-datasets-columns] sync status cell: shows '—' when undefined", () => {
    renderWithProviders(
      <TableWrapper rows={[MINIMAL_ROW]} callbacks={{}} />,
    )
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:kb-datasets-columns] revision cell: shows 'Version N' when present", () => {
    renderWithProviders(
      <TableWrapper rows={[FULL_ROW]} callbacks={{}} />,
    )
    expect(screen.getByText("Version 7")).toBeInTheDocument()
  })

  it("[tag:kb-datasets-columns] revision cell: shows '—' when undefined", () => {
    renderWithProviders(
      <TableWrapper rows={[MINIMAL_ROW]} callbacks={{}} />,
    )
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:kb-datasets-columns] labels cell: renders ChipList when non-empty", () => {
    renderWithProviders(
      <TableWrapper rows={[FULL_ROW]} callbacks={{}} />,
    )
    expect(screen.getByText("production")).toBeInTheDocument()
    expect(screen.getByText("v2")).toBeInTheDocument()
  })

  it("[tag:kb-datasets-columns] labels cell: shows '—' when empty array", () => {
    renderWithProviders(
      <TableWrapper rows={[NO_LABELS_ROW]} callbacks={{}} />,
    )
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:kb-datasets-columns] labels cell: shows '—' when labels is undefined", () => {
    renderWithProviders(
      <TableWrapper rows={[MINIMAL_ROW]} callbacks={{}} />,
    )
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:kb-datasets-columns] name cell: shows '—' inside navigable link when name is undefined", () => {
    const namelessRow: KBDatasetTableRow = {
      ...FULL_ROW,
      id: "ds-nameless",
      name: undefined,
    }
    const onNavigateDataset = vi.fn()
    renderWithProviders(
      <TableWrapper rows={[namelessRow]} callbacks={{ onNavigateDataset }} />,
    )
    const btn = screen.getByRole("button")
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveTextContent("—")
  })
})
