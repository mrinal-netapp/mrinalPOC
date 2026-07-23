import { useState, type ReactElement } from "react";

import type { DatasetDetail } from "@/api/dataset.types";
import { useGetDataSourceQuery } from "@/api/data-source-api.slice";
import { POLLING_INTERVAL } from "@/consts/api.consts";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { TabGroup, TabContent } from "@/ui-lib/base-components/tab/tab-group";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { CardBlock, CardBlockKeyValueList } from "@/ui-lib/base-components/card/card.block";
import { Spinner } from "@/ui-lib/base-components/spinner/spinner";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import { buildDataSourceDetailRows } from "../../data-source/detail/data-source-detail-overview.utils";
import { buildDatasetDetailRows } from "./dataset-detail-overview.utils";
import "./dataset-detail.scss";

// -- Props --

interface DatasetDetailOverviewProps {
  data: DatasetDetail;
}

// -- Tabs --

const OVERVIEW_TABS = [
  { id: "dataset", label: "Dataset details" },
  { id: "data-source", label: "Assigned data source" },
];

// -- Data source tab content --

function DataSourceTabContent({ dsrcId }: { dsrcId: string }): ReactElement {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data, isLoading, isError } = useGetDataSourceQuery(
    { projectId, dsrcId },
    { pollingInterval: POLLING_INTERVAL, skip: !projectId || !dsrcId },
  );

  if (isLoading) {
    return (
      <Card>
        <CardContent>
          <div style={{ display: "flex", justifyContent: "center", padding: "32px 0" }}>
            <Spinner size="fitContent" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <CardContent>
          <CardBlock type="description">
            <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--notification-error)">
              Failed to load data source details.
            </Typography>
          </CardBlock>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent>
        <CardBlockKeyValueList rows={buildDataSourceDetailRows(data)} />
      </CardContent>
    </Card>
  );
}

// -- Component --

function DatasetDetailOverview({ data }: DatasetDetailOverviewProps): ReactElement {
  const [activeTab, setActiveTab] = useState("dataset");

  const datasetRows = buildDatasetDetailRows(data);

  return (
    <>
      <TabGroup
        tabs={OVERVIEW_TABS}
        activeTabId={activeTab}
        onTabChange={setActiveTab}
        variant="card"
        fitting="fill-container"
        className="dset-overview__tabs"
      >
        <TabContent tabId="dataset" className="dset-overview__tab-content">
          <Card>
            <CardContent>
              <CardBlockKeyValueList rows={datasetRows} />
            </CardContent>
          </Card>
        </TabContent>

        <TabContent tabId="data-source" className="dset-overview__tab-content">
          {data.data_source
            ? <DataSourceTabContent dsrcId={data.data_source.dsrc_id} />
            : (
              <Card>
                <CardContent>
                  <CardBlock type="description">
                    <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                      No data source assigned to this dataset.
                    </Typography>
                  </CardBlock>
                </CardContent>
              </Card>
            )
          }
        </TabContent>
      </TabGroup>
    </>
  );
}

export { DatasetDetailOverview };
export type { DatasetDetailOverviewProps };
