import type { SelectDropdownItemData } from "@/ui-lib/base-components/select-dropdown/select-dropdown.types"
import type {
  AddToolMcpAuthType,
  AddToolMcpConfig,
  AddToolMcpConnectionType,
  AddToolMcpHeader,
} from "./add-tool.types"

export const ADD_TOOL_STRINGS = {
  PAGE_TITLE: "Add toolsets",
  TOOL_TITLE: "Toolset",
  TOOL_SUBTITLE: "Add toolset for agents to perform actions during execution.",
  DETAILS_TITLE: "Details",
  DETAILS_SUBTITLE: "Provide the identifying information for this toolset.",
  TAB_ADD_FROM_CATALOG: "Add from catalog",
  TAB_ADD_CUSTOM_TOOL: "Add custom toolset",
  NAME_LABEL: "Name",
  NAME_PLACEHOLDER: "$name",
  DESCRIPTION_LABEL: "Description",
  DESCRIPTION_PLACEHOLDER: "$description",
  LABELS_LABEL: "Labels",
  LABELS_TOOLTIP: "Add labels to group and filter tools.",
  LABELS_PLACEHOLDER: "Select labels",
  MCP_SECTION_TITLE: "MCP server configuration",
  MCP_SECTION_SUBTITLE: "Connect to the MCP server by specifying configuration details to access it.",
  MCP_CARD_TITLE: "MCP server",
  CONFIGURE_ACTION_LABEL: "Configure",
  CONNECTION_STATUS_LABEL: "Connection status",
  CONNECTION_STATUS_VALUE: "Not configured",
  CONNECTION_STATUS_SUCCESS: "Successful",
  CONNECTION_STATUS_FAILED: "Failed",
  CONFIGURE_DIALOG_TITLE: "Add MCP server",
  MCP_SERVER_DETAILS_TITLE: "MCP server details",
  SERVER_URL_LABEL: "Server URL",
  SERVER_URL_PLACEHOLDER: "https://example.com",
  CONNECTION_TYPE_LABEL: "Connection type",
  AUTHENTICATION_DETAILS_TITLE: "Authentication details",
  AUTHENTICATION_TYPE_LABEL: "Type",
  AUTHORIZATION_ENDPOINT_URL_LABEL: "Authorization endpoint URL",
  TOKEN_ENDPOINT_URL_LABEL: "Token endpoint URL",
  ISSUER_URL_LABEL: "Issuer URL",
  CLIENT_ID_LABEL: "Client ID",
  CLIENT_SECRET_LABEL: "Client Secret",
  SCOPE_LABEL: "Scope",
  REGISTRATION_URL_LABEL: "Registration URL",
  JWKS_URL_LABEL: "JSON Web Key Set URL",
  API_KEY_LABEL: "API key",
  HEADER_NAME_LABEL: "Header name",
  BEARER_TOKEN_LABEL: "Bearer token",
  OPTIONAL_SUFFIX: "Optional",
  MCP_UNAUTH_WARNING:
    "This server isn't authenticated. Connect only if you trust this source.",
  ADD_CUSTOM_HEADERS_TOGGLE: "Add custom headers",
  APPLY_RATE_LIMITING_TOGGLE: "Apply rate limiting",
  HEADER_KEY_LABEL: "Header key",
  HEADER_VALUE_LABEL: "Header value",
  ADD_CUSTOM_HEADER_ACTION: "Add custom header",
  FORWARD_HEADERS_TOGGLE: "Forward request headers",
  FORWARD_HEADERS_HINT:
    "Header names forwarded per-request from the caller to the MCP server (e.g. Authorization, X-Project-ID, X-User-ID). Use * to forward all.",
  FORWARD_HEADER_NAME_LABEL: "Header name",
  ADD_FORWARD_HEADER_ACTION: "Add header",
  RETRY_TIMEOUT_SECTION_LABEL: "Retry and timeout configuration",
  RETRY_COUNT_LABEL: "Retry count",
  TIMEOUT_MS_LABEL: "Timeout count, ms",
  CALLS_PER_MINUTE_LABEL: "Calls per minute",
  SAVE_MCP_ACTION_LABEL: "Add",
  DISCARD_ACTION_LABEL: "Cancel",
  MCP_VALIDATION_SUCCESS_MESSAGE: "$validation message",
  MCP_VALIDATION_FAILED_MESSAGE: "$validation message for connection issues after adding the access details.",
  SUBMIT_LABEL: "Add",
  CANCEL_LABEL: "Cancel",

  // Catalog tab
  CATALOG_TABLE_LABEL: "Tools",
  CATALOG_NAME_LABEL: "Name",
  CATALOG_NAME_PLACEHOLDER: "my_mcp_server (alphanumeric + underscores)",
  CATALOG_DESCRIPTION_LABEL: "Description",
  CATALOG_DESCRIPTION_PLACEHOLDER: "Optional description for this server instance",
  CATALOG_ENV_VARS_LABEL: "Connection details",
  CATALOG_LOCATION_LABEL: "Location",
  CATALOG_RESOURCE_PRESET_LABEL: "Resource Preset",
  CATALOG_SELECT_TEMPLATE_ARIA: "Select template",
} as const

export const ADD_TOOL_DEFAULT_LABEL_ITEMS: SelectDropdownItemData[] = [
  { key: "staging", value: "staging", label: "Staging" },
  { key: "production", value: "production", label: "Production" },
  { key: "nfs", value: "nfs", label: "NFS" },
]

export const ADD_TOOL_DEFAULT_SELECTED_LABELS: string[] = []

export const ADD_TOOL_MCP_CONNECTION_TYPE_OPTIONS: Array<{
  key: AddToolMcpConnectionType
  value: AddToolMcpConnectionType
  label: string
}> = [
  { key: "sse", value: "sse", label: "SSE" },
  { key: "streamable_http", value: "streamable_http", label: "Streamable HTTP" },
]

export const ADD_TOOL_MCP_AUTH_TYPE_OPTIONS: Array<{
  key: AddToolMcpAuthType
  value: AddToolMcpAuthType
  label: string
}> = [
  { key: "enterprise_jwt_oidc", value: "enterprise_jwt_oidc", label: "Enterprise JWT (OIDC / Entra / Okta / Auth0)" },
  { key: "oauth2_pkce", value: "oauth2_pkce", label: "OAuth 2.1 (Authorization code with PKCE)" },
  { key: "oauth2_client_credentials", value: "oauth2_client_credentials", label: "OAuth 2.1 (Client credentials)" },
  { key: "api_key", value: "api_key", label: "API key" },
  { key: "bearer_token", value: "bearer_token", label: "Bearer token" },
  { key: "no_auth", value: "no_auth", label: "No authentication" },
]

export const ADD_TOOL_EMPTY_MCP_HEADER: AddToolMcpHeader = {
  key: "",
  value: "",
}

export const ADD_TOOL_DEFAULT_MCP_CONFIG: AddToolMcpConfig = {
  serverUrl: "",
  connectionType: "sse",
  authType: "no_auth",
  authorizationEndpointUrl: "",
  tokenEndpointUrl: "",
  issuerUrl: "",
  clientId: "",
  clientSecret: "",
  scope: "",
  registrationUrl: "",
  jwksUrl: "",
  apiKey: "",
  headerName: "X-API-Key",
  bearerToken: "",
  addCustomHeaders: false,
  customHeaders: [{ ...ADD_TOOL_EMPTY_MCP_HEADER }],
  addForwardedHeaders: false,
  forwardedHeaders: [""],
  applyRateLimiting: false,
  callsPerMinute: "60",
  retryCount: "3",
  timeoutMs: "30000",
  isRetryTimeoutExpanded: false,
}
