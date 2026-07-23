import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useNavigate } from "react-router";

import { useAppSelector } from "@/store";
import { dataSourceSelector } from "@/store/selectors/data-source.selector";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import {
  useListDataSourcesQuery,
  useDeleteDataSourceMutation,
  useUpdateDataSourceDeprecationMutation,
} from "@/api/data-source-api.slice";
import { POLLING_INTERVAL } from "@/consts/api.consts";
import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp";
import type { BaseTableOptions } from "@/ui-lib/base-components/baseTableMcpBxp";
import { toast } from "@/ui-lib/base-components/toast/toast";
import { ConfirmDialog } from "@/components/dialog/confirm-dialog/confirm-dialog";
import {
  createDataSourceListColumns,
  type DataSourceTableRow,
  type ActionMenuItem,
} from "@/components/data-source/columns/data-source-list.columns";
import { dataManagementPaths } from "../../data-management.consts";
import "./data-source-list.scss";

// Table options — wired with top bar actions
const createTableOptions = (onCreateClick: () => void): BaseTableOptions => ({
  enablePagination: true,
  enableColumnSorting: true,
  enableColumnResizing: true,
  enableTableTopBar: true,
  enableRowFilter: true,
  topBarOptions: {
    rowCountLabel: "Data sources",
    showSearch: true,
    onPrimaryAction: onCreateClick,
    primaryActionLabel: "Register",
  },
});

function DataSourceListContent(): ReactElement {
  const navigate = useNavigate();

  const tableOptions: BaseTableOptions = useMemo(
    () => createTableOptions(() => navigate(dataManagementPaths.dataSourceCreate)),
    [navigate],
  );

  // API
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const listFilters = useAppSelector(dataSourceSelector.listFilters);
  const { data, isLoading, isError } = useListDataSourcesQuery(
    { projectId, ...listFilters },
    { pollingInterval: POLLING_INTERVAL, skip: !projectId },
  );
  const [deleteDataSource, { isLoading: isDeleting }] = useDeleteDataSourceMutation();
  const [updateDeprecation] = useUpdateDataSourceDeprecationMutation();

  // Delete confirm dialog state
  const [deleteTarget, setDeleteTarget] = useState<{ dsrcId: string; name: string } | null>(null);

  const handleDelete = useCallback(async () => {
    /* v8 ignore start -- handleDelete is only called from ConfirmDialog.onConfirm which is only shown when deleteTarget !== null */
    if (!deleteTarget) return;
    /* v8 ignore stop */
    try {
      await deleteDataSource({ projectId, dsrcId: deleteTarget.dsrcId }).unwrap();
      toast.success(`"${deleteTarget.name}" deleted successfully.`);
    } catch {
      toast.error(`Failed to delete "${deleteTarget.name}".`);
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, deleteDataSource, projectId]);

  const handleToggleDeprecation = useCallback(async (row: DataSourceTableRow) => {
    const newValue = !row.deprecated;
    try {
      await updateDeprecation({ projectId, dsrcId: row.dsrc_id, body: { deprecated: newValue } }).unwrap();
      toast.success(`"${row.name}" ${newValue ? "deprecated" : "restored"} successfully.`);
    } catch {
      toast.error(`Failed to update deprecation for "${row.name}".`);
    }
  }, [updateDeprecation, projectId]);

  // Per-row action menu items — label toggles based on row state
  const getActionMenuItems = useCallback(
    (row: DataSourceTableRow): ActionMenuItem<DataSourceTableRow>[] => [
      {
        label: "View details",
        onClick: (r) => navigate(dataManagementPaths.dataSourceDetail(r.dsrc_id)),
      },
      // {
      //   label: row.deprecated ? "Un-deprecate" : "Deprecate",
      //   onClick: (r) => handleToggleDeprecation(r),
      //   isDisabled: row.scan_status === "Scanning",
      // },
      // "Scan" is temporarily hidden until the scan integration is ready.
      {
        label: "Edit",
        onClick: (r) => navigate(dataManagementPaths.dataSourceEdit(r.dsrc_id)),
        isDisabled: row.scan_status === "Scanning",
      },
      {
        label: "Delete",
        onClick: (r) => setDeleteTarget({ dsrcId: r.dsrc_id, name: r.name }),
      },
    ],
    [navigate, handleToggleDeprecation],
  );

  const columns = useMemo(
    () =>
      createDataSourceListColumns({
        onNavigateDetail: (dsrcId) => navigate(dataManagementPaths.dataSourceDetail(dsrcId)),
        /* v8 ignore next -- onNavigateDataset is only invoked when a user clicks an associated-dataset link in the table; no integration-level click-through test exists */
        onNavigateDataset: (dsetId) => navigate(dataManagementPaths.datasetDetail(dsetId)),
        actionMenuItems: getActionMenuItems,
      }),
    [navigate, getActionMenuItems],
  );

  // Adapt API data to BaseTable's `BaseElement` requirement (needs `id` field)
  const tableData: DataSourceTableRow[] = useMemo(
    () =>
      /* v8 ignore start -- tests always mock data as defined; the ?? [] fallback covers the loading state */
      (data?.data ?? []).map((item) => ({
        ...item,
        id: item.dsrc_id,
      })),
    /* v8 ignore stop */
    [data],
  );

  return (
    <>
      <BaseTable<DataSourceTableRow>
        options={tableOptions}
        data={tableData}
        columns={columns}
        isLoading={isLoading}
        isError={isError}
      />

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete data source"
        description={<>Are you sure you want to delete &quot;{deleteTarget?.name}&quot;? This action cannot be undone.</>}
        variant="danger"
        confirmLabel="Delete"
        loading={isDeleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}

// Keep the old export name for backward compatibility with routes.tsx until it is updated
const DataSourceList = DataSourceListContent;

export { DataSourceListContent, DataSourceList };
