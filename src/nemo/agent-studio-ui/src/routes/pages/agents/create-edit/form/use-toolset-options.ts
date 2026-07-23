import { useMemo } from "react";

import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { useListMcpServersQuery } from "@/routes/pages/agents/api/agents-config-api.slice";
import type {
  McpServerHealthStatus,
  McpServerSummary,
} from "@/routes/pages/agents/api/agents-config.types";

import type {
  ToolsetHealthStatus,
  ToolsetOption,
} from "../configure-dialogs/configure-dialogs.types";

export type ToolsetOptions = {
  options: ToolsetOption[];
  isLoading: boolean;
  isError: boolean;
};

// Maps the MCP server connection status onto the dialog's health palette.
function toToolsetStatus(status: McpServerHealthStatus): ToolsetHealthStatus {
  switch (status) {
    case "connected":
      return "healthy";
    case "disconnected":
      return "degraded";
    case "error":
      return "unhealthy";
    default:
      return "unknown";
  }
}

// The list row only carries the server's tool allowlist (`allowedTools`, names
// with no descriptions). It's used as a fallback; the dialog enriches the
// selected toolset with the live catalog from `GET /mcp-servers/{id}/tools`
// (see `useToolsetTools`).
function toToolsetTools(server: McpServerSummary): ToolsetOption["tools"] {
  return (server.allowedTools ?? []).map((tool) => ({
    id: tool,
    name: tool,
    description: "",
  }));
}

const AUTH_TYPE_LABELS: Record<string, string> = {
  none: "None",
  api_key: "API key",
  bearer_token: "Bearer token",
  basic: "Basic",
  oauth2: "OAuth 2.0",
};

function toToolsetOption(server: McpServerSummary): ToolsetOption {
  return {
    id: server.id,
    name: server.name,
    description: server.description ?? undefined,
    status: toToolsetStatus(server.status),
    authType: server.authType ? (AUTH_TYPE_LABELS[server.authType] ?? server.authType) : undefined,
    labels: server.labels ?? [],
    tools: toToolsetTools(server),
    // Preserve the allow-list so the picker can constrain the live catalog to
    // only server-permitted tools. config-service returns `null` (not just
    // absent) when a server has no restriction, so normalize any non-array to
    // `undefined` — an array means "restrict", anything else means "allow all".
    allowedToolNames: Array.isArray(server.allowedTools) ? server.allowedTools : undefined,
  };
}

/**
 * Loads the project's MCP servers from config-service for the agent form's
 * "Add toolset" dialog. Each MCP server is presented as a selectable toolset;
 * the agent persists the chosen server ids as `mcpServerIds`.
 */
export function useToolsetOptions(): ToolsetOptions {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const { data, isLoading, isError } = useListMcpServersQuery(
    { projectId },
    { skip: !projectId },
  );

  const options = useMemo<ToolsetOption[]>(
    () => (data ?? []).map(toToolsetOption),
    [data],
  );

  return { options, isLoading, isError: isError || !projectId };
}
