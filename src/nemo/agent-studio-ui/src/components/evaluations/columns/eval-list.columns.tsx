import type React from "react";
import type { ColumnDef, Column } from "@tanstack/react-table";

import type { EvalListItem } from "@/routes/pages/evaluations/api/eval.types";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { ChipList } from "@/ui-lib/base-components/chip-list/chip-list";
import { buttonVariants } from "@/ui-lib/base-components/button/button.variants";
import { SortIcon } from "@/ui-lib/base-components/baseTableMcpBxp/sortIcon";
import { ActionsCell } from "@/components/data-source/columns/cells/actions-cell";
import type { ActionMenuItem } from "@/components/data-source/columns/cells/actions-cell";
import { displayEvalActor } from "@/components/evaluations/eval-actor-display";
import { EvalStatusCell } from "./cells/eval-status-cell";

type SortableColumn = Pick<Column<EvalListTableRow>, "getIsSorted" | "getCanSort" | "toggleSorting" | "clearSorting">;

function renderSortableHeader(label: string, column: SortableColumn): React.ReactElement | string {
  const current = column.getIsSorted();
  if (!column.getCanSort()) return label;
  return (
    <button
      type="button"
      className={buttonVariants({ variant: "flat" })}
      onClick={() => {
        if (current === "asc") column.toggleSorting(true);
        else if (current === "desc") column.clearSorting();
        else column.toggleSorting(false);
      }}
    >
      {label}
      <SortIcon direction={current} />
    </button>
  );
}

export type EvalListTableRow = EvalListItem & {
  id: string;
};

export type EvalColumnsCallbacks = {
  onNavigateDetail: (templateId: string) => void;
  actionMenuItems: ActionMenuItem<EvalListTableRow>[] | ((row: EvalListTableRow) => ActionMenuItem<EvalListTableRow>[]);
};

function createEvalListColumns(callbacks: EvalColumnsCallbacks): ColumnDef<EvalListTableRow>[] {
  return [
    {
      accessorKey: "evalName",
      header: ({ column }) => renderSortableHeader("Name", column),
      size: 280,
      minSize: 200,
      cell: ({ row }) => (
        <button
          type="button"
          className="eval-list-name-link"
          onClick={() => callbacks.onNavigateDetail(row.original.templateId)}
        >
          <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-button-primary)">
            {row.original.evalName}
          </Typography>
        </button>
      ),
    },
    {
      accessorKey: "latestRunStatus",
      header: ({ column }) => renderSortableHeader("Latest run status", column),
      size: 160,
      minSize: 130,
      cell: ({ row }) => <EvalStatusCell status={row.original.latestRunStatus ?? undefined} />,
    },
    {
      accessorKey: "runCount",
      header: ({ column }) => renderSortableHeader("Evaluation runs", column),
      size: 140,
      minSize: 110,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-button-primary)">
          {row.original.runCount}
        </Typography>
      ),
    },
    {
      accessorKey: "updatedAt",
      header: ({ column }) => renderSortableHeader("Last time updated", column),
      size: 200,
      minSize: 160,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
          {row.original.updatedAt}
        </Typography>
      ),
    },
    {
      accessorKey: "owner",
      header: ({ column }) => renderSortableHeader("Owner", column),
      size: 160,
      minSize: 120,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
          {displayEvalActor(row.original.owner)}
        </Typography>
      ),
    },
    {
      accessorKey: "lastModifiedBy",
      header: ({ column }) => renderSortableHeader("Last modified by", column),
      size: 160,
      minSize: 120,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
          {displayEvalActor(row.original.lastModifiedBy)}
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
        const labels = row.original.labels ?? [];
        if (!labels.length) return <span className="eval-list-cell-placeholder">—</span>;
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
            name={row.original.evalName}
            menuItems={items}
          />
        );
      },
    },
  ];
}

export { createEvalListColumns };
export type { ActionMenuItem };
