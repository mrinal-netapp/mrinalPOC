import { screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";

import { renderWithProviders } from "@test/render";
import { mockResizeObserver } from "@test/mocks";
import type { MemberListTableRow } from "@/routes/pages/administration/administration-members.utils";
import { createMemberListColumns } from "./member-list.columns";

const ROW: MemberListTableRow = {
  id: "al@example.com",
  userId: "al@example.com",
  name: "Al Smith",
  email: "al@example.com",
  role: "admin",
  displayRole: "Admin",
  lastActive: { kind: "never" },
  createdAt: "",
};

function TableWrapper({
  row,
  callbacks,
}: {
  row: MemberListTableRow;
  callbacks: Parameters<typeof createMemberListColumns>[0];
}) {
  const columns = createMemberListColumns(callbacks);
  const table = useReactTable({
    data: [row],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <table>
      <tbody>
        {table.getRowModel().rows.map((tableRow) => (
          <tr key={tableRow.id}>
            {tableRow.getVisibleCells().map((cell) => (
              <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

describe("member-list.columns", () => {
  let resizeObserver: ReturnType<typeof mockResizeObserver>;

  beforeEach(() => {
    resizeObserver = mockResizeObserver();
  });

  afterEach(() => {
    resizeObserver.cleanup();
  });

  it("[tag:member-list-columns] opens edit form from name link", () => {
    const onEditMember = vi.fn();

    renderWithProviders(
      <TableWrapper
        row={ROW}
        callbacks={{
          actionMenuItems: [],
          onEditMember,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Al Smith" }));
    expect(onEditMember).toHaveBeenCalledWith(ROW);
  });

  it("[tag:member-list-columns] disables name link and actions when actions are disabled", () => {
    renderWithProviders(
      <TableWrapper
        row={ROW}
        callbacks={{
          actionMenuItems: [{ label: "Delete", onClick: vi.fn() }],
          isActionsDisabled: true,
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Al Smith" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Actions for Al Smith/ })).toBeDisabled();
  });

  it("[tag:member-list-columns] invokes dynamic action menu items", () => {
    const onDelete = vi.fn();

    renderWithProviders(
      <TableWrapper
        row={ROW}
        callbacks={{
          actionMenuItems: (currentRow) => [{ label: "Delete", onClick: () => onDelete(currentRow.email) }],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Actions for Al Smith/ }));
    fireEvent.click(screen.getByText("Delete"));
    expect(onDelete).toHaveBeenCalledWith("al@example.com");
  });

  it("[tag:member-list-columns] uses static action menu items", () => {
    const onDelete = vi.fn();

    renderWithProviders(
      <TableWrapper
        row={ROW}
        callbacks={{
          actionMenuItems: [{ label: "Delete", onClick: onDelete }],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Actions for Al Smith/ }));
    fireEvent.click(screen.getByText("Delete"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
