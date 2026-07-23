import { screen } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach } from "vitest"

import { renderWithProviders } from "@test/render"

import { ADD_TOOL_STRINGS } from "../add-tool.consts"
import { ADD_TOOL_DEFAULT_CATALOG_STATE, CATALOG_TEMPLATES } from "./catalog.consts"
import type { CatalogFormState } from "./catalog.types"

import { CatalogMcpConfigCard } from "./catalog-mcp-config-card"

const { mockUseListCredentialsQuery } = vi.hoisted(() => ({
  mockUseListCredentialsQuery: vi.fn(() => ({
    data: [
      { id: "cred-azure-1", name: "My Azure SP", provider: "azure_cloud", projectId: "proj-1" },
    ],
    isFetching: false,
  })),
}))

vi.mock("@/routes/pages/credentials/credential-api.slice", () => ({
  useListCredentialsQuery: mockUseListCredentialsQuery,
}))

describe("CatalogMcpConfigCard", () => {
  const template = CATALOG_TEMPLATES[0]
  const defaultProps = {
    projectId: "proj-1",
    template,
    formState: { ...ADD_TOOL_DEFAULT_CATALOG_STATE } as CatalogFormState,
    onConfigure: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("[tag:catalog-mcp-card] renders MCP section title", () => {
    renderWithProviders(<CatalogMcpConfigCard {...defaultProps} />)

    expect(screen.getByText(ADD_TOOL_STRINGS.MCP_SECTION_TITLE)).toBeInTheDocument()
  })

  it("[tag:catalog-mcp-card] renders MCP section subtitle", () => {
    renderWithProviders(<CatalogMcpConfigCard {...defaultProps} />)

    expect(screen.getByText(ADD_TOOL_STRINGS.MCP_SECTION_SUBTITLE)).toBeInTheDocument()
  })

  it("[tag:catalog-mcp-card] renders Configure button", () => {
    renderWithProviders(<CatalogMcpConfigCard {...defaultProps} />)

    expect(screen.getByRole("button", { name: ADD_TOOL_STRINGS.CONFIGURE_ACTION_LABEL })).toBeInTheDocument()
  })

  it("[tag:catalog-mcp-card] shows 'not-configured' status before save", () => {
    renderWithProviders(<CatalogMcpConfigCard {...defaultProps} />)

    expect(screen.getByText("Not configured")).toBeInTheDocument()
  })

  it("[tag:catalog-mcp-card] shows saved details after successful validation", () => {
    const savedState: CatalogFormState = {
      ...ADD_TOOL_DEFAULT_CATALOG_STATE,
      selectedTemplateId: "azure_netapp_files",
      mcpConfigSaved: true,
      catalogMcpConnectionStatus: "successful",
      runtimeCredentialId: "cred-azure-1",
      envVarValues: { AZURE_SUBSCRIPTION_ID: "sub-123" },
      resourcePreset: "small",
    }

    renderWithProviders(
      <CatalogMcpConfigCard {...defaultProps} formState={savedState} />,
    )

    expect(screen.getByText("Connected")).toBeInTheDocument()
    expect(screen.getByText("Runtime Credential")).toBeInTheDocument()
    expect(screen.getByText("My Azure SP")).toBeInTheDocument()
    expect(screen.getByText("AZURE_SUBSCRIPTION_ID")).toBeInTheDocument()
    expect(screen.getByText("sub-123")).toBeInTheDocument()
  })

  it("[tag:catalog-mcp-card] shows error status when validation failed", () => {
    const savedState: CatalogFormState = {
      ...ADD_TOOL_DEFAULT_CATALOG_STATE,
      selectedTemplateId: "azure_netapp_files",
      mcpConfigSaved: false,
      catalogMcpConnectionStatus: "failed",
      catalogMcpValidationMessage: "ANF account not found",
      runtimeCredentialId: "cred-azure-1",
      envVarValues: { AZURE_SUBSCRIPTION_ID: "sub-123" },
      resourcePreset: "small",
    }

    renderWithProviders(
      <CatalogMcpConfigCard {...defaultProps} formState={savedState} />,
    )

    expect(screen.getByText("Error")).toBeInTheDocument()
    expect(screen.queryByText("Connected")).not.toBeInTheDocument()
  })

  it("[tag:catalog-mcp-card] skips credential list query when no runtimeCredentialId", () => {
    const savedState: CatalogFormState = {
      ...ADD_TOOL_DEFAULT_CATALOG_STATE,
      selectedTemplateId: "azure_netapp_files",
      mcpConfigSaved: true,
      catalogMcpConnectionStatus: "successful",
      runtimeCredentialId: "",
      envVarValues: { AZURE_SUBSCRIPTION_ID: "sub-123" },
      resourcePreset: "small",
    }

    renderWithProviders(
      <CatalogMcpConfigCard {...defaultProps} formState={savedState} />,
    )

    expect(mockUseListCredentialsQuery).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-1", provider: "azure_cloud" }),
      expect.objectContaining({ skip: true }),
    )
    expect(screen.getByText("Runtime Credential")).toBeInTheDocument()
    expect(screen.getByText("azure_cloud")).toBeInTheDocument()
    expect(screen.queryByText("cred-azure-1")).not.toBeInTheDocument()
  })
})
