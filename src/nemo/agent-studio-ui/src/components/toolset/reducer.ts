import { createSlice, type PayloadAction } from "@reduxjs/toolkit"

import type { ToolListParams } from "./toolset-list/toolset-list.types"
import type { AddToolMcpConfig, AddToolMcpConnectionStatus, AddToolMode } from "./add-tool/add-tool.types"
import type { AddToolMcpHeader } from "./add-tool/add-tool.types"
import type { CatalogFormState, CatalogTemplateId } from "./add-tool/catalog/catalog.types"
import { ADD_TOOL_DEFAULT_CATALOG_STATE, CATALOG_TEMPLATES } from "./add-tool/catalog/catalog.consts"
import type { TimeRangeOption } from "./toolset-detail/toolset-overview.types"
import type { EditToolLoadPayload } from "./toolset.types"

import {
  createInitialAddToolFormState,
  createInitialDetailState,
  createInitialEditToolFormState,
  createInitialToolsetState,
  TOOLSET_STORE_SLICE_NAME,
  type ToolsetState,
} from "./model"
import type { ToolsetAgentRow, ToolsetDetailRecord } from "./toolset.types"

const initialState: ToolsetState = createInitialToolsetState()

const toolsetSlice = createSlice({
  name: TOOLSET_STORE_SLICE_NAME,
  initialState,
  reducers: {
    setToolsetFilters(state, action: PayloadAction<Partial<ToolListParams>>) {
      state.listFilters = { ...state.listFilters, ...action.payload }
    },
    resetToolsetFilters(state) {
      state.listFilters = {}
    },
    resetAddToolState(state) {
      state.addToolForm = createInitialAddToolFormState()
    },
    setAddToolActiveTabId(state, action: PayloadAction<AddToolMode>) {
      state.addToolForm.activeTabId = action.payload
    },
    setAddToolName(state, action: PayloadAction<string>) {
      state.addToolForm.name = action.payload
    },
    setAddToolDescription(state, action: PayloadAction<string>) {
      state.addToolForm.description = action.payload
    },
    setAddToolSelectedLabels(state, action: PayloadAction<string[]>) {
      state.addToolForm.selectedLabels = action.payload
    },
    openMcpConfigDialog(state) {
      state.addToolForm.mcpConfigDialogOpen = true
      state.addToolForm.mcpConfigDraft = state.addToolForm.savedMcpConfig
        ? { ...state.addToolForm.savedMcpConfig }
        : createInitialAddToolFormState().mcpConfigDraft
    },
    closeMcpConfigDialog(state) {
      state.addToolForm.mcpConfigDialogOpen = false
      state.addToolForm.mcpConfigDraft = state.addToolForm.savedMcpConfig
        ? { ...state.addToolForm.savedMcpConfig }
        : createInitialAddToolFormState().mcpConfigDraft
    },
    setMcpConfigDraft(state, action: PayloadAction<Partial<AddToolMcpConfig>>) {
      state.addToolForm.mcpConfigDraft = { ...state.addToolForm.mcpConfigDraft, ...action.payload }
    },
    setMcpConfigCustomHeaders(state, action: PayloadAction<Array<{ key: string; value: string }>>) {
      state.addToolForm.mcpConfigDraft.customHeaders = action.payload
    },
    setMcpConfigForwardedHeaders(state, action: PayloadAction<string[]>) {
      state.addToolForm.mcpConfigDraft.forwardedHeaders = action.payload
    },
    saveMcpConfig(state) {
      state.addToolForm.savedMcpConfig = { ...state.addToolForm.mcpConfigDraft }
      state.addToolForm.mcpConfigDialogOpen = false
    },
    setMcpValidationResult(
      state,
      action: PayloadAction<{
        status: AddToolMcpConnectionStatus
        message: string | null
      }>,
    ) {
      state.addToolForm.mcpConnectionStatus = action.payload.status
      state.addToolForm.mcpValidationMessage = action.payload.message
    },
    addAddToolLabel(state, action: PayloadAction<string>) {
      const trimmedValue = action.payload.trim()
      const normalizedValue = trimmedValue.toLowerCase()
      if (!normalizedValue) return

      const hasLabel = state.addToolForm.labelItems.some((item) => item.value === normalizedValue)
      if (!hasLabel) {
        state.addToolForm.labelItems.push({
          key: normalizedValue,
          value: normalizedValue,
          label: trimmedValue,
        })
      }

      const isSelected = state.addToolForm.selectedLabels.some((item) => item === normalizedValue)
      if (!isSelected) {
        state.addToolForm.selectedLabels.push(normalizedValue)
      }
    },

    // Catalog actions
    selectCatalogTemplate(state, action: PayloadAction<CatalogTemplateId>) {
      const template = CATALOG_TEMPLATES.find((t) => t.id === action.payload)
      if (!template) return

      const envVarValues: Record<string, string> = {}
      for (const envVar of template.envVars) {
        envVarValues[envVar.key] = envVar.value
      }

      state.addToolForm.catalog = {
        ...ADD_TOOL_DEFAULT_CATALOG_STATE,
        selectedTemplateId: action.payload,
        catalogName: template.name,
        catalogDescription: template.description,
        envVarValues,
        resourcePreset: template.defaultResourcePreset ?? "small",
      }
      state.addToolForm.name = template.name
      state.addToolForm.description = template.description
    },
    setCatalogName(state, action: PayloadAction<string>) {
      state.addToolForm.catalog.catalogName = action.payload
    },
    setCatalogDescription(state, action: PayloadAction<string>) {
      state.addToolForm.catalog.catalogDescription = action.payload
    },
    setCatalogEnvVarValue(state, action: PayloadAction<{ key: string; value: string }>) {
      state.addToolForm.catalog.envVarValues[action.payload.key] = action.payload.value
      state.addToolForm.catalog.mcpConfigSaved = false
      state.addToolForm.catalog.catalogMcpConnectionStatus = "not_configured"
      state.addToolForm.catalog.catalogMcpValidationMessage = null
    },
    setCatalogRuntimeCredentialId(state, action: PayloadAction<string>) {
      state.addToolForm.catalog.runtimeCredentialId = action.payload
      state.addToolForm.catalog.mcpConfigSaved = false
      state.addToolForm.catalog.catalogMcpConnectionStatus = "not_configured"
      state.addToolForm.catalog.catalogMcpValidationMessage = null
    },
    setCatalogResourcePreset(state, action: PayloadAction<CatalogFormState["resourcePreset"]>) {
      state.addToolForm.catalog.resourcePreset = action.payload
    },
    setCatalogCustomHeaders(state, action: PayloadAction<boolean>) {
      state.addToolForm.catalog.addCustomHeaders = action.payload
    },
    setCatalogCustomHeaderValues(state, action: PayloadAction<Array<{ key: string; value: string }>>) {
      state.addToolForm.catalog.customHeaders = action.payload
    },
    setCatalogRateLimiting(state, action: PayloadAction<boolean>) {
      state.addToolForm.catalog.applyRateLimiting = action.payload
    },
    setCatalogCallsPerMinute(state, action: PayloadAction<string>) {
      state.addToolForm.catalog.callsPerMinute = action.payload
    },
    setCatalogRetryCount(state, action: PayloadAction<string>) {
      state.addToolForm.catalog.retryCount = action.payload
    },
    setCatalogTimeoutMs(state, action: PayloadAction<string>) {
      state.addToolForm.catalog.timeoutMs = action.payload
    },
    setCatalogRetryTimeoutExpanded(state, action: PayloadAction<boolean>) {
      state.addToolForm.catalog.isRetryTimeoutExpanded = action.payload
    },
    openCatalogMcpConfigDialog(state) {
      state.addToolForm.catalog.mcpConfigDialogOpen = true
    },
    closeCatalogMcpConfigDialog(state) {
      state.addToolForm.catalog.mcpConfigDialogOpen = false
    },
    saveCatalogMcpConfig(state) {
      state.addToolForm.catalog.mcpConfigDialogOpen = false
      state.addToolForm.catalog.mcpConfigSaved = true
    },
    setCatalogMcpValidationResult(
      state,
      action: PayloadAction<{
        status: AddToolMcpConnectionStatus
        message: string | null
      }>,
    ) {
      state.addToolForm.catalog.catalogMcpConnectionStatus = action.payload.status
      state.addToolForm.catalog.catalogMcpValidationMessage = action.payload.message
    },

    // List
    setListLoading(state, action: PayloadAction<boolean>) {
      state.list.isLoading = action.payload
    },
    setListError(state, action: PayloadAction<boolean>) {
      state.list.isError = action.payload
    },
    setListItems(state, action: PayloadAction<ToolsetState["list"]["items"]>) {
      state.list.items = action.payload
    },

    // Edit
    resetEditToolState(state) {
      state.editToolForm = createInitialEditToolFormState()
    },
    loadEditToolForm(
      state,
      action: PayloadAction<EditToolLoadPayload & { toolId: string }>,
    ) {
      const { toolId, configFields, labels, ...rest } = action.payload
      state.editToolForm = {
        ...createInitialEditToolFormState(),
        toolId,
        ...rest,
        configFields: configFields.map((field) => ({ ...field })),
        selectedLabels: [...labels],
        labelItems: createInitialEditToolFormState().labelItems,
      }
    },
    setEditToolId(state, action: PayloadAction<string>) {
      state.editToolForm.toolId = action.payload
    },
    setEditDescription(state, action: PayloadAction<string>) {
      state.editToolForm.description = action.payload
    },
    setEditSelectedLabels(state, action: PayloadAction<string[]>) {
      state.editToolForm.selectedLabels = action.payload
    },
    addEditToolLabel(state, action: PayloadAction<string>) {
      const trimmedValue = action.payload.trim()
      const normalizedValue = trimmedValue.toLowerCase()
      if (!normalizedValue) return

      const hasLabel = state.editToolForm.labelItems.some((item) => item.value === normalizedValue)
      if (!hasLabel) {
        state.editToolForm.labelItems.push({
          key: normalizedValue,
          value: normalizedValue,
          label: trimmedValue,
        })
      }

      if (!state.editToolForm.selectedLabels.includes(normalizedValue)) {
        state.editToolForm.selectedLabels.push(normalizedValue)
      }
    },
    setEditConfigDialogOpen(state, action: PayloadAction<boolean>) {
      state.editToolForm.configDialogOpen = action.payload
    },
    setEditConfigFieldValue(state, action: PayloadAction<{ key: string; value: string }>) {
      const { key, value } = action.payload
      state.editToolForm.configFields = state.editToolForm.configFields.map((field) =>
        field.key === key ? { ...field, value } : field,
      )
    },
    setEditAddCustomHeaders(state, action: PayloadAction<boolean>) {
      state.editToolForm.addCustomHeaders = action.payload
    },
    setEditCustomHeaders(state, action: PayloadAction<AddToolMcpHeader[]>) {
      state.editToolForm.customHeaders = action.payload
    },
    setEditAddForwardedHeaders(state, action: PayloadAction<boolean>) {
      state.editToolForm.addForwardedHeaders = action.payload
    },
    setEditForwardedHeaders(state, action: PayloadAction<string[]>) {
      state.editToolForm.forwardedHeaders = action.payload
    },
    setEditApplyRateLimiting(state, action: PayloadAction<boolean>) {
      state.editToolForm.applyRateLimiting = action.payload
    },
    setEditCallsPerMinute(state, action: PayloadAction<string>) {
      state.editToolForm.callsPerMinute = action.payload
    },
    setEditSubmitted(state, action: PayloadAction<boolean>) {
      state.editToolForm.submitted = action.payload
    },

    // Detail
    resetDetailState(state) {
      state.detail = createInitialDetailState()
    },
    setDetailOverviewTimeRange(state, action: PayloadAction<TimeRangeOption | null>) {
      state.detail.overviewTimeRange = action.payload
    },
    setDetailMetricsCollapsed(state, action: PayloadAction<boolean>) {
      state.detail.isMetricsCollapsed = action.payload
    },
    setDetailMcpExpanded(state, action: PayloadAction<boolean>) {
      state.detail.mcpExpanded = action.payload
    },
    setDetailData(
      state,
      action: PayloadAction<{ toolId: string; tool: ToolsetDetailRecord; agents: ToolsetAgentRow[] }>,
    ) {
      state.detail.toolId = action.payload.toolId
      state.detail.tool = action.payload.tool
      state.detail.agents = action.payload.agents
      state.detail.isLoading = false
      state.detail.isError = false
    },
    setDetailLoading(state, action: PayloadAction<boolean>) {
      state.detail.isLoading = action.payload
    },
    setDetailError(state, action: PayloadAction<boolean>) {
      state.detail.isError = action.payload
    },
    setDetailToolId(state, action: PayloadAction<string>) {
      state.detail.toolId = action.payload
    },
  },
})

export const {
  setToolsetFilters,
  resetToolsetFilters,
  resetAddToolState,
  setAddToolActiveTabId,
  setAddToolName,
  setAddToolDescription,
  setAddToolSelectedLabels,
  openMcpConfigDialog,
  closeMcpConfigDialog,
  setMcpConfigDraft,
  setMcpConfigCustomHeaders,
  setMcpConfigForwardedHeaders,
  saveMcpConfig,
  setMcpValidationResult,
  addAddToolLabel,
  selectCatalogTemplate,
  setCatalogName,
  setCatalogDescription,
  setCatalogEnvVarValue,
  setCatalogRuntimeCredentialId,
  setCatalogResourcePreset,
  setCatalogCustomHeaders,
  setCatalogCustomHeaderValues,
  setCatalogRateLimiting,
  setCatalogCallsPerMinute,
  setCatalogRetryCount,
  setCatalogTimeoutMs,
  setCatalogRetryTimeoutExpanded,
  openCatalogMcpConfigDialog,
  closeCatalogMcpConfigDialog,
  saveCatalogMcpConfig,
  setCatalogMcpValidationResult,
  setListLoading,
  setListError,
  setListItems,
  resetEditToolState,
  loadEditToolForm,
  setEditToolId,
  setEditDescription,
  setEditSelectedLabels,
  addEditToolLabel,
  setEditConfigDialogOpen,
  setEditConfigFieldValue,
  setEditAddCustomHeaders,
  setEditCustomHeaders,
  setEditAddForwardedHeaders,
  setEditForwardedHeaders,
  setEditApplyRateLimiting,
  setEditCallsPerMinute,
  setEditSubmitted,
  resetDetailState,
  setDetailOverviewTimeRange,
  setDetailMetricsCollapsed,
  setDetailMcpExpanded,
  setDetailData,
  setDetailLoading,
  setDetailError,
  setDetailToolId,
} = toolsetSlice.actions

export const toolsetReducer = toolsetSlice.reducer
