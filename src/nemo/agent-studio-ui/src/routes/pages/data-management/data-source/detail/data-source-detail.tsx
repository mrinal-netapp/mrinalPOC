import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useStore } from "react-redux";
import { useParams, useNavigate } from "react-router";

import {
  useGetDataSourceQuery,
  useRecordConnectionTestResultMutation,
} from "@/api/data-source-api.slice";
import { startConnectorTest, getWorkflowStatus } from "@/api/workflow-api";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { POLLING_INTERVAL } from "@/consts/api.consts";
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
import { toast } from "@/ui-lib/base-components/toast/toast";
import { StatusCell, ConnectionStatusCell } from "@/components/data-source/columns/cells/status-cell";
import { dataManagementPaths } from "../../data-management.consts";
import { DataSourceDetailOverview } from "./data-source-detail-overview";
import { DataSourceDetailDataPreview } from "./data-source-detail-data-preview";
import { DataSourceDetailDatasets } from "./data-source-detail-datasets";
import "./data-source-detail.scss";

// -- Tab definitions --

const DETAIL_TABS: TabItem[] = [
  { id: "overview", label: "Overview" },
  { id: "data-preview", label: "Data preview" },
  { id: "associated-datasets", label: "Associated datasets" },
];

// -- Component --

function DataSourceDetail(): ReactElement {
  const { dsrcId } = useParams<{ dsrcId: string }>();
  const navigate = useNavigate();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const reduxStore = useStore();
  const { data, isLoading, isError } = useGetDataSourceQuery(
    { projectId, dsrcId: dsrcId ?? "" },
    { skip: !dsrcId || !projectId, pollingInterval: POLLING_INTERVAL },
  );
  const [recordConnectionTestResult] = useRecordConnectionTestResultMutation();

  const [activeTab, setActiveTab] = useState("overview");
  const [testing, setTesting] = useState(false);

  // -- Test connection (connectors only) --
  // Runs the connector-test workflow against the saved connector_config +
  // credential, then persists the outcome so the Status bar (and landing page)
  // reflect Success/Failed. Mirrors the access-config dialog's test lifecycle.
  const handleTestConnection = useCallback(async () => {
    if (!data?.connector_config || !data.credential_id) {
      toast.error("This data source has no connector credentials to test.");
      return;
    }
    setTesting(true);

    let success = false;
    let message = "Connection successful.";
    try {
      const { workflowId } = await startConnectorTest(projectId, {
        connectorConfig: data.connector_config as Record<string, unknown>,
        credentialId: data.credential_id,
      }, reduxStore.getState);
      const deadline = Date.now() + 90_000;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        let st;
        try {
          st = await getWorkflowStatus(workflowId, reduxStore.getState);
        } catch (pollErr) {
          if (Date.now() > deadline) throw pollErr instanceof Error ? pollErr : new Error("Connection test failed.");
          continue;
        }
        if (st.isRunning || st.status === "running") {
          if (Date.now() > deadline) {
            success = false;
            message = "The connection test timed out.";
            break;
          }
          continue;
        }
        if (st.status === "completed") {
          success = true;
          message = "Connection successful.";
        } else {
          success = false;
          message = st.failureMessage || "Connection failed.";
        }
        break;
      }
    } catch (err) {
      success = false;
      message = err instanceof Error ? err.message : "Connection test failed.";
    }

    // Persist the outcome (best-effort) so the Status bar refreshes via cache
    // invalidation. A failure here just leaves the previous status unchanged.
    try {
      await recordConnectionTestResult({ projectId, dsrcId: data.dsrc_id, success, message }).unwrap();
    } catch {
      /* non-fatal */
    }

    if (success) {
      toast.success(message);
    } else {
      toast.error(message);
    }
    setTesting(false);
  }, [data, projectId, recordConnectionTestResult, reduxStore]);

  // -- Breadcrumbs --

  const breadcrumbItems: BreadcrumbItem[] = useMemo(() => [
    { label: "Data sources", href: dataManagementPaths.dataSources },
    { label: data?.name ?? "...", href: "" },
  ], [data?.name]);

  // -- Loading state --

  if (isLoading) {
    return (
      <div className="ds-detail__loading">
        <Spinner size="fitContent" />
      </div>
    );
  }

  // -- Error / not found --

  if (isError || !data) {
    return (
      <div className="ds-detail__error">
        <Typography Component="p" fontSize="fs16" boldness="semibold" color="var(--notification-error)">
          Failed to load data source.
        </Typography>
        <Button
          variant="outline"
          size="medium"
          label="Back to data sources"
          onClick={() => navigate(dataManagementPaths.dataSources)}
        />
      </div>
    );
  }

  // Connector sources (Object store / Database / Storage system / API) report
  // their health via the connection test (Untested / Success / Failed), matching
  // the access-config card + landing page. Volume sources use mount health.
  const isConnector = data.connector_config != null || (data.category != null && data.category !== "Volume");

  return (
    <div className="ds-detail">
      {/* Header: breadcrumbs + title row */}
      <div className="ds-detail__header">
        <Breadcrumb items={breadcrumbItems} />

        <div className="ds-detail__title-row">
          <h1 className="ds-detail__title">{data.name}</h1>
          <div className="ds-detail__title-actions">
            {isConnector && (
              <Button
                variant="outline"
                size="medium"
                label="Test connection"
                loading={testing}
                isDisabled={testing}
                onClick={handleTestConnection}
              />
            )}
            <Button
              variant="solid"
              size="medium"
              label="Edit"
              onClick={() => navigate(dataManagementPaths.dataSourceEdit(data.dsrc_id))}
            />
          </div>
        </div>
      </div>

      {/* Stats card */}
      <Card className="ds-detail__stats-card">
        <CardContentLayout columns={2}>
          <CardBlock type="metric" hasSideSeparator>
            <CardBlockValue>{data.name}</CardBlockValue>
            <CardBlockLabel>Name</CardBlockLabel>
          </CardBlock>

          <CardBlock type="metric">
            <CardBlockValue>
              {isConnector ? (
                <ConnectionStatusCell
                  status={data.status}
                  lastValidatedAt={data.last_validated_at}
                  connectionTestStatus={data.connection_test_status}
                  deprecated={data.deprecated}
                />
              ) : (
                <StatusCell status={data.status} deprecated={data.deprecated} />
              )}
            </CardBlockValue>
            <CardBlockLabel>Status</CardBlockLabel>
          </CardBlock>
        </CardContentLayout>
      </Card>

      {/* Tabs */}
      <div className="ds-detail__tabs">
        <TabGroup
          tabs={DETAIL_TABS}
          activeTabId={activeTab}
          variant="general"
          onTabChange={setActiveTab}
          ariaLabel="Data source detail tabs"
        >
          <TabContent tabId="overview" className="ds-detail__tab-content">
            <DataSourceDetailOverview data={data} />
          </TabContent>

          <TabContent tabId="data-preview" className="ds-detail__tab-content ds-detail__tab-content--preview">
            <DataSourceDetailDataPreview data={data} projectId={projectId} />
          </TabContent>

          <TabContent tabId="associated-datasets" className="ds-detail__tab-content">
            <DataSourceDetailDatasets dsrcId={data.dsrc_id} />
          </TabContent>
        </TabGroup>
      </div>

    </div>
  );
}

export { DataSourceDetail };
