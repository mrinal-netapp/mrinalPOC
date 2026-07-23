import { screen, waitFor } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders } from "@test/render"
import type { DataSourceDetail } from "@/api/data-source.types"

// Mock DataSourceForm to keep the test isolated from form complexity
vi.mock("./form/data-source-form", () => ({
  DataSourceForm: ({ isEdit, initialData }: { isEdit?: boolean; initialData?: DataSourceDetail }) => (
    <div
      data-testid="data-source-form"
      data-is-edit={isEdit ? "true" : "false"}
      data-name={initialData?.name}
    />
  ),
}))

// Mock RTK Query hooks
const mockGetDataSource = vi.fn()

vi.mock("@/api/data-source-api.slice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/data-source-api.slice")>()
  return {
    ...actual,
    useGetDataSourceQuery: (...args: unknown[]) => mockGetDataSource(...args),
  }
})

import { DataSourceEditPage } from "./data-source-edit-page"

const MOCK_DETAIL: DataSourceDetail = {
  dsrc_id: "ds-abc",
  name: "My Source",
  source_type: "NFS",
  status: "Healthy",
  scan_status: "Completed",
  deprecated: false,
  labels: [],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  description: null,
  connection: {
    server: "nfs.host",
    export_path: "/data",
    folder_boundary: null,
    auth_method: "none",
    username: "",
  },
  modified_by: "admin",
  scan: null,
  scanned_data_count: null,
  associated_datasets: [],
  associated_datasets_count: 0,
  last_validated_at: null,
  last_validation_error: null,
}

function renderEditPage(dsrcId?: string) {
  const path = dsrcId
    ? `/data-sources/${dsrcId}/edit`
    : "/data-sources/edit"
  const routePath = dsrcId
    ? "/data-sources/:dsrcId/edit"
    : "/data-sources/edit"

  return renderWithProviders(undefined, {
    routeConfig: [
      {
        path: routePath,
        element: <DataSourceEditPage />,
      },
      // Redirect target for Navigate
      {
        path: "/data-sources",
        element: <div data-testid="ds-list" />,
      },
    ],
    initialEntries: [path],
  })
}

// ---------------------------------------------------------------------------
// Section 7.4–7.7 — DataSourceEditPage
// ---------------------------------------------------------------------------

describe("DataSourceEditPage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // 7.4
  it("[tag:data-source-edit-page] no dsrcId param → renders Navigate to list", async () => {
    mockGetDataSource.mockReturnValue({ data: undefined, isLoading: false, isError: false })

    // Route without :dsrcId param means useParams returns undefined
    renderWithProviders(undefined, {
      routeConfig: [
        {
          path: "/data-sources/edit",
          element: <DataSourceEditPage />,
        },
        {
          path: "/data-sources",
          element: <div data-testid="ds-list" />,
        },
      ],
      initialEntries: ["/data-sources/edit"],
    })

    // Should have navigated to the list page
    await waitFor(() => {
      expect(screen.getByTestId("ds-list")).toBeInTheDocument()
    })
  })

  // 7.5
  it("[tag:data-source-edit-page][tag:loading] isLoading → full-page spinner shown", () => {
    mockGetDataSource.mockReturnValue({ data: undefined, isLoading: true, isError: false })

    renderEditPage("ds-abc")

    // Spinner renders without DataSourceForm
    expect(screen.queryByTestId("data-source-form")).not.toBeInTheDocument()
    // The spinner container div is present
    const loadingDiv = document.querySelector(".ds-form-page__loading")
    expect(loadingDiv).toBeInTheDocument()
  })

  // 7.6
  it("[tag:data-source-edit-page][tag:error] error or no data → error message rendered", () => {
    mockGetDataSource.mockReturnValue({ data: undefined, isLoading: false, isError: true })

    renderEditPage("ds-abc")

    expect(screen.getByText("Failed to load data source.")).toBeInTheDocument()
    expect(screen.queryByTestId("data-source-form")).not.toBeInTheDocument()
  })

  // 7.7
  it("[tag:data-source-edit-page] data loaded → DataSourceForm receives isEdit + initialData", () => {
    mockGetDataSource.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })

    renderEditPage("ds-abc")

    const form = screen.getByTestId("data-source-form")
    expect(form).toBeInTheDocument()
    expect(form).toHaveAttribute("data-is-edit", "true")
    expect(form).toHaveAttribute("data-name", "My Source")
  })
})
