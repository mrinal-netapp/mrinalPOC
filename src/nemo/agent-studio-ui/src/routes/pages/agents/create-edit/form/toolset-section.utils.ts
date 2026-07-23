import type {
  ToolsetConfig,
  ToolsetHealthStatus,
  ToolsetOption,
} from "../configure-dialogs/configure-dialogs.types";
import type { AgentAttachedToolset, AgentKBStatus } from "./agent-form.consts";

const TOOLSET_STATUS_TO_FORM_STATUS: Record<ToolsetHealthStatus, AgentKBStatus> = {
  healthy: "healthy",
  degraded: "degraded",
  unhealthy: "unhealthy",
  unknown: "unhealthy",
};

function buildAttachedToolset(
  draft: ToolsetConfig,
  catalog: readonly ToolsetOption[],
): AgentAttachedToolset | null {
  const option = catalog.find((t) => t.id === draft.toolsetId);
  if (!option) return null;
  const selectedTools = option.tools.filter((tool) => draft.selectedToolIds.includes(tool.id));
  return {
    id: option.id,
    name: option.name,
    status: TOOLSET_STATUS_TO_FORM_STATUS[option.status],
    account: option.name,
    authMethod: option.authType ?? option.labels[0] ?? "—",
    tools: selectedTools.map((t) => t.name),
  };
}

function enrichWithCatalog(
  attached: AgentAttachedToolset,
  catalog: readonly ToolsetOption[],
): AgentAttachedToolset {
  const option = catalog.find((o) => o.id === attached.id);
  if (!option) return attached;
  const tools = attached.tools.length > 0 ? attached.tools : option.tools.map((t) => t.name);
  return {
    ...attached,
    name: option.name,
    status: TOOLSET_STATUS_TO_FORM_STATUS[option.status],
    account: option.name,
    authMethod: option.authType ?? option.labels[0] ?? "—",
    tools,
  };
}

export { buildAttachedToolset, enrichWithCatalog };
