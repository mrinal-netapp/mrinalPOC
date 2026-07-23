import { useMemo, type ReactElement } from "react";
import { useNavigate } from "react-router";

import { useGetKBAssignedDatasetQuery } from "@/api/kb-api.slice";
import { useGetDatasetQuery } from "@/api/dataset-api.slice";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp";
import type { BaseTableOptions } from "@/ui-lib/base-components/baseTableMcpBxp";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import {
  createKBDatasetsColumns,
  type KBDatasetTableRow,
} from "@/components/knowledge-base/columns/kb-datasets.columns";
import { dataManagementPaths } from "../../data-management/data-management.consts";

// -- Props --

interface KBDetailDatasetProps {
  kbId: string;
}

// -- Table options --

const TABLE_OPTIONS: BaseTableOptions = {
  enablePagination: false,
  enableColumnSorting: true,
  enableColumnResizing: true,
  enableTableTopBar: true,
  topBarOptions: {
    rowCountLabel: "Assigned datasets",
    showSearch: true,
  },
};

// -- Component --

function KBDetailDataset({ kbId }: KBDetailDatasetProps): ReactElement {
  const navigate = useNavigate();
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data, isLoading, isError } = useGetKBAssignedDatasetQuery(
    { projectId, kbId },
    { skip: !projectId || !kbId },
  );

  const dsetId = data?.dataset?.dset_id ?? "";
  const { data: datasetDetail } = useGetDatasetQuery(
    { projectId, dsetId },
    { skip: !projectId || !dsetId },
  );

  const columns = useMemo(
    () => createKBDatasetsColumns({
      onNavigateDataset: (id) => navigate(dataManagementPaths.datasetDetail(id)),
    }),
    [navigate],
  );

  const tableData: KBDatasetTableRow[] = useMemo(() => {
    const ds = data?.dataset;
    if (!ds?.dset_id) return [];
    return [{
      ...ds,
      id: ds.dset_id,
      refresh_config: datasetDetail?.refresh_config ?? null,
    }];
  }, [data, datasetDetail]);

  return (
    <>
      <div className="kb-dataset__header">
        <Typography fontSize="fs20" boldness="semibold">
          Assigned datasets
        </Typography>
        <Typography fontSize="fs16" boldness="regular">
          This knowledge base indexes content from your datasets to enable semantic search. The index stays up to date through scheduled synchronizations.
        </Typography>
      </div>

      <BaseTable<KBDatasetTableRow>
        options={TABLE_OPTIONS}
        data={tableData}
        columns={columns}
        isLoading={isLoading}
        isError={isError}
      />
    </>
  );
}

export { KBDetailDataset };
export type { KBDetailDatasetProps };
