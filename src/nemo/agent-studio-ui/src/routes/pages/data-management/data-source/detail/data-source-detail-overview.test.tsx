import { screen } from "@testing-library/react"
import { describe, it, expect } from "vitest"

import { renderWithProviders } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import type { DataSourceDetail } from "@/api/data-source.types"
import { DataSourceDetailOverview } from "./data-source-detail-overview"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_DATA: DataSourceDetail = {
  dsrc_id: "ds-1",
  name: "Test Source",
  source_type: "NFS",
  status: "Healthy",
  scan_status: "Completed",
  deprecated: false,
  labels: ["prod", "nfs"],
  created_at: "2024-01-15T10:30:00Z",
  updated_at: "2024-01-15T10:30:00Z",
  description: "A test description",
  connection: {
    server: "nfs.example.com",
    export_path: "/data",
    folder_boundary: null,
    auth_method: "none",
    username: "admin",
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

// ---------------------------------------------------------------------------
// Section 10.1–10.5 — DataSourceDetailOverview
// ---------------------------------------------------------------------------

describe("DataSourceDetailOverview", () => {
  let roHandle: ReturnType<typeof mockResizeObserver>

  beforeEach(() => {
    roHandle = mockResizeObserver()
  })

  afterEach(() => {
    roHandle.cleanup()
  })

  // 10.1
  it("[tag:ds-detail-overview] all metadata rows rendered", () => {
    renderWithProviders(<DataSourceDetailOverview data={MOCK_DATA} />)

    expect(screen.getByText("Name")).toBeInTheDocument()
    expect(screen.getByText("Test Source")).toBeInTheDocument()
    expect(screen.getByText("Description")).toBeInTheDocument()
    expect(screen.getByText("A test description")).toBeInTheDocument()
    expect(screen.getByText("Labels")).toBeInTheDocument()
    expect(screen.getByText("Type")).toBeInTheDocument()
    expect(screen.getByText("Server name (IP address)")).toBeInTheDocument()
    expect(screen.getByText("nfs.example.com")).toBeInTheDocument()
    expect(screen.getByText("Path")).toBeInTheDocument()
    expect(screen.getByText("/data")).toBeInTheDocument()
    expect(screen.getByText("Username")).toBeInTheDocument()
    expect(screen.getByText("admin")).toBeInTheDocument()
    expect(screen.getByText("Password")).toBeInTheDocument()
    expect(screen.getByText("Last time update")).toBeInTheDocument()
    expect(screen.getByText("Created")).toBeInTheDocument()
  })

  // 10.2
  it("[tag:ds-detail-overview] labels row: non-empty → renders ChipList", () => {
    renderWithProviders(<DataSourceDetailOverview data={MOCK_DATA} />)

    // ChipList renders each label as chip text
    expect(screen.getByText("prod")).toBeInTheDocument()
    expect(screen.getByText("nfs")).toBeInTheDocument()
  })

  // 10.3
  it("[tag:ds-detail-overview][tag:empty] labels row: empty array → renders '-'", () => {
    const data = { ...MOCK_DATA, labels: [] }
    renderWithProviders(<DataSourceDetailOverview data={data} />)

    // No chip items; the Labels row value is the plain dash "-"
    const labelsLabel = screen.getByText("Labels")
    const row = labelsLabel.closest(".card-block") ?? labelsLabel.parentElement
    expect(row?.textContent).toContain("-")
  })

  // 10.4
  it("[tag:ds-detail-overview] null/empty description renders '-'", () => {
    const data = { ...MOCK_DATA, description: null }
    renderWithProviders(<DataSourceDetailOverview data={data} />)

    const descLabel = screen.getByText("Description")
    const row = descLabel.closest(".card-block") ?? descLabel.parentElement
    expect(row?.textContent).toContain("-")
  })

  // 10.5
  it("[tag:ds-detail-overview] source type 'NFS' → label 'NFS share'", () => {
    renderWithProviders(<DataSourceDetailOverview data={MOCK_DATA} />)

    expect(screen.getByText("NFS share")).toBeInTheDocument()
  })

  // Gap 9: covers the `|| "-"` fallback branches on lines 27-29 for empty connection fields
  it("[tag:ds-detail-overview][tag:empty] empty/null connection fields show '-' placeholders", () => {
    const data = {
      ...MOCK_DATA,
      connection: {
        ...MOCK_DATA.connection,
        server: "",
        export_path: null,
        username: "",
      },
    }
    renderWithProviders(<DataSourceDetailOverview data={data} />)

    const serverLabel = screen.getByText("Server name (IP address)")
    const serverRow = serverLabel.closest(".card-block") ?? serverLabel.parentElement
    expect(serverRow?.textContent).toContain("-")

    const pathLabel = screen.getByText("Path")
    const pathRow = pathLabel.closest(".card-block") ?? pathLabel.parentElement
    expect(pathRow?.textContent).toContain("-")

    const usernameLabel = screen.getByText("Username")
    const usernameRow = usernameLabel.closest(".card-block") ?? usernameLabel.parentElement
    expect(usernameRow?.textContent).toContain("-")
  })

  // Gap 9b: covers line 26 `SOURCE_TYPE_LABELS[data.source_type] ?? data.source_type`
  //         when the source type is not in the labels map
  it("[tag:ds-detail-overview] unknown source type falls back to raw type string", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = { ...MOCK_DATA, source_type: "UNKNOWN_TYPE" as any }
    renderWithProviders(<DataSourceDetailOverview data={data} />)

    expect(screen.getByText("UNKNOWN_TYPE")).toBeInTheDocument()
  })
})
