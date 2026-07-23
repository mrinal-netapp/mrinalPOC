import type { ColumnDef } from "@tanstack/react-table";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { StatusCell } from "@/components/data-source/columns/cells/status-cell";
import type { DataSourceTableRow } from "@/components/data-source/columns/data-source-list.columns";

// -- Callbacks --

export interface DatasetFormDataSourcePickerColumnsCallbacks {
  onScan?: (row: DataSourceTableRow) => void;
  onViewData: (row: DataSourceTableRow) => void;
}

// -- Column factory --

function createDatasetFormDataSourcePickerColumns(
  callbacks: DatasetFormDataSourcePickerColumnsCallbacks,
): ColumnDef<DataSourceTableRow>[] {
  return [
    {
      accessorKey: "name",
      header: "Name",
      size: 220,
      minSize: 160,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-button-primary)">
          {row.original.name}
        </Typography>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      size: 140,
      cell: ({ row }) => (
        <StatusCell status={row.original.status} deprecated={row.original.deprecated} />
      ),
    },
    {
      accessorKey: "category",
      header: "Type",
      size: 140,
      // Show the human-readable category (Volume, Database, ...) and fall back
      // to the underlying protocol only if the category is unavailable.
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {row.original.category ?? row.original.source_type ?? "—"}
        </Typography>
      ),
    },
    {
      id: "data",
      header: "Data",
      size: 100,
      enableSorting: false,
      // The browse dialog hits the volume-specific /connectors/volume-browse
      // endpoint, so "View" only works for Volume sources. Other categories
      // get a disabled placeholder until a connector-appropriate browser exists.
      cell: ({ row }) => {
        if (row.original.category !== "Volume") {
          return (
            <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-disabled)">
              —
            </Typography>
          );
        }
        return (
          <Typography
            Component="span"
            fontSize="fs14"
            boldness="regular"
            color="var(--text-button-primary)"
            style={{ cursor: "pointer" }}
            onClick={() => callbacks.onViewData(row.original)}
          >
            View
          </Typography>
        );
      },
    },
  ];
}

export { createDatasetFormDataSourcePickerColumns };
export type { DataSourceTableRow } from "@/components/data-source/columns/data-source-list.columns";
