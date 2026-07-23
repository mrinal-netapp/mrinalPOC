import type { ColumnDef } from "@tanstack/react-table";
import type { DataSourceDatasetRef } from "@/api/data-source.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { ChipList } from "@/ui-lib/base-components/chip-list/chip-list";
import { formatDateTimeFull } from "@/components/data-source/utils/data-source.utils";
import { DatasetStatusCell } from "@/components/data-source/columns/cells/status-cell";

// -- Row type adaptor (BaseTable requires `id`) --

export interface DatasetTableRow extends DataSourceDatasetRef {
  id: string;
}

// -- Callbacks --

export interface DatasetColumnsCallbacks {
  onNavigateDataset?: (dsetId: string) => void;
}

// -- Column factory --

function createDataSourceDatasetsColumns(
  callbacks: DatasetColumnsCallbacks,
): ColumnDef<DatasetTableRow>[] {
  return [
    {
      accessorKey: "name",
      header: "Name",
      size: 220,
      minSize: 180,
      cell: ({ row }) => {
        if (callbacks.onNavigateDataset) {
          return (
            <button
              type="button"
              className="ds-name-link"
              onClick={() => callbacks.onNavigateDataset!(row.original.dset_id)}
            >
              <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-button-primary)">
                {row.original.name}
              </Typography>
            </button>
          );
        }
        return (
          <Typography Component="span" fontSize="fs14" boldness="regular">
            {row.original.name}
          </Typography>
        );
      },
    },
    {
      accessorKey: "file_scope",
      header: "File scope",
      size: 120,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {(row.original.file_scope ?? 0).toLocaleString("en-US")}
        </Typography>
      ),
    },
    {
      accessorKey: "synchronization_schedule",
      header: "Sync schedule",
      size: 160,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {row.original.synchronization_schedule ?? "—"}
        </Typography>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      size: 140,
      cell: ({ row }) => <DatasetStatusCell status={row.original.status} />,
    },
    {
      accessorKey: "labels",
      header: "Labels",
      size: 160,
      minSize: 140,
      enableSorting: false,
      cell: ({ row }) => {
        const { labels } = row.original;
        if (!labels.length) return <span className="ds-cell-placeholder">—</span>;
        return (
          <ChipList
            values={labels}
            getLabel={(v) => String(v)}
            isRemovable={false}
            isDisabled={false}
          />
        );
      },
    },
    {
      accessorKey: "created_at",
      header: "Created",
      size: 180,
      minSize: 140,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {formatDateTimeFull(row.original.created_at)}
        </Typography>
      ),
    },
  ];
}

export { createDataSourceDatasetsColumns };
