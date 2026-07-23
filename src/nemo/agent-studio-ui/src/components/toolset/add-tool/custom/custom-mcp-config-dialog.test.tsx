import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/ui-lib/base-components/select-dropdown/select-dropdown", () => ({
  SelectDropdown: ({
    label,
    onValueChange,
  }: {
    label?: string
    onValueChange?: (value: string) => void
  }) => (
    <button
      type="button"
      onClick={() => {
        if (label?.includes("Connection type")) {
          onValueChange?.("streamable_http")
          return
        }
        onValueChange?.("enterprise_jwt_oidc")
      }}
    >
      {label}
    </button>
  ),
}))

import { ADD_TOOL_DEFAULT_MCP_CONFIG } from "../add-tool.consts"
import type { AddToolMcpConfig } from "../add-tool.types"
import { CustomMcpConfigDialog } from "./custom-mcp-config-dialog"

const baseHandlers = {
  onClose: vi.fn(),
  onDraftChange: vi.fn(),
  onCustomHeadersChange: vi.fn(),
  onForwardedHeadersChange: vi.fn(),
  onSave: vi.fn(),
}

function renderDialog(mcpConfigDraft: AddToolMcpConfig, handlers = baseHandlers) {
  return render(
    <CustomMcpConfigDialog
      open
      mcpConfigDraft={mcpConfigDraft}
      {...handlers}
    />,
  )
}

describe("CustomMcpConfigDialog", () => {
  it("[tag:mcp-dialog] renders nothing when closed", () => {
    const { container } = render(
      <CustomMcpConfigDialog
        open={false}
        mcpConfigDraft={ADD_TOOL_DEFAULT_MCP_CONFIG}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onCustomHeadersChange={vi.fn()}
        onForwardedHeadersChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )

    expect(container.querySelector(".dialog-popup")).not.toBeInTheDocument()
  })

  it("[tag:mcp-dialog] renders title and fields when open", () => {
    renderDialog(ADD_TOOL_DEFAULT_MCP_CONFIG)

    expect(screen.getByText("Add MCP server")).toBeInTheDocument()
    expect(screen.getByText("MCP server details")).toBeInTheDocument()
    expect(screen.getByText("Authentication details")).toBeInTheDocument()
  })

  it("[tag:mcp-dialog] renders Server URL input", () => {
    renderDialog(ADD_TOOL_DEFAULT_MCP_CONFIG)
    expect(screen.getByLabelText("Server URL")).toBeInTheDocument()
  })

  it("[tag:mcp-dialog] renders Add and Cancel buttons", () => {
    renderDialog(ADD_TOOL_DEFAULT_MCP_CONFIG)

    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
  })

  it("[tag:mcp-dialog] shows no-auth warning when authType is no_auth", () => {
    renderDialog({ ...ADD_TOOL_DEFAULT_MCP_CONFIG, authType: "no_auth" })
    expect(screen.getByText(/isn't authenticated/)).toBeInTheDocument()
  })

  it("[tag:mcp-dialog] saves valid enterprise_jwt_oidc config", async () => {
    const onSave = vi.fn()
    const user = userEvent.setup({ delay: null })

    renderDialog(
      {
        ...ADD_TOOL_DEFAULT_MCP_CONFIG,
        authType: "enterprise_jwt_oidc",
        serverUrl: "https://mcp.example.com",
        issuerUrl: "https://issuer.example.com",
        clientId: "client",
        scope: "read",
      },
      { ...baseHandlers, onSave },
    )

    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("[tag:mcp-dialog] saves valid oauth2_pkce config", async () => {
    const onSave = vi.fn()
    const user = userEvent.setup({ delay: null })

    renderDialog(
      {
        ...ADD_TOOL_DEFAULT_MCP_CONFIG,
        authType: "oauth2_pkce",
        serverUrl: "https://mcp.example.com",
        authorizationEndpointUrl: "https://auth.example.com/authorize",
        tokenEndpointUrl: "https://auth.example.com/token",
        clientId: "client",
      },
      { ...baseHandlers, onSave },
    )

    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("[tag:mcp-dialog] saves valid oauth2_client_credentials config", async () => {
    const onSave = vi.fn()
    const user = userEvent.setup({ delay: null })

    renderDialog(
      {
        ...ADD_TOOL_DEFAULT_MCP_CONFIG,
        authType: "oauth2_client_credentials",
        serverUrl: "https://mcp.example.com",
        tokenEndpointUrl: "https://auth.example.com/token",
        clientId: "client",
        clientSecret: "secret",
      },
      { ...baseHandlers, onSave },
    )

    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("[tag:mcp-dialog] saves valid api_key config", async () => {
    const onSave = vi.fn()
    const user = userEvent.setup({ delay: null })

    renderDialog(
      {
        ...ADD_TOOL_DEFAULT_MCP_CONFIG,
        authType: "api_key",
        serverUrl: "https://mcp.example.com",
        apiKey: "key-123",
      },
      { ...baseHandlers, onSave },
    )

    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("[tag:mcp-dialog] saves valid bearer_token config", async () => {
    const onSave = vi.fn()
    const user = userEvent.setup({ delay: null })

    renderDialog(
      {
        ...ADD_TOOL_DEFAULT_MCP_CONFIG,
        authType: "bearer_token",
        serverUrl: "https://mcp.example.com",
        bearerToken: "token-123",
      },
      { ...baseHandlers, onSave },
    )

    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("[tag:mcp-dialog] blocks save when server URL is missing", async () => {
    const onSave = vi.fn()
    const user = userEvent.setup({ delay: null })

    renderDialog({ ...ADD_TOOL_DEFAULT_MCP_CONFIG, authType: "no_auth", serverUrl: "" }, { ...baseHandlers, onSave })

    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it("[tag:mcp-dialog] saves no_auth when server URL is provided", async () => {
    const onSave = vi.fn()
    const user = userEvent.setup({ delay: null })

    renderDialog(
      { ...ADD_TOOL_DEFAULT_MCP_CONFIG, authType: "no_auth", serverUrl: "https://mcp.example.com" },
      { ...baseHandlers, onSave },
    )

    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it.each([
    "enterprise_jwt_oidc",
    "oauth2_pkce",
    "oauth2_client_credentials",
    "api_key",
    "bearer_token",
  ] as const)("[tag:mcp-dialog] blocks save for %s when auth fields are missing", async (authType) => {
    const onSave = vi.fn()
    const user = userEvent.setup({ delay: null })

    renderDialog(
      { ...ADD_TOOL_DEFAULT_MCP_CONFIG, authType, serverUrl: "https://mcp.example.com" },
      { ...baseHandlers, onSave },
    )

    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it("[tag:mcp-dialog] fills enterprise_jwt_oidc fields and shows validation on blur", async () => {
    const onDraftChange = vi.fn()
    const user = userEvent.setup({ delay: null })

    renderDialog(
      { ...ADD_TOOL_DEFAULT_MCP_CONFIG, authType: "enterprise_jwt_oidc", serverUrl: "https://mcp.example.com" },
      { ...baseHandlers, onDraftChange },
    )

    await user.type(screen.getByLabelText(/Issuer URL/), "https://issuer.example.com")
    await user.type(screen.getByLabelText(/Client ID/), "client-id")
    await user.type(screen.getByLabelText(/Scope/), "read")
    await user.type(screen.getByLabelText(/JSON Web Key Set URL/), "https://jwks.example.com")
    expect(onDraftChange).toHaveBeenCalled()
  })

  it("[tag:mcp-dialog] fills oauth2_client_credentials, api_key, and bearer fields", async () => {
    const onDraftChange = vi.fn()
    const user = userEvent.setup({ delay: null })

    const { rerender } = render(
      <CustomMcpConfigDialog
        open
        mcpConfigDraft={{
          ...ADD_TOOL_DEFAULT_MCP_CONFIG,
          authType: "oauth2_client_credentials",
          serverUrl: "https://mcp.example.com",
        }}
        {...baseHandlers}
        onDraftChange={onDraftChange}
      />,
    )

    await user.type(screen.getByLabelText(/Token endpoint URL/), "https://auth.example.com/token")
    await user.type(screen.getByLabelText(/Client ID/), "client")
    await user.type(screen.getByLabelText(/Client Secret/), "secret")

    rerender(
      <CustomMcpConfigDialog
        open
        mcpConfigDraft={{
          ...ADD_TOOL_DEFAULT_MCP_CONFIG,
          authType: "api_key",
          serverUrl: "https://mcp.example.com",
        }}
        {...baseHandlers}
        onDraftChange={onDraftChange}
      />,
    )
    await user.type(screen.getByLabelText(/API key/), "key-value")
    await user.type(screen.getByLabelText("Header name"), "X-API-Key")

    rerender(
      <CustomMcpConfigDialog
        open
        mcpConfigDraft={{
          ...ADD_TOOL_DEFAULT_MCP_CONFIG,
          authType: "bearer_token",
          serverUrl: "https://mcp.example.com",
        }}
        {...baseHandlers}
        onDraftChange={onDraftChange}
      />,
    )
    await user.type(screen.getByLabelText(/Bearer token/), "bearer-value")

    expect(onDraftChange).toHaveBeenCalled()
  })

  it("[tag:mcp-dialog] changes connection and auth type from dropdowns", async () => {
    const onDraftChange = vi.fn()
    const user = userEvent.setup({ delay: null })

    renderDialog(
      { ...ADD_TOOL_DEFAULT_MCP_CONFIG, serverUrl: "https://mcp.example.com" },
      { ...baseHandlers, onDraftChange },
    )

    await user.click(screen.getByRole("button", { name: "Connection type" }))
    await user.click(screen.getByRole("button", { name: "Type" }))

    expect(onDraftChange).toHaveBeenCalled()
  })

  it("[tag:mcp-dialog] shows validation errors for oauth2_client_credentials on save", async () => {
    const user = userEvent.setup({ delay: null })

    renderDialog({
      ...ADD_TOOL_DEFAULT_MCP_CONFIG,
      authType: "oauth2_client_credentials",
      serverUrl: "https://mcp.example.com",
      tokenEndpointUrl: "https://auth.example.com/token",
      clientId: "client",
      clientSecret: "",
    })

    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(screen.getByText("Client Secret is required")).toBeInTheDocument()
  })

  it("[tag:mcp-dialog] shows validation errors for bearer_token on save", async () => {
    const user = userEvent.setup({ delay: null })

    renderDialog({
      ...ADD_TOOL_DEFAULT_MCP_CONFIG,
      authType: "bearer_token",
      serverUrl: "https://mcp.example.com",
      bearerToken: "",
    })

    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(screen.getByText("Bearer token is required")).toBeInTheDocument()
  })

  it("[tag:mcp-dialog] shows validation errors for enterprise_jwt_oidc on save", async () => {
    const user = userEvent.setup({ delay: null })

    renderDialog({
      ...ADD_TOOL_DEFAULT_MCP_CONFIG,
      authType: "enterprise_jwt_oidc",
      serverUrl: "https://mcp.example.com",
      issuerUrl: "",
      clientId: "",
      scope: "",
    })

    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(screen.getByText("Scope is required")).toBeInTheDocument()
  })

  it("[tag:mcp-dialog] closes via escape on dialog", async () => {
    const onClose = vi.fn()
    const user = userEvent.setup({ delay: null })

    renderDialog(
      { ...ADD_TOOL_DEFAULT_MCP_CONFIG, serverUrl: "https://mcp.example.com" },
      { ...baseHandlers, onClose },
    )

    await user.keyboard("{Escape}")
    expect(onClose).toHaveBeenCalled()
  })

  it("[tag:mcp-dialog] fills oauth2_pkce fields", async () => {
    const onDraftChange = vi.fn()
    const user = userEvent.setup({ delay: null })

    renderDialog(
      {
        ...ADD_TOOL_DEFAULT_MCP_CONFIG,
        authType: "oauth2_pkce",
        serverUrl: "https://mcp.example.com",
      },
      { ...baseHandlers, onDraftChange },
    )

    await user.type(screen.getByLabelText(/Authorization endpoint URL/), "https://auth.example.com/authorize")
    await user.type(screen.getByLabelText(/Token endpoint URL/), "https://auth.example.com/token")
    await user.type(screen.getByLabelText(/Client ID/), "client")
    await user.type(screen.getByLabelText(/Scope/), "read")
    expect(onDraftChange).toHaveBeenCalled()
  })

  it("[tag:mcp-dialog] manages custom headers and rate limiting", async () => {
    const onDraftChange = vi.fn()
    const onCustomHeadersChange = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup({ delay: null })

    renderDialog(
      {
        ...ADD_TOOL_DEFAULT_MCP_CONFIG,
        authType: "no_auth",
        serverUrl: "https://mcp.example.com",
        addCustomHeaders: true,
        customHeaders: [{ key: "k1", value: "v1" }],
        applyRateLimiting: true,
        callsPerMinute: "60",
      },
      { ...baseHandlers, onDraftChange, onCustomHeadersChange, onClose },
    )

    await user.clear(screen.getByLabelText("Server URL"))
    await user.type(screen.getByLabelText("Server URL"), "https://other.example.com")
    expect(onDraftChange).toHaveBeenCalled()

    fireEvent.blur(screen.getByLabelText("Server URL"))

    await user.click(screen.getByLabelText("Add custom headers"))
    expect(onDraftChange).toHaveBeenCalled()

    await user.clear(screen.getByLabelText("Header key"))
    await user.type(screen.getByLabelText("Header key"), "Auth")
    await user.clear(screen.getByLabelText("Header value"))
    await user.type(screen.getByLabelText("Header value"), "token")
    expect(onCustomHeadersChange).toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Delete header" }))
    expect(onCustomHeadersChange).toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Add custom header" }))

    await user.click(screen.getByLabelText("Apply rate limiting"))

    await user.clear(screen.getByLabelText("Calls per minute"))
    await user.type(screen.getByLabelText("Calls per minute"), "100")

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onClose).toHaveBeenCalled()
  })
})
