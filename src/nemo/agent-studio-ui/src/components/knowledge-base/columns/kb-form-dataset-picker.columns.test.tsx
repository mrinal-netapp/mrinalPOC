import { screen } from "@testing-library/react"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
} from "@tanstack/react-table"

import { renderWithProviders } from "@test/render"
import { mockResizeObserver } from "@test/mocks"
import {
  createKBFormDatasetPickerColumns,
  type KBFormDatasetPickerRow,
} from "./kb-form-dataset-picker.columns"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULL_ROW: KBFormDatasetPickerRow = {
  id: "d-1",
  dset_id: "d-1",
  name: "Training Dataset",
  kind: "unstructured",
  status: "Healthy",
  lifecycle_status: "ready",
  deprecated: false,
  files_count: 2_500,
  synchronization_status: "Completed",
  data_source: null,
  input_type: "data-source",
  latest_snapshot: {
    id: "snap-1",
    version: 1,
    date: "2026-02-10T07:15:06Z",
    total_files: 2500,
    files_added: 0,
    files_removed: 0,
    total_folders: 10,
  },
  labels: ["staging", "v2"],
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  modified_by: "user",
}

const EMPTY_ROW: KBFormDatasetPickerRow = {
  ...FULL_ROW,
  id: "d-2",
  dset_id: "d-2",
  name: "Empty Labels DS",
  latest_snapshot: null,
  labels: [],
}

// ---------------------------------------------------------------------------
// Table wrapper
// ---------------------------------------------------------------------------

function TableWrapper({ rows }: { rows: KBFormDatasetPickerRow[] }) {
  const columns = createKBFormDatasetPickerColumns()
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })

  return (
    <table>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.id}>
            {row.getVisibleCells().map((cell) => (
              <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createKBFormDatasetPickerColumns", () => {
  let roCleanup: () => void
  beforeEach(() => { roCleanup = mockResizeObserver().cleanup })
  afterEach(() => roCleanup?.())

  it("[tag:kb-dataset-picker-columns] name cell renders name text", () => {
    renderWithProviders(<TableWrapper rows={[FULL_ROW]} />)
    expect(screen.getByText("Training Dataset")).toBeInTheDocument()
  })

  it("[tag:kb-dataset-picker-columns] status cell renders DatasetStatusCell", () => {
    renderWithProviders(<TableWrapper rows={[FULL_ROW]} />)
    expect(screen.getByText("Healthy")).toBeInTheDocument()
  })

  it("[tag:kb-dataset-picker-columns] file scope cell shows formatted scope", () => {
    renderWithProviders(<TableWrapper rows={[FULL_ROW]} />)
    expect(screen.getByText("2,500 files / 10 folders")).toBeInTheDocument()
  })

  it("[tag:kb-dataset-picker-columns] sync schedule cell shows placeholder '—'", () => {
    renderWithProviders(<TableWrapper rows={[FULL_ROW]} />)
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:kb-dataset-picker-columns] last sync cell shows formatted date when snapshot present", () => {
    renderWithProviders(<TableWrapper rows={[FULL_ROW]} />)
    expect(screen.getByText(/Feb/)).toBeInTheDocument()
  })

  it("[tag:kb-dataset-picker-columns] last sync cell shows '—' when no snapshot", () => {
    renderWithProviders(<TableWrapper rows={[EMPTY_ROW]} />)
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })

  it("[tag:kb-dataset-picker-columns] labels cell renders ChipList for non-empty labels", () => {
    renderWithProviders(<TableWrapper rows={[FULL_ROW]} />)
    expect(screen.getByText("staging")).toBeInTheDocument()
    expect(screen.getByText("v2")).toBeInTheDocument()
  })

  it("[tag:kb-dataset-picker-columns] labels cell shows '—' for empty labels", () => {
    renderWithProviders(<TableWrapper rows={[EMPTY_ROW]} />)
    expect(screen.getAllByText("—").length).toBeGreaterThan(0)
  })
})
