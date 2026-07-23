import { screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders } from "@test/render"
import type { DatasetDetail } from "@/api/dataset.types"

vi.mock("./form/dataset-form", () => ({
  DatasetForm: ({
    isEdit,
    initialData,
  }: {
    isEdit?: boolean
    initialData?: DatasetDetail
  }) => (
    <div
      data-testid="dataset-form"
      data-is-edit={isEdit ? "true" : "false"}
      data-name={initialData?.name}
    />
  ),
}))

const mockGetDataset = vi.fn()

vi.mock("@/api/dataset-api.slice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/dataset-api.slice")>()
  return {
    ...actual,
    useGetDatasetQuery: (...args: unknown[]) => mockGetDataset(...args),
  }
})

import { DatasetEditPage } from "./dataset-edit-page"

const MOCK_DATASET: DatasetDetail = {
  dset_id: "dset-1",
  name: "My Dataset",
  kind: "unstructured",
  input_type: "data-source",
  status: "Healthy",
  lifecycle_status: "ready",
  deprecated: false,
  files_count: 10,
  synchronization_status: "Completed",
  latest_snapshot: null,
  labels: [],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  modified_by: "admin",
  data_source: { dsrc_id: "ds-1", name: "Source" },
  description: "Desc",
  spec: {
    folder_scope: "all",
    paths: [],
    file_types: [],
    last_modified_filter: "all",
    max_file_size_bytes: null,
    exclude_patterns: [],
  },
  refresh_config: null,
  synchronization_summary: null,
  sql_query: null,
  catalog_namespace: null,
  catalog_table_name: null,
}

function renderEditPage(dsetId?: string) {
  const path = dsetId
    ? `/datasets/${dsetId}/edit`
    : "/datasets/edit"
  const routePath = dsetId
    ? "/datasets/:dsetId/edit"
    : "/datasets/edit"

  return renderWithProviders(undefined, {
    routeConfig: [
      {
        path: routePath,
        element: <DatasetEditPage />,
      },
      {
        path: "/datasets",
        element: <div data-testid="dset-list" />,
      },
    ],
    initialEntries: [path],
  })
}

// ---------------------------------------------------------------------------
// DatasetEditPage
// ---------------------------------------------------------------------------

describe("DatasetEditPage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("[tag:dataset-edit-page] no dsetId param → Navigate to datasets list", () => {
    mockGetDataset.mockReturnValue({ data: undefined, isLoading: false, isError: false })

    renderWithProviders(undefined, {
      routeConfig: [
        {
          path: "/datasets/edit",
          element: <DatasetEditPage />,
        },
        {
          path: "/datasets",
          element: <div data-testid="dset-list" />,
        },
      ],
      initialEntries: ["/datasets/edit"],
    })

    expect(screen.getByTestId("dset-list")).toBeInTheDocument()
  })

  it("[tag:dataset-edit-page][tag:loading] isLoading → full-page spinner shown", () => {
    mockGetDataset.mockReturnValue({ data: undefined, isLoading: true, isError: false })

    renderEditPage("dset-1")

    expect(screen.queryByTestId("dataset-form")).not.toBeInTheDocument()
    expect(document.querySelector(".dset-form-page__loading")).toBeInTheDocument()
  })

  it("[tag:dataset-edit-page][tag:error] error or no data → error message rendered", () => {
    mockGetDataset.mockReturnValue({ data: undefined, isLoading: false, isError: true })

    renderEditPage("dset-1")

    expect(screen.getByText("Failed to load dataset.")).toBeInTheDocument()
    expect(screen.queryByTestId("dataset-form")).not.toBeInTheDocument()
  })

  it("[tag:dataset-edit-page] data loaded → DatasetForm receives isEdit + initialData", () => {
    mockGetDataset.mockReturnValue({
      data: MOCK_DATASET,
      isLoading: false,
      isError: false,
    })

    renderEditPage("dset-1")

    const form = screen.getByTestId("dataset-form")
    expect(form).toBeInTheDocument()
    expect(form).toHaveAttribute("data-is-edit", "true")
    expect(form).toHaveAttribute("data-name", "My Dataset")
  })
})
