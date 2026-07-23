import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useNavigate } from "react-router";

import { useDeleteProjectMutation } from "@/api/project-api.slice";
import { ProjectDeleteDialog } from "./project-delete-dialog";
import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp";
import type { BaseTableOptions } from "@/ui-lib/base-components/baseTableMcpBxp";
import { toast } from "@/ui-lib/base-components/toast/toast";
import {
  createProjectListColumns,
  mapProjectsToTableRows,
  type ProjectListTableRow,
} from "@/components/projects/columns/project-list.columns";
import { useProject } from "@/contexts/project";
import { ROUTE_PATHS } from "@/routes/routes.consts";
import { useAccessibleProjects } from "../hooks/use-accessible-projects";
import { PROJECT_DELETE_STRINGS } from "../create-edit/project-form.consts";
import { PROJECTS_LIST_STRINGS, projectsPaths } from "../projects.consts";
import { ProjectsEmptyState } from "./projects-empty-state";

function ProjectsListContent(): ReactElement {
  const navigate = useNavigate();
  const { projects, isLoading, isError, isProjectAdmin } = useAccessibleProjects();
  const { activeProject, switchProject } = useProject();
  const [deleteProject, { isLoading: isDeleting }] = useDeleteProjectMutation();
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const handleCreateProject = useCallback(() => {
    navigate(projectsPaths.create);
  }, [navigate]);

  const handleSelectProject = useCallback(
    (projectId: string) => {
      if (!projectId || projectId === activeProject?.id) return;
      switchProject(projectId);
      navigate(ROUTE_PATHS.OVERVIEW);
    },
    [activeProject?.id, navigate, switchProject],
  );

  const tableOptions: BaseTableOptions = useMemo(
    () => ({
      enablePagination: true,
      enableColumnSorting: true,
      enableColumnResizing: true,
      enableTableTopBar: true,
      enableRowFilter: true,
      topBarOptions: {
        rowCountLabel: "Projects",
        showSearch: true,
        primaryActionLabel: PROJECTS_LIST_STRINGS.ADD_PROJECT_LABEL,
        onPrimaryAction: handleCreateProject,
      },
    }),
    [handleCreateProject],
  );

  const getActionMenuItems = useCallback(
    (row: ProjectListTableRow) => [
      {
        label: "Edit",
        onClick: () => navigate(projectsPaths.edit(row.id)),
        isDisabled: !isProjectAdmin(row.id),
      },
      {
        label: "Delete",
        onClick: () => setDeleteTarget({ id: row.id, name: row.name }),
        className: "dropdown-menu-item--destructive",
        isDisabled: !isProjectAdmin(row.id),
      },
    ],
    [isProjectAdmin, navigate],
  );

  const columns = useMemo(
    () => createProjectListColumns({
      actionMenuItems: getActionMenuItems,
      isProjectAdmin: (row) => isProjectAdmin(row.id),
      onSelectProject: handleSelectProject,
      activeProjectId: activeProject?.id,
    }),
    [activeProject?.id, getActionMenuItems, handleSelectProject, isProjectAdmin],
  );

  const tableData = useMemo(
    () => mapProjectsToTableRows(projects),
    [projects],
  );

  const showEmptyState = !isLoading && !isError && tableData.length === 0;

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;

    try {
      await deleteProject(deleteTarget.id).unwrap();
      toast.success(PROJECT_DELETE_STRINGS.SUCCESS(deleteTarget.name));
    } catch {
      toast.error(PROJECT_DELETE_STRINGS.ERROR(deleteTarget.name));
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteProject, deleteTarget]);

  if (showEmptyState) {
    return <ProjectsEmptyState onCreateProject={handleCreateProject} />;
  }

  return (
    <>
      <BaseTable<ProjectListTableRow>
        options={tableOptions}
        data={tableData}
        columns={columns}
        isLoading={isLoading}
        isError={isError}
      />

      <ProjectDeleteDialog
        open={deleteTarget !== null}
        projectName={deleteTarget?.name ?? ""}
        loading={isDeleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}

export { ProjectsListContent };
