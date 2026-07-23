import { screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
} from "@tanstack/react-table"

import { renderWithProviders } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import type { DatasetListItem } from "@/api/dataset.types"
import {
  createDatasetListColumns,
  type DatasetTableRow,
  type ActionMenuItem,
} from "./dataset-list.columns"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_ROW: DatasetTableRow = {
  id: "d-1",
  dset_id: "d-1",
  name: "My Dataset",
  kind: "unstructured",
  status: "Healthy",
  lifecycle_status: "ready",
  synchronization_status: "Completed",
  input_type: "data-source",
  data_source: { dsrc_id: "ds-1", name: "production-nfs-share" },
  deprecated: false,
  files_count: 1247,
  labels: ["Staging"],
  created_at: "2024-01-15T10:00:00Z",
  updated_at: "2024-01-15T10:00:00Z",
  modified_by: "user@example.com",
  latest_snapshot: { id: "snap-1", version: 5, date: "2026-02-10T07:15:06Z", total_files: 1247, files_added: 10, files_removed: 2 },
}

const DEPRECATED_ROW: DatasetTableRow = {
  ...BASE_ROW,
  id: "d-dep",
  dset_id: "d-dep",
  name: "Old Dataset",
  deprecated: true,
}

const NO_DATASOURCE_ROW: DatasetTableRow = {
  ...BASE_ROW,
  id: "d-up",
  dset_id: "d-up",
  input_type: "upload",
  data_source: null,
  latest_snapshot: null,
}

const MANUAL_UPLOAD_ROW: DatasetTableRow = {
  ...NO_DATASOURCE_ROW,
  synchronization_status: "Never",
}

const EMPTY_LABELS_ROW: DatasetTableRow = { ...BASE_ROW, id: "d-nl", dset_id: "d-nl", labels: [] }

function TableWrapper({
  rows,
  callbacks,
}: {
  rows: DatasetTableRow[]
  callbacks: Parameters<typeof createDatasetListColumns>[0]
}) {
  const columns = createDatasetListColumns(callbacks)

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDatasetListColumns", () => {
  let roCleanup: () => void
  beforeEach(() => { roCleanup = mockResizeObserver().cleanup })
  afterEach(() => roCleanup?.())

  const menuItems: ActionMenuItem<DatasetTableRow>[] = [
    { label: "Edit", onClick: vi.fn() },
    { label: "Delete", onClick: vi.fn() },
  ]

  // 1
  it("[tag:dataset-list-columns] name cell: not deprecated renders button link calling onNavigateDetail", () => {
    const onNavigateDetail = vi.fn()

    renderWithProviders(
      <TableWrapper
        rows={[BASE_ROW]}
        callbacks={{ onNavigateDetail, actionMenuItems: menuItems }}
      />,
    )

    const nameBtn = screen.getByRole("button", { name: "My Dataset" })
    expect(nameBtn).toBeInTheDocument()
    fireEvent.click(nameBtn)
    expect(onNavigateDetail).toHaveBeenCalledWith("d-1")
  })

  // 2
  it("[tag:dataset-list-columns][tag:deprecated] name cell: deprecated shows muted text, no button", () => {
    renderWithProviders(
      <TableWrapper
        rows={[DEPRECATED_ROW]}
        callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }}
      />,
    )

    expect(screen.queryByRole("button", { name: "Old Dataset" })).not.toBeInTheDocument()
    expect(screen.getByText("Old Dataset")).toBeInTheDocument()
  })

  // 3
  it("[tag:dataset-list-columns] status column renders DatasetStatusCell (shows status label)", () => {
    renderWithProviders(
      <TableWrapper
        rows={[BASE_ROW]}
        callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }}
      />,
    )

    expect(screen.getByText("Healthy")).toBeInTheDocument()
  })

  // 4
  it("[tag:dataset-list-columns] file scope column shows formatted files_count", () => {
    renderWithProviders(
      <TableWrapper
        rows={[BASE_ROW]}
        callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }}
      />,
    )

    expect(screen.getByText("1,247")).toBeInTheDocument()
  })

  // 5
  it("[tag:dataset-list-columns] synchronization status column renders SyncStatusCell", () => {
    renderWithProviders(
      <TableWrapper
        rows={[BASE_ROW]}
        callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }}
      />,
    )

    expect(screen.getByText("Completed")).toBeInTheDocument()
  })

  it("[tag:dataset-list-columns] manual upload shows '—' instead of Never synced in sync status", () => {
    renderWithProviders(
      <TableWrapper
        rows={[MANUAL_UPLOAD_ROW]}
        callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }}
      />,
    )

    expect(screen.queryByText("Never synced")).not.toBeInTheDocument()
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  // 6
  it("[tag:dataset-list-columns] revision column shows 'Version N' when snapshot present", () => {
    renderWithProviders(
      <TableWrapper
        rows={[BASE_ROW]}
        callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }}
      />,
    )

    expect(screen.getByText("Version 5")).toBeInTheDocument()
  })

  // 7
  it("[tag:dataset-list-columns] revision column shows '—' when no snapshot", () => {
    renderWithProviders(
      <TableWrapper
        rows={[NO_DATASOURCE_ROW]}
        callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }}
      />,
    )

    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  // 8
  it("[tag:dataset-list-columns] assigned data source: renders link button when callback provided and not deprecated", () => {
    const onNavigateDataSource = vi.fn()

    renderWithProviders(
      <TableWrapper
        rows={[BASE_ROW]}
        callbacks={{ onNavigateDetail: vi.fn(), onNavigateDataSource, actionMenuItems: menuItems }}
      />,
    )

    const dsBtn = screen.getByRole("button", { name: "production-nfs-share" })
    expect(dsBtn).toBeInTheDocument()
    fireEvent.click(dsBtn)
    expect(onNavigateDataSource).toHaveBeenCalledWith("ds-1")
  })

  // 9
  it("[tag:dataset-list-columns] assigned data source: shows plain text when no callback", () => {
    renderWithProviders(
      <TableWrapper
        rows={[BASE_ROW]}
        callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }}
      />,
    )

    expect(screen.getByText("production-nfs-share")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "production-nfs-share" })).not.toBeInTheDocument()
  })

  // 10
  it("[tag:dataset-list-columns] assigned data source: shows '—' when null", () => {
    renderWithProviders(
      <TableWrapper
        rows={[NO_DATASOURCE_ROW]}
        callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }}
      />,
    )

    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  // 11
  it("[tag:dataset-list-columns] last synchronization: shows formatted date from latest_snapshot", () => {
    renderWithProviders(
      <TableWrapper
        rows={[BASE_ROW]}
        callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }}
      />,
    )

    expect(screen.getByText(/Feb/)).toBeInTheDocument()
  })

  // 12
  it("[tag:dataset-list-columns] last synchronization: shows '—' when no snapshot", () => {
    renderWithProviders(
      <TableWrapper
        rows={[NO_DATASOURCE_ROW]}
        callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }}
      />,
    )

    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  // 13
  it("[tag:dataset-list-columns][tag:empty] labels cell: empty array renders '—'", () => {
    renderWithProviders(
      <TableWrapper
        rows={[EMPTY_LABELS_ROW]}
        callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }}
      />,
    )

    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  // 14
  it("[tag:dataset-list-columns] labels cell with values renders ChipList", () => {
    renderWithProviders(
      <TableWrapper
        rows={[BASE_ROW]}
        callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }}
      />,
    )

    expect(screen.getByText("Staging")).toBeInTheDocument()
  })

  // 15
  it("[tag:dataset-list-columns] actions: renders action button for the row", () => {
    renderWithProviders(
      <TableWrapper
        rows={[BASE_ROW]}
        callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }}
      />,
    )

    expect(
      screen.getByRole("button", { name: `Actions for ${BASE_ROW.name}` }),
    ).toBeInTheDocument()
  })

  // 16
  it("[tag:dataset-list-columns] actions: factory function receives the row", async () => {
    const factory = vi.fn((row: DatasetTableRow): ActionMenuItem<DatasetTableRow>[] => [
      { label: `Edit ${row.name}`, onClick: vi.fn() },
    ])

    const { default: ue } = await import("@testing-library/user-event")
    const user = ue.setup()

    renderWithProviders(
      <TableWrapper
        rows={[BASE_ROW]}
        callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: factory }}
      />,
    )

    await user.click(screen.getByRole("button", { name: `Actions for ${BASE_ROW.name}` }))

    expect(factory).toHaveBeenCalledWith(BASE_ROW)
    expect(await screen.findByText(`Edit ${BASE_ROW.name}`)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// DatasetListItem shape guard — ensures fixture covers all required fields
// ---------------------------------------------------------------------------

const _shapeCheck: DatasetListItem = {
  dset_id: "d-1",
  name: "x",
  kind: "unstructured",
  status: "Healthy",
  lifecycle_status: "ready",
  synchronization_status: "Completed",
  input_type: "data-source",
  data_source: null,
  deprecated: false,
  files_count: 0,
  labels: [],
  created_at: "",
  updated_at: "",
  modified_by: "",
  latest_snapshot: null,
}
void _shapeCheck
