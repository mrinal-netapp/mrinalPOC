import { act, renderHook } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { Provider } from "react-redux"
import { describe, expect, it } from "vitest"

import { createMockStore } from "@test/mocks"

import { resetAddToolState } from "../reducer"
import { useAddToolFormState } from "./add-tool.actions"

describe("useAddToolFormState", () => {
  const renderAddHook = () => {
    const store = createMockStore()
    store.dispatch(resetAddToolState())

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(Provider, { store, children })

    return { store, ...renderHook(() => useAddToolFormState(), { wrapper }) }
  }

  it("[tag:add-tool-state] exposes default values after reset", () => {
    const { result } = renderAddHook()

    expect(result.current.activeTabId).toBe("custom")
    expect(result.current.name).toBe("")
    expect(result.current.description).toBe("")
    expect(result.current.mcpConnectionStatus).toBe("not_configured")
  })

  it("[tag:add-tool-state] updates name via setName", () => {
    const { result } = renderAddHook()

    act(() => {
      result.current.setName("test-tool")
    })

    expect(result.current.name).toBe("test-tool")
  })

  it("[tag:add-tool-state] updates description via setDescription", () => {
    const { result } = renderAddHook()

    act(() => {
      result.current.setDescription("tool desc")
    })

    expect(result.current.description).toBe("tool desc")
  })

  it("[tag:add-tool-state] updates tab via setActiveTabId", () => {
    const { result } = renderAddHook()

    act(() => {
      result.current.setActiveTabId("catalog")
    })

    expect(result.current.activeTabId).toBe("catalog")
  })

  it("[tag:add-tool-state] handles label changes", () => {
    const { result } = renderAddHook()

    act(() => {
      result.current.onLabelChange(["production"])
    })

    expect(result.current.selectedLabels).toEqual(["production"])
  })

  it("[tag:add-tool-state] opens and closes MCP dialog", () => {
    const { result } = renderAddHook()

    act(() => {
      result.current.openMcpDialog()
    })
    expect(result.current.mcpConfigDialogOpen).toBe(true)

    act(() => {
      result.current.closeMcpDialog()
    })
    expect(result.current.mcpConfigDialogOpen).toBe(false)
  })

  it("[tag:add-tool-state] saves MCP config", () => {
    const { result } = renderAddHook()

    act(() => {
      result.current.openMcpDialog()
      result.current.setMcpDraft({ serverUrl: "https://test.com" })
      result.current.saveMcpDialog()
    })

    expect(result.current.savedMcpConfig?.serverUrl).toBe("https://test.com")
    expect(result.current.mcpConfigDialogOpen).toBe(false)
  })

  it("[tag:add-tool-state] sets validation result", () => {
    const { result } = renderAddHook()

    act(() => {
      result.current.setMcpValidationResult("successful", "Connected")
    })

    expect(result.current.mcpConnectionStatus).toBe("successful")
    expect(result.current.mcpValidationMessage).toBe("Connected")
  })

  it("[tag:add-tool-state] handles label branches and catalog actions", () => {
    const { result } = renderAddHook()

    act(() => {
      result.current.onLabelChange("staging")
      result.current.onLabelChange(["staging", "production"])
      result.current.onLabelChange(null)
      result.current.onAddLabel("Team-C")
      result.current.setMcpCustomHeaders([{ key: "X", value: "1" }])
      result.current.onSelectCatalogTemplate("azure_netapp_files")
      result.current.onCatalogNameChange("catalog-name")
      result.current.onCatalogDescriptionChange("catalog-desc")
      result.current.onCatalogEnvVarValueChange("AZURE_SUBSCRIPTION_ID", "sub")
      result.current.onCatalogResourcePresetChange("large")
      result.current.onCatalogCustomHeadersToggle(true)
      result.current.onCatalogCustomHeaderValuesChange([{ key: "h", value: "v" }])
      result.current.onCatalogRateLimitingChange(true)
      result.current.onCatalogCallsPerMinuteChange("90")
      result.current.onCatalogRetryCountChange("5")
      result.current.onCatalogTimeoutMsChange("45000")
      result.current.onCatalogRetryTimeoutExpandedChange(true)
      result.current.openCatalogMcpDialog()
      result.current.closeCatalogMcpDialog()
      result.current.saveCatalogMcpDialog()
    })

    expect(result.current.selectedLabels).toContain("team-c")
    expect(result.current.catalog.catalogName).toBe("catalog-name")
    expect(result.current.catalog.mcpConfigSaved).toBe(true)
  })
})
