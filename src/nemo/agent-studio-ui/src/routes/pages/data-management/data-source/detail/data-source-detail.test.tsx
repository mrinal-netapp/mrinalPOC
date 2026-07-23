import { screen } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import type { DataSourceDetail as DataSourceDetailData } from "@/api/data-source.types"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn()

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>()
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})

const mockGetDataSource = vi.fn()

vi.mock("@/api/data-source-api.slice", () => ({
  useGetDataSourceQuery: (...args: unknown[]) => mockGetDataSource(...args),
  useUpdateDataSourceMutation: () => [vi.fn(), { isLoading: false }],
  useRecordConnectionTestResultMutation: () => [vi.fn(), { isLoading: false }],
  useListDataSourcesQuery: () => ({ data: undefined, isLoading: false, isError: false }),
  useDeleteDataSourceMutation: () => [vi.fn(), { isLoading: false }],
  useUpdateDataSourceDeprecationMutation: () => [vi.fn()],
}))

// Mock sub-tab components to isolate DataSourceDetail
vi.mock("./data-source-detail-overview", () => ({
  DataSourceDetailOverview: ({ data }: { data: DataSourceDetailData }) => (
    <div data-testid="overview-tab" data-name={data.name} />
  ),
}))

vi.mock("./data-source-detail-datasets", () => ({
  DataSourceDetailDatasets: ({ dsrcId }: { dsrcId: string }) => (
    <div data-testid="datasets-tab" data-id={dsrcId} />
  ),
}))

vi.mock("./data-source-detail-data-preview", () => ({
  DataSourceDetailDataPreview: ({ data }: { data: DataSourceDetailData }) => (
    <div data-testid="data-preview-tab" data-id={data.dsrc_id} />
  ),
}))

import { DataSourceDetail } from "./data-source-detail"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_DETAIL: DataSourceDetailData = {
  dsrc_id: "ds-xyz",
  name: "Prod Source",
  source_type: "NFS",
  status: "Healthy",
  scan_status: "Completed",
  deprecated: false,
  labels: ["prod"],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  description: "Production NFS source",
  connection: {
    server: "nfs.prod",
    export_path: "/data",
    folder_boundary: null,
    auth_method: "none",
    username: "",
  },
  modified_by: "admin",
  scan: {
    status: "Completed",
    scan_depth: "all_levels",
    custom_depth: null,
    total_files: 5000,
    total_folders: 200,
    total_size_bytes: 1_073_741_824,
    last_completed_at: "2024-06-01T00:00:00Z",
    status_message: null,
    file_type_stats: null,
  },
  scanned_data_count: 5000,
  associated_datasets: [],
  associated_datasets_count: 0,
  last_validated_at: null,
  last_validation_error: null,
}

function renderDetail(dsrcId = "ds-xyz") {
  return renderWithProviders(undefined, {
    routeConfig: [
      {
        path: "/data-sources/:dsrcId",
        element: <DataSourceDetail />,
      },
      {
        path: "/data-sources",
        element: <div data-testid="ds-list" />,
      },
      {
        path: "/data-sources/:dsrcId/edit",
        element: <div data-testid="edit-page" />,
      },
    ],
    initialEntries: [`/data-sources/${dsrcId}`],
  })
}

// ---------------------------------------------------------------------------
// Section 9 — DataSourceDetail
// ---------------------------------------------------------------------------

describe("DataSourceDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // 9.1
  it("[tag:data-source-detail][tag:loading] query loading → full-page spinner", () => {
    mockGetDataSource.mockReturnValue({ data: undefined, isLoading: true, isError: false })
    renderDetail()

    expect(document.querySelector(".ds-detail__loading")).toBeInTheDocument()
    expect(screen.queryByText("Prod Source")).not.toBeInTheDocument()
  })

  // 9.2
  it("[tag:data-source-detail][tag:error] query error → error message and Back button rendered", () => {
    mockGetDataSource.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    renderDetail()

    expect(screen.getByText("Failed to load data source.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Back to data sources" })).toBeInTheDocument()
  })

  // 9.3
  it("[tag:data-source-detail] success → breadcrumbs, title, stats card rendered", () => {
    mockGetDataSource.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    renderDetail()

    expect(screen.getByRole("heading", { name: "Prod Source" })).toBeInTheDocument()
    expect(screen.getByText("Data sources")).toBeInTheDocument()
  })

  // 9.4
  it("[tag:data-source-detail] stats card shows StatusCell", () => {
    mockGetDataSource.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    renderDetail()

    expect(screen.getByText("Healthy")).toBeInTheDocument()
    // Scan status was removed from the stats card.
    expect(screen.queryByText("Scan status")).not.toBeInTheDocument()
  })

  // 9.5
  it("[tag:data-source-detail] Scanned data metric is no longer rendered", () => {
    mockGetDataSource.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    renderDetail()

    expect(screen.queryByText("Scanned data")).not.toBeInTheDocument()
  })

  // 9.6
  it("[tag:data-source-detail] Scanning tab is no longer rendered", () => {
    mockGetDataSource.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    renderDetail()

    expect(screen.queryByRole("tab", { name: "Scanning" })).not.toBeInTheDocument()
  })

  // 9.7
  it("[tag:data-source-detail] clicking Overview/Datasets tabs renders correct sub-component", async () => {
    const user = userEvent.setup()
    mockGetDataSource.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    renderDetail()

    // Overview is active by default
    expect(screen.getByTestId("overview-tab")).toBeInTheDocument()

    // Switch to Data preview
    await user.click(screen.getByRole("tab", { name: "Data preview" }))
    expect(screen.getByTestId("data-preview-tab")).toBeInTheDocument()

    // Switch to Associated datasets
    await user.click(screen.getByRole("tab", { name: "Associated datasets" }))
    expect(screen.getByTestId("datasets-tab")).toBeInTheDocument()
  })

  it("[tag:data-source-detail] Data preview tab is rendered", () => {
    mockGetDataSource.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    renderDetail()

    expect(screen.getByRole("tab", { name: "Data preview" })).toBeInTheDocument()
  })

  // 9.8
  it("[tag:data-source-detail] Activity tab is no longer rendered", () => {
    mockGetDataSource.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    renderDetail()

    expect(screen.queryByRole("tab", { name: "Activity" })).not.toBeInTheDocument()
  })

  // 9.9
  it("[tag:data-source-detail] Back to data sources navigates to list path", async () => {
    const user = userEvent.setup()
    mockGetDataSource.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    renderDetail()

    await user.click(screen.getByRole("button", { name: "Back to data sources" }))

    expect(mockNavigate).toHaveBeenCalledWith(
      expect.stringContaining("data-sources"),
    )
  })

  // 9.10
  it("[tag:data-source-detail] Edit button navigates to edit path", async () => {
    const user = userEvent.setup()
    mockGetDataSource.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    renderDetail()

    await user.click(screen.getByRole("button", { name: "Edit" }))

    expect(mockNavigate).toHaveBeenCalledWith(
      expect.stringContaining("ds-xyz"),
    )
  })

  // 9.11 — branch: dsrcId undefined → skip=true → !data → renders error state (covers line 39 ?? branch)
  it("[tag:data-source-detail] no dsrcId route param shows not-found error state", () => {
    mockGetDataSource.mockReturnValue({ data: undefined, isLoading: false, isError: false })

    renderWithProviders(undefined, {
      routeConfig: [
        {
          path: "/data-sources",
          element: <DataSourceDetail />,
        },
        {
          path: "/data-sources",
          element: <div data-testid="data-management-home" />,
        },
      ],
      initialEntries: ["/data-sources"],
    })

    expect(screen.getByText("Failed to load data source.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Back to data sources" })).toBeInTheDocument()
  })

  // 9.12 — Scan button has been removed from the detail header
  it("[tag:data-source-detail] Scan button is no longer rendered", () => {
    mockGetDataSource.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    renderDetail()

    expect(screen.queryByRole("button", { name: "Scan" })).not.toBeInTheDocument()
  })

  // 9.13 — Test connection button shows only for connector sources
  it("[tag:data-source-detail] Test connection button is hidden for volume sources", () => {
    mockGetDataSource.mockReturnValue({ data: MOCK_DETAIL, isLoading: false, isError: false })
    renderDetail()

    expect(screen.queryByRole("button", { name: "Test connection" })).not.toBeInTheDocument()
  })

  it("[tag:data-source-detail] Test connection button shows for connector sources", () => {
    mockGetDataSource.mockReturnValue({
      data: {
        ...MOCK_DETAIL,
        category: "Object Store",
        connector_config: { scope: "resource", provider: "s3", connector_type: "objectstore", bucket: "b" },
        credential_id: "cred-1",
      },
      isLoading: false,
      isError: false,
    })
    renderDetail()

    expect(screen.getByRole("button", { name: "Test connection" })).toBeInTheDocument()
  })
})
