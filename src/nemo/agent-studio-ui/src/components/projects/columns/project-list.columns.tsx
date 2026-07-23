import type { ColumnDef } from "@tanstack/react-table";

import type { Project } from "@/api/project.types";
import { getProjectDescription } from "@/api/project.types";
import type { AccessibleProject } from "@/routes/pages/projects/hooks/use-accessible-projects";
import { ProjectIcon } from "@/components/projects/project-icon/project-icon";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import {
  ActionsCell,
  type ActionMenuItem,
} from "@/components/data-source/columns/cells/actions-cell";
import "./project-list.columns.scss";

/**
 * Row shape consumed by the projects table. `role` here is the display
 * label ("Admin" / "Member" / "—"), distinct from `Project.role` (the
 * enum). `Omit<Project, "role">` keeps the rest of the project fields
 * available without the inherited enum type fighting the display string.
 */
export interface ProjectListTableRow extends Omit<Project, "role"> {
  id: string;
  description: string;
  role: string;
}

export interface ProjectListColumnsCallbacks {
  actionMenuItems:
    | ActionMenuItem<ProjectListTableRow>[]
    | ((row: ProjectListTableRow) => ActionMenuItem<ProjectListTableRow>[]);
  isProjectAdmin?: (row: ProjectListTableRow) => boolean;
  /**
   * Called when the user clicks a project name in the list. Wired at the
   * page level to switch the active project and navigate to the Agent
   * Studio overview — same project switch as the header switcher, with a
   * redirect off the management screen so the user lands in the new
   * project's workspace.
   */
  onSelectProject?: (projectId: string) => void;
  /** Id of the project currently active; that row's link is rendered
   * as disabled since re-clicking it is a no-op. */
  activeProjectId?: string;
}

function createProjectListColumns(
  callbacks: ProjectListColumnsCallbacks,
): ColumnDef<ProjectListTableRow>[] {
  return [
    {
      accessorKey: "name",
      header: "Projects",
      size: 240,
      minSize: 180,
      cell: ({ row }) => {
        const isActive = callbacks.activeProjectId === row.original.id;
        const onSelect = callbacks.onSelectProject;
        const nameEl = (
          <Typography
            Component="span"
            fontSize="fs14"
            boldness="semibold"
            color={
              onSelect && !isActive ? "var(--text-button-primary)" : undefined
            }
          >
            {row.original.name}
          </Typography>
        );

        return (
          <div className="project-list-name-cell">
            <ProjectIcon />
            {onSelect ? (
              <button
                type="button"
                className="project-list-name-link"
                onClick={() => onSelect(row.original.id)}
                disabled={isActive}
                aria-label={
                  isActive
                    ? `${row.original.name} (active project)`
                    : `Switch to ${row.original.name}`
                }
                aria-current={isActive ? "true" : undefined}
              >
                {nameEl}
              </button>
            ) : (
              nameEl
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "description",
      header: "Description",
      size: 320,
      minSize: 200,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14">
          {row.original.description || "—"}
        </Typography>
      ),
    },
    {
      accessorKey: "role",
      header: "Role",
      size: 140,
      minSize: 100,
      cell: ({ row }) => (
        <Typography Component="span" fontSize="fs14">
          {row.original.role}
        </Typography>
      ),
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
        const canManage = callbacks.isProjectAdmin?.(row.original) ?? true;

        return (
          <ActionsCell
            row={row.original}
            name={row.original.name}
            menuItems={items}
            isDisabled={!canManage}
          />
        );
      },
    },
  ];
}

export function mapProjectsToTableRows(
  projects: Array<Project | AccessibleProject>,
): ProjectListTableRow[] {
  return projects.map((project) => ({
    ...project,
    id: project.id,
    description: getProjectDescription(project.metadata),
    role: "roleLabel" in project ? project.roleLabel : "—",
  }));
}

export { createProjectListColumns };
