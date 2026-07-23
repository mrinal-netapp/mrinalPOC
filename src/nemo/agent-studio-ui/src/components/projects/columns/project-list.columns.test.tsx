import { screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";

import { renderWithProviders } from "@test/render";
import { mockResizeObserver } from "@test/mocks";
import type { AccessibleProject } from "@/routes/pages/projects/hooks/use-accessible-projects";
import {
  createProjectListColumns,
  mapProjectsToTableRows,
  type ProjectListTableRow,
} from "./project-list.columns";

const PROJECT: AccessibleProject = {
  id: "proj-alpha",
  name: "Alpha Project",
  created_at: "2026-05-25T14:32:10.123Z",
  updated_at: "2026-05-25T14:32:10.123Z",
  metadata: { description: "Team workspace" },
  home_dir: "s3://default-nemo/projects/proj-alpha",
  membershipRole: "admin",
  roleLabel: "Admin",
  isAdmin: true,
};

function TableWrapper({
  row,
  callbacks,
}: {
  row: ProjectListTableRow;
  callbacks: Parameters<typeof createProjectListColumns>[0];
}) {
  const columns = createProjectListColumns(callbacks);
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

describe("project-list.columns", () => {
  let resizeObserver: ReturnType<typeof mockResizeObserver>;

  beforeEach(() => {
    resizeObserver = mockResizeObserver();
  });

  afterEach(() => {
    resizeObserver.cleanup();
  });

  it("[tag:project-list-columns] maps accessible projects to table rows", () => {
    const rows = mapProjectsToTableRows([PROJECT]);
    expect(rows[0]).toMatchObject({
      id: "proj-alpha",
      name: "Alpha Project",
      description: "Team workspace",
      role: "Admin",
    });
  });

  it("[tag:project-list-columns] renders description fallback and disables actions for non-admins", () => {
    const onEdit = vi.fn();
    const row = mapProjectsToTableRows([{ ...PROJECT, metadata: {}, roleLabel: "Member" }])[0]!;

    renderWithProviders(
      <TableWrapper
        row={row}
        callbacks={{
          actionMenuItems: [{ label: "Edit", onClick: onEdit }],
          isProjectAdmin: () => false,
        }}
      />,
    );

    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Actions for Alpha Project/ })).toBeDisabled();
  });

  it("[tag:project-list-columns] invokes dynamic action menu items", () => {
    const onEdit = vi.fn();
    const row = mapProjectsToTableRows([PROJECT])[0]!;

    renderWithProviders(
      <TableWrapper
        row={row}
        callbacks={{
          actionMenuItems: (currentRow) => [{ label: "Edit", onClick: () => onEdit(currentRow.id) }],
          isProjectAdmin: () => true,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Actions for Alpha Project/ }));
    fireEvent.click(screen.getByText("Edit"));
    expect(onEdit).toHaveBeenCalledWith("proj-alpha");
  });

  it("[tag:project-list-columns] uses static action menu items when admin by default", () => {
    const onEdit = vi.fn();
    const row = mapProjectsToTableRows([PROJECT])[0]!;

    renderWithProviders(
      <TableWrapper
        row={row}
        callbacks={{
          actionMenuItems: [{ label: "Edit", onClick: onEdit }],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Actions for Alpha Project/ }));
    fireEvent.click(screen.getByText("Edit"));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("[tag:project-list-columns] name cell renders a link that calls onSelectProject", () => {
    // Clicking the project name is how the user makes that project the
    // active one from the list — ProjectsListContent wires this to switch
    // the project and navigate to the Agent Studio overview.
    const onSelect = vi.fn();
    const row = mapProjectsToTableRows([PROJECT])[0]!;

    renderWithProviders(
      <TableWrapper
        row={row}
        callbacks={{
          actionMenuItems: [],
          onSelectProject: onSelect,
          activeProjectId: "proj-other",
        }}
      />,
    );

    const link = screen.getByRole("button", { name: /Switch to Alpha Project/ });
    expect(link).not.toBeDisabled();
    fireEvent.click(link);
    expect(onSelect).toHaveBeenCalledWith("proj-alpha");
  });

  it("[tag:project-list-columns] name cell is disabled and marked aria-current for the active project", () => {
    // Re-clicking the row for the already-active project is a no-op,
    // so render it as a disabled link with aria-current so screen
    // readers announce it as the current project.
    const onSelect = vi.fn();
    const row = mapProjectsToTableRows([PROJECT])[0]!;

    renderWithProviders(
      <TableWrapper
        row={row}
        callbacks={{
          actionMenuItems: [],
          onSelectProject: onSelect,
          activeProjectId: "proj-alpha",
        }}
      />,
    );

    const link = screen.getByRole("button", { name: /Alpha Project \(active project\)/ });
    expect(link).toBeDisabled();
    expect(link).toHaveAttribute("aria-current", "true");
    fireEvent.click(link);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("[tag:project-list-columns] name cell falls back to plain text when onSelectProject is not provided", () => {
    // Some callers (e.g. a read-only project chooser dialog) will not
    // wire a switch handler. In that case the name renders as plain
    // Typography with no button/link affordance.
    const row = mapProjectsToTableRows([PROJECT])[0]!;

    renderWithProviders(
      <TableWrapper
        row={row}
        callbacks={{
          actionMenuItems: [],
        }}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /Switch to Alpha Project/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Alpha Project")).toBeInTheDocument();
  });
});
