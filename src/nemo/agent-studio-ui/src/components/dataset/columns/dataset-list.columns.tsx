import type { ColumnDef } from "@tanstack/react-table";

import type { DatasetListItem } from "@/api/dataset.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { ChipList } from "@/ui-lib/base-components/chip-list/chip-list";
import { formatDateTimeFull } from "@/components/data-source/utils/data-source.utils";
import { DatasetStatusCell, SyncStatusCell } from "@/components/dataset/columns/cells/status-cell";
import { ActionsCell } from "@/components/data-source/columns/cells/actions-cell";
import type { ActionMenuItem } from "@/components/data-source/columns/cells/actions-cell";

// -- Row type adaptor --

export interface DatasetTableRow extends DatasetListItem {
  id: string;
}

// -- Callbacks --

export interface DatasetColumnsCallbacks {
  onNavigateDetail: (dsetId: string) => void;
  onNavigateDataSource?: (dsrcId: string) => void;
  actionMenuItems: ActionMenuItem<DatasetTableRow>[] | ((row: DatasetTableRow) => ActionMenuItem<DatasetTableRow>[]);
}

// -- Column factory --

function createDatasetListColumns(
  callbacks: DatasetColumnsCallbacks,
): ColumnDef<DatasetTableRow>[] {
  return [
    {
      accessorKey: "name",
      header: "Name",
      size: 220,
      minSize: 180,
      cell: ({ row }) => {
        const { deprecated } = row.original;
        if (deprecated) {
          return (
            <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-disabled)">
              {row.original.name}
            </Typography>
          );
        }
        return (
          <button
            type="button"
            className="ds-name-link"
            onClick={() => callbacks.onNavigateDetail(row.original.dset_id)}
          >
            <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-button-primary)">
              {row.original.name}
            </Typography>
          </button>
        );
      },
    },
    {
      accessorKey: "status",
      header: "Status",
      size: 130,
      cell: ({ row }) => (
        <DatasetStatusCell status={row.original.status} errorMessage={row.original.error_message} />
      ),
    },
    {
      accessorKey: "files_count",
      header: "File scope",
      size: 110,
      cell: ({ row }) => {
        const color = row.original.deprecated ? "var(--text-disabled)" : undefined;
        return (
          <Typography Component="span" fontSize="fs14" boldness="regular" color={color}>
            {row.original.files_count.toLocaleString("en-US")}
          </Typography>
        );
      },
    },
    {
      accessorKey: "synchronization_status",
      header: "Sync status",
      size: 180,
      minSize: 150,
      cell: ({ row }) => (
        <SyncStatusCell
          status={row.original.synchronization_status}
          inputType={row.original.input_type}
          variant="list"
          errorMessage={row.original.error_message}
        />
      ),
    },
    {
      id: "revision",
      header: "Revision",
      size: 110,
      enableSorting: false,
      cell: ({ row }) => {
        const { latest_snapshot, deprecated } = row.original;
        const color = deprecated ? "var(--text-disabled)" : undefined;
        return (
          <Typography Component="span" fontSize="fs14" boldness="regular" color={color}>
            {latest_snapshot ? `Version ${latest_snapshot.version}` : "—"}
          </Typography>
        );
      },
    },
    {
      id: "data_source",
      header: "Assigned data source",
      size: 180,
      minSize: 130,
      enableSorting: false,
      cell: ({ row }) => {
        const { data_source, deprecated } = row.original;
        if (!data_source) {
          return <span className="ds-cell-placeholder">—</span>;
        }
        if (callbacks.onNavigateDataSource && !deprecated) {
          return (
            <button
              type="button"
              className="ds-name-link"
              onClick={() => callbacks.onNavigateDataSource!(data_source.dsrc_id)}
            >
              <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-button-primary)">
                {data_source.name}
              </Typography>
            </button>
          );
        }
        const color = deprecated ? "var(--text-disabled)" : undefined;
        return (
          <Typography Component="span" fontSize="fs14" boldness="regular" color={color}>
            {data_source.name}
          </Typography>
        );
      },
    },
    {
      id: "last_synchronization",
      header: "Last synchronization",
      size: 180,
      minSize: 140,
      enableSorting: false,
      cell: ({ row }) => {
        const { latest_snapshot, deprecated } = row.original;
        const color = deprecated ? "var(--text-disabled)" : undefined;
        return (
          <Typography Component="span" fontSize="fs14" boldness="regular" color={color}>
            {latest_snapshot ? formatDateTimeFull(latest_snapshot.date) : "—"}
          </Typography>
        );
      },
    },
    {
      accessorKey: "labels",
      header: "Labels",
      size: 160,
      minSize: 120,
      enableSorting: false,
      cell: ({ row }) => {
        const { labels } = row.original;
        if (!labels.length) return <span className="ds-cell-placeholder">—</span>;
        return (
          <ChipList
            values={labels}
            getLabel={(v) => String(v)}
            isRemovable={false}
            isDisabled={row.original.deprecated}
          />
        );
      },
    },
    {
      id: "actions",
      header: "Actions",
      size: 75,
      minSize: 75,
      maxSize: 75,
      enableSorting: false,
      enableResizing: false,
      cell: ({ row }) => {
        const items = typeof callbacks.actionMenuItems === "function"
          ? callbacks.actionMenuItems(row.original)
          : callbacks.actionMenuItems;
        return (
          <ActionsCell
            row={row.original}
            name={row.original.name}
            menuItems={items}
          />
        );
      },
    },
  ];
}

export { createDatasetListColumns };
export type { ActionMenuItem };
