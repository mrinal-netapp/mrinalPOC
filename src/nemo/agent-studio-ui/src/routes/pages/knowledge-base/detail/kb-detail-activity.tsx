import { useMemo, type ReactElement } from "react";

import type { KBDetail } from "@/api/kb.types";
import { createKBActivityColumns } from "@/components/knowledge-base/columns/kb-activity.columns";
import type { KBActivityTableRow } from "@/components/knowledge-base/columns/kb-activity.columns";
import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp";
import type { BaseTableOptions } from "@/ui-lib/base-components/baseTableMcpBxp";

// -- Props --

interface KBDetailActivityProps {
  data: KBDetail;
}

// -- Table options --

const ACTIVITY_TABLE_OPTIONS: BaseTableOptions = {
  enablePagination: false,
  enableColumnSorting: true,
  enableColumnResizing: true,
  enableTableTopBar: true,
  topBarOptions: {
    rowCountLabel: "Activities",
    showSearch: false,
  },
};

// -- Component --

function KBDetailActivity({ data }: KBDetailActivityProps): ReactElement {
  const columns = useMemo(() => createKBActivityColumns(), []);

  const rows: KBActivityTableRow[] = useMemo(
    () => (data.activity ?? [])
      .map((entry, idx) => ({
        ...entry,
        id: `${entry.timestamp ?? ""}-${idx}`,
      }))
      .sort((a, b) => {
        const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
        return timeB - timeA;
      }),
    [data.activity],
  );

  return (
    <BaseTable<KBActivityTableRow>
      options={ACTIVITY_TABLE_OPTIONS}
      data={rows}
      columns={columns}
      isLoading={false}
      isError={false}
    />
  );
}

export { KBDetailActivity };
export type { KBDetailActivityProps };
