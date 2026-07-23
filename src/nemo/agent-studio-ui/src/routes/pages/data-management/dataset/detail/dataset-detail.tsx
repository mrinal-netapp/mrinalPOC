import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useParams, useNavigate } from "react-router";
import { IconRefresh, IconChevronDown } from "@tabler/icons-react";

import { useGetDatasetQuery, useListDatasetKnowledgeBasesQuery, useTriggerDatasetSyncMutation, useUpdateDatasetMutation, useDeleteDatasetMutation } from "@/api/dataset-api.slice";
import { apiSlice } from "@/api/api.slice";
import type { DatasetRefreshConfig } from "@/api/dataset.types";
import { POLLING_INTERVAL, IMPORT_POLLING_INTERVAL } from "@/consts/api.consts";
import { useAppDispatch, useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { Breadcrumb } from "@/ui-lib/base-components/breadcrumb/breadcrumb";
import type { BreadcrumbItem } from "@/ui-lib/base-components/breadcrumb/breadcrumb";
import { Button } from "@/ui-lib/base-components/button/button";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardBlock, CardBlockLabel, CardBlockValue } from "@/ui-lib/base-components/card/card.block";
import { CardContentLayout } from "@/ui-lib/base-components/card/card.content-layout";
import { TabGroup, TabContent } from "@/ui-lib/base-components/tab/tab-group";
import type { TabItem } from "@/ui-lib/base-components/tab/tab";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu";
import { ConfirmDialog } from "@/components/dialog/confirm-dialog/confirm-dialog";
import { toast } from "@/ui-lib/base-components/toast/toast";
import { showDatasetDeleteErrorToast } from "@/utils/delete-dependents.utils";
import { formatDateTimeFull } from "@/components/data-source/utils/data-source.utils";
import { DatasetStatusCell, SyncStatusCell } from "@/components/dataset/columns/cells/status-cell";
import { isSyncMetricsApplicable } from "@/components/dataset/utils/dataset.utils";
import { dataManagementPaths } from "../../data-management.consts";
import { DatasetDetailOverview } from "./dataset-detail-overview";
import { DatasetDetailDataPreview } from "./dataset-detail-data-preview";
import { DatasetDetailSync } from "./dataset-detail-sync";
import { DatasetDetailKB } from "./dataset-detail-kb";
import { SyncSettingsDialog } from "../create-edit/sync-settings-dialog";
import "./dataset-detail.scss";

// -- Component --

function DatasetDetail(): ReactElement {
  const { dsetId } = useParams<{ dsetId: string }>();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const [importPoll, setImportPoll] = useState(false);
  const { data, isLoading, isError } = useGetDatasetQuery(
    { projectId, dsetId: dsetId ?? "" },
    { skip: !dsetId || !projectId, pollingInterval: importPoll ? IMPORT_POLLING_INTERVAL : POLLING_INTERVAL },
  );

  // Keep `importPoll` in sync with the dataset's import state as it changes,
  // without a "sync state to a prop" effect — this is the React-recommended
  // render-phase update pattern (see "Storing information from previous
  // renders" in the useState docs), guarded so it only fires on an actual
  // change rather than every render.
  const importSignal = `${data?.lifecycle_status ?? ""}:${data?.status ?? ""}`;
  const [prevImportSignal, setPrevImportSignal] = useState(importSignal);
  if (importSignal !== prevImportSignal) {
    setPrevImportSignal(importSignal);
    setImportPoll(data?.lifecycle_status === "in_progress" || data?.status === "Importing");
  }

  const { data: kbData } = useListDatasetKnowledgeBasesQuery(
    { projectId, dsetId: dsetId ?? "" },
    { skip: !dsetId || !projectId, pollingInterval: POLLING_INTERVAL },
  );

  const [triggerSync, { isLoading: isSyncing }] = useTriggerDatasetSyncMutation();
  const [updateDataset, { isLoading: isSavingSync }] = useUpdateDatasetMutation();
  const [deleteDataset, { isLoading: isDeleting }] = useDeleteDatasetMutation();

  const [activeTab, setActiveTab] = useState("overview");
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // -- Breadcrumbs --

  const breadcrumbItems: BreadcrumbItem[] = useMemo(() => [
    { label: "Datasets", href: dataManagementPaths.datasets },
    { label: data?.name ?? "...", href: "" },
  ], [data?.name]);

  // -- Dynamic tabs --

  const detailTabs: TabItem[] = useMemo(() => {
    const syncEnabled = data?.refresh_config?.auto_refresh_enabled === true;
    const kbCount = kbData?.knowledge_bases?.length ?? 0;
    return [
      { id: "overview", label: "Overview" },
      { id: "data-preview", label: "Data preview" },
      { id: "sync", label: `Sync schedule (${syncEnabled ? "Enabled" : "Disabled"})` },
      { id: "assigned-kb", label: `Assigned knowledge bases (${kbCount})` },
      // No Activity panel is rendered yet — keep disabled until implemented to
      // avoid showing an empty tab panel.
      { id: "activity", label: "Activity", isDisabled: true },
    ];
  }, [data?.refresh_config?.auto_refresh_enabled, kbData?.knowledge_bases?.length]);

  // -- Actions --

  // The header refresh icon must reflect everything visible on the page, not
  // just the top-level dataset record: the Sync tab's snapshots list and the
  // Assigned knowledge bases tab are separate RTK Query subscriptions with
  // their own cache entries, so a plain `refetch()` on `getDataset` alone
  // leaves them stale until the page is fully reloaded. Invalidate every tag
  // scoped to this dataset (plus its assigned data source, if any) so all
  // active subscribers — mounted or not — pick up fresh data immediately or
  // on next mount.
  const dataSourceId = data?.data_source?.dsrc_id;
  const handleRefresh = useCallback(() => {
    if (!dsetId) return;
    dispatch(
      apiSlice.util.invalidateTags([
        { type: "DatasetDetail", id: dsetId },
        { type: "DatasetSnapshots", id: dsetId },
        { type: "DatasetManifests", id: dsetId },
        { type: "DatasetKBs", id: dsetId },
        ...(dataSourceId
          ? [{ type: "DataSourceDetail" as const, id: dataSourceId }]
          : []),
      ]),
    );
  }, [dispatch, dsetId, dataSourceId]);

  const handleSync = useCallback(async () => {
    if (!data) return;
    try {
      await triggerSync({ projectId, dsetId: data.dset_id }).unwrap();
      toast.success("Synchronization started successfully.");
    } catch {
      toast.error("Failed to start synchronization.");
    }
  }, [triggerSync, data, projectId]);

  const handleSyncSettingsSave = useCallback(async (refreshConfig: DatasetRefreshConfig) => {
    if (!data) return;
    try {
      await updateDataset({ projectId, dsetId: data.dset_id, body: { refresh_config: refreshConfig } }).unwrap();
      toast.success("Sync settings updated successfully.");
      setSyncDialogOpen(false);
    } catch {
      toast.error("Failed to update sync settings.");
    }
  }, [updateDataset, data, projectId]);

  const handleDelete = useCallback(async () => {
    if (!data) return;
    try {
      await deleteDataset({ projectId, dsetId: data.dset_id, dsrcId: data.data_source?.dsrc_id }).unwrap();
      toast.success("Dataset deleted successfully.");
      navigate(dataManagementPaths.datasets);
    } catch (err) {
      showDatasetDeleteErrorToast(err);
    }
  }, [deleteDataset, data, navigate, projectId]);

  // -- Loading state --

  if (isLoading) {
    return (
      <div className="dset-detail__loading">
        <Spinner size="fitContent" />
      </div>
    );
  }

  // -- Error / not found --

  if (isError || !data) {
    return (
      <div className="dset-detail__error">
        <Typography Component="p" fontSize="fs16" boldness="semibold" color="var(--notification-error)">
          Failed to load dataset.
        </Typography>
        <Button
          variant="outline"
          size="medium"
          label="Back to datasets"
          onClick={() => navigate(dataManagementPaths.datasets)}
        />
      </div>
    );
  }

  const isSynchronizing = data.synchronization_status === "Synchronizing";
  // Manual (upload) datasets can't be synced from a source — hide sync actions.
  const isManual = data.input_type === "upload";

  return (
    <div className="dset-detail">
      {/* Header: breadcrumbs + title row */}
      <div className="dset-detail__header">
        <Breadcrumb items={breadcrumbItems} />

        <div className="dset-detail__title-row">
          <Typography Component="h1" fontSize="fs20" boldness="semibold" className="dset-detail__title">
            Dataset details
          </Typography>
          <div className="dset-detail__title-actions">
            <Button
              variant="icon"
              icon={<IconRefresh size={18} />}
              onClick={handleRefresh}
              aria-label="Refresh dataset"
            />
            <Button
              variant="outline"
              size="medium"
              label="Edit"
              onClick={() => navigate(dataManagementPaths.datasetEdit(data.dset_id))}
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="solid"
                    size="medium"
                    label="Actions"
                    icon={<IconChevronDown size={16} />}
                    iconPosition="right"
                    aria-label="Dataset actions"
                  />
                }
              />
              <DropdownMenuContent side="bottom" align="end">
                {!isManual && (
                  <>
                    <DropdownMenuItem disabled={isSynchronizing || isSyncing} onClick={handleSync}>
                      <Typography Component="span" fontSize="fs14" boldness="regular">
                        Sync now
                      </Typography>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setSyncDialogOpen(true)}>
                      <Typography Component="span" fontSize="fs14" boldness="regular">
                        Edit sync settings
                      </Typography>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem onClick={() => setDeleteDialogOpen(true)}>
                  <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--notification-error)">
                    Delete dataset
                  </Typography>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {data.status === "Failed" && data.error_message ? (
        <Card className="dset-detail__error-banner">
          <CardContentLayout columns={1}>
            <Typography Component="p" fontSize="fs14" color="var(--notification-error)">
              {data.error_message}
            </Typography>
          </CardContentLayout>
        </Card>
      ) : null}

      {/* Stats card */}
      <Card className="dset-detail__stats-card">
        <CardContentLayout columns={6}>
          <CardBlock type="metric" hasSideSeparator>
            <CardBlockValue>{data.name}</CardBlockValue>
            <CardBlockLabel>Name</CardBlockLabel>
          </CardBlock>

          <CardBlock type="metric" hasSideSeparator>
            <CardBlockValue>
              <DatasetStatusCell status={data.status} errorMessage={data.error_message} />
            </CardBlockValue>
            <CardBlockLabel>Status</CardBlockLabel>
          </CardBlock>

          <CardBlock type="metric" hasSideSeparator>
            <CardBlockValue>
              <SyncStatusCell
                status={data.synchronization_status}
                inputType={data.input_type}
                variant={data.input_type === "upload" ? "import" : "detail"}
                errorMessage={data.error_message}
              />
            </CardBlockValue>
            <CardBlockLabel>{data.input_type === "upload" ? "Import status" : "Refresh status"}</CardBlockLabel>
          </CardBlock>

          <CardBlock type="metric" hasSideSeparator>
            <CardBlockValue>
              {data.latest_snapshot ? `Version ${data.latest_snapshot.version}` : "—"}
            </CardBlockValue>
            <CardBlockLabel>Revision</CardBlockLabel>
          </CardBlock>

          <CardBlock type="metric" hasSideSeparator>
            <CardBlockValue isEllipsis>
              {isSyncMetricsApplicable(data.synchronization_status)
                && data.synchronization_summary?.last_completed_synchronization
                ? formatDateTimeFull(data.synchronization_summary.last_completed_synchronization)
                : "—"}
            </CardBlockValue>
            <CardBlockLabel>Last completed sync</CardBlockLabel>
          </CardBlock>

          <CardBlock type="metric">
            <CardBlockValue>
              {data.data_source?.name || "—"}
            </CardBlockValue>
            <CardBlockLabel>Assigned data source</CardBlockLabel>
          </CardBlock>
        </CardContentLayout>
      </Card>

      {/* Tabs */}
      <div className="dset-detail__tabs">
        <TabGroup
          tabs={detailTabs}
          activeTabId={activeTab}
          variant="general"
          onTabChange={setActiveTab}
          ariaLabel="Dataset detail tabs"
        >
          <TabContent tabId="overview" className="dset-detail__tab-content">
            <DatasetDetailOverview data={data} />
          </TabContent>

          <TabContent tabId="data-preview" className="dset-detail__tab-content">
            <DatasetDetailDataPreview
              dsetId={data.dset_id}
              namespace={data.catalog_namespace}
              catalogTableName={data.catalog_table_name}
              isReady={data.lifecycle_status === "ready"}
              snapshotVersion={data.latest_snapshot?.version}
              snapshotId={data.latest_snapshot?.id}
              datasetUpdatedAt={data.updated_at}
            />
          </TabContent>

          <TabContent tabId="sync" className="dset-detail__tab-content">
            <DatasetDetailSync data={data} />
          </TabContent>

          <TabContent tabId="assigned-kb" className="dset-detail__tab-content">
            <DatasetDetailKB dsetId={data.dset_id} />
          </TabContent>
        </TabGroup>
      </div>

      {/* Sync settings dialog (from header Actions) */}
      <SyncSettingsDialog
        open={syncDialogOpen}
        onClose={() => setSyncDialogOpen(false)}
        isLoading={isSavingSync}
        initialRefreshConfig={data.refresh_config}
        onConfirm={handleSyncSettingsSave}
      />

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={deleteDialogOpen}
        title="Delete dataset?"
        description={`"${data.name}" will be permanently deleted and cannot be recovered.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={handleDelete}
        onCancel={() => setDeleteDialogOpen(false)}
        loading={isDeleting}
      />
    </div>
  );
}

export { DatasetDetail };
