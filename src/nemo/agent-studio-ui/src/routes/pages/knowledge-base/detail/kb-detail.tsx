import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useParams, useNavigate } from "react-router";
import { IconChevronDown } from "@tabler/icons-react";

import type { KBDetail as KBDetailData, KBSynchronizationConfig } from "@/api/kb.types";
import {
  useGetKnowledgeBaseQuery,
  useGetKBAssignedDatasetQuery,
  useManualSyncKBMutation,
  useUpdateKnowledgeBaseMutation,
  kbApi,
} from "@/api/kb-api.slice";
import { kbStatusPollingInterval } from "@/components/knowledge-base/utils/kb.utils";
import { useAppSelector } from "@/store";
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
} from "@/ui-lib/base-components/dropdown-menu/dropdown-menu";
import { toast } from "@/ui-lib/base-components/toast/toast";
import { showKBWorkflowOutcomeToast } from "@/components/knowledge-base/utils/kb-workflow-outcome.utils";
import { getKBStatusLabel, getKBStatusVisual } from "@/components/knowledge-base/utils/kb.utils";
import { StatusIcon } from "@/components/data-source/utils/status-icon";
import { SyncStatusCell } from "@/components/dataset/columns/cells/status-cell";
import { kbPaths } from "../knowledge-base.consts";
import { KBDetailOverview } from "./kb-detail-overview";
import { KBDetailPlayground } from "./kb-detail-playground";
import { KBDetailSync } from "./kb-detail-sync";
import { KBDetailDataset } from "./kb-detail-dataset";
import { KBDetailActivity } from "./kb-detail-activity";
import { KBSyncSettingsDialog } from "./kb-sync-settings-dialog";
import "./kb-detail.scss";

// -- Tab definitions --

const DETAIL_TABS: TabItem[] = [
  { id: "overview", label: "Overview" },
  { id: "playground", label: "Playground" },
  { id: "sync", label: "Sync" },
  { id: "dataset", label: "Dataset" },
  { id: "cost", label: "Cost", isDisabled: true },
  { id: "activity", label: "Activity" },
];

// -- Component --

function KBDetail(): ReactElement {
  const { kbId } = useParams<{ kbId: string }>();
  const navigate = useNavigate();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const detailQueryArg = useMemo(
    () => ({ projectId, kbId: kbId ?? "" }),
    [projectId, kbId],
  );
  const cachedDetailSelector = useMemo(
    () => kbApi.endpoints.getKnowledgeBase.select(detailQueryArg),
    [detailQueryArg],
  );
  const cachedDetail = useAppSelector(cachedDetailSelector);
  const { data, isLoading, isError } = useGetKnowledgeBaseQuery(
    detailQueryArg,
    {
      skip: !kbId || !projectId,
      pollingInterval: kbStatusPollingInterval(cachedDetail.data?.status),
      refetchOnMountOrArgChange: true,
    },
  );
  const { data: assignedDataset } = useGetKBAssignedDatasetQuery(
    { projectId, kbId: kbId ?? "" },
    { skip: !kbId || !projectId },
  );
  const [manualSyncKB] = useManualSyncKBMutation();
  const [updateKB, { isLoading: isSavingSync }] = useUpdateKnowledgeBaseMutation();

  const [activeTab, setActiveTab] = useState("overview");
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);

  const handleSyncNow = useCallback(async () => {
    if (!data) return;
    try {
      const result = await manualSyncKB({ projectId, kbId: data.kb_id }).unwrap();
      showKBWorkflowOutcomeToast('sync', result);
    } catch {
      toast.error("Failed to start synchronization.");
    }
  }, [manualSyncKB, projectId, data]);

  const handleSyncSettingsSave = useCallback(async (syncConfig: KBSynchronizationConfig) => {
    if (!data) return;
    try {
      const result = await updateKB({
        projectId,
        kbId: data.kb_id,
        body: { synchronization_config: syncConfig },
      }).unwrap();
      showKBWorkflowOutcomeToast('syncSettings', result);
      setSyncDialogOpen(false);
    } catch {
      toast.error("Failed to update synchronization settings.");
    }
  }, [updateKB, projectId, data]);

  // -- Breadcrumbs --

  // Merge the separately-fetched assigned dataset name into the data object so
  // KBDetailOverview (which reads data.assigned_dataset?.name) shows the correct
  // value even when toKBDetail() leaves assigned_dataset unpopulated.
  const enrichedData = useMemo(
    (): KBDetailData | undefined => {
      if (!data) return undefined;
      return {
        ...data,
        assigned_dataset: assignedDataset?.dataset ?? data.assigned_dataset,
      };
    },
    [data, assignedDataset],
  );

  const breadcrumbItems: BreadcrumbItem[] = useMemo(() => [
    { label: "Knowledge Bases", href: kbPaths.root },
    { label: data?.name ?? "...", href: "" },
  ], [data?.name]);

  // -- Loading state --

  if (isLoading) {
    return (
      <div className="kb-detail__loading">
        <Spinner size="fitContent" />
      </div>
    );
  }

  // -- Error / not found --

  if (isError || !data) {
    return (
      <div className="kb-detail__error">
        <Typography Component="p" fontSize="fs16" boldness="semibold" color="var(--notification-error)">
          Failed to load knowledge base.
        </Typography>
        <Button
          variant="outline"
          size="medium"
          label="Back to Knowledge Bases"
          onClick={() => navigate(kbPaths.root)}
        />
      </div>
    );
  }

  const statusVisual = getKBStatusVisual(data.status);
  const statusLabel = getKBStatusLabel(data.status, data.deprecated);

  return (
    <div className="kb-detail">
      {/* Header: breadcrumbs + title row */}
      <div className="kb-detail__header">
        <Breadcrumb items={breadcrumbItems} />

        <div className="kb-detail__title-row">
          <Typography Component="h1" fontSize="fs20" boldness="semibold" className="kb-detail__title">
            {data.name}
          </Typography>
          <div className="kb-detail__title-actions">
            <Button
              variant="outline"
              size="medium"
              label="Edit"
              onClick={() => navigate(kbPaths.edit(data.kb_id))}
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
                    aria-label="Knowledge base actions"
                  />
                }
              />
              <DropdownMenuContent side="bottom" align="end">
                <DropdownMenuItem onClick={() => void handleSyncNow()}>
                  <Typography Component="span" fontSize="fs14" boldness="regular">
                    Sync now
                  </Typography>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSyncDialogOpen(true)}>
                  <Typography Component="span" fontSize="fs14" boldness="regular">
                    Edit sync settings
                  </Typography>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Top stats card */}
      <Card className="kb-detail__stats-card">
        <CardContentLayout columns={4}>
          <CardBlock type="metric" hasSideSeparator>
            <CardBlockValue isEllipsis>{data.name}</CardBlockValue>
            <CardBlockLabel>Name</CardBlockLabel>
          </CardBlock>

          <CardBlock type="metric" hasSideSeparator>
            <CardBlockValue>
              <span className="kb-detail__status-badge">
                <StatusIcon visual={statusVisual} />
                <Typography Component="span" fontSize="fs14" boldness="semibold">
                  {statusLabel}
                </Typography>
              </span>
            </CardBlockValue>
            <CardBlockLabel>Status</CardBlockLabel>
          </CardBlock>

          <CardBlock type="metric" hasSideSeparator>
            <CardBlockValue>
              {data.synchronization_status
                ? <SyncStatusCell status={data.synchronization_status} boldness="semibold" />
                : "—"
              }
            </CardBlockValue>
            <CardBlockLabel>Sync status</CardBlockLabel>
          </CardBlock>

          <CardBlock type="metric">
            <CardBlockValue isEllipsis>
              {assignedDataset?.dataset?.name ?? "—"}
            </CardBlockValue>
            <CardBlockLabel>Assigned dataset</CardBlockLabel>
          </CardBlock>
        </CardContentLayout>
      </Card>

      {/* Tabs */}
      <div className="kb-detail__tabs">
        <TabGroup
          tabs={DETAIL_TABS}
          activeTabId={activeTab}
          variant="general"
          onTabChange={setActiveTab}
          ariaLabel="Knowledge base detail tabs"
        >
          <TabContent tabId="overview" className="kb-detail__tab-content">
            {/* enrichedData is always defined here — data is verified non-null above */}
            <KBDetailOverview data={enrichedData!} />
          </TabContent>

          <TabContent tabId="playground" keepMounted className="kb-detail__tab-content">
            <KBDetailPlayground kbId={data.kb_id} projectId={projectId} />
          </TabContent>

          <TabContent tabId="sync" className="kb-detail__tab-content">
            <KBDetailSync data={data} />
          </TabContent>

          <TabContent tabId="dataset" className="kb-detail__tab-content">
            <KBDetailDataset kbId={data.kb_id} />
          </TabContent>

          <TabContent tabId="activity" className="kb-detail__tab-content">
            <KBDetailActivity data={data} />
          </TabContent>
        </TabGroup>
      </div>
      <KBSyncSettingsDialog
        open={syncDialogOpen}
        onClose={() => setSyncDialogOpen(false)}
        isLoading={isSavingSync}
        initialSyncConfig={data.synchronization_config}
        onConfirm={handleSyncSettingsSave}
      />
    </div>
  );
}

export { KBDetail };
