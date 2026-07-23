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
  createKBListColumns,
  type KBListTableRow,
  type KBColumnsCallbacks,
  type ActionMenuItem,
} from "./kb-list.columns"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_ROW: KBListTableRow = {
  id: "kb-1",
  kb_id: "kb-1",
  name: "My Knowledge Base",
  status: "ready",
  deprecated: false,
  labels: ["production"],
  created_at: "2024-01-15T10:00:00Z",
  snapshot: {
    id: "snap-1",
    version: 3,
    files_indexed: 1_247,
    vectors: 9_999,
    last_sync: "2026-02-10T07:15:06Z",
  },
}

const DEPRECATED_ROW: KBListTableRow = {
  ...BASE_ROW,
  id: "kb-dep",
  kb_id: "kb-dep",
  name: "Old KB",
  deprecated: true,
}

const NO_SNAPSHOT_ROW: KBListTableRow = {
  ...BASE_ROW,
  id: "kb-ns",
  kb_id: "kb-ns",
  name: "No Snapshot KB",
  snapshot: null,
}

const EMPTY_LABELS_ROW: KBListTableRow = {
  ...BASE_ROW,
  id: "kb-nl",
  kb_id: "kb-nl",
  labels: [],
}

// ---------------------------------------------------------------------------
// Table wrapper
// ---------------------------------------------------------------------------

function TableWrapper({
  rows,
  callbacks,
}: {
  rows: KBListTableRow[]
  callbacks: KBColumnsCallbacks
}) {
  const columns = createKBListColumns(callbacks)
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

describe("createKBListColumns", () => {
  let roCleanup: () => void
  const menuItems: ActionMenuItem<KBListTableRow>[] = [
    { label: "Edit", onClick: vi.fn() },
    { label: "Delete", onClick: vi.fn() },
  ]

  beforeEach(() => { roCleanup = mockResizeObserver().cleanup })
  afterEach(() => roCleanup?.())

  it("[tag:kb-list-columns] name cell: renders navigable button when not deprecated", () => {
    const onNavigateDetail = vi.fn()
    renderWithProviders(
      <TableWrapper rows={[BASE_ROW]} callbacks={{ onNavigateDetail, actionMenuItems: menuItems }} />,
    )

    const btn = screen.getByRole("button", { name: "My Knowledge Base" })
    fireEvent.click(btn)
    expect(onNavigateDetail).toHaveBeenCalledWith("kb-1")
  })

  it("[tag:kb-list-columns] name cell: deprecated renders disabled text, no button", () => {
    renderWithProviders(
      <TableWrapper rows={[DEPRECATED_ROW]} callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }} />,
    )

    expect(screen.queryByRole("button", { name: "Old KB" })).not.toBeInTheDocument()
    expect(screen.getByText("Old KB")).toBeInTheDocument()
  })

  it("[tag:kb-list-columns] status column renders KBStatusCell", () => {
    renderWithProviders(
      <TableWrapper rows={[BASE_ROW]} callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }} />,
    )
    expect(screen.getByText("Ready")).toBeInTheDocument()
  })

  it("[tag:kb-list-columns] indexed data with snapshot shows formatted value", () => {
    renderWithProviders(
      <TableWrapper rows={[BASE_ROW]} callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }} />,
    )
    expect(screen.getByText("1,247 files / 9,999 vectors")).toBeInTheDocument()
  })

  it("[tag:kb-list-columns] indexed data without snapshot shows '—'", () => {
    renderWithProviders(
      <TableWrapper rows={[NO_SNAPSHOT_ROW]} callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }} />,
    )
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:kb-list-columns] current version shows 'Version N' when snapshot has version", () => {
    renderWithProviders(
      <TableWrapper rows={[BASE_ROW]} callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }} />,
    )
    expect(screen.getByText("Version 3")).toBeInTheDocument()
  })

  it("[tag:kb-list-columns] current version shows '—' when no snapshot", () => {
    renderWithProviders(
      <TableWrapper rows={[NO_SNAPSHOT_ROW]} callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }} />,
    )
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:kb-list-columns] last sync shows formatted date when snapshot has last_sync", () => {
    renderWithProviders(
      <TableWrapper rows={[BASE_ROW]} callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }} />,
    )
    expect(screen.getByText(/Feb/)).toBeInTheDocument()
  })

  it("[tag:kb-list-columns] last sync shows '—' when no snapshot", () => {
    renderWithProviders(
      <TableWrapper rows={[NO_SNAPSHOT_ROW]} callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }} />,
    )
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:kb-list-columns] labels with values renders ChipList", () => {
    renderWithProviders(
      <TableWrapper rows={[BASE_ROW]} callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }} />,
    )
    expect(screen.getByText("production")).toBeInTheDocument()
  })

  it("[tag:kb-list-columns] empty labels shows '—'", () => {
    renderWithProviders(
      <TableWrapper rows={[EMPTY_LABELS_ROW]} callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }} />,
    )
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:kb-list-columns] actions column renders action button", () => {
    renderWithProviders(
      <TableWrapper rows={[BASE_ROW]} callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }} />,
    )
    expect(screen.getByRole("button", { name: `Actions for ${BASE_ROW.name}` })).toBeInTheDocument()
  })

  it("[tag:kb-list-columns] actions: function-based menuItems receives the row", async () => {
    const factory = vi.fn((row: KBListTableRow): ActionMenuItem<KBListTableRow>[] => [
      { label: `Edit ${row.name}`, onClick: vi.fn() },
    ])

    const { default: ue } = await import("@testing-library/user-event")
    const user = ue.setup()

    renderWithProviders(
      <TableWrapper rows={[BASE_ROW]} callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: factory }} />,
    )

    await user.click(screen.getByRole("button", { name: `Actions for ${BASE_ROW.name}` }))
    expect(factory).toHaveBeenCalledWith(BASE_ROW)
    expect(await screen.findByText(`Edit ${BASE_ROW.name}`)).toBeInTheDocument()
  })
})
