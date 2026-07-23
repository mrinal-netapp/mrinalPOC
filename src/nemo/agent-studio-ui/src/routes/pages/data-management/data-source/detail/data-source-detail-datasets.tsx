import { useMemo, type ReactElement } from "react";
import { useNavigate } from "react-router";

import { useListDataSourceDatasetsQuery } from "@/api/data-source-api.slice";
import { POLLING_INTERVAL } from "@/consts/api.consts";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp";
import type { BaseTableOptions } from "@/ui-lib/base-components/baseTableMcpBxp";
import {
  createDataSourceDatasetsColumns,
  type DatasetTableRow,
} from "@/components/data-source/columns/data-source-datasets.columns";
import { dataManagementPaths } from "../../data-management.consts";

// -- Props --

interface DataSourceDetailDatasetsProps {
  dsrcId: string;
}

// -- Table options --

const TABLE_OPTIONS: BaseTableOptions = {
  enablePagination: false,
  enableColumnSorting: true,
  enableColumnResizing: true,
  enableTableTopBar: true,
  topBarOptions: {
    rowCountLabel: "Associated datasets",
    showSearch: true,
  },
};

// -- Component --

function DataSourceDetailDatasets({ dsrcId }: DataSourceDetailDatasetsProps): ReactElement {
  const navigate = useNavigate();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data, isLoading, isError } = useListDataSourceDatasetsQuery(
    { projectId, dsrcId },
    { pollingInterval: POLLING_INTERVAL, skip: !projectId || !dsrcId },
  );

  const columns = useMemo(
    () => createDataSourceDatasetsColumns({
      onNavigateDataset: (dsetId) => navigate(dataManagementPaths.datasetDetail(dsetId)),
    }),
    [navigate],
  );

  const tableData: DatasetTableRow[] = useMemo(
    () => (data?.datasets ?? []).map((d) => ({ ...d, id: d.dset_id })),
    [data],
  );

  return (
    <BaseTable<DatasetTableRow>
      options={TABLE_OPTIONS}
      data={tableData}
      columns={columns}
      isLoading={isLoading}
      isError={isError}
    />
  );
}

export { DataSourceDetailDatasets };
export type { DataSourceDetailDatasetsProps };
