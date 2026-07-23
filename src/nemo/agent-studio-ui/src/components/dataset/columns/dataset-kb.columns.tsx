import type { ColumnDef } from "@tanstack/react-table";
import { useNavigate } from "react-router";

import type { DatasetKBListItem } from "@/api/dataset.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { ChipList } from "@/ui-lib/base-components/chip-list/chip-list";
import { formatDateTimeFull } from "@/components/data-source/utils/data-source.utils";
import { kbPaths } from "@/routes/pages/knowledge-base/knowledge-base.consts";

// -- Row type adaptor --

export interface KBTableRow extends DatasetKBListItem {
  id: string;
}

// -- Column factory --

interface CreateKBColumnsOptions {
  onNavigateDetail: (kbId: string) => void;
}

function createKBColumns({ onNavigateDetail }: CreateKBColumnsOptions): ColumnDef<KBTableRow>[] {
  return [
    {
      accessorKey: "name",
      header: "Name",
      size: 220,
      minSize: 180,
      cell: ({ row }) => (
        <button
          type="button"
          className="ds-name-link"
          onClick={() => onNavigateDetail(row.original.kb_id)}
        >
          <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-button-primary)">
            {row.original.name}
          </Typography>
        </button>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      size: 120,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {row.original.status}
        </Typography>
      ),
    },
    {
      accessorKey: "file_scope",
      header: "File scope",
      size: 110,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {row.original.file_scope.toLocaleString("en-US")}
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
            isDisabled={false}
          />
        );
      },
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
  ];
}

function useKBColumns(): ColumnDef<KBTableRow>[] {
  const navigate = useNavigate();
  return createKBColumns({
    onNavigateDetail: (kbId) => navigate(kbPaths.detail(kbId)),
  });
}

export { createKBColumns, useKBColumns };
export type { CreateKBColumnsOptions };
