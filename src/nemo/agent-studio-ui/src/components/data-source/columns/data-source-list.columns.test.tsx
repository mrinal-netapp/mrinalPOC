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
  createDataSourceListColumns,
  type DataSourceTableRow,
  type ActionMenuItem,
} from "./data-source-list.columns"

// ---------------------------------------------------------------------------
// Section 5 — createDataSourceListColumns
// ---------------------------------------------------------------------------

const BASE_ROW: DataSourceTableRow = {
  id: "ds-1",
  dsrc_id: "ds-1",
  name: "My Source",
  status: "Healthy",
  scan_status: "Completed",
  source_type: "NFS",
  deprecated: false,
  labels: ["prod"],
  created_at: "2024-01-15T10:00:00Z",
  updated_at: "2024-01-15T10:00:00Z",
  associated_datasets: [{ dset_id: "d1", name: "Dataset A" }],
  associated_datasets_count: 1,
  last_validated_at: null,
  last_validation_error: null,
  scan: null,
}

const DEPRECATED_ROW: DataSourceTableRow = {
  ...BASE_ROW,
  id: "ds-dep",
  dsrc_id: "ds-dep",
  name: "Old Source",
  deprecated: true,
}

const EMPTY_LABELS_ROW: DataSourceTableRow = { ...BASE_ROW, id: "ds-nl", dsrc_id: "ds-nl", labels: [], associated_datasets: [] }

function TableWrapper({
  rows,
  callbacks,
}: {
  rows: DataSourceTableRow[]
  callbacks: Parameters<typeof createDataSourceListColumns>[0]
}) {
  const columns = createDataSourceListColumns(callbacks)

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

describe("createDataSourceListColumns", () => {
  let roCleanup: () => void
  beforeEach(() => { roCleanup = mockResizeObserver().cleanup })
  afterEach(() => roCleanup?.())

  const menuItems: ActionMenuItem<DataSourceTableRow>[] = [
    { label: "Edit", onClick: vi.fn() },
    { label: "Delete", onClick: vi.fn() },
  ]

  // 5.1
  it("[tag:ds-list-columns] name cell: not deprecated renders button link calling onNavigateDetail", () => {
    const onNavigateDetail = vi.fn()

    renderWithProviders(
      <TableWrapper
        rows={[BASE_ROW]}
        callbacks={{ onNavigateDetail, actionMenuItems: menuItems }}
      />,
    )

    const nameBtn = screen.getByRole("button", { name: "My Source" })
    expect(nameBtn).toBeInTheDocument()
    fireEvent.click(nameBtn)
    expect(onNavigateDetail).toHaveBeenCalledWith("ds-1")
  })

  // 5.2
  it("[tag:ds-list-columns][tag:deprecated] name cell: deprecated shows muted text, no button", () => {
    renderWithProviders(
      <TableWrapper
        rows={[DEPRECATED_ROW]}
        callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }}
      />,
    )

    expect(screen.queryByRole("button", { name: "Old Source" })).not.toBeInTheDocument()
    expect(screen.getByText("Old Source")).toBeInTheDocument()
  })

  // 5.3
  it("[tag:ds-list-columns] connection status: never-validated row shows 'Untested'", () => {
    renderWithProviders(
      <TableWrapper
        rows={[BASE_ROW]}
        callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }}
      />,
    )

    // BASE_ROW.last_validated_at is null → Untested regardless of backend status
    expect(screen.getByText("Untested")).toBeInTheDocument()
  })

  // 5.3b
  it("[tag:ds-list-columns] connection status: validated Healthy → 'Success', validated unhealthy → 'Failed'", () => {
    renderWithProviders(
      <TableWrapper
        rows={[
          { ...BASE_ROW, id: "ds-ok", dsrc_id: "ds-ok", status: "Healthy", last_validated_at: "2024-01-15T10:00:00Z" },
          { ...BASE_ROW, id: "ds-bad", dsrc_id: "ds-bad", status: "Unhealthy", last_validated_at: "2024-01-15T10:00:00Z" },
        ]}
        callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }}
      />,
    )

    expect(screen.getByText("Success")).toBeInTheDocument()
    expect(screen.getByText("Failed")).toBeInTheDocument()
  })

  // 5.5
  it("[tag:ds-list-columns][tag:deprecated] source_type and created_at rendered for deprecated row", () => {
    renderWithProviders(
      <TableWrapper
        rows={[DEPRECATED_ROW]}
        callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }}
      />,
    )

    expect(screen.getByText("NFS share")).toBeInTheDocument()
    // created_at cell should still render some date text
    expect(screen.getByText(/Jan/)).toBeInTheDocument()
  })

  // 5.6
  it("[tag:ds-list-columns][tag:empty] labels cell: empty array renders '—'", () => {
    renderWithProviders(
      <TableWrapper
        rows={[EMPTY_LABELS_ROW]}
        callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }}
      />,
    )

    // The empty labels cell renders a placeholder em-dash
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  // 5.7
  it("[tag:ds-list-columns] labels cell with values renders ChipList", () => {
    renderWithProviders(
      <TableWrapper
        rows={[BASE_ROW]}
        callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }}
      />,
    )

    expect(screen.getByText("prod")).toBeInTheDocument()
  })

  // 5.8
  it("[tag:ds-list-columns] associated_datasets column delegates to AssociatedDatasetsCell", () => {
    renderWithProviders(
      <TableWrapper
        rows={[BASE_ROW]}
        callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }}
      />,
    )

    expect(screen.getByText("Dataset A")).toBeInTheDocument()
  })

  // 5.9
  it("[tag:ds-list-columns] actions: static menuItems array renders action button", () => {
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

  // 5.10
  it("[tag:ds-list-columns] actions: factory function receives the row", async () => {
    const factory = vi.fn((row: DataSourceTableRow): ActionMenuItem<DataSourceTableRow>[] => [
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
