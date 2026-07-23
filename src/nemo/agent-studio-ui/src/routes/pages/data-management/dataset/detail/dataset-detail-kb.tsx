import { useMemo, type ReactElement } from "react";

import { useListDatasetKnowledgeBasesQuery } from "@/api/dataset-api.slice";
import { POLLING_INTERVAL } from "@/consts/api.consts";
import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp";
import type { BaseTableOptions } from "@/ui-lib/base-components/baseTableMcpBxp";
import { useKBColumns } from "@/components/dataset/columns/dataset-kb.columns";
import type { KBTableRow } from "@/components/dataset/columns/dataset-kb.columns";

// -- Props --

interface DatasetDetailKBProps {
  dsetId: string;
}

// -- Table options --

const TABLE_OPTIONS: BaseTableOptions = {
  enablePagination: false,
  enableColumnSorting: true,
  enableColumnResizing: true,
  enableTableTopBar: true,
  topBarOptions: {
    rowCountLabel: "Knowledge bases",
    showSearch: true,
  },
};

// -- Component --

function DatasetDetailKB({ dsetId }: DatasetDetailKBProps): ReactElement {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data, isLoading, isError } = useListDatasetKnowledgeBasesQuery(
    { projectId, dsetId },
    { pollingInterval: POLLING_INTERVAL, skip: !projectId || !dsetId },
  );

  const columns = useKBColumns();

  const tableData: KBTableRow[] = useMemo(
    () => (data?.knowledge_bases ?? []).map((kb) => ({ ...kb, id: kb.kb_id })),
    [data],
  );

  return (
    <BaseTable<KBTableRow>
      options={TABLE_OPTIONS}
      data={tableData}
      columns={columns}
      isLoading={isLoading}
      isError={isError}
    />
  );
}

export { DatasetDetailKB };
export type { DatasetDetailKBProps };
