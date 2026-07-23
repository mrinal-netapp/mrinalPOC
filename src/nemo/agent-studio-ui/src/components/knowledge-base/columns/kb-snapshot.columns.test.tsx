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
  createKBSnapshotColumns,
  type KBSnapshotTableRow,
  type KBSnapshotColumnsCallbacks,
} from "./kb-snapshot.columns"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CURRENT_ROW: KBSnapshotTableRow = {
  id: "snap-1",
  version: 3,
  status: "completed",
  expired: false,
  is_current: true,
  created_at: "2026-02-10T07:15:06Z",
  documents_indexed: 1_234,
}

const AVAILABLE_ROW: KBSnapshotTableRow = {
  ...CURRENT_ROW,
  id: "snap-2",
  version: 2,
  is_current: false,
}

const EXPIRED_ROW: KBSnapshotTableRow = {
  ...CURRENT_ROW,
  id: "snap-3",
  version: 1,
  is_current: false,
  expired: true,
}

const ERRORED_ROW: KBSnapshotTableRow = {
  ...CURRENT_ROW,
  id: "snap-4",
  version: 4,
  status: "errored",
  is_current: false,
  expired: false,
}

const PENDING_ROW: KBSnapshotTableRow = {
  ...CURRENT_ROW,
  id: "snap-5",
  version: 5,
  status: "pending",
  is_current: false,
  expired: false,
}

const IN_PROGRESS_ROW: KBSnapshotTableRow = {
  ...CURRENT_ROW,
  id: "snap-6",
  version: 6,
  status: "in-progress",
  is_current: false,
  expired: false,
}

const NO_VERSION_ROW: KBSnapshotTableRow = {
  ...CURRENT_ROW,
  id: "snap-7",
  version: undefined as unknown as number,
  is_current: false,
}

// ---------------------------------------------------------------------------
// Table wrapper
// ---------------------------------------------------------------------------

function TableWrapper({
  rows,
  callbacks,
}: {
  rows: KBSnapshotTableRow[]
  callbacks: KBSnapshotColumnsCallbacks
}) {
  const columns = createKBSnapshotColumns(callbacks)
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

describe("createKBSnapshotColumns", () => {
  const onRollback = vi.fn()
  const onRemove = vi.fn()
  const onRestore = vi.fn()
  const callbacks: KBSnapshotColumnsCallbacks = { onRollback, onRemove, onRestore }

  let roCleanup: () => void
  beforeEach(() => {
    roCleanup = mockResizeObserver().cleanup
    vi.clearAllMocks()
  })
  afterEach(() => roCleanup?.())

  // -- version cell --

  it("[tag:kb-snapshot-columns] version cell shows 'Version N'", () => {
    renderWithProviders(<TableWrapper rows={[CURRENT_ROW]} callbacks={callbacks} />)
    expect(screen.getByText("Version 3")).toBeInTheDocument()
  })

  it("[tag:kb-snapshot-columns] version cell shows '—' when version is null", () => {
    renderWithProviders(<TableWrapper rows={[NO_VERSION_ROW]} callbacks={callbacks} />)
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  // -- created_at cell --

  it("[tag:kb-snapshot-columns] created_at cell shows formatted date", () => {
    renderWithProviders(<TableWrapper rows={[CURRENT_ROW]} callbacks={callbacks} />)
    expect(screen.getByText(/Feb/)).toBeInTheDocument()
  })

  // -- status cell --

  it("[tag:kb-snapshot-columns] status: current shows 'In use'", () => {
    renderWithProviders(<TableWrapper rows={[CURRENT_ROW]} callbacks={callbacks} />)
    expect(screen.getByText("In use")).toBeInTheDocument()
  })

  it("[tag:kb-snapshot-columns] status: expired shows 'Removed'", () => {
    renderWithProviders(<TableWrapper rows={[EXPIRED_ROW]} callbacks={callbacks} />)
    expect(screen.getByText("Removed")).toBeInTheDocument()
  })

  it("[tag:kb-snapshot-columns] status: completed (not current) shows 'Available'", () => {
    renderWithProviders(<TableWrapper rows={[AVAILABLE_ROW]} callbacks={callbacks} />)
    expect(screen.getByText("Available")).toBeInTheDocument()
  })

  it("[tag:kb-snapshot-columns] status: errored shows 'Failed'", () => {
    renderWithProviders(<TableWrapper rows={[ERRORED_ROW]} callbacks={callbacks} />)
    expect(screen.getByText("Failed")).toBeInTheDocument()
  })

  it("[tag:kb-snapshot-columns] status: pending shows 'Pending'", () => {
    renderWithProviders(<TableWrapper rows={[PENDING_ROW]} callbacks={callbacks} />)
    expect(screen.getByText("Pending")).toBeInTheDocument()
  })

  it("[tag:kb-snapshot-columns] status: in-progress shows 'In progress'", () => {
    renderWithProviders(<TableWrapper rows={[IN_PROGRESS_ROW]} callbacks={callbacks} />)
    expect(screen.getByText("In progress")).toBeInTheDocument()
  })

  // -- files synced cell --

  it("[tag:kb-snapshot-columns] files synced shows formatted number", () => {
    renderWithProviders(<TableWrapper rows={[CURRENT_ROW]} callbacks={callbacks} />)
    expect(screen.getByText("1,234")).toBeInTheDocument()
  })

  // -- changes cell --

  it("[tag:kb-snapshot-columns] changes cell renders placeholder until API provides data", () => {
    renderWithProviders(<TableWrapper rows={[CURRENT_ROW]} callbacks={callbacks} />)
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  // -- actions cell --

  it("[tag:kb-snapshot-columns] actions: current snapshot has Rollback disabled", async () => {
    const user = userEvent.setup()
    renderWithProviders(<TableWrapper rows={[CURRENT_ROW]} callbacks={callbacks} />)

    await user.click(screen.getByRole("button", { name: /Actions for/i }))

    const rollback = await screen.findByText("Rollback")
    expect(rollback.closest("button") ?? rollback.closest("[role=menuitem]")).toHaveAttribute("aria-disabled", "true")
  })

  it("[tag:kb-snapshot-columns] actions: available (not current, not expired) has Remove enabled", async () => {
    const user = userEvent.setup()
    renderWithProviders(<TableWrapper rows={[AVAILABLE_ROW]} callbacks={callbacks} />)

    await user.click(screen.getByRole("button", { name: /Actions for/i }))
    expect(await screen.findByText("Remove")).toBeInTheDocument()
  })

  it("[tag:kb-snapshot-columns] actions: expired snapshot shows 'Restore' instead of 'Remove'", async () => {
    const user = userEvent.setup()
    renderWithProviders(<TableWrapper rows={[EXPIRED_ROW]} callbacks={callbacks} />)

    await user.click(screen.getByRole("button", { name: /Actions for/i }))
    expect(await screen.findByText("Restore")).toBeInTheDocument()
    expect(screen.queryByText("Remove")).not.toBeInTheDocument()
  })

  it("[tag:kb-snapshot-columns] status: unrecognised status falls through to default branch", () => {
    const unknownStatusRow: KBSnapshotTableRow = {
      ...CURRENT_ROW,
      id: "snap-unknown",
      status: "unknown-status" as KBSnapshotTableRow["status"],
      is_current: false,
      expired: false,
    }
    renderWithProviders(<TableWrapper rows={[unknownStatusRow]} callbacks={callbacks} />)
    expect(screen.getByText("unknown-status")).toBeInTheDocument()
  })

  it("[tag:kb-snapshot-columns] status: unrecognised status with isCurrent falls back to pending visual", () => {
    const unknownCurrentRow: KBSnapshotTableRow = {
      ...CURRENT_ROW,
      id: "snap-unknown-current",
      status: "unknown-status" as KBSnapshotTableRow["status"],
      is_current: true,
      expired: false,
    }
    renderWithProviders(<TableWrapper rows={[unknownCurrentRow]} callbacks={callbacks} />)
    expect(screen.getByText("In use")).toBeInTheDocument()
  })
})
