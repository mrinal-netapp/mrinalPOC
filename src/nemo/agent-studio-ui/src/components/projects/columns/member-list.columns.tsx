import type { ReactNode } from "react";
import type { ColumnDef } from "@tanstack/react-table";

import {
  ActionsCell,
  type ActionMenuItem,
} from "@/components/data-source/columns/cells/actions-cell";
import type { MemberListTableRow } from "@/routes/pages/administration/administration-members.utils";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import "./member-list.columns.scss";

export interface MemberListColumnsCallbacks {
  actionMenuItems:
    | ActionMenuItem<MemberListTableRow>[]
    | ((row: MemberListTableRow) => ActionMenuItem<MemberListTableRow>[]);
  isActionsDisabled?: boolean;
  onEditMember?: (row: MemberListTableRow) => void;
}

function renderLastActive(): ReactNode {
  return (
    <Typography Component="span" fontSize="fs14">
      -
    </Typography>
  );
}

function createMemberListColumns(
  callbacks: MemberListColumnsCallbacks,
): ColumnDef<MemberListTableRow>[] {
  return [
    {
      accessorKey: "name",
      header: "Name",
      size: 200,
      minSize: 160,
      cell: ({ row }) => (
        <button
          type="button"
          className="member-list-name-link"
          disabled={callbacks.isActionsDisabled}
          onClick={() => callbacks.onEditMember?.(row.original)}
        >
          {row.original.name}
        </button>
      ),
    },
    {
      accessorKey: "email",
      header: "Email address",
      size: 240,
      minSize: 180,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14">
          {row.original.email}
        </Typography>
      ),
    },
    {
      accessorKey: "displayRole",
      header: "Role",
      size: 140,
      minSize: 100,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14">
          {row.original.displayRole}
        </Typography>
      ),
    },
    {
      accessorKey: "lastActive",
      header: "Last active",
      size: 160,
      minSize: 120,
      enableSorting: false,
      cell: () => renderLastActive(),
    },
    {
      id: "actions",
      header: "",
      size: 56,
      minSize: 56,
      enableSorting: false,
      cell: ({ row }) => {
        const items =
          typeof callbacks.actionMenuItems === "function"
            ? callbacks.actionMenuItems(row.original)
            : callbacks.actionMenuItems;

        return (
          <ActionsCell
            row={row.original}
            name={row.original.name}
            isDisabled={callbacks.isActionsDisabled}
            menuItems={items}
          />
        );
      },
    },
  ];
}

export { createMemberListColumns };
