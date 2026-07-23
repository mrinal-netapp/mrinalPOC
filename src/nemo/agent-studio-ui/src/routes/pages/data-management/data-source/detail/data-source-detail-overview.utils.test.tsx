import { screen } from "@testing-library/react"
import { describe, it, expect, beforeEach, afterEach } from "vitest"

import { renderWithProviders } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import type { DataSourceDetail } from "@/api/data-source.types"
import { buildDataSourceDetailRows } from "./data-source-detail-overview.utils"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDataSourceDetail(overrides: Partial<DataSourceDetail> = {}): DataSourceDetail {
  return {
    dsrc_id: "ds-1",
    name: "Production NFS",
    description: "Main data source",
    source_type: "NFS",
    status: "Active",
    scan_status: "completed",
    deprecated: false,
    associated_datasets: [],
    associated_datasets_count: 0,
    last_validated_at: null,
    last_validation_error: null,
    scan: null,
    labels: ["production"],
    created_at: "2024-01-15T10:00:00Z",
    updated_at: "2024-01-15T10:00:00Z",
    connection: {
      server: "10.0.0.1",
      export_path: "/data/exports",
      folder_boundary: null,
      auth_method: "none",
      username: "admin",
    },
    modified_by: "user@example.com",
    scanned_data_count: 500,
    ...overrides,
  } as DataSourceDetail
}

function RowRenderer({ data }: { data: DataSourceDetail }) {
  const rows = buildDataSourceDetailRows(data)
  return (
    <dl>
      {rows.map((r, i) => (
        <div key={i}>
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildDataSourceDetailRows", () => {
  let roCleanup: () => void
  beforeEach(() => { roCleanup = mockResizeObserver().cleanup })
  afterEach(() => roCleanup?.())

  it("[tag:data-source][tag:overview-utils] produces all expected labels", () => {
    const rows = buildDataSourceDetailRows(makeDataSourceDetail())
    const labels = rows.map((r) => r.label)

    expect(labels).toContain("Name")
    expect(labels).toContain("Description")
    expect(labels).toContain("Labels")
    expect(labels).toContain("Type")
    expect(labels).toContain("Server name (IP address)")
    expect(labels).toContain("Path")
    expect(labels).toContain("Username")
    expect(labels).toContain("Password")
    expect(labels).toContain("Last time update")
    expect(labels).toContain("Created")
  })

  it("[tag:data-source][tag:overview-utils] Name row has the data source name", () => {
    const rows = buildDataSourceDetailRows(makeDataSourceDetail())
    const nameRow = rows.find((r) => r.label === "Name")
    expect(nameRow?.value).toBe("Production NFS")
  })

  it("[tag:data-source][tag:overview-utils] Description shows '-' when null", () => {
    const rows = buildDataSourceDetailRows(makeDataSourceDetail({ description: null }))
    const descRow = rows.find((r) => r.label === "Description")
    expect(descRow?.value).toBe("-")
  })

  it("[tag:data-source][tag:overview-utils] Description shows '-' when empty", () => {
    const rows = buildDataSourceDetailRows(makeDataSourceDetail({ description: "" }))
    const descRow = rows.find((r) => r.label === "Description")
    expect(descRow?.value).toBe("-")
  })

  it("[tag:data-source][tag:overview-utils] Labels renders ChipList when non-empty", () => {
    renderWithProviders(<RowRenderer data={makeDataSourceDetail()} />)
    expect(screen.getByText("production")).toBeInTheDocument()
  })

  it("[tag:data-source][tag:overview-utils] Labels renders '-' when empty", () => {
    const rows = buildDataSourceDetailRows(makeDataSourceDetail({ labels: [] }))
    const labelsRow = rows.find((r) => r.label === "Labels")
    expect(labelsRow?.value).toBe("-")
  })

  it("[tag:data-source][tag:overview-utils] Type shows label from SOURCE_TYPE_LABELS", () => {
    const rows = buildDataSourceDetailRows(makeDataSourceDetail())
    const typeRow = rows.find((r) => r.label === "Type")
    expect(typeRow?.value).toBe("NFS share")
  })

  it("[tag:data-source][tag:overview-utils] Server shows IP address", () => {
    const rows = buildDataSourceDetailRows(makeDataSourceDetail())
    const serverRow = rows.find((r) => r.label === "Server name (IP address)")
    expect(serverRow?.value).toBe("10.0.0.1")
  })

  it("[tag:data-source][tag:overview-utils] Server shows '-' when empty", () => {
    const ds = makeDataSourceDetail()
    ds.connection.server = ""
    const rows = buildDataSourceDetailRows(ds)
    const serverRow = rows.find((r) => r.label === "Server name (IP address)")
    expect(serverRow?.value).toBe("-")
  })

  it("[tag:data-source][tag:overview-utils] Path shows export_path", () => {
    const rows = buildDataSourceDetailRows(makeDataSourceDetail())
    const pathRow = rows.find((r) => r.label === "Path")
    expect(pathRow?.value).toBe("/data/exports")
  })

  it("[tag:data-source][tag:overview-utils] Username shows value or '-'", () => {
    const rows = buildDataSourceDetailRows(makeDataSourceDetail())
    const userRow = rows.find((r) => r.label === "Username")
    expect(userRow?.value).toBe("admin")
  })

  it("[tag:data-source][tag:overview-utils] Password shows '-' when no username/credential is set", () => {
    const rows = buildDataSourceDetailRows(
      makeDataSourceDetail({
        connection: {
          server: "10.0.0.1",
          export_path: "/data/exports",
          folder_boundary: null,
          auth_method: "none",
          username: "",
        },
      } as Partial<DataSourceDetail>),
    )
    const pwRow = rows.find((r) => r.label === "Password")
    expect(pwRow?.value).toBe("-")
  })

  it("[tag:data-source][tag:overview-utils] Password shows '********' when a username is present", () => {
    const rows = buildDataSourceDetailRows(makeDataSourceDetail({ source_type: "SMB" } as Partial<DataSourceDetail>))
    const pwRow = rows.find((r) => r.label === "Password")
    expect(pwRow?.value).toBe("********")
  })

  it("[tag:data-source][tag:overview-utils] Created shows formatted date", () => {
    const rows = buildDataSourceDetailRows(makeDataSourceDetail())
    const createdRow = rows.find((r) => r.label === "Created")
    expect(typeof createdRow?.value).toBe("string")
    expect(createdRow?.value).not.toBe("-")
  })
})
