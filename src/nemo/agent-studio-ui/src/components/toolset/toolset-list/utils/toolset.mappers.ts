import type { ToolListItem } from "../toolset-list.types";

import { TOOLSET_STRINGS } from "../toolset-list.consts"
import type { ToolStatus, ToolType, ToolsetRow } from "../toolset-list.types"

// Catalog-deployed servers run on the platform → Local. User-onboarded servers
// reach an external endpoint → Remote.
const TOOL_TYPE_MAP: Record<ToolListItem["tool_type"], ToolType> = {
  catalogue: TOOLSET_STRINGS.LOCAL_LABEL,
  custom: TOOLSET_STRINGS.REMOTE_LABEL,
};

const STATUS_MAP: Record<NonNullable<ToolListItem["healthiness_status"]>, ToolStatus> = {
  Healthy: "healthy",
  Unhealthy: "unhealthy",
  Unknown: "unknown",
  Deploying: "deploying",
};

export function mapToolListItemToToolsetRow(item: ToolListItem): ToolsetRow {
  const mappedStatus = item.healthiness_status ? STATUS_MAP[item.healthiness_status] : "unknown";

  return {
    id: item.tool_id,
    name: item.tool_name,
    type: TOOL_TYPE_MAP[item.tool_type],
    status: mappedStatus,
    statusDetails: getStatusDetails(item.last_validation_error),
    associatedAgents: formatAssociatedAgents(item.agents_count),
    labels: item.tags,
  };
}

function formatAssociatedAgents(count: number): string {
  return `${count} ${count === 1 ? "agent" : "agents"}`
}

function getStatusDetails(lastValidationError: string | null): string {
  return lastValidationError?.trim() ?? ""
}
