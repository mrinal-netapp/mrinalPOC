import type { SelectDropdownItemData } from "@/ui-lib/base-components/select-dropdown/select-dropdown.types"

import type { AddToolMcpHeader } from "./add-tool/add-tool.types"
import type { ToolListItem, ToolListParams } from "./toolset-list/toolset-list.types"
import type { TimeRangeOption } from "./toolset-detail/toolset-overview.types"
import type { ToolsetConfigField } from "./edit-tool/edit-tool.types"
import type { AddToolState } from "./add-tool/add-tool.types"

export type ToolsetConnectionStatus = "connected" | "error" | "not-configured"

export type ToolsetDetailMetrics = {
  toolsCount: number
  successRate: string
  calls: string
  avgLatencyMs: number
}

export type ToolsetDetailRecord = {
  id: string
  name: string
  status: string
  type: string
  associatedAgents: string
  description: string
  labels: string
  mcpServer: string
  authType: string
  lastValidated: string
  callsPerMinute: string
  callsPerDay: string
  lastUpdated: string
  created: string
  connectionStatus: ToolsetConnectionStatus
  forwardedHeaders: string
  isPlatformManaged: boolean
  metrics: ToolsetDetailMetrics
}

export type ToolsetAgentRow = {
  id: string
  name: string
  status: string
  labels: string[]
  created: string
}

export type ToolsetListState = {
  items: ToolListItem[]
  isLoading: boolean
  isError: boolean
}

export type EditToolLoadPayload = {
  name: string
  description: string
  labels: string[]
  addCustomHeaders: boolean
  customHeaders: AddToolMcpHeader[]
  addForwardedHeaders: boolean
  forwardedHeaders: string[]
  applyRateLimiting: boolean
  callsPerMinute: string
  configFields: ToolsetConfigField[]
}

export type EditToolFormState = {
  toolId: string | null
  name: string
  description: string
  labelItems: SelectDropdownItemData[]
  selectedLabels: string[]
  configFields: ToolsetConfigField[]
  configDialogOpen: boolean
  addCustomHeaders: boolean
  customHeaders: AddToolMcpHeader[]
  addForwardedHeaders: boolean
  forwardedHeaders: string[]
  applyRateLimiting: boolean
  callsPerMinute: string
  submitted: boolean
}

export type ToolsetDetailState = {
  toolId: string | null
  tool: ToolsetDetailRecord | null
  agents: ToolsetAgentRow[]
  isLoading: boolean
  isError: boolean
  overviewTimeRange: TimeRangeOption | null
  isMetricsCollapsed: boolean
  mcpExpanded: boolean
}

export type ToolsetState = {
  list: ToolsetListState
  listFilters: ToolListParams
  addToolForm: AddToolState
  editToolForm: EditToolFormState
  detail: ToolsetDetailState
}
