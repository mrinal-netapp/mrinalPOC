import { useMemo } from "react";

import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import {
  useGetAgentQuery,
  useListMcpServersQuery,
} from "@/routes/pages/agents/api/agents-config-api.slice";
import type {
  McpServerSummary,
} from "@/routes/pages/agents/api/agents-config.types";
import { isTeamAgentId } from "../../../utils/agents-api-mapper";
import type {
  ToolsetHealthStatus,
  ToolsetRow,
  ToolsetType,
} from "./toolsets-panel.types";

interface UseAgentToolsetsResult {
  rows: ToolsetRow[];
  isLoading: boolean;
  isError: boolean;
}

// The selected toolset list is driven by `agent.mcpServerIds` (explicit user
// selection). For display metadata, classify onboarding-type servers as Remote
// and everything else as Local.
function mapType(server: McpServerSummary | undefined): ToolsetType {
  return server?.deploymentType === "remote" ? "Remote" : "Local";
}

function mapStatus(server: McpServerSummary | undefined): ToolsetHealthStatus {
  return server?.status === "connected" ? "Healthy" : "Unhealthy";
}

function mapToolset(
  id: string,
  summary: McpServerSummary | undefined,
): ToolsetRow {
  return {
    id,
    name: summary?.name ?? id,
    type: mapType(summary),
    status: mapStatus(summary),
    // The MCP servers endpoint only reports dependent counts, not the agent
    // refs, so the associated-agents column can't be resolved here yet.
    // TODO(api): expose MCP server dependents as `{id, name}` refs.
    associatedAgents: [],
    labels: summary?.labels ?? [],
  };
}

/**
 * Single source of truth for the toolsets attached to a given agent.
 *
 * Both `ToolsetsPanel` (renders the rows) and `AgentDetailPage`
 * (counts the rows for the tab badge) consume this hook so the
 * visible count and the table contents can never drift apart.
 *
 * Selection source of truth is `agent.mcpServerIds`. We intentionally do not
 * infer attachments from `_resolvedMCPServers`, because that resolved map can
 * include default/available servers rather than user-selected toolsets.
 */
export function useAgentToolsets(agentId: string): UseAgentToolsetsResult {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const skip = !projectId || !agentId || isTeamAgentId(agentId);

  const { data, isLoading, isError } = useGetAgentQuery(
    { projectId, id: agentId },
    { skip },
  );

  // Joined to resolve per-server detail (labels) the agent enrichment omits.
  const {
    data: mcpServers,
    isLoading: isMcpListLoading,
    isError: isMcpListError,
  } = useListMcpServersQuery({ projectId }, { skip });

  const rows = useMemo<ToolsetRow[]>(() => {
    const byId = new Map((mcpServers ?? []).map((s) => [s.id, s]));
    return (data?.mcpServerIds ?? []).map((serverId) => mapToolset(serverId, byId.get(serverId)));
  }, [data, mcpServers]);

  return {
    rows,
    isLoading: isLoading || isMcpListLoading,
    isError: isError || isMcpListError,
  };
}
