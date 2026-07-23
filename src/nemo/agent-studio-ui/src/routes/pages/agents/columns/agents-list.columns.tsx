import type { ColumnDef } from "@tanstack/react-table";

import { Typography } from "@/ui-lib/base-components/typography/typography";
import { formatDateTimeFull } from "@/components/data-source/utils/data-source.utils";
import { ActionsCell } from "@/components/data-source/columns/cells/actions-cell";
import type { ActionMenuItem } from "@/components/data-source/columns/cells/actions-cell";
import { AgentHealthCell } from "@/routes/pages/agents/columns/cells/agent-health-cell";
import { AgentDeploymentCell } from "@/routes/pages/agents/columns/cells/agent-deployment-cell";
import { OverflowListCell } from "@/routes/pages/agents/columns/cells/overflow-list-cell";
import type {
  AssociatedResource,
  SingleAgent,
  TeamAgent,
} from "@/routes/pages/agents/agents.types";
import { ROUTES } from "@/routes/routes.consts";
import { CellMarker } from "./cell-marker";

function getAssociatedResourceHref(resource: AssociatedResource): string {
  if (resource.kind === "knowledge-base") {
    return `/${ROUTES.KNOWLEDGE_BASES}/${resource.id}`;
  }
  return `/${ROUTES.AGENTS}/${resource.id}`;
}

export type AgentTableRow = (SingleAgent | TeamAgent) & {
  associatedItems: AssociatedResource[];
  teamDependencyCount?: number;
};

interface AgentsColumnsCallbacks {
  associatedColumnHeader: string;
  onNavigateDetail: (agentId: string) => void;
  actionMenuItems: (row: AgentTableRow) => ActionMenuItem<AgentTableRow>[];
  /**
   * Returns true when the row should render in the greyed,
   * non-editable "deprecated" state. Falsy by default — the column
   * factory treats the row as live.
   */
  isDeprecated?: (rowId: string) => boolean;
}

function createAgentsListColumns(
  callbacks: AgentsColumnsCallbacks,
): ColumnDef<AgentTableRow>[] {
  const checkDeprecated = (id: string): boolean =>
    callbacks.isDeprecated?.(id) ?? false;

  return [
    {
      accessorKey: "name",
      header: "Name",
      size: 180,
      minSize: 140,
      cell: ({ row }) => {
        const deprecated = checkDeprecated(row.original.id);
        return (
          <CellMarker isDeprecated={deprecated}>
            {deprecated ? (
              <Typography
                Component="span"
                fontSize="fs14"
                boldness="regular"
                color="var(--text-disabled)"
              >
                {row.original.name}
              </Typography>
            ) : (
              <button
                type="button"
                className="agent-list-name-link"
                onClick={() => callbacks.onNavigateDetail(row.original.id)}
              >
                <Typography
                  Component="span"
                  fontSize="fs14"
                  boldness="regular"
                  color="var(--text-button-primary)"
                >
                  {row.original.name}
                </Typography>
              </button>
            )}
          </CellMarker>
        );
      },
    },
    {
      accessorKey: "status",
      header: "Status",
      size: 130,
      minSize: 110,
      cell: ({ row }) => (
        <CellMarker isDeprecated={checkDeprecated(row.original.id)}>
          <AgentHealthCell status={row.original.status} />
        </CellMarker>
      ),
    },
    {
      id: "models",
      header: "Models",
      size: 160,
      minSize: 120,
      accessorFn: (row) => row.models.join(", "),
      cell: ({ row }) => (
        <CellMarker isDeprecated={checkDeprecated(row.original.id)}>
          <OverflowListCell
            items={row.original.models.map((model, idx) => ({
              id: `${row.original.id}-model-${idx}`,
              name: model,
            }))}
          />
        </CellMarker>
      ),
    },
    {
      id: "associated",
      header: callbacks.associatedColumnHeader,
      size: 280,
      minSize: 200,
      enableSorting: false,
      cell: ({ row }) => (
        <CellMarker isDeprecated={checkDeprecated(row.original.id)}>
          <OverflowListCell
            items={row.original.associatedItems.map((item) => ({
              id: item.id,
              name: item.name,
              href: getAssociatedResourceHref(item),
            }))}
          />
        </CellMarker>
      ),
    },
    {
      id: "last_updated",
      header: "Last time updated",
      size: 240,
      minSize: 220,
      accessorFn: (row) => row.lastUpdated,
      cell: ({ row }) => (
        <CellMarker isDeprecated={checkDeprecated(row.original.id)}>
          <Typography Component="span" fontSize="fs14" boldness="regular">
            {formatDateTimeFull(row.original.lastUpdated)}
          </Typography>
        </CellMarker>
      ),
    },
    {
      accessorKey: "deploymentStatus",
      header: "Deployment status",
      size: 160,
      minSize: 140,
      cell: ({ row }) => (
        <CellMarker isDeprecated={checkDeprecated(row.original.id)}>
          <AgentDeploymentCell status={row.original.deploymentStatus} />
        </CellMarker>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      size: 88,
      minSize: 88,
      maxSize: 88,
      enableSorting: false,
      enableResizing: false,
      cell: ({ row }) => (
        // Actions cell is intentionally OUTSIDE the marker so the
        // kebab button stays at full opacity and clearly clickable —
        // the deprecated treatment lives in greyed cells, not in a
        // greyed action menu. The menu item list itself
        // (passed via `actionMenuItems`) is responsible for which
        // entries are enabled in the deprecated state.
        <span className="agent-list-actions-cell">
          <ActionsCell
            row={row.original}
            name={row.original.name}
            menuItems={callbacks.actionMenuItems(row.original)}
          />
        </span>
      ),
    },
  ];
}

export { createAgentsListColumns };
export type { ActionMenuItem, AgentsColumnsCallbacks };
