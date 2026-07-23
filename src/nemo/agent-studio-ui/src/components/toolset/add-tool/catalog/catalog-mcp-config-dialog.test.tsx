import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ADD_TOOL_DEFAULT_CATALOG_STATE, CATALOG_TEMPLATES } from "./catalog.consts"
import type { CatalogFormState } from "./catalog.types"
import { CatalogMcpConfigDialog } from "./catalog-mcp-config-dialog"

const azureTemplate = CATALOG_TEMPLATES.find((t) => t.id === "azure_netapp_files")!

const filledFormState: CatalogFormState = {
  ...ADD_TOOL_DEFAULT_CATALOG_STATE,
  selectedTemplateId: "azure_netapp_files",
  catalogName: "Azure NetApp Files",
  envVarValues: {
    AZURE_SUBSCRIPTION_ID: "sub-1",
    AZURE_RESOURCE_GROUP: "rg-1",
    ANF_ACCOUNT_NAME: "account-1",
  },
  runtimeCredentialId: "cred-azure-1",
  resourcePreset: "medium",
  addCustomHeaders: true,
  customHeaders: [{ key: "X-Test", value: "value" }],
  applyRateLimiting: true,
  callsPerMinute: "120",
}

const credentialItems = [
  { key: "cred-azure-1", value: "cred-azure-1", label: "Azure prod credential" },
  { key: "cred-azure-2", value: "cred-azure-2", label: "Azure staging credential" },
]

describe("CatalogMcpConfigDialog", () => {
  const defaultProps = {
    open: true,
    template: azureTemplate,
    formState: filledFormState,
    credentialItems,
    isLoadingCredentials: false,
    onClose: vi.fn(),
    onEnvVarValueChange: vi.fn(),
    onRuntimeCredentialChange: vi.fn(),
    onResourcePresetChange: vi.fn(),
    onCustomHeadersToggle: vi.fn(),
    onCustomHeaderValuesChange: vi.fn(),
    onRateLimitingChange: vi.fn(),
    onCallsPerMinuteChange: vi.fn(),
    onSave: vi.fn(),
  }

  it("[tag:catalog-mcp-dialog] renders runtime credential and env vars", () => {
    render(<CatalogMcpConfigDialog {...defaultProps} />)

    expect(screen.getByText("Runtime Credential")).toBeInTheDocument()
    expect(screen.getByText("azure_cloud")).toBeInTheDocument()
    expect(screen.getByText("Connection details")).toBeInTheDocument()
    expect(screen.getByLabelText(/AZURE_SUBSCRIPTION_ID/)).toBeInTheDocument()
  })

  it("[tag:catalog-mcp-dialog] populates runtime credential dropdown and shows the selection", () => {
    render(<CatalogMcpConfigDialog {...defaultProps} />)

    expect(screen.getByText("Azure prod credential")).toBeInTheDocument()
    expect(
      screen.queryByText("No 'azure_cloud' credentials in this project yet"),
    ).not.toBeInTheDocument()
  })

  it("[tag:catalog-mcp-dialog] blocks save when a required runtime credential is not selected", async () => {
    const onSave = vi.fn()
    const user = userEvent.setup({ delay: null })

    render(
      <CatalogMcpConfigDialog
        {...defaultProps}
        formState={{ ...filledFormState, runtimeCredentialId: "" }}
        onSave={onSave}
      />,
    )

    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText("A 'azure_cloud' credential is required")).toBeInTheDocument()
  })

  it("[tag:catalog-mcp-dialog] blocks save when required env vars are missing", async () => {
    const onSave = vi.fn()
    const user = userEvent.setup({ delay: null })

    render(
      <CatalogMcpConfigDialog
        {...defaultProps}
        formState={{
          ...filledFormState,
          envVarValues: { AZURE_SUBSCRIPTION_ID: "", AZURE_RESOURCE_GROUP: "", ANF_ACCOUNT_NAME: "" },
        }}
        onSave={onSave}
      />,
    )

    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it("[tag:catalog-mcp-dialog] saves when required fields are valid", async () => {
    const onSave = vi.fn()
    const user = userEvent.setup({ delay: null })

    render(<CatalogMcpConfigDialog {...defaultProps} onSave={onSave} />)

    await user.click(screen.getByRole("button", { name: "Add" }))
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("[tag:catalog-mcp-dialog] calls handlers for env vars, headers, and rate limiting", async () => {
    const onEnvVarValueChange = vi.fn()
    const onCustomHeaderValuesChange = vi.fn()
    const onCallsPerMinuteChange = vi.fn()
    const onClose = vi.fn()
    const user = userEvent.setup({ delay: null })

    render(
      <CatalogMcpConfigDialog
        {...defaultProps}
        onEnvVarValueChange={onEnvVarValueChange}
        onCustomHeaderValuesChange={onCustomHeaderValuesChange}
        onCallsPerMinuteChange={onCallsPerMinuteChange}
        onClose={onClose}
      />,
    )

    await user.clear(screen.getByLabelText(/AZURE_SUBSCRIPTION_ID/))
    await user.type(screen.getByLabelText(/AZURE_SUBSCRIPTION_ID/), "sub-2")
    expect(onEnvVarValueChange).toHaveBeenCalled()

    fireEvent.blur(screen.getByLabelText(/AZURE_RESOURCE_GROUP/))

    await user.clear(screen.getByLabelText("Header key"))
    await user.type(screen.getByLabelText("Header key"), "Auth")
    await user.clear(screen.getByLabelText("Header value"))
    await user.type(screen.getByLabelText("Header value"), "token")
    expect(onCustomHeaderValuesChange).toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Delete header" }))
    expect(onCustomHeaderValuesChange).toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Add custom header" }))

    await user.clear(screen.getByLabelText("Calls per minute"))
    await user.type(screen.getByLabelText("Calls per minute"), "200")
    expect(onCallsPerMinuteChange).toHaveBeenCalled()

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onClose).toHaveBeenCalled()
  })

  it("[tag:catalog-mcp-dialog] changes resource preset selection", async () => {
    const onResourcePresetChange = vi.fn()
    const user = userEvent.setup({ delay: null })

    render(
      <CatalogMcpConfigDialog
        {...defaultProps}
        onResourcePresetChange={onResourcePresetChange}
      />,
    )

    const radios = screen.getAllByRole("radio")
    await user.click(radios[2] ?? radios[0]!)
    expect(onResourcePresetChange).toHaveBeenCalled()
  })

  it("[tag:catalog-mcp-dialog] shows helper text for optional env vars", () => {
    const fsxnTemplate = CATALOG_TEMPLATES.find((t) => t.id === "fsxn")!
    const optionalVar = fsxnTemplate.envVars.find((v) => !v.isRequired)!

    render(
      <CatalogMcpConfigDialog
        {...defaultProps}
        template={fsxnTemplate}
        formState={{
          ...filledFormState,
          envVarValues: { ...filledFormState.envVarValues, [optionalVar.key]: "" },
        }}
      />,
    )

    expect(screen.getByText(optionalVar.helperText!)).toBeInTheDocument()
  })

  it("[tag:catalog-mcp-dialog] closes via escape", async () => {
    const onClose = vi.fn()
    const user = userEvent.setup({ delay: null })

    render(<CatalogMcpConfigDialog {...defaultProps} onClose={onClose} />)
    await user.keyboard("{Escape}")
    expect(onClose).toHaveBeenCalled()
  })

  it("[tag:catalog-mcp-dialog] renders template without env vars", () => {
    const templateWithoutEnv = { ...azureTemplate, envVars: [], runtimeCredential: undefined, hasResourcePreset: false }
    render(
      <CatalogMcpConfigDialog
        {...defaultProps}
        template={templateWithoutEnv}
        formState={{ ...ADD_TOOL_DEFAULT_CATALOG_STATE, addCustomHeaders: false, applyRateLimiting: false }}
      />,
    )

    expect(screen.queryByText("Connection details")).not.toBeInTheDocument()
  })
})
