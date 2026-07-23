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
  createSnapshotColumns,
  type SnapshotTableRow,
  type SnapshotColumnsCallbacks,
} from "./dataset-snapshot.columns"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CURRENT_ROW: SnapshotTableRow = {
  id: "snap-1",
  version: 3,
  status: "completed",
  total_files: 100,
  total_folders: 10,
  files_synced: 95,
  files_added: 5,
  files_removed: 2,
  used_knowledge_base: null,
  expired: false,
  is_current: true,
  created_at: "2026-02-10T07:15:06Z",
}

const AVAILABLE_ROW: SnapshotTableRow = {
  ...CURRENT_ROW,
  id: "snap-2",
  version: 2,
  is_current: false,
  files_added: 0,
  files_removed: 0,
}

const EXPIRED_ROW: SnapshotTableRow = {
  ...CURRENT_ROW,
  id: "snap-3",
  version: 1,
  is_current: false,
  expired: true,
}

const NO_VERSION_ROW: SnapshotTableRow = {
  ...CURRENT_ROW,
  id: "snap-4",
  version: null as unknown as number,
  is_current: false,
}

// ---------------------------------------------------------------------------
// Table wrapper
// ---------------------------------------------------------------------------

function TableWrapper({
  rows,
  callbacks,
}: {
  rows: SnapshotTableRow[]
  callbacks: SnapshotColumnsCallbacks
}) {
  const columns = createSnapshotColumns(callbacks)
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

describe("createSnapshotColumns", () => {
  const onRollback = vi.fn()
  const onRemove = vi.fn()
  const onRestore = vi.fn()
  const callbacks: SnapshotColumnsCallbacks = { onRollback, onRemove, onRestore }

  let roCleanup: () => void
  beforeEach(() => {
    roCleanup = mockResizeObserver().cleanup
    vi.clearAllMocks()
  })
  afterEach(() => roCleanup?.())

  // -- version cell --

  it("[tag:dataset-snapshot-columns] version cell shows 'Version N'", () => {
    renderWithProviders(<TableWrapper rows={[CURRENT_ROW]} callbacks={callbacks} />)
    expect(screen.getByText("Version 3")).toBeInTheDocument()
  })

  it("[tag:dataset-snapshot-columns] version cell shows '—' when version is null", () => {
    renderWithProviders(<TableWrapper rows={[NO_VERSION_ROW]} callbacks={callbacks} />)
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  // -- created_at cell --

  it("[tag:dataset-snapshot-columns] created_at cell shows formatted date", () => {
    renderWithProviders(<TableWrapper rows={[CURRENT_ROW]} callbacks={callbacks} />)
    expect(screen.getByText(/Feb/)).toBeInTheDocument()
  })

  // -- status cell --

  it("[tag:dataset-snapshot-columns] status cell renders SnapshotDisplayStatusCell", () => {
    renderWithProviders(<TableWrapper rows={[CURRENT_ROW]} callbacks={callbacks} />)
    expect(screen.getByText("In use")).toBeInTheDocument()
  })

  it("[tag:dataset-snapshot-columns] status cell shows 'Removed' for expired", () => {
    renderWithProviders(<TableWrapper rows={[EXPIRED_ROW]} callbacks={callbacks} />)
    expect(screen.getByText("Removed")).toBeInTheDocument()
  })

  // -- files synced cell --

  it("[tag:dataset-snapshot-columns] files synced shows formatted number", () => {
    renderWithProviders(<TableWrapper rows={[CURRENT_ROW]} callbacks={callbacks} />)
    expect(screen.getByText("95")).toBeInTheDocument()
  })

  // -- changes cell --

  it("[tag:dataset-snapshot-columns] changes cell shows added/removed values", () => {
    renderWithProviders(<TableWrapper rows={[CURRENT_ROW]} callbacks={callbacks} />)
    expect(screen.getByText("+5")).toBeInTheDocument()
    expect(screen.getByText("-2")).toBeInTheDocument()
  })

  it("[tag:dataset-snapshot-columns] changes cell shows 'No changes' when both 0", () => {
    renderWithProviders(<TableWrapper rows={[AVAILABLE_ROW]} callbacks={callbacks} />)
    expect(screen.getByText("No changes")).toBeInTheDocument()
  })

  // -- actions cell --

  it("[tag:dataset-snapshot-columns] actions: current snapshot has Rollback disabled", async () => {
    const user = userEvent.setup()
    renderWithProviders(<TableWrapper rows={[CURRENT_ROW]} callbacks={callbacks} />)

    await user.click(screen.getByRole("button", { name: /Actions for/i }))

    const rollback = await screen.findByText("Rollback")
    expect(rollback.closest("button") ?? rollback.closest("[role=menuitem]")).toHaveAttribute("aria-disabled", "true")
  })

  it("[tag:dataset-snapshot-columns] actions: available has Remove enabled", async () => {
    const user = userEvent.setup()
    renderWithProviders(<TableWrapper rows={[AVAILABLE_ROW]} callbacks={callbacks} />)

    await user.click(screen.getByRole("button", { name: /Actions for/i }))
    expect(await screen.findByText("Remove")).toBeInTheDocument()
  })

  it("[tag:dataset-snapshot-columns] actions: expired shows Restore instead of Remove", async () => {
    const user = userEvent.setup()
    renderWithProviders(<TableWrapper rows={[EXPIRED_ROW]} callbacks={callbacks} />)

    await user.click(screen.getByRole("button", { name: /Actions for/i }))
    expect(await screen.findByText("Restore")).toBeInTheDocument()
    expect(screen.queryByText("Remove")).not.toBeInTheDocument()
  })
})
