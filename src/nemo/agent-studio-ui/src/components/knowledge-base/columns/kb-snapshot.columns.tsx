import type { ColumnDef } from "@tanstack/react-table";
import { IconCircleMinus } from "@tabler/icons-react";

import type { KBSnapshot, KBSnapshotBuildStatus } from "@/api/kb.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { formatDateTimeFull, formatNumber, type StatusVisualConfig } from "@/components/data-source/utils/data-source.utils";
import { ActionsCell } from "@/components/data-source/columns/cells/actions-cell";
import type { ActionMenuItem } from "@/components/data-source/columns/cells/actions-cell";
import { StatusIcon } from "@/components/data-source/utils/status-icon";
import { KB_SNAPSHOT_STATUS_MAP } from "@/components/knowledge-base/utils/kb.utils";

export interface KBSnapshotTableRow extends KBSnapshot {
  id: string;
}

interface KBSnapshotColumnsCallbacks {
  onRollback: (row: KBSnapshotTableRow) => void;
  onRemove: (row: KBSnapshotTableRow) => void;
  onRestore: (row: KBSnapshotTableRow) => void;
}

interface KBSnapshotResolvedStatus {
  visual: StatusVisualConfig;
  label: string;
}

function getKBSnapshotResolvedStatus(
  status: KBSnapshotBuildStatus,
  expired: boolean,
  isCurrent: boolean,
): KBSnapshotResolvedStatus {
  if (expired) {
    return {
      visual: { type: "icon", Icon: IconCircleMinus, color: "var(--text-disabled)" },
      label: "Removed",
    };
  }

  if (isCurrent) {
    const baseVisual = KB_SNAPSHOT_STATUS_MAP[status] ?? KB_SNAPSHOT_STATUS_MAP.pending;
    return { visual: baseVisual, label: "In use" };
  }

  const visual = KB_SNAPSHOT_STATUS_MAP[status] ?? KB_SNAPSHOT_STATUS_MAP.pending;
  let label: string;
  switch (status) {
    case "pending": label = "Pending"; break;
    case "in-progress": label = "In progress"; break;
    case "completed": label = "Available"; break;
    case "errored": label = "Failed"; break;
    default: label = status;
  }

  return { visual, label };
}

function createKBSnapshotColumns(
  { onRollback, onRemove, onRestore }: KBSnapshotColumnsCallbacks,
): ColumnDef<KBSnapshotTableRow>[] {
  return [
    {
      accessorKey: "version",
      header: "Name",
      size: 120,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {row.original.version != null ? `Version ${row.original.version}` : "—"}
        </Typography>
      ),
    },
    {
      accessorKey: "created_at",
      header: "Created at",
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
      cell: ({ row }) => {
        const { status, expired, is_current } = row.original;
        const { visual, label } = getKBSnapshotResolvedStatus(status, expired, is_current);
        return (
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <StatusIcon visual={visual} />
            <Typography Component="span" fontSize="fs14" boldness="regular">
              {label}
            </Typography>
          </span>
        );
      },
    },
    {
      accessorKey: "documents_indexed",
      header: "Files synced",
      size: 150,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {formatNumber(row.original.documents_indexed)}
        </Typography>
      ),
    },
    {
      id: "changes",
      header: "Changes",
      size: 150,
      enableSorting: false,
      // Wire up added/removed counts when the KB snapshot API provides change data
      cell: () => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          —
        </Typography>
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
        const menuItems: ActionMenuItem<KBSnapshotTableRow>[] = [
          { label: "Rollback", onClick: onRollback, isDisabled: is_current || expired },
          expired
            ? { label: "Restore", onClick: onRestore }
            : { label: "Remove", onClick: onRemove, isDisabled: is_current },
        ];

        const name = row.original.version != null ? `Version ${row.original.version}` : "snapshot";

        return (
          <ActionsCell<KBSnapshotTableRow>
            row={row.original}
            name={name}
            menuItems={menuItems}
          />
        );
      },
    },
  ];
}

export { createKBSnapshotColumns };
export type { KBSnapshotColumnsCallbacks };
