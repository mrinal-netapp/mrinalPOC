import { useState, useCallback, type ReactElement } from "react";
import {
  IconRadar2,
  IconDotsCircleHorizontal,
} from "@tabler/icons-react";

import type { DataSourceDetail, ScanDepth, ScanStatus } from "@/api/data-source.types";
import { useUpdateDataSourceMutation, useTriggerManualScanMutation } from "@/api/data-source-api.slice";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
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
import { toast } from "@/ui-lib/base-components/toast/toast";
import {
  SCAN_STATUS_ICON_MAP,
  formatDateTimeFull,
  formatNumber,
  formatBytes,
  getScanStatusLabel,
  getScanDepthDisplay,
} from "@/components/data-source/utils/data-source.utils";
import { StatusIcon } from "@/components/data-source/utils/status-icon";
import { ScanningSettingsDialog } from "../scanning-settings-dialog";
import { FolderBrowserDialog } from "@/components/data-source/browse-data-source-dialog";

// -- Props --

interface DataSourceDetailScanningProps {
  data: DataSourceDetail;
}

function ScanStatusIndicator({ status }: { status: ScanStatus }): ReactElement {
  const visual = SCAN_STATUS_ICON_MAP[status];
  const label = getScanStatusLabel(status);

  return (
    <>
      <StatusIcon visual={visual} />
      <Typography Component="span" fontSize="fs14" boldness="semibold">
        {label}
      </Typography>
    </>
  );
}

// -- Component --

function DataSourceDetailScanning({ data }: DataSourceDetailScanningProps): ReactElement {
  const scan = data.scan;
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [viewDataOpen, setViewDataOpen] = useState(false);
  const [updateDataSource, { isLoading: isSaving }] = useUpdateDataSourceMutation();
  const [triggerManualScan, { isLoading: isScanning }] = useTriggerManualScanMutation();

  const handleScan = useCallback(async () => {
    /* v8 ignore start -- Scan button has isDisabled={!scan}; this guard is unreachable from the UI */
    if (!scan) return;
    /* v8 ignore stop */
    try {
      await triggerManualScan({
        projectId,
        dsrcId: data.dsrc_id,
        scanConfig: { scan_depth: scan.scan_depth, custom_depth: scan.custom_depth },
      }).unwrap();
      toast.success("Scan started successfully.");
    } catch {
      toast.error("Failed to start scan.");
    }
  }, [triggerManualScan, projectId, data.dsrc_id, scan]);

  const handleScanSave = useCallback(async (scanDepth: ScanDepth, customDepth: number | null) => {
    try {
      await updateDataSource({
        projectId,
        dsrcId: data.dsrc_id,
        body: {
          scan_config: {
            scan_depth: scanDepth,
            custom_depth: scanDepth === "custom" ? customDepth : null,
          },
        },
      }).unwrap();
      toast.success("Scanning settings updated successfully.");
      setEditDialogOpen(false);
    } catch {
      toast.error("Failed to update scanning settings.");
    }
  }, [updateDataSource, projectId, data.dsrc_id]);

  return (
    <>
      <Card className="ds-scanning__card">
        <CardHeader
          icon={<IconRadar2 />}
          title="Scanning"
          hasSeparator
          actions={[
            <Button
              key="scan-btn"
              variant="flat"
              size="medium"
              label="Scan"
              loading={isScanning}
              isDisabled={data.scan_status === "Scanning" || !scan}
              onClick={handleScan}
            />,
            <DropdownMenu key="scan-menu">
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="icon"
                    icon={<IconDotsCircleHorizontal size={18} />}
                    aria-label="Scanning actions"
                  />
                }
              />
              <DropdownMenuContent side="bottom" align="end">
                <DropdownMenuItem
                  disabled={data.scan_status === "Scanning"}
                  onClick={() => setEditDialogOpen(true)}
                >
                  <Typography Component="span" fontSize="fs14" boldness="regular">
                    Edit scanning settings
                  </Typography>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setViewDataOpen(true)}>
                  <Typography Component="span" fontSize="fs14" boldness="regular">
                    View scanned data
                  </Typography>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>,
          ]}
        />

        <CardContentLayout columns={3}>
          {/* Row 1 */}
          <CardBlock type="metric" hasSideSeparator>
            <CardBlockValue className="ds-scanning__status-value">
              <ScanStatusIndicator status={data.scan_status} />
            </CardBlockValue>
            <CardBlockLabel>Scan status</CardBlockLabel>
          </CardBlock>

          <CardBlock type="metric" hasSideSeparator >
            <CardBlockValue isEllipsis>
              {getScanDepthDisplay(scan?.scan_depth, scan?.custom_depth)}
            </CardBlockValue>
            <CardBlockLabel>Configuration</CardBlockLabel>
          </CardBlock>

          <CardBlock type="metric" >
            <CardBlockValue isEllipsis>
              {scan?.last_completed_at ? formatDateTimeFull(scan.last_completed_at) : "-"}
            </CardBlockValue>
            <CardBlockLabel>Last completed scan</CardBlockLabel>
          </CardBlock>

          {/* Row 2 */}
          <CardBlock type="metric" hasSideSeparator>
            <CardBlockValue>
              {formatNumber(scan?.total_files)}
            </CardBlockValue>
            <CardBlockLabel>Files</CardBlockLabel>
          </CardBlock>

          <CardBlock type="metric" hasSideSeparator>
            <CardBlockValue>
              {formatNumber(scan?.total_folders)}
            </CardBlockValue>
            <CardBlockLabel>Folders</CardBlockLabel>
          </CardBlock>

          <CardBlock type="metric">
            <CardBlockValue>
              {formatBytes(scan?.total_size_bytes)}
            </CardBlockValue>
            <CardBlockLabel>Size</CardBlockLabel>
          </CardBlock>
        </CardContentLayout>
      </Card>

      <ScanningSettingsDialog
        open={editDialogOpen}
        onClose={() => setEditDialogOpen(false)}
        isEdit
        isLoading={isSaving}
        initialScanDepth={scan?.scan_depth ?? "none"}
        initialCustomDepth={scan?.custom_depth ?? null}
        onConfirm={handleScanSave}
      />

      <FolderBrowserDialog
        open={viewDataOpen}
        onClose={() => setViewDataOpen(false)}
        datasourceId={data.dsrc_id}
        isReadOnly
        totalFiles={scan?.total_files}
        lastCompletedAt={scan?.last_completed_at}
      />
    </>
  );
}

export { DataSourceDetailScanning };
export type { DataSourceDetailScanningProps };
