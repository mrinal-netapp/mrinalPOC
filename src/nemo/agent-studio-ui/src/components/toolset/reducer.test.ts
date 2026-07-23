import { describe, expect, it, vi } from "vitest"

import { createInitialAddToolFormState } from "./model"

vi.mock("./add-tool/catalog/catalog.consts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./add-tool/catalog/catalog.consts")>()
  const templateWithoutPreset = {
    ...actual.CATALOG_TEMPLATES[0]!,
    id: "no_default_preset",
    name: "No Preset Template",
  }
  delete (templateWithoutPreset as { defaultResourcePreset?: string }).defaultResourcePreset

  return {
    ...actual,
    CATALOG_TEMPLATES: [...actual.CATALOG_TEMPLATES, templateWithoutPreset],
  }
})
import {
  addAddToolLabel,
  addEditToolLabel,
  closeCatalogMcpConfigDialog,
  closeMcpConfigDialog,
  loadEditToolForm,
  openCatalogMcpConfigDialog,
  openMcpConfigDialog,
  resetAddToolState,
  resetDetailState,
  resetEditToolState,
  resetToolsetFilters,
  saveCatalogMcpConfig,
  saveMcpConfig,
  selectCatalogTemplate,
  setAddToolActiveTabId,
  setAddToolDescription,
  setAddToolName,
  setAddToolSelectedLabels,
  setCatalogCallsPerMinute,
  setCatalogCustomHeaderValues,
  setCatalogCustomHeaders,
  setCatalogDescription,
  setCatalogEnvVarValue,
  setCatalogName,
  setCatalogRateLimiting,
  setCatalogResourcePreset,
  setCatalogRetryCount,
  setCatalogRetryTimeoutExpanded,
  setCatalogTimeoutMs,
  setDetailData,
  setDetailError,
  setDetailLoading,
  setDetailMcpExpanded,
  setDetailMetricsCollapsed,
  setDetailOverviewTimeRange,
  setDetailToolId,
  setEditAddCustomHeaders,
  setEditApplyRateLimiting,
  setEditCallsPerMinute,
  setEditConfigFieldValue,
  setEditCustomHeaders,
  setEditDescription,
  setEditSelectedLabels,
  setEditSubmitted,
  setEditToolId,
  setListError,
  setListItems,
  setListLoading,
  setMcpConfigCustomHeaders,
  setMcpConfigDraft,
  setMcpValidationResult,
  setToolsetFilters,
  toolsetReducer,
} from "./reducer"
import { TOOLSET_AGENTS_FIXTURE, TOOLSET_DETAIL_FIXTURE } from "./toolset-detail/toolset-detail.fixtures"
import type { EditToolLoadPayload } from "./toolset.types"

const editPayload: EditToolLoadPayload = {
  name: "tool-mcp-01",
  description: "description",
  labels: ["staging"],
  addCustomHeaders: false,
  customHeaders: [],
  addForwardedHeaders: false,
  forwardedHeaders: [""],
  applyRateLimiting: false,
  callsPerMinute: "",
  configFields: [{ key: "serverUrl", label: "Server URL", value: "https://example.com", isRequired: true }],
}

describe("toolsetReducer", () => {
  it("[tag:toolset][tag:redux] returns the initial state", () => {
    const state = toolsetReducer(undefined, { type: "@@INIT" })

    expect(state.listFilters).toEqual({})
    expect(state.addToolForm.activeTabId).toBe("custom")
    expect(state.addToolForm.name).toBe("")
    expect(state.addToolForm.description).toBe("")
    expect(state.addToolForm.selectedLabels).toEqual([])
    expect(state.list.items).toEqual([])
    expect(state.editToolForm.toolId).toBeNull()
  })

  it("[tag:toolset][tag:redux] sets and resets toolset filters", () => {
    const withFilters = toolsetReducer(undefined, setToolsetFilters({ limit: 20, offset: 0 }))
    expect(withFilters.listFilters).toEqual({ limit: 20, offset: 0 })

    const reset = toolsetReducer(withFilters, resetToolsetFilters())
    expect(reset.listFilters).toEqual({})
  })

  it("[tag:toolset][tag:redux] updates add tool primitive fields", () => {
    const withTab = toolsetReducer(undefined, setAddToolActiveTabId("catalog"))
    const withName = toolsetReducer(withTab, setAddToolName("tool-name"))
    const withDescription = toolsetReducer(withName, setAddToolDescription("description"))
    const withSelectedLabels = toolsetReducer(withDescription, setAddToolSelectedLabels(["staging"]))

    expect(withSelectedLabels.addToolForm.activeTabId).toBe("catalog")
    expect(withSelectedLabels.addToolForm.name).toBe("tool-name")
    expect(withSelectedLabels.addToolForm.description).toBe("description")
    expect(withSelectedLabels.addToolForm.selectedLabels).toEqual(["staging"])
  })

  it("[tag:toolset][tag:redux] adds label and avoids duplicates/blank values", () => {
    const withBlank = toolsetReducer(undefined, addAddToolLabel("   "))
    expect(withBlank.addToolForm.labelItems).toHaveLength(3)

    const withNewLabel = toolsetReducer(withBlank, addAddToolLabel("Team-A"))
    expect(withNewLabel.addToolForm.labelItems).toHaveLength(4)
    expect(withNewLabel.addToolForm.selectedLabels).toContain("team-a")

    const withDuplicate = toolsetReducer(withNewLabel, addAddToolLabel("team-a"))
    expect(withDuplicate.addToolForm.selectedLabels.filter((item) => item === "team-a")).toHaveLength(1)

    const withStagingAgain = toolsetReducer(undefined, addAddToolLabel("staging"))
    const again = toolsetReducer(withStagingAgain, addAddToolLabel("staging"))
    expect(again.addToolForm.selectedLabels.filter((label) => label === "staging")).toHaveLength(1)
  })

  it("[tag:toolset][tag:redux] resets add tool form to defaults", () => {
    const dirtyState = toolsetReducer(
      toolsetReducer(undefined, setAddToolName("dirty")),
      addAddToolLabel("new-label"),
    )
    const resetState = toolsetReducer(dirtyState, resetAddToolState())

    expect(resetState.addToolForm.name).toBe("")
    expect(resetState.addToolForm.selectedLabels).toEqual([])
  })

  it("[tag:toolset][tag:redux] setListItems stores list rows", () => {
    const state = toolsetReducer(
      undefined,
      setListItems([{ tool_id: "t1", tool_name: "Tool 1" } as never]),
    )
    expect(state.list.items).toHaveLength(1)
  })

  it("[tag:toolset][tag:redux] sets list loading and error flags", () => {
    const loading = toolsetReducer(undefined, setListLoading(true))
    const errored = toolsetReducer(loading, setListError(true))

    expect(errored.list.isLoading).toBe(true)
    expect(errored.list.isError).toBe(true)
  })

  it("[tag:toolset][tag:redux] handles MCP dialog draft actions", () => {
    let state = toolsetReducer(undefined, openMcpConfigDialog())
    expect(state.addToolForm.mcpConfigDialogOpen).toBe(true)

    state = toolsetReducer(state, setMcpConfigDraft({ serverUrl: "https://mcp.example.com" }))
    state = toolsetReducer(state, setMcpConfigCustomHeaders([{ key: "X-Test", value: "1" }]))
    state = toolsetReducer(state, saveMcpConfig())
    expect(state.addToolForm.savedMcpConfig?.serverUrl).toBe("https://mcp.example.com")

    state = toolsetReducer(state, openMcpConfigDialog())
    expect(state.addToolForm.mcpConfigDraft.serverUrl).toBe("https://mcp.example.com")

    state = toolsetReducer(state, closeMcpConfigDialog())
    expect(state.addToolForm.mcpConfigDialogOpen).toBe(false)

    const fresh = toolsetReducer(undefined, closeMcpConfigDialog())
    expect(fresh.addToolForm.mcpConfigDraft).toEqual(createInitialAddToolFormState().mcpConfigDraft)
  })

  it("[tag:toolset][tag:redux] sets MCP validation result", () => {
    const state = toolsetReducer(
      undefined,
      setMcpValidationResult({ status: "failed", message: "Connection failed" }),
    )
    expect(state.addToolForm.mcpConnectionStatus).toBe("failed")
    expect(state.addToolForm.mcpValidationMessage).toBe("Connection failed")
  })

  it("[tag:toolset][tag:redux] handles catalog template and field actions", () => {
    const invalid = toolsetReducer(undefined, selectCatalogTemplate("not_a_template" as never))
    expect(invalid.addToolForm.catalog.selectedTemplateId).toBeNull()

    const withoutPreset = toolsetReducer(undefined, selectCatalogTemplate("no_default_preset" as never))
    expect(withoutPreset.addToolForm.catalog.resourcePreset).toBe("small")

    let state = toolsetReducer(undefined, selectCatalogTemplate("azure_netapp_files"))
    expect(state.addToolForm.catalog.selectedTemplateId).toBe("azure_netapp_files")
    expect(state.addToolForm.name).toBe("Azure NetApp Files")

    state = toolsetReducer(state, setCatalogName("my-server"))
    state = toolsetReducer(state, setCatalogDescription("desc"))
    state = toolsetReducer(state, setCatalogEnvVarValue({ key: "AZURE_SUBSCRIPTION_ID", value: "sub-1" }))
    state = toolsetReducer(state, setCatalogResourcePreset("large"))
    state = toolsetReducer(state, setCatalogCustomHeaders(true))
    state = toolsetReducer(state, setCatalogCustomHeaderValues([{ key: "k", value: "v" }]))
    state = toolsetReducer(state, setCatalogRateLimiting(true))
    state = toolsetReducer(state, setCatalogCallsPerMinute("120"))
    state = toolsetReducer(state, setCatalogRetryCount("5"))
    state = toolsetReducer(state, setCatalogTimeoutMs("60000"))
    state = toolsetReducer(state, setCatalogRetryTimeoutExpanded(true))
    state = toolsetReducer(state, openCatalogMcpConfigDialog())
    state = toolsetReducer(state, closeCatalogMcpConfigDialog())
    state = toolsetReducer(state, saveCatalogMcpConfig())

    expect(state.addToolForm.catalog.catalogName).toBe("my-server")
    expect(state.addToolForm.catalog.mcpConfigSaved).toBe(true)
  })

  it("[tag:toolset][tag:redux] loadEditToolForm sets edit form fields", () => {
    const state = toolsetReducer(
      undefined,
      loadEditToolForm({ toolId: "tool-mcp-01", ...editPayload }),
    )
    expect(state.editToolForm.toolId).toBe("tool-mcp-01")
    expect(state.editToolForm.name).toBe("tool-mcp-01")
  })

  it("[tag:toolset][tag:redux] resets and updates edit form fields", () => {
    const resetState = toolsetReducer(
      toolsetReducer(undefined, loadEditToolForm({ toolId: "t1", ...editPayload })),
      resetEditToolState(),
    )
    expect(resetState.editToolForm.toolId).toBeNull()

    let state = toolsetReducer(undefined, loadEditToolForm({ toolId: "t1", ...editPayload }))

    state = toolsetReducer(state, setEditDescription("new desc"))
    state = toolsetReducer(state, setEditSelectedLabels(["staging", "prod"]))
    state = toolsetReducer(state, addEditToolLabel("   "))
    state = toolsetReducer(state, addEditToolLabel("Team-B"))
    state = toolsetReducer(state, addEditToolLabel("team-b"))
    state = toolsetReducer(state, setEditAddCustomHeaders(true))
    state = toolsetReducer(state, setEditCustomHeaders([{ key: "h", value: "v" }]))
    state = toolsetReducer(state, setEditApplyRateLimiting(true))
    state = toolsetReducer(state, setEditCallsPerMinute("90"))
    state = toolsetReducer(state, setEditSubmitted(true))

    expect(state.editToolForm.description).toBe("new desc")
    expect(state.editToolForm.selectedLabels).toContain("team-b")
    expect(state.editToolForm.submitted).toBe(true)
  })

  it("[tag:toolset][tag:redux] detail and edit reducers update slice fields", () => {
    const withDetail = toolsetReducer(
      undefined,
      setDetailData({
        toolId: TOOLSET_DETAIL_FIXTURE.id,
        tool: TOOLSET_DETAIL_FIXTURE,
        agents: TOOLSET_AGENTS_FIXTURE,
      }),
    )
    expect(withDetail.detail.tool?.name).toBe("tool-mcp-01")

    const withOverview = toolsetReducer(withDetail, setDetailOverviewTimeRange("Last week"))
    const collapsed = toolsetReducer(withOverview, setDetailMetricsCollapsed(true))
    const mcpCollapsed = toolsetReducer(collapsed, setDetailMcpExpanded(false))

    expect(mcpCollapsed.detail.overviewTimeRange).toBe("Last week")
    expect(mcpCollapsed.detail.isMetricsCollapsed).toBe(true)
    expect(mcpCollapsed.detail.mcpExpanded).toBe(false)

    const loading = toolsetReducer(undefined, setDetailLoading(true))
    const errored = toolsetReducer(loading, setDetailError(true))
    expect(errored.detail.isLoading).toBe(true)
    expect(errored.detail.isError).toBe(true)

    const resetDetail = toolsetReducer(errored, resetDetailState())
    expect(resetDetail.detail.isLoading).toBe(false)
    expect(resetDetail.detail.isError).toBe(false)

    const withToolId = toolsetReducer(resetDetail, setDetailToolId("route-id"))
    expect(withToolId.detail.toolId).toBe("route-id")

    const withEditId = toolsetReducer(undefined, setEditToolId("edit-id"))
    const withField = toolsetReducer(
      withEditId,
      setEditConfigFieldValue({ key: "serverUrl", value: "https://example.com" }),
    )
    const withLabel = toolsetReducer(withField, addEditToolLabel("Team-A"))

    expect(withLabel.editToolForm.toolId).toBe("edit-id")
    expect(withLabel.editToolForm.selectedLabels).toContain("team-a")
  })
})
