import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useNavigate } from "react-router";

import { useAppSelector } from "@/store";
import { evalSelector } from "@/store/selectors/eval.selector";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { useListEvaluationsQuery, useDeleteEvaluationMutation, useTriggerRunMutation } from "@/routes/pages/evaluations/api/eval-api.slice";
import { POLLING_INTERVAL } from "@/consts/api.consts";
import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp";
import type { BaseTableOptions } from "@/ui-lib/base-components/baseTableMcpBxp";
import { toast } from "@/ui-lib/base-components/toast/toast";
import { ConfirmDialog } from "@/components/dialog/confirm-dialog/confirm-dialog";
import {
  createEvalListColumns,
  type EvalListTableRow,
  type ActionMenuItem,
} from "@/components/evaluations/columns/eval-list.columns";
import { evalPaths } from "../evaluations.consts";

import "./eval-list-content.scss";

function EvalListContent(): ReactElement {
  const navigate = useNavigate();

  // Server state via RTK Query — listFilters drives the query args so search /
  // filter state survives route changes (Redux slice, 3-reducer pattern).
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const listFilters = useAppSelector(evalSelector.listFilters);
  const { data, isLoading, isError } = useListEvaluationsQuery(
    { projectId, ...(Object.keys(listFilters).length > 0 ? listFilters : {}) },
    { pollingInterval: POLLING_INTERVAL, skip: !projectId },
  );
  const [deleteEvaluation, { isLoading: isDeleting }] = useDeleteEvaluationMutation();
  const [triggerRun] = useTriggerRunMutation();

  // Local UI state — modal target is component-private (not shared across routes).
  const [deleteTarget, setDeleteTarget] = useState<{ templateId: string; name: string } | null>(null);

  const tableOptions: BaseTableOptions = useMemo(
    () => ({
      enablePagination: true,
      enableColumnSorting: true,
      enableColumnResizing: true,
      enableTableTopBar: true,
      enableRowFilter: true,
      enableRowExpansion: false,
      topBarOptions: {
        rowCountLabel: "Evaluations",
        showSearch: true,
        onPrimaryAction: () => navigate(evalPaths.create),
        primaryActionLabel: "Add",
      },
    }),
    [navigate],
  );

  const handleDelete = useCallback(async (target: { templateId: string; name: string }) => {
    if (!projectId) return;

    try {
      await deleteEvaluation({ projectId, templateId: target.templateId }).unwrap();
      toast.success(`"${target.name}" deleted successfully.`);
    } catch {
      toast.error(`Failed to delete "${target.name}".`);
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteEvaluation, projectId]);

  const getActionMenuItems = useCallback(
    (row: EvalListTableRow): ActionMenuItem<EvalListTableRow>[] => [
      {
        label: "View details",
        onClick: () => navigate(evalPaths.detail(row.templateId)),
      },
      {
        label: "Start manual run",
        onClick: async () => {
          if (!projectId) return;

          try {
            await triggerRun({ projectId, templateId: row.templateId, options: {} }).unwrap();
            toast.success(`Run queued for "${row.evalName}".`);
            navigate(evalPaths.detail(row.templateId));
          } catch {
            toast.error(`Failed to start run for "${row.evalName}".`);
          }
        },
      },
      {
        label: "Edit",
        onClick: () => navigate(evalPaths.edit(row.templateId)),
      },
      {
        label: "Clone",
        onClick: () => navigate(`${evalPaths.create}?cloneFrom=${row.templateId}`),
      },
      {
        label: "Delete",
        onClick: () => setDeleteTarget({ templateId: row.templateId, name: row.evalName }),
      },
    ],
    [navigate, projectId, triggerRun],
  );

  const columns = useMemo(
    () =>
      createEvalListColumns({
        onNavigateDetail: (templateId) => navigate(evalPaths.detail(templateId)),
        actionMenuItems: getActionMenuItems,
      }),
    [navigate, getActionMenuItems],
  );

  const tableData: EvalListTableRow[] = useMemo(
    () => (data?.data ?? []).map((item) => ({ ...item, id: item.templateId })),
    [data],
  );

  return (
    <>
      <BaseTable<EvalListTableRow>
        options={tableOptions}
        data={tableData}
        columns={columns}
        isLoading={isLoading}
        isError={isError}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete evaluation"
        description={<>Are you sure you want to delete &quot;{deleteTarget?.name}&quot;? This action cannot be undone.</>}
        variant="danger"
        confirmLabel="Delete"
        loading={isDeleting}
        onConfirm={() => handleDelete(deleteTarget!)}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}

export { EvalListContent };
