import { useState, useCallback, useMemo, type ReactElement } from "react";
import {
  IconRefresh,
  IconDotsCircleHorizontal,
  IconInfoCircle,
} from "@tabler/icons-react";

import type { DatasetDetail, DatasetRefreshConfig } from "@/api/dataset.types";
import {
  useUpdateDatasetMutation,
  useTriggerDatasetSyncMutation,
  useListDatasetSnapshotsQuery,
  useUpdateDatasetSnapshotMutation,
} from "@/api/dataset-api.slice";
import { POLLING_INTERVAL } from "@/consts/api.consts";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { createSnapshotColumns } from "@/components/dataset/columns/dataset-snapshot.columns";
import type { SnapshotTableRow } from "@/components/dataset/columns/dataset-snapshot.columns";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardHeader } from "@/ui-lib/base-components/card/card.header";
import { CardContentLayout } from "@/ui-lib/base-components/card/card.content-layout";
import { CardBlock, CardBlockLabel, CardBlockValue } from "@/ui-lib/base-components/card/card.block";
import { Button } from "@/ui-lib/base-components/button/button";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu";
import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp";
import type { BaseTableOptions } from "@/ui-lib/base-components/baseTableMcpBxp";
import { toast } from "@/ui-lib/base-components/toast/toast";
import { formatDateTimeFull } from "@/components/data-source/utils/data-source.utils";
import { getScheduleLabel, isSyncMetricsApplicable } from "@/components/dataset/utils/dataset.utils";
import { SyncStatusCell } from "@/components/dataset/columns/cells/status-cell";
import { SyncSettingsDialog } from "../create-edit/sync-settings-dialog";
import { UPLOAD_SCHEDULE_DISABLED_MESSAGE } from "../create-edit/form/sync-settings-section";

// -- Props --

interface DatasetDetailSyncProps {
  data: DatasetDetail;
}

// -- Helpers --

// -- Snapshot table --

const SNAPSHOT_TABLE_OPTIONS: BaseTableOptions = {
  enablePagination: false,
  enableColumnSorting: true,
  enableColumnResizing: true,
  enableTableTopBar: true,
  topBarOptions: {
    rowCountLabel: "Snapshots",
    showSearch: false,
  },
};

// -- Component --

function DatasetDetailSync({ data }: DatasetDetailSyncProps): ReactElement {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [updateDataset, { isLoading: isSaving }] = useUpdateDatasetMutation();
  const [triggerSync, { isLoading: isSyncing }] = useTriggerDatasetSyncMutation();
  const [updateSnapshot] = useUpdateDatasetSnapshotMutation();
  const { data: snapshotsData, isLoading: snapshotsLoading, isError: snapshotsError, error: snapshotsErrorObj } =
    useListDatasetSnapshotsQuery(
      { projectId, dsetId: data.dset_id },
      { pollingInterval: POLLING_INTERVAL, skip: !projectId || !data.dset_id },
    );

  const syncSummary = data.synchronization_summary;
  const isSynchronizing = data.synchronization_status === "Synchronizing";
  const showSyncMetrics = isSyncMetricsApplicable(data.synchronization_status);
  // Manual (upload) datasets have no external source to sync from — the acquire
  // workflow requires an originConnector and always fails for them. Keep the
  // sync-trigger / sync-schedule controls visible but greyed-out (disabled) so
  // the affordance stays discoverable while clearly unavailable.
  const isManual = data.input_type === "upload";
  const syncDisabled = isSynchronizing || isManual;
  const manualSyncTooltip = isManual
    ? "Sync is unavailable for manually uploaded datasets."
    : undefined;

  // The snapshots endpoint returns 409 while an import/sync is in flight (and
  // before the catalog table exists). That's an expected transient state, not a
  // real failure, so don't flash a hard error in the grid: show it as loading
  // while synchronizing, and fall back to the empty state otherwise.
  const snapshotsErrorStatus =
    snapshotsErrorObj && typeof snapshotsErrorObj === "object" && "status" in snapshotsErrorObj
      ? (snapshotsErrorObj as { status?: number | string }).status
      : undefined;
  const snapshotsPending = snapshotsError && snapshotsErrorStatus === 409;

  const handleSync = useCallback(async () => {
    try {
      await triggerSync({ projectId, dsetId: data.dset_id }).unwrap();
      toast.success("Synchronization started successfully.");
    } catch {
      toast.error("Failed to start synchronization.");
    }
  }, [triggerSync, projectId, data.dset_id]);

  const handleSyncSettingsSave = useCallback(async (refreshConfig: DatasetRefreshConfig) => {
    try {
      await updateDataset({
        projectId,
        dsetId: data.dset_id,
        body: { refresh_config: refreshConfig },
      }).unwrap();
      toast.success("Synchronization settings updated successfully.");
      setEditDialogOpen(false);
    } catch {
      toast.error("Failed to update synchronization settings.");
    }
  }, [updateDataset, projectId, data.dset_id]);

  const handleRollbackSnapshot = useCallback(async (row: SnapshotTableRow) => {
    try {
      await updateSnapshot({
        projectId,
        dsetId: data.dset_id,
        snapshotId: row.id,
        body: { is_current: true },
      }).unwrap();
      toast.success("Snapshot rolled back successfully.");
    } catch {
      toast.error("Failed to rollback snapshot.");
    }
  }, [updateSnapshot, projectId, data.dset_id]);

  const handleRemoveSnapshot = useCallback(async (row: SnapshotTableRow) => {
    try {
      await updateSnapshot({
        projectId,
        dsetId: data.dset_id,
        snapshotId: row.id,
        body: { deprecated: true },
      }).unwrap();
      toast.success("Snapshot removed successfully.");
    } catch {
      toast.error("Failed to remove snapshot.");
    }
  }, [updateSnapshot, projectId, data.dset_id]);

  const snapshotColumns = useMemo(
    () => createSnapshotColumns({
      onRollback: handleRollbackSnapshot,
      onRemove: handleRemoveSnapshot,
      onRestore: () => toast.error("Snapshot restore is not yet supported."),
    }),
    [handleRollbackSnapshot, handleRemoveSnapshot],
  );

  const snapshotRows: SnapshotTableRow[] = useMemo(
    () => (snapshotsData?.snapshots ?? []).map((s) => ({ ...s, id: s.id })),
    [snapshotsData],
  );

  return (
    <>
      <Card className="dset-sync__card">
        <CardHeader
          icon={<IconRefresh />}
          title="Synchronization"
          hasSeparator
          actions={[
            <Button
              key="sync-btn"
              variant="flat"
              size="medium"
              label="Sync"
              loading={isSyncing}
              isDisabled={syncDisabled}
              title={manualSyncTooltip}
              onClick={handleSync}
            />,
            <DropdownMenu key="sync-menu">
              <DropdownMenuTrigger
                disabled={isManual}
                render={
                  <Button
                    variant="icon"
                    icon={<IconDotsCircleHorizontal size={18} />}
                    aria-label="Synchronization actions"
                    isDisabled={isManual}
                    title={manualSyncTooltip}
                  />
                }
              />
              <DropdownMenuContent side="bottom" align="end">
                <DropdownMenuItem
                  disabled={syncDisabled}
                  onClick={handleSync}
                >
                  <Typography Component="span" fontSize="fs14" boldness="regular">
                    Sync now
                  </Typography>
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={isManual}
                  onClick={() => setEditDialogOpen(true)}
                >
                  <Typography Component="span" fontSize="fs14" boldness="regular">
                    Edit sync settings
                  </Typography>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>,
          ]}
        />

        {isManual && (
          <div className="dset-sync__notice">
            <span className="dset-sync__notice-icon">
              <IconInfoCircle size={16} stroke={1.5} aria-hidden />
            </span>
            <Typography
              Component="p"
              fontSize="fs14"
              boldness="regular"
              className="dset-sync__notice-text"
            >
              {UPLOAD_SCHEDULE_DISABLED_MESSAGE}
            </Typography>
          </div>
        )}

        <CardContentLayout columns={4}>
          <CardBlock type="metric" hasSideSeparator>
            <CardBlockValue className="dset-sync__status-value">
              <SyncStatusCell
                status={data.synchronization_status}
                inputType={data.input_type}
                variant="sync"
                boldness="semibold"
                errorMessage={data.error_message}
              />
            </CardBlockValue>
            <CardBlockLabel>Sync status</CardBlockLabel>
          </CardBlock>

          <CardBlock type="metric" hasSideSeparator>
            <CardBlockValue isEllipsis>
              {showSyncMetrics
                ? (getScheduleLabel(data.refresh_config) ?? syncSummary?.schedule ?? "Manual")
                : "—"}
            </CardBlockValue>
            <CardBlockLabel>Schedule</CardBlockLabel>
          </CardBlock>

          <CardBlock type="metric" hasSideSeparator>
            <CardBlockValue isEllipsis>
              {showSyncMetrics && syncSummary?.last_completed_synchronization
                ? formatDateTimeFull(syncSummary.last_completed_synchronization)
                : "—"}
            </CardBlockValue>
            <CardBlockLabel>Last completed synchronization</CardBlockLabel>
          </CardBlock>

          <CardBlock type="metric">
            <CardBlockValue isEllipsis>
              {showSyncMetrics && syncSummary?.next_scheduled_synchronization
                ? formatDateTimeFull(syncSummary.next_scheduled_synchronization)
                : "—"}
            </CardBlockValue>
            <CardBlockLabel>Next scheduled synchronization</CardBlockLabel>
          </CardBlock>
        </CardContentLayout>
      </Card>

      {/* Snapshot history table */}
      <BaseTable<SnapshotTableRow>
        options={SNAPSHOT_TABLE_OPTIONS}
        data={snapshotRows}
        columns={snapshotColumns}
        isLoading={snapshotsLoading || (snapshotsPending && isSynchronizing)}
        isError={snapshotsError && !snapshotsPending}
      />

      <SyncSettingsDialog
        open={editDialogOpen}
        onClose={() => setEditDialogOpen(false)}
        isLoading={isSaving}
        initialRefreshConfig={data.refresh_config}
        onConfirm={handleSyncSettingsSave}
      />
    </>
  );
}

export { DatasetDetailSync };
export type { DatasetDetailSyncProps };
