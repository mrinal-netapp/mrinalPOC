import type { ColumnDef } from "@tanstack/react-table";

import type { DatasetSnapshot } from "@/api/dataset.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { formatDateTimeFull, formatNumber } from "@/components/data-source/utils/data-source.utils";
import { SnapshotDisplayStatusCell } from "@/components/dataset/columns/cells/status-cell";
import { ChangesCell } from "@/components/columns/cells/changes-cell";
import { ActionsCell } from "@/components/data-source/columns/cells/actions-cell";
import type { ActionMenuItem } from "@/components/data-source/columns/cells/actions-cell";

// -- Row type adaptor --

export interface SnapshotTableRow extends DatasetSnapshot {
  id: string;
}

// -- Column factory --

interface SnapshotColumnsCallbacks {
  onRollback: (row: SnapshotTableRow) => void;
  onRemove: (row: SnapshotTableRow) => void;
  onRestore: (row: SnapshotTableRow) => void;
}

function createSnapshotColumns(
  { onRollback, onRemove, onRestore }: SnapshotColumnsCallbacks,
): ColumnDef<SnapshotTableRow>[] {
  return [
    {
      accessorKey: "version",
      header: "Name",
      size: 140,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {row.original.version != null ? `Version ${row.original.version}` : "—"}
        </Typography>
      ),
    },
    {
      accessorKey: "created_at",
      header: "Created",
      size: 200,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {formatDateTimeFull(row.original.created_at)}
        </Typography>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      size: 140,
      cell: ({ row }) => (
        <SnapshotDisplayStatusCell
          expired={row.original.expired}
          isCurrent={row.original.is_current}
          status={row.original.status}
        />
      ),
    },
    {
      accessorKey: "files_synced",
      header: "Files synced",
      size: 120,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {formatNumber(row.original.files_synced)}
        </Typography>
      ),
    },
    {
      id: "changes",
      header: "Changes",
      size: 160,
      enableSorting: false,
      cell: ({ row }) => (
        <ChangesCell added={row.original.files_added} removed={row.original.files_removed} />
      ),
    },
    {
      id: "actions",
      header: "",
      size: 56,
      enableSorting: false,
      enableResizing: false,
      cell: ({ row }) => {
        const { expired, is_current } = row.original;
        const menuItems: ActionMenuItem<SnapshotTableRow>[] = [
          { label: "Rollback", onClick: onRollback, isDisabled: is_current || expired },
          { label: "View changes", onClick: () => { }, isDisabled: true },
          expired
            ? { label: "Restore", onClick: onRestore }
            : { label: "Remove", onClick: onRemove, isDisabled: is_current },
        ];

        const name = row.original.version != null ? `Version ${row.original.version}` : "snapshot";

        return (
          <ActionsCell<SnapshotTableRow>
            row={row.original}
            name={name}
            menuItems={menuItems}
          />
        );
      },
    },
  ];
}

export { createSnapshotColumns };
export type { SnapshotColumnsCallbacks };
