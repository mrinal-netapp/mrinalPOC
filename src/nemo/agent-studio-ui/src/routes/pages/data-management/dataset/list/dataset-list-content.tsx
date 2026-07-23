import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useNavigate } from "react-router";

import { useAppSelector } from "@/store";
import { datasetSelector } from "@/store/selectors/dataset.selector";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import {
  useListDatasetsQuery,
  useDeleteDatasetMutation,
} from "@/api/dataset-api.slice";
import { POLLING_INTERVAL } from "@/consts/api.consts";
import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp";
import type { BaseTableOptions } from "@/ui-lib/base-components/baseTableMcpBxp";
import { toast } from "@/ui-lib/base-components/toast/toast";
import { ConfirmDialog } from "@/components/dialog/confirm-dialog/confirm-dialog";
import { showDatasetDeleteErrorToast } from "@/utils/delete-dependents.utils";
import {
  createDatasetListColumns,
  type DatasetTableRow,
  type ActionMenuItem,
} from "@/components/dataset/columns/dataset-list.columns";
import { dataManagementPaths } from "../../data-management.consts";

function DatasetListContent(): ReactElement {
  const navigate = useNavigate();

  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const listFilters = useAppSelector(datasetSelector.listFilters);
  const { data, isLoading, isError } = useListDatasetsQuery(
    { projectId, ...listFilters },
    { pollingInterval: POLLING_INTERVAL, skip: !projectId },
  );
  const [deleteDataset, { isLoading: isDeleting }] = useDeleteDatasetMutation();

  const [deleteTarget, setDeleteTarget] = useState<{ dsetId: string; dsrcId?: string; name: string } | null>(null);

  const tableOptions: BaseTableOptions = useMemo(() => ({
    enablePagination: true,
    enableColumnSorting: true,
    enableColumnResizing: true,
    enableTableTopBar: true,
    enableRowFilter: true,
    topBarOptions: {
      rowCountLabel: "Datasets",
      showSearch: true,
      onPrimaryAction: () => navigate(dataManagementPaths.datasetCreate),
      primaryActionLabel: "Add",
    },
  }), [navigate]);

  const handleDelete = useCallback(async () => {
    /* v8 ignore start */
    if (!deleteTarget) return;
    /* v8 ignore stop */
    try {
      await deleteDataset({ projectId, dsetId: deleteTarget.dsetId, dsrcId: deleteTarget.dsrcId }).unwrap();
      toast.success(`"${deleteTarget.name}" deleted successfully.`);
    } catch (err) {
      showDatasetDeleteErrorToast(err, deleteTarget.name);
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, deleteDataset, projectId]);

  const getActionMenuItems = useCallback(
    (): ActionMenuItem<DatasetTableRow>[] => {
      return [
        {
          label: "View details",
          onClick: (r) => navigate(dataManagementPaths.datasetDetail(r.dset_id)),
        },
        {
          label: "Edit",
          onClick: (r) => navigate(dataManagementPaths.datasetEdit(r.dset_id)),
        },
        {
          label: "Delete",
          onClick: (r) => setDeleteTarget({ dsetId: r.dset_id, dsrcId: r.data_source?.dsrc_id, name: r.name }),
        },
      ];
    },
    [navigate],
  );

  const columns = useMemo(
    () =>
      createDatasetListColumns({
        onNavigateDetail: (dsetId) => navigate(dataManagementPaths.datasetDetail(dsetId)),
        onNavigateDataSource: (dsrcId) => navigate(dataManagementPaths.dataSourceDetail(dsrcId)),
        actionMenuItems: getActionMenuItems,
      }),
    [navigate, getActionMenuItems],
  );

  const tableData: DatasetTableRow[] = useMemo(
    () =>
      /* v8 ignore start */
      (data?.data ?? []).map((item) => ({ ...item, id: item.dset_id })),
    /* v8 ignore stop */
    [data],
  );

  return (
    <>
      <BaseTable<DatasetTableRow>
        options={tableOptions}
        data={tableData}
        columns={columns}
        isLoading={isLoading}
        isError={isError}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete dataset"
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

export { DatasetListContent };
