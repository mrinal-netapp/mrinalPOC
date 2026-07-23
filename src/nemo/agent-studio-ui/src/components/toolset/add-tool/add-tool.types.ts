import type { SelectDropdownItemData } from "@/ui-lib/base-components/select-dropdown/select-dropdown.types"
import type { CatalogFormState } from "./catalog/catalog.types"

export type AddToolMode = "catalog" | "custom"
export type AddToolMcpConnectionType = "sse" | "streamable_http"
export type AddToolMcpAuthType =
  | "enterprise_jwt_oidc"
  | "oauth2_pkce"
  | "oauth2_client_credentials"
  | "api_key"
  | "bearer_token"
  | "no_auth"
export type AddToolMcpConnectionStatus = "not_configured" | "successful" | "failed"

export type AddToolMcpHeader = {
  key: string
  value: string
}

export type AddToolMcpConfig = {
  serverUrl: string
  connectionType: AddToolMcpConnectionType
  authType: AddToolMcpAuthType
  authorizationEndpointUrl: string
  tokenEndpointUrl: string
  issuerUrl: string
  clientId: string
  clientSecret: string
  scope: string
  registrationUrl: string
  jwksUrl: string
  apiKey: string
  headerName: string
  bearerToken: string
  addCustomHeaders: boolean
  customHeaders: AddToolMcpHeader[]
  addForwardedHeaders: boolean
  forwardedHeaders: string[]
  applyRateLimiting: boolean
  callsPerMinute: string
  retryCount: string
  timeoutMs: string
  isRetryTimeoutExpanded: boolean
}

export type AddToolState = {
  activeTabId: AddToolMode
  name: string
  description: string
  labelItems: SelectDropdownItemData[]
  selectedLabels: string[]
  mcpConfigDialogOpen: boolean
  mcpConfigDraft: AddToolMcpConfig
  savedMcpConfig: AddToolMcpConfig | null
  mcpConnectionStatus: AddToolMcpConnectionStatus
  mcpValidationMessage: string | null
  catalog: CatalogFormState
}
