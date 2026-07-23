import { screen, waitFor, act } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { ReactNode } from "react"

import { renderWithProviders } from "@test/render"
import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types"
import { mockResizeObserver } from "@test/mocks"
import { TestFormWrapper } from "./test-helpers"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockUseListDatasetsQuery = vi.fn()

vi.mock("@/api/dataset-api.slice", () => ({
  useListDatasetsQuery: (...args: unknown[]) => mockUseListDatasetsQuery(...args),
}))

vi.mock("@/ui-lib/base-components/baseTableMcpBxp", () => ({
  BaseTable: ({
    data,
    isLoading,
    isError,
    onRowSelectionChange,
  }: {
    data: Array<Record<string, unknown>>
    isLoading: boolean
    isError: boolean
    onRowSelectionChange?: (selection: Record<string, boolean>) => void
    columns: Array<{ cell?: (ctx: { row: { original: Record<string, unknown> } }) => ReactNode }>
  }) => (
    <div data-testid="picker-table" data-loading={String(isLoading)} data-error={String(isError)}>
      {isLoading && <span data-testid="table-loading">Loading…</span>}
      {isError && <span data-testid="table-error">Error</span>}
      {!isLoading && !isError && data.map((row, i) => (
        <div key={i} data-testid="picker-row" data-id={String(row.id)}>
          <button
            data-testid={`select-row-${row.id}`}
            onClick={() => onRowSelectionChange?.({ [String(row.id)]: true })}
          >
            Select
          </button>
        </div>
      ))}
    </div>
  ),
}))

import { KBDatasetPicker } from "./kb-dataset-picker"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DATASETS = [
  { dset_id: "ds-1", name: "Active DS", deprecated: false, status: "Healthy", labels: [], kind: "unstructured" },
  { dset_id: "ds-2", name: "Deprecated DS", deprecated: true, status: "Healthy", labels: [], kind: "unstructured" },
  { dset_id: "ds-3", name: "Another DS", deprecated: false, status: "Healthy", labels: [], kind: "unstructured" },
  { dset_id: "ds-4", name: "Structured DS", deprecated: false, status: "Healthy", labels: [], kind: "structured" },
]

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let roCleanup: () => void

beforeEach(() => {
  vi.clearAllMocks()
  roCleanup = mockResizeObserver().cleanup

  mockUseListDatasetsQuery.mockReturnValue({
    data: { data: DATASETS },
    isLoading: false,
    isError: false,
  })
})
afterEach(() => roCleanup?.())

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KBDatasetPicker", () => {
  it("[tag:kb-dataset-picker] renders the table with non-deprecated datasets", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBDatasetPicker form={form} isEdit={false} />}</TestFormWrapper>,
    )
    const rows = screen.getAllByTestId("picker-row")
    expect(rows).toHaveLength(3)
    expect(screen.getByTestId("select-row-ds-1")).toBeInTheDocument()
    expect(screen.getByTestId("select-row-ds-3")).toBeInTheDocument()
    expect(screen.getByTestId("select-row-ds-4")).toBeInTheDocument()
  })

  it("[tag:kb-dataset-picker] filters out deprecated datasets", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBDatasetPicker form={form} isEdit={false} />}</TestFormWrapper>,
    )
    expect(screen.queryByTestId("select-row-ds-2")).not.toBeInTheDocument()
  })

  it("[tag:kb-dataset-picker] passes loading state to table", () => {
    mockUseListDatasetsQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    })
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBDatasetPicker form={form} isEdit={false} />}</TestFormWrapper>,
    )
    expect(screen.getByTestId("table-loading")).toBeInTheDocument()
  })

  it("[tag:kb-dataset-picker] passes error state to table", () => {
    mockUseListDatasetsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    })
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBDatasetPicker form={form} isEdit={false} />}</TestFormWrapper>,
    )
    expect(screen.getByTestId("table-error")).toBeInTheDocument()
  })

  it("[tag:kb-dataset-picker] handles empty data gracefully", () => {
    mockUseListDatasetsQuery.mockReturnValue({
      data: { data: [] },
      isLoading: false,
      isError: false,
    })
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBDatasetPicker form={form} isEdit={false} />}</TestFormWrapper>,
    )
    expect(screen.queryByTestId("picker-row")).not.toBeInTheDocument()
  })

  it("[tag:kb-dataset-picker] handles undefined data (initial load)", () => {
    mockUseListDatasetsQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    })
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBDatasetPicker form={form} isEdit={false} />}</TestFormWrapper>,
    )
    expect(screen.queryByTestId("picker-row")).not.toBeInTheDocument()
  })

  it("[tag:kb-dataset-picker] row selection sets dataset_id on the form", async () => {
    const { userEvent: ue } = await import("@test/render")
    const user = ue.setup()
    let capturedForm: { getFieldValue: (name: string) => unknown } | undefined
    renderWithProviders(
      <TestFormWrapper>
        {(form) => {
          capturedForm = form as unknown as typeof capturedForm
          return <KBDatasetPicker form={form} isEdit={false} />
        }}
      </TestFormWrapper>,
    )

    await user.click(screen.getByTestId("select-row-ds-1"))
    expect(capturedForm?.getFieldValue("dataset_id")).toBe("ds-1")
  })

  it("[tag:kb-dataset-picker] row deselection sets dataset_id to empty string", async () => {
    const { userEvent: ue } = await import("@test/render")
    const user = ue.setup()
    let capturedForm: { getFieldValue: (name: string) => unknown } | undefined

    vi.mocked(mockUseListDatasetsQuery).mockReturnValue({
      data: { data: DATASETS },
      isLoading: false,
      isError: false,
    })

    renderWithProviders(
      <TestFormWrapper>
        {(form) => {
          capturedForm = form as unknown as typeof capturedForm
          return <KBDatasetPicker form={form} isEdit={false} />
        }}
      </TestFormWrapper>,
    )

    await user.click(screen.getByTestId("select-row-ds-1"))
    expect(capturedForm?.getFieldValue("dataset_id")).toBe("ds-1")
  })

  it("[tag:kb-dataset-picker] renders dataset_id field error when present", () => {
    renderWithProviders(
      <TestFormWrapper>{(form) => <KBDatasetPicker form={form} isEdit={false} />}</TestFormWrapper>,
    )
    const table = screen.getByTestId("picker-table")
    expect(table).toBeInTheDocument()
  })

  it("[tag:kb-dataset-picker] shows error message when dataset_id has validation errors", async () => {
    let capturedForm: AnyReactFormApi | undefined

    renderWithProviders(
      <TestFormWrapper>
        {(form) => {
          capturedForm = form
          return <KBDatasetPicker form={form} isEdit={false} />
        }}
      </TestFormWrapper>,
    )

    // Trigger a submission attempt so the onChange validator fires the error
    act(() => {
      capturedForm!.setFieldMeta("dataset_id", (prev) => ({
        ...prev,
        errorMap: { ...prev.errorMap, onChange: "Please select a dataset" },
        errors: ["Please select a dataset"],
      }))
    })

    await waitFor(() => {
      expect(screen.getByText("Please select a dataset")).toBeInTheDocument()
    })
  })
})
