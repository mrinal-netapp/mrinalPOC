import { useState, type ReactElement } from "react";
import {
  IconFileText,
  IconSearch,
  IconPuzzle,
  IconVector,
  IconDatabase,
  IconCurrencyDollar,
} from "@tabler/icons-react";

import type { KBDetail } from "@/api/kb.types";
import { useGetKBAssignedDatasetQuery } from "@/api/kb-api.slice";
import { useGetDatasetQuery } from "@/api/dataset-api.slice";
import { POLLING_INTERVAL } from "@/consts/api.consts";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardContentLayout } from "@/ui-lib/base-components/card/card.content-layout";
import { CardBlock, CardBlockMetric, CardBlockKeyValueList, type KeyValueRow } from "@/ui-lib/base-components/card/card.block";
import { TabGroup, TabContent } from "@/ui-lib/base-components/tab/tab-group";
import { ChipList } from "@/ui-lib/base-components/chip-list/chip-list";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { formatDateTimeFull } from "@/components/data-source/utils/data-source.utils";
import { buildDatasetDetailRows } from "@/routes/pages/data-management/dataset/detail/dataset-detail-overview.utils";
import { getKBChunkingStrategyLabel } from "../create-edit/form/kb-form.consts";
import { formatIndexSize, formatNumber } from "./kb-detail-overview.utils";
import "./kb-detail.scss";

// -- Props --

interface KBDetailOverviewProps {
  data: KBDetail;
}

// -- Tabs --

const OVERVIEW_TABS = [
  { id: "kb-details", label: "KB details" },
  { id: "dataset", label: "Dataset" },
];

// -- Dataset tab content --

function DatasetTabContent({ kbId }: { kbId: string }): ReactElement {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data: assignedData, isLoading: assignedLoading, isError: assignedError } =
    useGetKBAssignedDatasetQuery(
      { projectId, kbId },
      { skip: !projectId || !kbId },
    );

  const dsetId = assignedData?.dataset?.dset_id ?? "";
  const { data: datasetDetail, isLoading: datasetLoading, isError: datasetError } =
    useGetDatasetQuery(
      { projectId, dsetId },
      { skip: !projectId || !dsetId, pollingInterval: POLLING_INTERVAL },
    );

  if (assignedLoading || datasetLoading) {
    return (
      <Card>
        <CardContent>
          <div className="kb-overview__spinner-center">
            <Spinner size="fitContent" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (assignedError || !assignedData?.dataset?.dset_id) {
    return (
      <Card>
        <CardContent>
          <CardBlock type="description">
            <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
              No dataset assigned to this knowledge base.
            </Typography>
          </CardBlock>
        </CardContent>
      </Card>
    );
  }

  if (datasetError || !datasetDetail) {
    return (
      <Card>
        <CardContent>
          <CardBlock type="description">
            <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--notification-error)">
              Failed to load dataset details.
            </Typography>
          </CardBlock>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent>
        <CardBlockKeyValueList rows={buildDatasetDetailRows(datasetDetail)} />
      </CardContent>
    </Card>
  );
}

// -- Component --

function KBDetailOverview({ data }: KBDetailOverviewProps): ReactElement {
  const [activeTab, setActiveTab] = useState("kb-details");

  // Metrics from the current snapshot for the overview dashboard card
  const snapshot = data.snapshot;

  /* v8 ignore start -- nullish fallback branches for optional API fields */
  const kbDetailsRows: KeyValueRow[] = [
    { label: "Name", value: data.name },
    { label: "Description", value: data.description || "—" },
    {
      label: "Labels",
      value: data.labels.length > 0
        ? <ChipList values={data.labels} getLabel={(v) => String(v)} isRemovable={false} isDisabled={false} />
        : "—",
    },
    { label: "Assigned dataset", value: data.assigned_dataset?.name ?? "—" },
    { label: "Synchronization", value: data.synchronization_config?.sync_mode ?? "—" },
    { label: "Data change threshold", value: data.synchronization_config?.data_change_threshold_enabled ? `${data.synchronization_config?.data_change_threshold_value ?? "—"} files` : "Disabled" },
    { label: "Embedding model", value: data.embedding_config?.model ?? "—" },
    { label: "Chunking strategy", value: getKBChunkingStrategyLabel(data.chunking_config?.strategy) },
    { label: "Chunk size", value: `${data.chunking_config?.chunk_size ?? "—"}` },
    { label: "Chunk overlap", value: `${data.chunking_config?.overlap ?? "—"}` },
    { label: "Last time updated", value: data.updated_at ? formatDateTimeFull(data.updated_at) : "—" },
    { label: "Created", value: formatDateTimeFull(data.created_at) },
  ];
  /* v8 ignore stop */

  return (
    <>
      {/* Overview metrics dashboard card */}
      <Card className="kb-overview__metrics-card">
        <CardContentLayout columns={6}>
          <CardBlock type="metric" hasSideSeparator>
            <CardBlockMetric
              value={formatNumber(data.snapshot?.files_indexed)}
              subtitle="Documents indexed"
              icon={<IconFileText />}
              orientation="vertical"
            />
          </CardBlock>

          <CardBlock type="metric" hasSideSeparator>
            <CardBlockMetric
              value="—"
              subtitle="Queries (last 7 days)"
              icon={<IconSearch />}
              orientation="vertical"
            />
          </CardBlock>

          <CardBlock type="metric" hasSideSeparator>
            <CardBlockMetric
              value={formatNumber(data.stats?.chunkCount)}
              subtitle="Text chunks"
              icon={<IconPuzzle />}
              orientation="vertical"
            />
          </CardBlock>

          <CardBlock type="metric" hasSideSeparator>
            <CardBlockMetric
              value={formatNumber(snapshot?.vectors)}
              subtitle="Vector embeddings"
              icon={<IconVector />}
              orientation="vertical"
            />
          </CardBlock>

          <CardBlock type="metric" hasSideSeparator>
            <CardBlockMetric
              value={formatIndexSize(data.stats?.storageBytes)}
              subtitle="Total index size"
              icon={<IconDatabase />}
              orientation="vertical"
            />
          </CardBlock>

          <CardBlock type="metric">
            <CardBlockMetric
              value="—"
              subtitle="Cost (last 30 days)"
              icon={<IconCurrencyDollar />}
              orientation="vertical"
            />
          </CardBlock>
        </CardContentLayout>
      </Card>

      {/* Inner tabs: KB details + Dataset */}
      <TabGroup
        tabs={OVERVIEW_TABS}
        activeTabId={activeTab}
        onTabChange={setActiveTab}
        variant="card"
        fitting="fill-container"
        className="kb-overview__tabs"
      >
        <TabContent tabId="kb-details" className="kb-overview__tab-content">
          <Card>
            <CardContent>
              <CardBlockKeyValueList rows={kbDetailsRows} />
            </CardContent>
          </Card>
        </TabContent>

        <TabContent tabId="dataset" className="kb-overview__tab-content">
          <DatasetTabContent kbId={data.kb_id} />
        </TabContent>
      </TabGroup>
    </>
  );
}

export { KBDetailOverview };
export type { KBDetailOverviewProps };
