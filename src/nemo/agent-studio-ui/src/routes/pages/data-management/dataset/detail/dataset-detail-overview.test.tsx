import { screen } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import type { DatasetDetail } from "@/api/dataset.types"
import type { DataSourceDetail as DataSourceDetailData } from "@/api/data-source.types"

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockGetDataSource = vi.fn()

vi.mock("@/api/data-source-api.slice", () => ({
  useGetDataSourceQuery: (...args: unknown[]) => mockGetDataSource(...args),
}))

import { DatasetDetailOverview } from "./dataset-detail-overview"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_DATA: DatasetDetail = {
  dset_id: "dset-1",
  name: "Test Dataset",
  kind: "unstructured",
  input_type: "data-source",
  status: "Healthy",
  lifecycle_status: "ready",
  synchronization_status: "Completed",
  deprecated: false,
  files_count: 500,
  labels: ["prod", "staging"],
  data_source: { dsrc_id: "ds-1", name: "Prod NFS" },
  latest_snapshot: null,
  created_at: "2024-01-15T10:30:00Z",
  updated_at: "2024-01-15T10:30:00Z",
  modified_by: "admin",
  description: "A test description",
  spec: {
    folder_scope: "custom",
    paths: ["/data/exports", "/data/reports"],
    file_types: [".pdf", ".docx"],
    last_modified_filter: "30d",
    max_file_size_bytes: 10_485_760,
    exclude_patterns: ["*.tmp", "*.log"],
  },
  refresh_config: null,
  synchronization_summary: null,
}

const MOCK_DS_DETAIL: DataSourceDetailData = {
  dsrc_id: "ds-1",
  name: "Prod NFS",
  source_type: "NFS",
  status: "Healthy",
  scan_status: "Completed",
  deprecated: false,
  labels: ["infra"],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  description: "Production NFS share",
  connection: {
    server: "nfs.prod.example.com",
    export_path: "/exports/data",
    folder_boundary: null,
    auth_method: "none",
    username: "svc-user",
  },
  modified_by: "admin",
  scan: null,
  scanned_data_count: null,
  associated_datasets: [],
  associated_datasets_count: 0,
  last_validated_at: null,
  last_validation_error: null,
}

// ---------------------------------------------------------------------------
// Tests — Dataset details tab
// ---------------------------------------------------------------------------

describe("DatasetDetailOverview", () => {
  let roHandle: ReturnType<typeof mockResizeObserver>

  beforeEach(() => {
    vi.clearAllMocks()
    roHandle = mockResizeObserver()
    mockGetDataSource.mockReturnValue({ data: undefined, isLoading: false, isError: false })
  })

  afterEach(() => {
    roHandle.cleanup()
  })

  it("[tag:dset-detail-overview] renders both tabs", () => {
    renderWithProviders(<DatasetDetailOverview data={MOCK_DATA} />)

    expect(screen.getByRole("tab", { name: "Dataset details" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Assigned data source" })).toBeInTheDocument()
  })

  it("[tag:dset-detail-overview] Dataset details tab is active by default with all rows", () => {
    renderWithProviders(<DatasetDetailOverview data={MOCK_DATA} />)

    expect(screen.getByText("Name")).toBeInTheDocument()
    expect(screen.getByText("Test Dataset")).toBeInTheDocument()
    expect(screen.getByText("Description")).toBeInTheDocument()
    expect(screen.getByText("A test description")).toBeInTheDocument()
    expect(screen.getByText("Labels")).toBeInTheDocument()
    // "Assigned data source" exists as both a tab and a row label
    const dsMatches = screen.getAllByText("Assigned data source")
    expect(dsMatches.length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText("Prod NFS")).toBeInTheDocument()
    expect(screen.getByText("File scope")).toBeInTheDocument()
    expect(screen.getByText("500")).toBeInTheDocument()
    expect(screen.getByText("Folder scope")).toBeInTheDocument()
    expect(screen.getByText("Custom selection")).toBeInTheDocument()
    expect(screen.getByText("Folders")).toBeInTheDocument()
    expect(screen.getByText("/data/exports, /data/reports")).toBeInTheDocument()
    expect(screen.getByText("File types")).toBeInTheDocument()
    expect(screen.getByText(".pdf, .docx")).toBeInTheDocument()
    expect(screen.getByText("Last modified")).toBeInTheDocument()
    expect(screen.getByText("Last 30 days")).toBeInTheDocument()
    expect(screen.getByText("Size limit")).toBeInTheDocument()
    expect(screen.getByText("Exclude patterns")).toBeInTheDocument()
    expect(screen.getByText("*.tmp, *.log")).toBeInTheDocument()
    expect(screen.getByText("Created")).toBeInTheDocument()
    expect(screen.getByText("Last time update")).toBeInTheDocument()
  })

  it("[tag:dset-detail-overview] labels row: non-empty → renders ChipList", () => {
    renderWithProviders(<DatasetDetailOverview data={MOCK_DATA} />)

    expect(screen.getByText("prod")).toBeInTheDocument()
    expect(screen.getByText("staging")).toBeInTheDocument()
  })

  it("[tag:dset-detail-overview][tag:empty] labels row: empty array → renders '-'", () => {
    const data = { ...MOCK_DATA, labels: [] }
    renderWithProviders(<DatasetDetailOverview data={data} />)

    const labelsLabel = screen.getByText("Labels")
    const row = labelsLabel.closest(".card-block") ?? labelsLabel.parentElement
    expect(row?.textContent).toContain("—")
  })

  it("[tag:dset-detail-overview] null description renders '-'", () => {
    const data = { ...MOCK_DATA, description: null }
    renderWithProviders(<DatasetDetailOverview data={data} />)

    const descLabel = screen.getByText("Description")
    const row = descLabel.closest(".card-block") ?? descLabel.parentElement
    expect(row?.textContent).toContain("—")
  })

  it("[tag:dset-detail-overview] null data_source renders '-' for assigned data source row", () => {
    const data = { ...MOCK_DATA, data_source: null }
    renderWithProviders(<DatasetDetailOverview data={data} />)

    // "Assigned data source" appears as both a tab label and a row label;
    // target the one inside a card-block (the row label).
    const matches = screen.getAllByText("Assigned data source")
    const rowLabel = matches.find((el) => el.closest(".card-block"))
    expect(rowLabel).toBeDefined()
    const row = rowLabel!.closest(".card-block") ?? rowLabel!.parentElement
    expect(row?.textContent).toContain("—")
  })

  it("[tag:dset-detail-overview] null spec renders '-' for spec fields", () => {
    const data = { ...MOCK_DATA, spec: null }
    renderWithProviders(<DatasetDetailOverview data={data} />)

    const foldersLabel = screen.getByText("Folders")
    const foldersRow = foldersLabel.closest(".card-block") ?? foldersLabel.parentElement
    expect(foldersRow?.textContent).toContain("—")

    const ftLabel = screen.getByText("File types")
    const ftRow = ftLabel.closest(".card-block") ?? ftLabel.parentElement
    expect(ftRow?.textContent).toContain("—")
  })

  it("[tag:dset-detail-overview] last_modified_filter all shows 'Any time'", () => {
    const data = {
      ...MOCK_DATA,
      spec: { ...MOCK_DATA.spec!, last_modified_filter: "all" as const },
    }
    renderWithProviders(<DatasetDetailOverview data={data} />)

    expect(screen.getByText("Any time")).toBeInTheDocument()
  })

  // -- Assigned data source tab --

  it("[tag:dset-detail-overview] switching to data source tab shows data source details", async () => {
    const user = userEvent.setup()
    mockGetDataSource.mockReturnValue({ data: MOCK_DS_DETAIL, isLoading: false, isError: false })
    renderWithProviders(<DatasetDetailOverview data={MOCK_DATA} />)

    await user.click(screen.getByRole("tab", { name: "Assigned data source" }))

    expect(screen.getByText("nfs.prod.example.com")).toBeInTheDocument()
    expect(screen.getByText("/exports/data")).toBeInTheDocument()
    expect(screen.getByText("NFS share")).toBeInTheDocument()
    expect(screen.getByText("svc-user")).toBeInTheDocument()
    expect(screen.getByText("Production NFS share")).toBeInTheDocument()
  })

  it("[tag:dset-detail-overview] data source tab loading shows spinner", async () => {
    const user = userEvent.setup()
    mockGetDataSource.mockReturnValue({ data: undefined, isLoading: true, isError: false })
    renderWithProviders(<DatasetDetailOverview data={MOCK_DATA} />)

    await user.click(screen.getByRole("tab", { name: "Assigned data source" }))

    expect(document.querySelector(".spinner")).toBeInTheDocument()
  })

  it("[tag:dset-detail-overview] data source tab error shows error message", async () => {
    const user = userEvent.setup()
    mockGetDataSource.mockReturnValue({ data: undefined, isLoading: false, isError: true })
    renderWithProviders(<DatasetDetailOverview data={MOCK_DATA} />)

    await user.click(screen.getByRole("tab", { name: "Assigned data source" }))

    expect(screen.getByText("Failed to load data source details.")).toBeInTheDocument()
  })

  it("[tag:dset-detail-overview] data source tab with no assigned data source shows placeholder", async () => {
    const user = userEvent.setup()
    const data = { ...MOCK_DATA, data_source: null }
    renderWithProviders(<DatasetDetailOverview data={data} />)

    await user.click(screen.getByRole("tab", { name: "Assigned data source" }))

    expect(screen.getByText("No data source assigned to this dataset.")).toBeInTheDocument()
  })

  it("[tag:dset-detail-overview] data source tab shows labels as ChipList", async () => {
    const user = userEvent.setup()
    mockGetDataSource.mockReturnValue({ data: MOCK_DS_DETAIL, isLoading: false, isError: false })
    renderWithProviders(<DatasetDetailOverview data={MOCK_DATA} />)

    await user.click(screen.getByRole("tab", { name: "Assigned data source" }))

    expect(screen.getByText("infra")).toBeInTheDocument()
  })

})
