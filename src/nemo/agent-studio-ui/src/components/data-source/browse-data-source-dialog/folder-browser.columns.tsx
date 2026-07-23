import type { ColumnDef } from "@tanstack/react-table";

import type { BaseElement, BaseTableOptions } from "@/ui-lib/base-components/baseTableMcpBxp";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { formatBytes, formatDateTimeFull } from "@/components/data-source/utils/data-source.utils";

// -- Row type --

export interface FolderBrowserRow extends BaseElement {
  name: string;
  path: string;
  type: string;
  size: number;
  lastModified: number;
}

// -- Column factory --

export function createFolderBrowserColumns(
  onFolderClick: (row: FolderBrowserRow) => void,
): ColumnDef<FolderBrowserRow>[] {
  return [
    {
      accessorKey: "name",
      header: "Name",
      size: 300,
      minSize: 200,
      cell: ({ row }) => {
        const { type, name } = row.original;
        if (type === "directory") {
          return (
            <button
              type="button"
              className="ds-name-link"
              onClick={() => onFolderClick(row.original)}
            >
              <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-button-primary)">
                {name}
              </Typography>
            </button>
          );
        }
        return (
          <Typography Component="span" fontSize="fs14" boldness="regular">
            {name}
          </Typography>
        );
      },
    },
    {
      accessorKey: "type",
      header: "Type",
      size: 100,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {row.original.type === "directory" ? "Folder" : row.original.type.toUpperCase()}
        </Typography>
      ),
    },
    {
      accessorKey: "size",
      header: "Size",
      size: 100,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {formatBytes(row.original.size)}
        </Typography>
      ),
    },
    {
      accessorKey: "lastModified",
      header: "Last modified",
      size: 200,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14" boldness="regular">
          {formatDateTimeFull(new Date(row.original.lastModified).toISOString())}
        </Typography>
      ),
    },
  ];
}

// -- Table options --

export const FOLDER_BROWSER_TABLE_OPTIONS: BaseTableOptions = {
  enableColumnSorting: true,
  enableRowSelection: (row) => "type" in row && row.type === "directory",
  enableRowMultiSelection: true,
};

export const FOLDER_BROWSER_TABLE_OPTIONS_READONLY: BaseTableOptions = {
  enableColumnSorting: true,
};
