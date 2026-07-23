import type { ColumnDef } from "@tanstack/react-table";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { ActionsCell } from "@/components/data-source/columns/cells/actions-cell";
import type { ActionMenuItem } from "@/components/data-source/columns/cells/actions-cell";
import type { BaseTableOptions, BaseElement } from "@/ui-lib/base-components/baseTableMcpBxp";

export interface PathRow extends BaseElement {
  path: string;
}

export const PATHS_TABLE_OPTIONS: BaseTableOptions = {
  enableColumnSorting: true,
};

export function createPathColumns(onRemove: (row: PathRow) => void): ColumnDef<PathRow>[] {
  return [
    {
      accessorKey: "path",
      header: "Folder paths",
      enableSorting: true,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {row.original.path}
        </Typography>
      ),
    },
    {
      id: "actions",
      header: "",
      size: 20,
      minSize: 20,
      maxSize: 20,
      enableSorting: false,
      enableResizing: false,
      cell: ({ row }) => {
        const items: ActionMenuItem<PathRow>[] = [
          { label: "Remove", onClick: (r) => onRemove(r) },
        ];
        return (
          <ActionsCell row={row.original} name={row.original.path} menuItems={items} />
        );
      },
    },
  ];
}
