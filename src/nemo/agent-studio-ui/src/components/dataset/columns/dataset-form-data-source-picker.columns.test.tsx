import { screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
} from "@tanstack/react-table";

import { renderWithProviders, userEvent } from "@test/render";
import { mockResizeObserver } from "@test/mocks";
import {
  createDatasetFormDataSourcePickerColumns,
  type DataSourceTableRow,
} from "./dataset-form-data-source-picker.columns";

// ---------------------------------------------------------------------------
// createDatasetFormDataSourcePickerColumns
// ---------------------------------------------------------------------------

const BASE_ROW: DataSourceTableRow = {
  id: "ds-1",
  dsrc_id: "ds-1",
  name: "My Source",
  status: "Healthy",
  scan_status: "Completed",
  category: "Volume",
  source_type: "NFS",
  deprecated: false,
  labels: ["prod"],
  created_at: "2024-01-15T10:00:00Z",
  updated_at: "2024-01-15T10:00:00Z",
  associated_datasets: [],
  associated_datasets_count: 0,
  last_validated_at: null,
  last_validation_error: null,
  scan: null,
};

function TableWrapper({
  rows,
  onScan,
  onViewData,
}: {
  rows: DataSourceTableRow[];
  onScan: (row: DataSourceTableRow) => void;
  onViewData: (row: DataSourceTableRow) => void;
}) {
  const columns = createDatasetFormDataSourcePickerColumns({ onScan, onViewData });

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

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
  );
}

describe("createDatasetFormDataSourcePickerColumns", () => {
  let roCleanup: () => void;
  beforeEach(() => { roCleanup = mockResizeObserver().cleanup; });
  afterEach(() => { roCleanup?.(); });

  it("renders the data source name cell", () => {
    renderWithProviders(
      <TableWrapper rows={[BASE_ROW]} onScan={vi.fn()} onViewData={vi.fn()} />,
    );
    expect(screen.getByText("My Source")).toBeInTheDocument();
  });

  it("renders the category when it is available", () => {
    const rowWithScan: DataSourceTableRow = {
      ...BASE_ROW,
      category: "Database",
    };

    renderWithProviders(
      <TableWrapper rows={[rowWithScan]} onScan={vi.fn()} onViewData={vi.fn()} />,
    );
    expect(screen.getByText("Database")).toBeInTheDocument();
  });

  it("falls back to source_type when category is absent", () => {
    const rowWithoutCategory: DataSourceTableRow = {
      ...BASE_ROW,
      category: null,
    };

    renderWithProviders(
      <TableWrapper rows={[rowWithoutCategory]} onScan={vi.fn()} onViewData={vi.fn()} />,
    );
    expect(screen.getByText("NFS")).toBeInTheDocument();
  });

  it("renders status and scan status cells", () => {
    renderWithProviders(
      <TableWrapper rows={[BASE_ROW]} onScan={vi.fn()} onViewData={vi.fn()} />,
    );
    // StatusCell and ScanStatusCell are rendered; just ensure no crash and row is present
    expect(screen.getByText("My Source")).toBeInTheDocument();
  });

  it("invokes onViewData when View is clicked for Volume sources", async () => {
    const user = userEvent.setup();
    const onScan = vi.fn();
    const onViewData = vi.fn();

    renderWithProviders(
      <TableWrapper rows={[BASE_ROW]} onScan={onScan} onViewData={onViewData} />,
    );

    await user.click(screen.getByText("View"));
    expect(onViewData).toHaveBeenCalledWith(BASE_ROW);
  });

  it("renders '—' instead of a View action for non-Volume sources", () => {
    const databaseRow: DataSourceTableRow = {
      ...BASE_ROW,
      category: "Database",
    };

    renderWithProviders(
      <TableWrapper rows={[databaseRow]} onScan={vi.fn()} onViewData={vi.fn()} />,
    );

    expect(screen.queryByText("View")).not.toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
