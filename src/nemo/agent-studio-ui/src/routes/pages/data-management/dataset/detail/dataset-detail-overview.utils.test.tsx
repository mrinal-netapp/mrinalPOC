import { screen } from "@testing-library/react"
import { describe, it, expect, beforeEach, afterEach } from "vitest"

import { renderWithProviders } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import type { DatasetDetail } from "@/api/dataset.types"
import { buildDatasetDetailRows } from "./dataset-detail-overview.utils"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDatasetDetail(overrides: Partial<DatasetDetail> = {}): DatasetDetail {
  return {
    dset_id: "d-1",
    name: "Test Dataset",
    kind: "unstructured",
    description: "A test description",
    status: "Healthy",
    lifecycle_status: "ready",
    deprecated: false,
    files_count: 100,
    synchronization_status: "Completed",
    data_source: { dsrc_id: "ds-1", name: "NFS Share" },
    input_type: "data-source",
    latest_snapshot: null,
    labels: ["staging", "v1"],
    created_at: "2024-01-15T10:00:00Z",
    updated_at: "2024-01-15T10:00:00Z",
    modified_by: "user",
    spec: {
      folder_scope: "all",
      paths: ["/data/train", "/data/eval"],
      file_types: [".csv", ".json"],
      last_modified_filter: "30d",
      max_file_size_bytes: 1_048_576,
      exclude_patterns: ["*.tmp"],
    },
    refresh_config: null,
    synchronization_summary: null,
    ...overrides,
  }
}

function RowRenderer({ data }: { data: DatasetDetail }) {
  const rows = buildDatasetDetailRows(data)
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

describe("buildDatasetDetailRows", () => {
  let roCleanup: () => void
  beforeEach(() => { roCleanup = mockResizeObserver().cleanup })
  afterEach(() => roCleanup?.())

  it("[tag:dataset][tag:overview-utils] produces correct labels for full data", () => {
    const data = makeDatasetDetail()
    const rows = buildDatasetDetailRows(data)
    const labels = rows.map((r) => r.label)

    expect(labels).toContain("Name")
    expect(labels).toContain("Description")
    expect(labels).toContain("Labels")
    expect(labels).toContain("Assigned data source")
    expect(labels).toContain("File scope")
    expect(labels).toContain("Folder scope")
    expect(labels).toContain("Folders")
    expect(labels).toContain("File types")
    expect(labels).toContain("Last modified")
    expect(labels).toContain("Size limit")
    expect(labels).toContain("Exclude patterns")
    expect(labels).toContain("Created")
    expect(labels).toContain("Last time update")
  })

  it("[tag:dataset][tag:overview-utils] Name row has the dataset name", () => {
    const rows = buildDatasetDetailRows(makeDatasetDetail())
    const nameRow = rows.find((r) => r.label === "Name")
    expect(nameRow?.value).toBe("Test Dataset")
  })

  it("[tag:dataset][tag:overview-utils] Description row has description or fallback", () => {
    const rows = buildDatasetDetailRows(makeDatasetDetail({ description: null }))
    const descRow = rows.find((r) => r.label === "Description")
    expect(descRow?.value).toBe("—")
  })

  it("[tag:dataset][tag:overview-utils] Labels renders ChipList when non-empty", () => {
    renderWithProviders(<RowRenderer data={makeDatasetDetail()} />)
    expect(screen.getByText("staging")).toBeInTheDocument()
  })

  it("[tag:dataset][tag:overview-utils] Labels renders '—' when empty", () => {
    const rows = buildDatasetDetailRows(makeDatasetDetail({ labels: [] }))
    const labelsRow = rows.find((r) => r.label === "Labels")
    expect(labelsRow?.value).toBe("—")
  })

  it("[tag:dataset][tag:overview-utils] Assigned data source shows name", () => {
    const rows = buildDatasetDetailRows(makeDatasetDetail())
    const dsRow = rows.find((r) => r.label === "Assigned data source")
    expect(dsRow?.value).toBe("NFS Share")
  })

  it("[tag:dataset][tag:overview-utils] Assigned data source shows '—' when null", () => {
    const rows = buildDatasetDetailRows(makeDatasetDetail({ data_source: null }))
    const dsRow = rows.find((r) => r.label === "Assigned data source")
    expect(dsRow?.value).toBe("—")
  })

  it("[tag:dataset][tag:overview-utils] File scope shows files_count as string", () => {
    const rows = buildDatasetDetailRows(makeDatasetDetail())
    const scopeRow = rows.find((r) => r.label === "File scope")
    expect(scopeRow?.value).toBe("100")
  })

  it("[tag:dataset][tag:overview-utils] File scope shows '—' when null", () => {
    const rows = buildDatasetDetailRows(makeDatasetDetail({ files_count: null as unknown as number }))
    const scopeRow = rows.find((r) => r.label === "File scope")
    expect(scopeRow?.value).toBe("—")
  })

  it("[tag:dataset][tag:overview-utils] Folder scope shows 'All folders' when folder_scope is all", () => {
    const rows = buildDatasetDetailRows(makeDatasetDetail())
    const scopeRow = rows.find((r) => r.label === "Folder scope")
    expect(scopeRow?.value).toBe("All folders")
  })

  it("[tag:dataset][tag:overview-utils] Folder scope shows 'Custom selection' when folder_scope is custom", () => {
    const rows = buildDatasetDetailRows(makeDatasetDetail({
      spec: { folder_scope: "custom", paths: ["/a", "/b"] },
    }))
    const scopeRow = rows.find((r) => r.label === "Folder scope")
    expect(scopeRow?.value).toBe("Custom selection")
  })

  it("[tag:dataset][tag:overview-utils] Folders shows joined paths", () => {
    const rows = buildDatasetDetailRows(makeDatasetDetail())
    const foldersRow = rows.find((r) => r.label === "Folders")
    expect(foldersRow?.value).toBe("/data/train, /data/eval")
  })

  it("[tag:dataset][tag:overview-utils] Folders shows '—' when empty", () => {
    const rows = buildDatasetDetailRows(makeDatasetDetail({ spec: { paths: [] } }))
    const foldersRow = rows.find((r) => r.label === "Folders")
    expect(foldersRow?.value).toBe("—")
  })

  it("[tag:dataset][tag:overview-utils] File types shows joined types", () => {
    const rows = buildDatasetDetailRows(makeDatasetDetail())
    const ftRow = rows.find((r) => r.label === "File types")
    expect(ftRow?.value).toBe(".csv, .json")
  })

  it("[tag:dataset][tag:overview-utils] Last modified shows label from options", () => {
    const rows = buildDatasetDetailRows(makeDatasetDetail())
    const lmRow = rows.find((r) => r.label === "Last modified")
    expect(lmRow?.value).toBe("Last 30 days")
  })

  it("[tag:dataset][tag:overview-utils] Size limit shows formatted bytes", () => {
    const rows = buildDatasetDetailRows(makeDatasetDetail())
    const sizeRow = rows.find((r) => r.label === "Size limit")
    expect(typeof sizeRow?.value).toBe("string")
    expect(sizeRow?.value).not.toBe("—")
  })

  it("[tag:dataset][tag:overview-utils] Size limit shows '—' when null", () => {
    const rows = buildDatasetDetailRows(makeDatasetDetail({
      spec: { max_file_size_bytes: null },
    }))
    const sizeRow = rows.find((r) => r.label === "Size limit")
    expect(sizeRow?.value).toBe("—")
  })

  it("[tag:dataset][tag:overview-utils] Exclude patterns shows joined patterns", () => {
    const rows = buildDatasetDetailRows(makeDatasetDetail())
    const epRow = rows.find((r) => r.label === "Exclude patterns")
    expect(epRow?.value).toBe("*.tmp")
  })

  it("[tag:dataset][tag:overview-utils] null spec defaults Folder scope to 'All folders' and empty filters to '—'", () => {
    const rows = buildDatasetDetailRows(makeDatasetDetail({ spec: null }))
    const folderScopeRow = rows.find((r) => r.label === "Folder scope")
    const foldersRow = rows.find((r) => r.label === "Folders")
    const ftRow = rows.find((r) => r.label === "File types")

    expect(folderScopeRow?.value).toBe("All folders")
    expect(foldersRow?.value).toBe("—")
    expect(ftRow?.value).toBe("—")
  })

  it("[tag:dataset][tag:overview-utils] hides file-filter rows for manual (upload) datasets", () => {
    const rows = buildDatasetDetailRows(makeDatasetDetail({ input_type: "upload" }))
    const labels = rows.map((r) => r.label)

    expect(labels).not.toContain("Folder scope")
    expect(labels).not.toContain("Folders")
    expect(labels).not.toContain("File types")
    expect(labels).not.toContain("Last modified")
    expect(labels).not.toContain("Size limit")
    expect(labels).not.toContain("Exclude patterns")
    // Core rows remain.
    expect(labels).toContain("Name")
    expect(labels).toContain("File scope")
    expect(labels).toContain("Created")
  })

  it("[tag:dataset][tag:overview-utils] hides file-filter rows for structured (metrics/DB) datasets", () => {
    const rows = buildDatasetDetailRows(makeDatasetDetail({ kind: "structured" }))
    const labels = rows.map((r) => r.label)

    expect(labels).not.toContain("Folder scope")
    expect(labels).not.toContain("File types")
    expect(labels).not.toContain("Exclude patterns")
    expect(labels).toContain("File scope")
  })

  it("[tag:dataset][tag:overview-utils] shows file-filter rows for unstructured data-source datasets", () => {
    const rows = buildDatasetDetailRows(makeDatasetDetail())
    const labels = rows.map((r) => r.label)

    expect(labels).toContain("Folder scope")
    expect(labels).toContain("File types")
    expect(labels).toContain("Exclude patterns")
  })
})
