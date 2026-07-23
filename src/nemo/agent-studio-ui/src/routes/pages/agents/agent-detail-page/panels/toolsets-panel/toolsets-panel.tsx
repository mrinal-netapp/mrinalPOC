import { useMemo, type ReactElement } from "react";

import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp";
import type { BaseTableOptions } from "@/ui-lib/base-components/baseTableMcpBxp";

import "@/routes/pages/agents/columns/agent-list.scss";

import { createToolsetsColumns } from "./toolsets-panel.columns";
import { TOOLSETS_PANEL_STRINGS } from "./toolsets-panel.consts";
import type { ToolsetRow } from "./toolsets-panel.types";
import { useAgentToolsets } from "./use-agent-toolsets";

interface ToolsetsPanelProps {
  /**
   * The agent whose toolsets are being viewed. Forwarded to
   * `useAgentToolsets`; the hook is the single source of truth for the
   * row set and is shared with `AgentDetailPage` so the tab badge and
   * the table contents stay aligned.
   */
  agentId: string;
}

function ToolsetsPanel({ agentId }: ToolsetsPanelProps): ReactElement {
  const { rows: tableData } = useAgentToolsets(agentId);

  const tableOptions: BaseTableOptions = useMemo(
    () => ({
      enablePagination: true,
      enableColumnSorting: true,
      enableColumnResizing: true,
      enableTableTopBar: true,
      enableRowFilter: true,
      topBarOptions: {
        rowCountLabel: TOOLSETS_PANEL_STRINGS.ROW_LABEL,
        showSearch: true,
      },
    }),
    [],
  );

  const columns = useMemo(() => createToolsetsColumns(), []);

  return (
    <div className="toolsets-panel">
      <BaseTable<ToolsetRow>
        options={tableOptions}
        data={tableData}
        columns={columns}
      />
    </div>
  );
}

export { ToolsetsPanel };
export type { ToolsetsPanelProps };
