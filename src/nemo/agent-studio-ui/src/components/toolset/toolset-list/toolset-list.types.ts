import type { BaseElement } from "@/ui-lib/base-components/baseTableMcpBxp"

export type ToolListHealthinessStatus = "Healthy" | "Unhealthy" | "Unknown" | "Deploying"
export type ToolListType = "catalogue" | "custom"

export type ToolListItem = {
  tool_id: string
  tool_name: string
  description: string | null
  tool_type: ToolListType
  region: string | null
  healthiness_status: ToolListHealthinessStatus | null
  last_validation_error: string | null
  last_validated_at: string | null
  pipelines_count: number
  agents_count: number
  is_deprecated: boolean
  tags: string[]
  updated_at: string
  updated_by: string
}

export type ToolListParams = {
  tool_type?: ToolListType
  healthiness_status?: ToolListHealthinessStatus
  limit?: number
  offset?: number
}

export type ToolStatus = "healthy" | "unhealthy" | "unknown" | "deploying"
export type ToolType = "Local" | "Remote"

export type ToolsetRow = BaseElement & {
  name: string
  type: ToolType
  status: ToolStatus
  statusDetails: string
  associatedAgents: string
  labels: string[]
}
