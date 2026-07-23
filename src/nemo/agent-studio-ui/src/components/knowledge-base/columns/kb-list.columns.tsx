import type { ColumnDef } from "@tanstack/react-table";

import type { KBListItem } from "@/api/kb.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { ChipList } from "@/ui-lib/base-components/chip-list/chip-list";
import { formatDateTimeFull } from "@/components/data-source/utils/data-source.utils";
import { ActionsCell } from "@/components/data-source/columns/cells/actions-cell";
import type { ActionMenuItem } from "@/components/data-source/columns/cells/actions-cell";
import { KBStatusCell } from "@/components/knowledge-base/columns/cells/kb-status-cell";
import { formatKBIndexedData } from "@/components/knowledge-base/utils/kb.utils";

export interface KBListTableRow extends KBListItem {
  id: string;
}

export interface KBColumnsCallbacks {
  onNavigateDetail: (kbId: string) => void;
  actionMenuItems: ActionMenuItem<KBListTableRow>[] | ((row: KBListTableRow) => ActionMenuItem<KBListTableRow>[]);
}

function createKBListColumns(callbacks: KBColumnsCallbacks): ColumnDef<KBListTableRow>[] {
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
            className="kb-list-name-link"
            onClick={() => callbacks.onNavigateDetail(row.original.kb_id)}
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
      size: 160,
      minSize: 130,
      cell: ({ row }) => (
        // Replace with correct status field once the KB list API exposes it
        <KBStatusCell status={row.original.status} deprecated={row.original.deprecated} />
      ),
    },
    {
      id: "job_details",
      header: "Job details",
      size: 140,
      minSize: 120,
      enableSorting: false,
      cell: ({ row }) => {
        const color = row.original.deprecated ? "var(--text-disabled)" : undefined;
        // Display job details once the KB list API exposes the field
        return (
          <Typography Component="span" fontSize="fs14" boldness="regular" color={color}>
            —
          </Typography>
        );
      },
    },
    {
      id: "indexed_data",
      header: "Indexed data",
      size: 150,
      minSize: 120,
      enableSorting: false,
      cell: ({ row }) => {
        const snap = row.original.snapshot;
        const color = row.original.deprecated ? "var(--text-disabled)" : undefined;
        if (!snap) {
          return <span className="kb-list-cell-placeholder">—</span>;
        }
        return (
          <Typography Component="span" fontSize="fs14" boldness="regular" color={color}>
            {formatKBIndexedData(snap.files_indexed, snap.vectors)}
          </Typography>
        );
      },
    },
    {
      id: "current_version",
      header: "Current version",
      size: 130,
      minSize: 110,
      enableSorting: false,
      cell: ({ row }) => {
        const version = row.original.snapshot?.version;
        const color = row.original.deprecated ? "var(--text-disabled)" : undefined;
        return (
          <Typography Component="span" fontSize="fs14" boldness="regular" color={color}>
            {version != null ? `Version ${version}` : "—"}
          </Typography>
        );
      },
    },
    {
      id: "last_sync",
      header: "Last sync",
      size: 180,
      minSize: 140,
      enableSorting: false,
      cell: ({ row }) => {
        const last = row.original.snapshot?.last_sync;
        const color = row.original.deprecated ? "var(--text-disabled)" : undefined;
        if (!last) {
          return <span className="kb-list-cell-placeholder">—</span>;
        }
        return (
          <Typography Component="span" fontSize="fs14" boldness="regular" color={color}>
            {formatDateTimeFull(last)}
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
        if (!labels.length) return <span className="kb-list-cell-placeholder">—</span>;
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


export { createKBListColumns };
export type { ActionMenuItem };
