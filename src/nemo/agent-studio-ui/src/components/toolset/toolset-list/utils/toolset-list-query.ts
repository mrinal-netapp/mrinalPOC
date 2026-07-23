import { useAppSelector } from "@/store"
import { projectContextSelector } from "@/store/selectors/project-context.selector"
import {
  useListMcpServersQuery,
} from "@/routes/pages/agents/api/agents-config-api.slice"
import type { McpServerSummary } from "@/routes/pages/agents/api/agents-config.types"

import { deriveToolHealth, type ToolHealth } from "../../toolset-health"
import { toolsetSelector } from "../../selectors"
import type { ToolListHealthinessStatus, ToolListItem } from "../toolset-list.types"

type ToolsetListQueryResult = {
  data: { data: ToolListItem[] } | undefined
  isLoading: boolean
  isError: boolean
}

const HEALTH_TO_LIST_STATUS: Record<ToolHealth, ToolListHealthinessStatus> = {
  healthy: "Healthy",
  unhealthy: "Unhealthy",
  deploying: "Deploying",
  unknown: "Unknown",
}

function mapMcpServerToToolListItem(server: McpServerSummary): ToolListItem {
  const agentsCount =
    server.dependentsSummary?.byKind?.agent ??
    0

  // Catalog (managed) tools show "Deploying" while their pod provisions instead
  // of a transient "Unknown"; see deriveToolHealth.
  const status = HEALTH_TO_LIST_STATUS[deriveToolHealth(server)]

  // "Local" vs "Remote" reflects where the server runs, not its transport:
  // servers deployed from the catalog run on our platform (deploymentType
  // 'managed' | 'platform') → "catalogue" (Local). User-onboarded servers that
  // point at an external endpoint (deploymentType 'remote' or unset) → "custom"
  // (Remote).
  const isCatalogDeployed =
    server.deploymentType === "managed" || server.deploymentType === "platform"

  return {
    tool_id: server.id,
    tool_name: server.name,
    description: server.description ?? null,
    tool_type: isCatalogDeployed ? "catalogue" : "custom",
    region: null,
    healthiness_status: status,
    last_validation_error: null,
    last_validated_at: null,
    pipelines_count: 0,
    agents_count: agentsCount,
    is_deprecated: false,
    tags: server.labels ?? [],
    updated_at: "",
    updated_by: "",
  }
}

/**
 * Reads toolset list state from Redux (`useToolsetListQuery`).
 * Server fetch will be wired here when the API integration is added.
 */
export function useToolsetListQuery(): ToolsetListQueryResult {
  const projectId = useAppSelector(projectContextSelector.activeProjectId)
  const { data: servers, isLoading, isError } = useListMcpServersQuery(
    { projectId, include: "dependentsSummary=true" },
    { skip: !projectId },
  )
  const fallbackItems = useAppSelector(toolsetSelector.listItems)
  const fallbackLoading = useAppSelector(toolsetSelector.listIsLoading)
  const fallbackError = useAppSelector(toolsetSelector.listIsError)

  if (!projectId) {
    return {
      data: { data: fallbackItems },
      isLoading: fallbackLoading,
      isError: fallbackError,
    }
  }

  return {
    data: { data: (servers ?? []).map(mapMcpServerToToolListItem) },
    isLoading,
    isError,
  }
}
