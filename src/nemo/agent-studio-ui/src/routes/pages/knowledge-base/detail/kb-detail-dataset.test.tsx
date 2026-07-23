import { screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { ReactNode } from "react"

import { renderWithProviders } from "@test/render"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn()

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>()
  return { ...actual, useNavigate: () => mockNavigate }
})

const mockGetKBAssignedDataset = vi.fn()
const mockGetDataset = vi.fn()

vi.mock("@/api/kb-api.slice", () => ({
  useGetKBAssignedDatasetQuery: (...args: unknown[]) => mockGetKBAssignedDataset(...args),
}))

vi.mock("@/api/dataset-api.slice", () => ({
  useGetDatasetQuery: (...args: unknown[]) => mockGetDataset(...args),
}))

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
    <div data-testid="kb-dataset-table" data-loading={String(isLoading)} data-error={String(isError)}>
      {isLoading && <span data-testid="table-loading">Loading…</span>}
      {isError && <span data-testid="table-error">Error</span>}
      {!isLoading && !isError && data.length === 0 && <span data-testid="table-empty">No data</span>}
      {!isLoading && !isError && data.map((row, i) => (
        <div key={i} data-testid="dataset-row" data-id={String(row.id)}>
          {columns.map((col, ci) => (
            <span key={ci}>{col.cell?.({ row: { original: row } })}</span>
          ))}
        </div>
      ))}
    </div>
  ),
}))

import { KBDetailDataset } from "./kb-detail-dataset"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KBDetailDataset", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetDataset.mockReturnValue({ data: undefined, isLoading: false, isError: false })
  })

  it("[tag:kb-detail-dataset] loading state shows loading attribute", () => {
    mockGetKBAssignedDataset.mockReturnValue({ data: undefined, isLoading: true, isError: false })
    renderWithProviders(<KBDetailDataset kbId="kb-1" />)

    expect(screen.getByTestId("kb-dataset-table")).toHaveAttribute("data-loading", "true")
  })

  it("[tag:kb-detail-dataset] error state shows error attribute", () => {
    mockGetKBAssignedDataset.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    renderWithProviders(<KBDetailDataset kbId="kb-1" />)

    expect(screen.getByTestId("kb-dataset-table")).toHaveAttribute("data-error", "true")
  })

  it("[tag:kb-detail-dataset] empty state when no dset_id", () => {
    mockGetKBAssignedDataset.mockReturnValue({
      data: { dataset: {} },
      isLoading: false,
      isError: false,
    })
    renderWithProviders(<KBDetailDataset kbId="kb-1" />)

    expect(screen.getByTestId("table-empty")).toBeInTheDocument()
  })

  it("[tag:kb-detail-dataset] renders row when dataset is assigned", () => {
    mockGetKBAssignedDataset.mockReturnValue({
      data: {
        dataset: {
          dset_id: "ds-1",
          name: "Training Data",
          status: "Healthy",
          file_scope: "100 files",
          labels: [],
        },
      },
      isLoading: false,
      isError: false,
    })
    renderWithProviders(<KBDetailDataset kbId="kb-1" />)

    expect(screen.getByTestId("dataset-row")).toBeInTheDocument()
  })

  it("[tag:kb-detail-dataset] name click navigates to dataset detail", () => {
    mockGetKBAssignedDataset.mockReturnValue({
      data: {
        dataset: {
          dset_id: "ds-1",
          name: "Training Data",
          status: "Healthy",
          labels: [],
        },
      },
      isLoading: false,
      isError: false,
    })
    renderWithProviders(<KBDetailDataset kbId="kb-1" />)

    const nameBtn = screen.getByRole("button", { name: "Training Data" })
    fireEvent.click(nameBtn)
    expect(mockNavigate).toHaveBeenCalled()
  })
})
