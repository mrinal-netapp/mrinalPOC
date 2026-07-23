import { useCallback, useMemo } from "react"
import {
  IconArrowsUpDown,
  IconClock,
  IconTargetArrow,
  IconTool,
} from "@tabler/icons-react"

import { useAppDispatch, useAppSelector } from "@/store"
import { projectContextSelector } from "@/store/selectors/project-context.selector"
import type { DetailCardRow } from "@/components/detail-card/detail-card.types"
import type { MetricItem } from "@/components/metrics-row/metrics-row.types"
import { useListMcpServersQuery } from "@/routes/pages/agents/api/agents-config-api.slice"
import { useListMcpServerDependentsQuery } from "@/routes/pages/agents/api/agents-config-api.slice"
import { useListMcpServerToolsQuery } from "@/routes/pages/agents/api/agents-config-api.slice"
import type { McpServerSummary } from "@/routes/pages/agents/api/agents-config.types"
import { formatDateTimeFull } from "@/components/data-source/utils/data-source.utils"
import { deriveToolHealth } from "../toolset-health"
import { resolveDisplayedForwardedHeaders } from "../platform-mcp-defaults"
import { useRefreshMcpServersMutation } from "../toolset.api"
import type { RefreshMcpServersResponse } from "../toolset.api"

import {
  setDetailMcpExpanded,
  setDetailMetricsCollapsed,
  setDetailOverviewTimeRange,
} from "../reducer"
import { toolsetSelector } from "../selectors"
import type { ToolsetAgentRow, ToolsetDetailRecord } from "../toolset.types"
import type { TimeRangeOption } from "./toolset-overview.types"

type UseToolsetDetailResult = {
  tool: ToolsetDetailRecord | null
  agents: ToolsetAgentRow[]
  isLoading: boolean
  isError: boolean
  isRefreshing: boolean
  mcpExpanded: boolean
  overviewTimeRange: TimeRangeOption | null
  isMetricsCollapsed: boolean
  metrics: MetricItem[]
  detailRows: DetailCardRow[]
  refresh: () => Promise<RefreshMcpServersResponse | null>
  setMcpExpanded: (value: boolean) => void
  setOverviewTimeRange: (value: TimeRangeOption | null) => void
  toggleMetricsCollapsed: () => void
}

function buildDetailRows(tool: ToolsetDetailRecord): DetailCardRow[] {
  return [
    { label: "Name", value: tool.name },
    { label: "Description", value: tool.description },
    { label: "Type", value: tool.type },
    { label: "Labels", value: tool.labels },
    { label: "MCP server", value: tool.mcpServer },
    { label: "Forwarded headers", value: tool.forwardedHeaders },
    { label: "Last time validated", value: tool.lastValidated },
    { label: "Calls per minute", value: tool.callsPerMinute },
    { label: "Calls per day", value: tool.callsPerDay },
    { label: "Last time updated", value: tool.lastUpdated },
    { label: "Created", value: tool.created },
  ]
}

/** Format an ISO timestamp for display, falling back to "-" when absent/invalid. */
function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "-"
  const formatted = formatDateTimeFull(iso)
  return formatted === "Invalid Date" ? "-" : formatted
}

const HEALTH_TO_STATUS_LABEL = {
  healthy: "Healthy",
  unhealthy: "Unhealthy",
  deploying: "Deploying",
  unknown: "Unknown",
} as const

function mapServerToToolsetDetail(server: McpServerSummary, toolsCount: number): ToolsetDetailRecord {
  const agentCount = server.dependentsSummary?.byKind?.agent ?? 0
  const forwarded = resolveDisplayedForwardedHeaders(server.deploymentType, server.extraHeaders)
  return {
    id: server.id,
    name: server.name,
    // Catalog (managed) tools read as "Deploying" while their pod provisions
    // rather than a transient "Unknown"; see deriveToolHealth.
    status: HEALTH_TO_STATUS_LABEL[deriveToolHealth(server)],
    type: server.transport === "stdio" ? "Local" : "Remote",
    associatedAgents: `${agentCount} ${agentCount === 1 ? "agent" : "agents"}`,
    description: server.description ?? "-",
    labels: (server.labels ?? []).join(", ") || "-",
    mcpServer: server.name,
    authType: server.authType ?? "none",
    // config-service has no dedicated validation timestamp; health polling
    // bumps updatedAt, so it's the best available "last validated" signal.
    lastValidated: formatTimestamp(server.updatedAt),
    callsPerMinute: "-",
    callsPerDay: "-",
    lastUpdated: formatTimestamp(server.updatedAt),
    created: formatTimestamp(server.createdAt),
    connectionStatus:
      server.status === "connected"
        ? "connected"
        : server.status === "error" || server.status === "disconnected"
          ? "error"
          : "not-configured",
    forwardedHeaders: forwarded.length > 0 ? forwarded.join(", ") : "-",
    isPlatformManaged: server.deploymentType === "platform",
    metrics: {
      toolsCount,
      successRate: "—",
      calls: "—",
      avgLatencyMs: 0,
    },
  }
}

function useToolsetDetail(toolId: string | undefined): UseToolsetDetailResult {
  const dispatch = useAppDispatch()
  const fallbackTool = useAppSelector(toolsetSelector.detailTool)
  const fallbackAgents = useAppSelector(toolsetSelector.detailAgents)
  const fallbackLoading = useAppSelector(toolsetSelector.detailIsLoading)
  const fallbackError = useAppSelector(toolsetSelector.detailIsError)
  const projectId = useAppSelector(projectContextSelector.activeProjectId)
  const { data: servers = [], isLoading, isFetching, isError } = useListMcpServersQuery(
    { projectId, include: "dependentsSummary=true" },
    { skip: !projectId },
  )
  const [refreshMcpServers, { isLoading: isRefreshing }] = useRefreshMcpServersMutation()
  const server = useMemo(
    () =>
      servers.find((item) => item.id === toolId) ??
      servers.find((item) => item.name === toolId),
    [servers, toolId],
  )
  const resolvedServerId = server?.id
  const {
    data: dependents,
    isLoading: isDependentsLoading,
    isFetching: isDependentsFetching,
    isError: isDependentsError,
  } = useListMcpServerDependentsQuery(
    { projectId, id: resolvedServerId ?? "" },
    { skip: !projectId || !resolvedServerId },
  )
  const {
    data: serverTools,
    isLoading: isToolsLoading,
    isFetching: isToolsFetching,
  } = useListMcpServerToolsQuery(
    { projectId, id: resolvedServerId ?? "" },
    { skip: !projectId || !resolvedServerId },
  )
  const tool = useMemo(
    () => {
      if (!server) return fallbackTool
      const discoveredToolsCount = serverTools?.length
      const allowedToolsCount =
        server.allowedTools?.length && !server.allowedTools.includes("*")
          ? server.allowedTools.length
          : undefined
      const toolsCount = discoveredToolsCount ?? allowedToolsCount ?? 0
      return mapServerToToolsetDetail(server, toolsCount)
    },
    [server, serverTools, fallbackTool],
  )
  const agents = useMemo(
    () =>
      server
        ? (dependents?.items ?? [])
            .filter((item) => item.kind === "agent")
            .map((item) => ({
              id: item.id,
              name: item.name ?? item.id,
              status: "-",
              labels: [],
              created: "-",
            }))
        : fallbackAgents,
    [server, dependents, fallbackAgents],
  )
  const mcpExpanded = useAppSelector(toolsetSelector.detailMcpExpanded)
  const overviewTimeRange = useAppSelector(toolsetSelector.detailOverviewTimeRange)
  const isMetricsCollapsed = useAppSelector(toolsetSelector.detailIsMetricsCollapsed)

  const metrics = useMemo((): MetricItem[] => {
    if (!tool) return []

    const items: MetricItem[] = [
      { icon: <IconTool size={24} />, value: String(tool.metrics.toolsCount), subtitle: "Tools" },
    ]

    if (tool.metrics.successRate !== "—") {
      items.push({
        icon: <IconTargetArrow size={24} />,
        value: tool.metrics.successRate,
        subtitle: "Success rate",
      })
    }

    if (tool.metrics.calls !== "—") {
      items.push({
        icon: <IconArrowsUpDown size={24} />,
        value: tool.metrics.calls,
        subtitle: "Calls",
      })
    }

    if (tool.metrics.avgLatencyMs > 0) {
      items.push({
        icon: <IconClock size={24} />,
        value: String(tool.metrics.avgLatencyMs),
        units: "ms",
        subtitle: "Average latency",
      })
    }

    return items
  }, [tool])

  const detailRows = useMemo(
    () => (tool ? buildDetailRows(tool) : []),
    [tool],
  )

  const setMcpExpanded = useCallback((value: boolean): void => {
    dispatch(setDetailMcpExpanded(value))
  }, [dispatch])

  const setOverviewTimeRange = useCallback((value: TimeRangeOption | null): void => {
    dispatch(setDetailOverviewTimeRange(value))
  }, [dispatch])

  const toggleMetricsCollapsed = useCallback((): void => {
    dispatch(setDetailMetricsCollapsed(!isMetricsCollapsed))
  }, [dispatch, isMetricsCollapsed])

  const refresh = useCallback(async (): Promise<RefreshMcpServersResponse | null> => {
    if (!projectId) {
      return null
    }
    try {
      return await refreshMcpServers({ projectId }).unwrap()
    } catch {
      return null
    }
  }, [projectId, refreshMcpServers])

  return {
    tool,
    agents,
    isLoading:
      isLoading ||
      isFetching ||
      isDependentsLoading ||
      isDependentsFetching ||
      isToolsLoading ||
      isToolsFetching ||
      fallbackLoading,
    isError: isError || isDependentsError || fallbackError,
    isRefreshing,
    mcpExpanded,
    overviewTimeRange,
    isMetricsCollapsed,
    metrics,
    detailRows,
    refresh,
    setMcpExpanded,
    setOverviewTimeRange,
    toggleMetricsCollapsed,
  }
}

export { useToolsetDetail, mapServerToToolsetDetail }
