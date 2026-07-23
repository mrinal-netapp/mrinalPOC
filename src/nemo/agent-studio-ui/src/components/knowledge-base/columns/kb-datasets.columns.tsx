import type { ColumnDef } from "@tanstack/react-table";
import type { KBAssignedDataset } from "@/api/kb.types";
import type { DatasetStatus, DatasetRefreshConfig, SynchronizationStatus } from "@/api/dataset.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { ChipList } from "@/ui-lib/base-components/chip-list/chip-list";
import { DatasetStatusCell } from "@/components/data-source/columns/cells/status-cell";
import { SyncStatusCell } from "@/components/dataset/columns/cells/status-cell";
import { getScheduleLabel } from "@/components/dataset/utils/dataset.utils";

// -- Row type adaptor (BaseTable requires `id`) --

export interface KBDatasetTableRow extends KBAssignedDataset {
  id: string;
  refresh_config?: DatasetRefreshConfig | null;
}

// -- Callbacks --

export interface KBDatasetColumnsCallbacks {
  onNavigateDataset?: (dsetId: string) => void;
}

// -- Column factory --

function createKBDatasetsColumns(
  callbacks: KBDatasetColumnsCallbacks,
): ColumnDef<KBDatasetTableRow>[] {
  return [
    {
      accessorKey: "name",
      header: "Name",
      size: 220,
      minSize: 180,
      cell: ({ row }) => {
        const dsetId = row.original.dset_id;
        if (callbacks.onNavigateDataset && dsetId) {
          return (
            <button
              type="button"
              className="ds-name-link"
              onClick={() => callbacks.onNavigateDataset!(dsetId)}
            >
              <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-button-primary)">
                {row.original.name ?? "—"}
              </Typography>
            </button>
          );
        }
        return (
          <Typography Component="span" fontSize="fs14" boldness="regular">
            {row.original.name ?? "—"}
          </Typography>
        );
      },
    },
    {
      accessorKey: "status",
      header: "Status",
      size: 140,
      cell: ({ row }) => {
        const status = row.original.status;
        if (!status) {
          return (
            <Typography Component="span" fontSize="fs14" boldness="regular">
              —
            </Typography>
          );
        }
        return <DatasetStatusCell status={status as DatasetStatus} />;
      },
    },
    {
      accessorKey: "file_scope",
      header: "File scope",
      size: 120,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {row.original.file_scope ?? "—"}
        </Typography>
      ),
    },
    {
      id: "synchronization_schedule",
      header: "Sync schedule",
      size: 160,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {getScheduleLabel(row.original.refresh_config) ?? "—"}
        </Typography>
      ),
    },
    {
      accessorKey: "synchronization_status",
      header: "Sync status",
      size: 160,
      cell: ({ row }) => {
        const syncStatus = row.original.synchronization_status;
        if (!syncStatus) {
          return (
            <Typography Component="span" fontSize="fs14" boldness="regular">
              —
            </Typography>
          );
        }
        return <SyncStatusCell status={syncStatus as SynchronizationStatus} />;
      },
    },
    {
      accessorKey: "active_version",
      header: "Revision",
      size: 140,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {row.original.active_version != null ? `Version ${row.original.active_version}` : "—"}
        </Typography>
      ),
    },
    {
      accessorKey: "labels",
      header: "Labels",
      size: 160,
      minSize: 140,
      enableSorting: false,
      cell: ({ row }) => {
        const labels = row.original.labels;
        if (!labels?.length) return <span className="ds-cell-placeholder">—</span>;
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
  ];
}

export { createKBDatasetsColumns };
