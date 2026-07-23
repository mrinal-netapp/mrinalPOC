import type { BaseElement } from "@/ui-lib/base-components/baseTableMcpBxp"
import type { AddToolMcpAuthType, AddToolMcpConnectionStatus } from "../add-tool.types"

export type CatalogTemplateId =
  | "azure_netapp_files"
  | "azure_netapp_files_logs"
  | "fsxn"
  | "google_cloud_netapp_volumes"
  | "google_cloud_netapp_volumes_logs"
  | "netapp_ontap"
  | "analytics_datasets"
  | "duckdb_iceberg"
  | "postgres"
  | "github"
  | "web_search"

export type CatalogLocationType = "Local" | "Remote"

export type CatalogResourcePreset = "small" | "medium" | "large"

export type CatalogTemplateRow = BaseElement & {
  name: string
  description: string
  locationType: CatalogLocationType
  tools: number
}

export type CatalogEnvVar = {
  key: string
  value: string
  placeholder?: string
  helperText: string
  isRequired?: boolean
}

export type CatalogRuntimeCredential = {
  type: string
  helperText: string
  isRequired?: boolean
}

export type CatalogTemplateDefinition = {
  id: CatalogTemplateId
  name: string
  description: string
  locationType: CatalogLocationType
  tools: number
  defaultServerUrl: string
  defaultAuthType: AddToolMcpAuthType
  envVars: CatalogEnvVar[]
  runtimeCredential?: CatalogRuntimeCredential
  hasResourcePreset: boolean
  resourcePresetOptions?: Array<{ value: CatalogResourcePreset; label: string }>
  defaultResourcePreset?: CatalogResourcePreset
}

export type CatalogFormState = {
  selectedTemplateId: CatalogTemplateId | null
  catalogName: string
  catalogDescription: string
  envVarValues: Record<string, string>
  runtimeCredentialId: string
  resourcePreset: CatalogResourcePreset
  addCustomHeaders: boolean
  customHeaders: Array<{ key: string; value: string }>
  applyRateLimiting: boolean
  callsPerMinute: string
  retryCount: string
  timeoutMs: string
  isRetryTimeoutExpanded: boolean
  mcpConfigDialogOpen: boolean
  mcpConfigSaved: boolean
  catalogMcpConnectionStatus: AddToolMcpConnectionStatus
  catalogMcpValidationMessage: string | null
}
