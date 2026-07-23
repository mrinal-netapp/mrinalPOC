import { useMemo, type ReactElement } from "react";

import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp";
import type { BaseTableOptions } from "@/ui-lib/base-components/baseTableMcpBxp";
import {
  createDataSourceActivityColumns,
  type ActivityTableRow,
} from "@/components/data-source/columns/data-source-activity.columns";

// -- Table options --

const TABLE_OPTIONS: BaseTableOptions = {
  enablePagination: false,
  enableColumnSorting: true,
  enableColumnResizing: true,
  enableTableTopBar: true,
  topBarOptions: {
    rowCountLabel: "Activity",
    showSearch: true,
  },
};

// -- Component --

/*
 * Waiting for the BE to decide if we will have this or not.
 * Once confirmed, replace with an RTK Query hook for GET /data-sources/:id/activity
 * and add loading / error / data state tests mirroring the Datasets tab pattern.
 */
const EMPTY_DATA: ActivityTableRow[] = [];

function DataSourceDetailActivity(): ReactElement {
  const columns = useMemo(() => createDataSourceActivityColumns(), []);

  return (
    <BaseTable<ActivityTableRow>
      options={TABLE_OPTIONS}
      data={EMPTY_DATA}
      columns={columns}
      isLoading={false}
      isError={false}
    />
  );
}

export { DataSourceDetailActivity };
