import { useMemo } from "react";

import { useAppSelector } from "@/store";
import { projectContextSelector } from "@/store/selectors/project-context.selector";
import { useListMcpServerToolsQuery } from "@/routes/pages/agents/api/agents-config-api.slice";

import type { ToolsetOption } from "../configure-dialogs/configure-dialogs.types";

export type ToolsetTools = {
  tools: ToolsetOption["tools"];
  isLoading: boolean;
  isError: boolean;
  /** True once a real (non-skipped) response has arrived. */
  isReady: boolean;
};

/**
 * Loads the live tool catalog for a single MCP server (the selected toolset)
 * from `GET /mcp-servers/{id}/tools`. Unlike the server's `allowedTools`
 * allowlist, these carry human-readable descriptions. The query is skipped
 * until a toolset is selected.
 */
export function useToolsetTools(toolsetId: string): ToolsetTools {
  const projectId = useAppSelector(projectContextSelector.activeProjectId);
  const skip = !toolsetId || !projectId;

  const { data, isLoading, isFetching, isError, isSuccess } =
    useListMcpServerToolsQuery(
      { projectId, id: toolsetId },
      { skip },
    );

  const tools = useMemo<ToolsetOption["tools"]>(
    () =>
      (data ?? []).map((tool) => ({
        id: tool.name,
        name: tool.name,
        description: tool.description ?? "",
      })),
    [data],
  );

  return {
    tools,
    isLoading: !skip && (isLoading || isFetching),
    isError: !skip && isError,
    isReady: !skip && isSuccess,
  };
}
