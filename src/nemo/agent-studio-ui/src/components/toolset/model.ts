import type { AddToolState } from "./add-tool/add-tool.types"
import {
  ADD_TOOL_DEFAULT_LABEL_ITEMS,
  ADD_TOOL_DEFAULT_MCP_CONFIG,
  ADD_TOOL_DEFAULT_SELECTED_LABELS,
} from "./add-tool/add-tool.consts"
import { ADD_TOOL_DEFAULT_CATALOG_STATE } from "./add-tool/catalog/catalog.consts"
import type {
  EditToolFormState,
  ToolsetDetailState,
  ToolsetListState,
  ToolsetState,
} from "./toolset.types"

export const TOOLSET_STORE_SLICE_NAME = "toolset"

export type {
  EditToolFormState,
  ToolsetAgentRow,
  ToolsetConnectionStatus,
  ToolsetDetailMetrics,
  ToolsetDetailRecord,
  ToolsetDetailState,
  ToolsetListState,
  ToolsetState,
} from "./toolset.types"
export type AddToolFormState = AddToolState

export const createInitialAddToolFormState = (): AddToolState => ({
  activeTabId: "custom",
  name: "",
  description: "",
  labelItems: [...ADD_TOOL_DEFAULT_LABEL_ITEMS],
  selectedLabels: [...ADD_TOOL_DEFAULT_SELECTED_LABELS],
  mcpConfigDialogOpen: false,
  mcpConfigDraft: { ...ADD_TOOL_DEFAULT_MCP_CONFIG },
  savedMcpConfig: null,
  mcpConnectionStatus: "not_configured",
  mcpValidationMessage: null,
  catalog: { ...ADD_TOOL_DEFAULT_CATALOG_STATE },
})

export const createInitialListState = (): ToolsetListState => ({
  items: [],
  isLoading: false,
  isError: false,
})

export const createInitialEditToolFormState = (): EditToolFormState => ({
  toolId: null,
  name: "",
  description: "",
  labelItems: [...ADD_TOOL_DEFAULT_LABEL_ITEMS],
  selectedLabels: [],
  configFields: [],
  configDialogOpen: false,
  addCustomHeaders: false,
  customHeaders: [],
  addForwardedHeaders: false,
  forwardedHeaders: [""],
  applyRateLimiting: false,
  callsPerMinute: "",
  submitted: false,
})

export const createInitialDetailState = (): ToolsetDetailState => ({
  toolId: null,
  tool: null,
  agents: [],
  isLoading: false,
  isError: false,
  overviewTimeRange: "Last month",
  isMetricsCollapsed: false,
  mcpExpanded: true,
})

export const createInitialToolsetState = (): ToolsetState => ({
  list: createInitialListState(),
  listFilters: {},
  addToolForm: createInitialAddToolFormState(),
  editToolForm: createInitialEditToolFormState(),
  detail: createInitialDetailState(),
})
