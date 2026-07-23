import { useMemo, type ReactElement } from "react";

import { BaseTable } from "@/ui-lib/base-components/baseTableMcpBxp";
import type { BaseTableOptions } from "@/ui-lib/base-components/baseTableMcpBxp";

import "@/routes/pages/agents/columns/agent-list.scss";

import { createAssignedKbColumns } from "./assigned-kb-panel.columns";
import { ASSIGNED_KB_PANEL_STRINGS } from "./assigned-kb-panel.consts";
import type { AssignedKnowledgeBaseRow } from "./assigned-kb-panel.types";
import { useAgentAssignedKbs } from "./use-agent-assigned-kbs";

interface AssignedKbPanelProps {
  /**
   * The agent whose assigned knowledge bases are being viewed.
   * Forwarded to `useAgentAssignedKbs`; the hook is the single source
   * of truth for the row set and is shared with `AgentDetailPage` so
   * the tab badge and the table contents stay aligned.
   */
  agentId: string;
}

function AssignedKbPanel({ agentId }: AssignedKbPanelProps): ReactElement {
  const { rows: tableData } = useAgentAssignedKbs(agentId);

  const tableOptions: BaseTableOptions = useMemo(
    () => ({
      enablePagination: true,
      enableColumnSorting: true,
      enableColumnResizing: true,
      enableTableTopBar: true,
      enableRowFilter: true,
      topBarOptions: {
        rowCountLabel: ASSIGNED_KB_PANEL_STRINGS.ROW_LABEL,
        showSearch: true,
      },
    }),
    [],
  );

  const columns = useMemo(() => createAssignedKbColumns(), []);

  return (
    <div className="assigned-kb-panel">
      <BaseTable<AssignedKnowledgeBaseRow>
        options={tableOptions}
        data={tableData}
        columns={columns}
      />
    </div>
  );
}

export { AssignedKbPanel };
export type { AssignedKbPanelProps };
