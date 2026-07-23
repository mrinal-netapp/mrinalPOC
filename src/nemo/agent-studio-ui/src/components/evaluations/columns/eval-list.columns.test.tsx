import { screen, fireEvent, render } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type Column,
  type ColumnDef,
} from "@tanstack/react-table"

import { renderWithProviders } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import {
  createEvalListColumns,
  type EvalListTableRow,
  type ActionMenuItem,
} from "./eval-list.columns"

const BASE_ROW: EvalListTableRow = {
  id: "evt-1",
  templateId: "evt-1",
  projectId: "project-1",
  evalName: "Finance eval",
  target: "agent_version",
  agent: { agentId: "agent-1", agentVersion: "v1" },
  models: ["gpt-4"],
  evaluationScope: "full_agent_execution",
  suite: "rag",
  evaluators: { strategy: "deterministic", deterministic: { metrics: ["rag_quality"] } },
  runMode: "single",
  latestRunStatus: "completed",
  runCount: 3,
  updatedAt: "2026-02-10",
  owner: "Sarah",
  lastModifiedBy: "Jordan",
  labels: ["finance"],
}

const NO_LABELS_ROW: EvalListTableRow = { ...BASE_ROW, id: "evt-2", templateId: "evt-2", labels: [] }
const UNDEF_LABELS_ROW: EvalListTableRow = { ...BASE_ROW, id: "evt-4", templateId: "evt-4", labels: undefined as unknown as string[] }
const NO_STATUS_ROW: EvalListTableRow = { ...BASE_ROW, id: "evt-3", templateId: "evt-3", latestRunStatus: undefined }

const menuItems: ActionMenuItem<EvalListTableRow>[] = [{ label: "Delete", onClick: vi.fn() }]

function TableWrapper({
  rows,
  callbacks,
}: {
  rows: EvalListTableRow[]
  callbacks: Parameters<typeof createEvalListColumns>[0]
}) {
  const columns = createEvalListColumns(callbacks)
  // eslint-disable-next-line react-hooks/incompatible-library -- test-only table harness mirrors other column tests.
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

// A minimal mock Column for invoking the sortable header render function.
function mockColumn(sorted: false | "asc" | "desc", canSort = true): Column<EvalListTableRow> {
  return {
    getIsSorted: () => sorted,
    getCanSort: () => canSort,
    toggleSorting: vi.fn(),
    clearSorting: vi.fn(),
  } as unknown as Column<EvalListTableRow>
}

describe("createEvalListColumns", () => {
  let roCleanup: () => void
  beforeEach(() => { roCleanup = mockResizeObserver().cleanup })
  afterEach(() => roCleanup?.())

  // -- Cells --

  it("[tag:eval-list-columns] name cell calls onNavigateDetail", () => {
    const onNavigateDetail = vi.fn()
    renderWithProviders(<TableWrapper rows={[BASE_ROW]} callbacks={{ onNavigateDetail, actionMenuItems: menuItems }} />)

    fireEvent.click(screen.getByRole("button", { name: "Finance eval" }))
    expect(onNavigateDetail).toHaveBeenCalledWith("evt-1")
  })

  it("[tag:eval-list-columns] status cell shows the status, runs count, dates and actors", () => {
    renderWithProviders(<TableWrapper rows={[BASE_ROW]} callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }} />)

    expect(screen.getByText("Completed")).toBeInTheDocument()
    expect(screen.getByText("3")).toBeInTheDocument()
    expect(screen.getByText("2026-02-10")).toBeInTheDocument()
    expect(screen.getByText("Sarah")).toBeInTheDocument()
    expect(screen.getByText("Jordan")).toBeInTheDocument()
  })

  it("[tag:eval-list-columns] status cell falls back when latestRunStatus is null", () => {
    renderWithProviders(<TableWrapper rows={[NO_STATUS_ROW]} callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }} />)

    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:eval-list-columns] labels cell renders chips and a placeholder when empty", () => {
    renderWithProviders(<TableWrapper rows={[BASE_ROW]} callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }} />)
    expect(screen.getByText("finance")).toBeInTheDocument()

    renderWithProviders(<TableWrapper rows={[NO_LABELS_ROW]} callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }} />)
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:eval-list-columns] labels cell defaults missing labels to a placeholder", () => {
    renderWithProviders(<TableWrapper rows={[UNDEF_LABELS_ROW]} callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }} />)
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:eval-list-columns] actions cell supports a static array and a factory", () => {
    renderWithProviders(<TableWrapper rows={[BASE_ROW]} callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: menuItems }} />)
    expect(screen.getByRole("button", { name: "Actions for Finance eval" })).toBeInTheDocument()

    const factory = vi.fn(() => menuItems)
    renderWithProviders(<TableWrapper rows={[NO_LABELS_ROW]} callbacks={{ onNavigateDetail: vi.fn(), actionMenuItems: factory }} />)
    expect(factory).toHaveBeenCalledWith(NO_LABELS_ROW)
  })

  // -- Sortable header render branches --

  it("[tag:eval-list-columns] header returns plain label when sorting disabled", () => {
    const columns = createEvalListColumns({ onNavigateDetail: vi.fn(), actionMenuItems: menuItems })
    const headerFn = (columns[0] as ColumnDef<EvalListTableRow>).header
    const out = typeof headerFn === "function"
      ? headerFn({ column: mockColumn(false, false) } as never)
      : headerFn
    expect(out).toBe("Name")
  })

  it.each<[false | "asc" | "desc", "toggleSorting" | "clearSorting"]>([
    [false, "toggleSorting"],
    ["asc", "toggleSorting"],
    ["desc", "clearSorting"],
  ])("[tag:eval-list-columns] sortable header click handles the %s state", (sorted, method) => {
    const columns = createEvalListColumns({ onNavigateDetail: vi.fn(), actionMenuItems: menuItems })
    const col = mockColumn(sorted)
    const headerFn = (columns[0] as ColumnDef<EvalListTableRow>).header as (ctx: { column: Column<EvalListTableRow> }) => React.ReactElement

    const { getByRole } = render(<>{headerFn({ column: col })}</>)
    fireEvent.click(getByRole("button"))

    expect(col[method]).toHaveBeenCalled()
  })
})
