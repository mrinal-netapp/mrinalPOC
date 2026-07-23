import { screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ReactNode } from "react"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockListKBs = vi.fn()

vi.mock("@/api/dataset-api.slice", () => ({
  useListDatasetKnowledgeBasesQuery: (...args: unknown[]) => mockListKBs(...args),
}))

// Mock BaseTable — renders ALL columns' cells per row
vi.mock("@/ui-lib/base-components/baseTableMcpBxp", () => ({
  BaseTable: ({
    data,
    isLoading,
    isError,
    columns,
  }: {
    data: Array<Record<string, unknown>>
    isLoading: boolean
    isError: boolean
    columns: Array<{ cell?: (ctx: { row: { original: Record<string, unknown> } }) => ReactNode }>
  }) => (
    <div data-testid="base-table" data-loading={String(isLoading)} data-error={String(isError)}>
      {isLoading && <span data-testid="table-loading">Loading…</span>}
      {isError && <span data-testid="table-error">Error</span>}
      {!isLoading && !isError && data.length === 0 && (
        <span data-testid="table-empty">No data</span>
      )}
      {!isLoading && !isError && data.map((row, i) => (
        <div key={i} data-testid="table-row" data-id={String(row.id)}>
          {columns.map((col, ci) => (
            <span key={ci}>{col.cell?.({ row: { original: row } })}</span>
          ))}
        </div>
      ))}
    </div>
  ),
}))

import { DatasetDetailKB } from "./dataset-detail-kb"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_KB = {
  kb_id: "kb-1",
  name: "My Knowledge Base",
  status: "Healthy",
  file_scope: 1200,
  synchronization_schedule: "Daily at 10:00",
  synchronization_status: "Completed",
  labels: ["prod"],
  created_at: "2024-01-01T00:00:00Z",
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DatasetDetailKB", () => {
  let roHandle: ReturnType<typeof mockResizeObserver>

  beforeEach(() => {
    vi.clearAllMocks()
    roHandle = mockResizeObserver()
  })

  afterEach(() => {
    roHandle.cleanup()
  })

  it("[tag:dset-detail-kb][tag:loading] isLoading propagates to BaseTable", () => {
    mockListKBs.mockReturnValue({ data: undefined, isLoading: true, isError: false })
    renderWithProviders(<DatasetDetailKB dsetId="dset-1" />)

    const table = screen.getByTestId("base-table")
    expect(table).toHaveAttribute("data-loading", "true")
    expect(screen.getByTestId("table-loading")).toBeInTheDocument()
  })

  it("[tag:dset-detail-kb][tag:error] isError propagates to BaseTable", () => {
    mockListKBs.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    renderWithProviders(<DatasetDetailKB dsetId="dset-1" />)

    const table = screen.getByTestId("base-table")
    expect(table).toHaveAttribute("data-error", "true")
    expect(screen.getByTestId("table-error")).toBeInTheDocument()
  })

  it("[tag:dset-detail-kb] knowledge bases mapped to KBTableRow (adds id: kb_id)", () => {
    mockListKBs.mockReturnValue({
      data: { knowledge_bases: [MOCK_KB] },
      isLoading: false,
      isError: false,
    })
    renderWithProviders(<DatasetDetailKB dsetId="dset-1" />)

    const rows = screen.getAllByTestId("table-row")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveAttribute("data-id", "kb-1")
  })

  it("[tag:dset-detail-kb][tag:empty] empty knowledge bases → BaseTable renders empty state", () => {
    mockListKBs.mockReturnValue({
      data: { knowledge_bases: [] },
      isLoading: false,
      isError: false,
    })
    renderWithProviders(<DatasetDetailKB dsetId="dset-1" />)

    expect(screen.getByTestId("table-empty")).toBeInTheDocument()
  })

  it("[tag:dset-detail-kb] name column renders as a clickable button", async () => {
    const user = userEvent.setup()
    mockListKBs.mockReturnValue({
      data: { knowledge_bases: [MOCK_KB] },
      isLoading: false,
      isError: false,
    })
    renderWithProviders(<DatasetDetailKB dsetId="dset-1" />)

    const btn = screen.getByRole("button", { name: "My Knowledge Base" })
    expect(btn).toBeInTheDocument()
    await user.click(btn)
  })

  it("[tag:dset-detail-kb] all column cells render correctly", () => {
    mockListKBs.mockReturnValue({
      data: { knowledge_bases: [MOCK_KB] },
      isLoading: false,
      isError: false,
    })
    renderWithProviders(<DatasetDetailKB dsetId="dset-1" />)

    expect(screen.getByText("Healthy")).toBeInTheDocument()
    expect(screen.getByText("1,200")).toBeInTheDocument()
    expect(screen.getByText("Daily at 10:00")).toBeInTheDocument()
    expect(screen.getByText("prod")).toBeInTheDocument()
  })

  it("[tag:dset-detail-kb] null synchronization_schedule renders '-'", () => {
    const kb = { ...MOCK_KB, synchronization_schedule: null }
    mockListKBs.mockReturnValue({
      data: { knowledge_bases: [kb] },
      isLoading: false,
      isError: false,
    })
    renderWithProviders(<DatasetDetailKB dsetId="dset-1" />)

    const rows = screen.getAllByTestId("table-row")
    expect(rows[0].textContent).toContain("—")
  })

  it("[tag:dset-detail-kb] empty labels renders placeholder", () => {
    const kb = { ...MOCK_KB, labels: [] }
    mockListKBs.mockReturnValue({
      data: { knowledge_bases: [kb] },
      isLoading: false,
      isError: false,
    })
    renderWithProviders(<DatasetDetailKB dsetId="dset-1" />)

    expect(screen.getByText("—")).toBeInTheDocument()
  })
})
