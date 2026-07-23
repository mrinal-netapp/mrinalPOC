import type { RootState } from "@/store/store.types"

import type {
  AddToolFormState,
  EditToolFormState,
  ToolsetDetailState,
  ToolsetListState,
  ToolsetState,
} from "./model"
import type { ToolListParams } from "./toolset-list/toolset-list.types"

const getToolsetState = (state: RootState): ToolsetState => state.toolset

export const toolsetSelector = {
  state(state: RootState): ToolsetState {
    return getToolsetState(state)
  },

  list(state: RootState): ToolsetListState {
    return getToolsetState(state).list
  },

  listItems(state: RootState) {
    return getToolsetState(state).list.items
  },

  listIsLoading(state: RootState): boolean {
    return getToolsetState(state).list.isLoading
  },

  listIsError(state: RootState): boolean {
    return getToolsetState(state).list.isError
  },

  listFilters(state: RootState): ToolListParams {
    return getToolsetState(state).listFilters
  },

  addToolFormState(state: RootState): AddToolFormState {
    return getToolsetState(state).addToolForm
  },

  editToolFormState(state: RootState): EditToolFormState {
    return getToolsetState(state).editToolForm
  },

  detail(state: RootState): ToolsetDetailState {
    return getToolsetState(state).detail
  },

  detailTool(state: RootState) {
    return getToolsetState(state).detail.tool
  },

  detailAgents(state: RootState) {
    return getToolsetState(state).detail.agents
  },

  detailIsLoading(state: RootState): boolean {
    return getToolsetState(state).detail.isLoading
  },

  detailIsError(state: RootState): boolean {
    return getToolsetState(state).detail.isError
  },

  detailOverviewTimeRange(state: RootState) {
    return getToolsetState(state).detail.overviewTimeRange
  },

  detailIsMetricsCollapsed(state: RootState): boolean {
    return getToolsetState(state).detail.isMetricsCollapsed
  },

  detailMcpExpanded(state: RootState): boolean {
    return getToolsetState(state).detail.mcpExpanded
  },

}
