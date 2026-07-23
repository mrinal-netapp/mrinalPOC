import { screen, waitFor } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ReactNode } from "react"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import type { DataSourceDatasetRef } from "@/api/data-source.types"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn()
const mockListDatasets = vi.fn()

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>()
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock("@/api/data-source-api.slice", () => ({
  useListDataSourceDatasetsQuery: (...args: unknown[]) => mockListDatasets(...args),
}))

// Mock BaseTable — renders first column's cell per row to enable navigation tests
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
          {columns[0]?.cell?.({ row: { original: row } })}
        </div>
      ))}
    </div>
  ),
}))

import { DataSourceDetailDatasets } from "./data-source-detail-datasets"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_DATASET: DataSourceDatasetRef = {
  dset_id: "dset-1",
  name: "My Dataset",
  file_scope: 1000,
  synchronization_schedule: null,
  status: "Healthy",
  labels: [],
  created_at: "2024-01-01T00:00:00Z",
}

// ---------------------------------------------------------------------------
// Section 10.13–10.16 — DataSourceDetailDatasets
// ---------------------------------------------------------------------------

describe("DataSourceDetailDatasets", () => {
  let roHandle: ReturnType<typeof mockResizeObserver>

  beforeEach(() => {
    vi.clearAllMocks()
    roHandle = mockResizeObserver()
  })

  afterEach(() => {
    roHandle.cleanup()
  })

  // 10.13
  it("[tag:ds-detail-datasets][tag:loading] isLoading propagates to BaseTable", () => {
    mockListDatasets.mockReturnValue({ data: undefined, isLoading: true, isError: false })
    renderWithProviders(<DataSourceDetailDatasets dsrcId="ds-1" />)

    const table = screen.getByTestId("base-table")
    expect(table).toHaveAttribute("data-loading", "true")
    expect(screen.getByTestId("table-loading")).toBeInTheDocument()
  })

  // 10.14
  it("[tag:ds-detail-datasets][tag:error] isError propagates to BaseTable", () => {
    mockListDatasets.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    renderWithProviders(<DataSourceDetailDatasets dsrcId="ds-1" />)

    const table = screen.getByTestId("base-table")
    expect(table).toHaveAttribute("data-error", "true")
    expect(screen.getByTestId("table-error")).toBeInTheDocument()
  })

  // 10.15
  it("[tag:ds-detail-datasets] datasets mapped to DatasetTableRow (adds id: dset_id)", () => {
    mockListDatasets.mockReturnValue({
      data: { datasets: [MOCK_DATASET] },
      isLoading: false,
      isError: false,
    })
    renderWithProviders(<DataSourceDetailDatasets dsrcId="ds-1" />)

    const rows = screen.getAllByTestId("table-row")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveAttribute("data-id", "dset-1")
  })

  // 10.16
  it("[tag:ds-detail-datasets][tag:empty] empty datasets → BaseTable renders empty state", () => {
    mockListDatasets.mockReturnValue({
      data: { datasets: [] },
      isLoading: false,
      isError: false,
    })
    renderWithProviders(<DataSourceDetailDatasets dsrcId="ds-1" />)

    expect(screen.getByTestId("table-empty")).toBeInTheDocument()
  })

  // 10.17
  it("[tag:ds-detail-datasets] clicking dataset name navigates to dataset detail path", async () => {
    const user = userEvent.setup()
    mockListDatasets.mockReturnValue({
      data: { datasets: [MOCK_DATASET] },
      isLoading: false,
      isError: false,
    })
    renderWithProviders(<DataSourceDetailDatasets dsrcId="ds-1" />)

    await user.click(screen.getByRole("button", { name: "My Dataset" }))

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining("dset-1"))
    })
  })
})
