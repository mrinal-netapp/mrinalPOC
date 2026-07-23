import { describe, expect, it } from "vitest"

import type { RootState } from "@/store/store.types"

import { createInitialToolsetState } from "./model"
import { toolsetSelector } from "./selectors"
import { TOOLSET_AGENTS_FIXTURE, TOOLSET_DETAIL_FIXTURE } from "./toolset-detail/toolset-detail.fixtures"

const createRootState = (overrides?: Partial<ReturnType<typeof createInitialToolsetState>>): RootState => {
  const toolset = { ...createInitialToolsetState(), ...overrides }
  toolset.list.items = [{ tool_id: "t1", tool_name: "Tool 1" } as never]
  toolset.list.isLoading = true
  toolset.list.isError = true
  toolset.listFilters = { limit: 10 }
  toolset.detail.tool = TOOLSET_DETAIL_FIXTURE
  toolset.detail.agents = TOOLSET_AGENTS_FIXTURE
  toolset.detail.isLoading = true
  toolset.detail.isError = true
  toolset.detail.isMetricsCollapsed = true
  toolset.detail.mcpExpanded = false
  toolset.editToolForm.toolId = "tool-mcp-01"

  return { toolset } as unknown as RootState
}

describe("toolsetSelector", () => {
  it("[tag:toolset][tag:selector] returns full state and list selectors", () => {
    const state = createRootState()

    expect(toolsetSelector.state(state)).toBe(state.toolset)
    expect(toolsetSelector.list(state).items).toHaveLength(1)
    expect(toolsetSelector.listItems(state)).toHaveLength(1)
    expect(toolsetSelector.listIsLoading(state)).toBe(true)
    expect(toolsetSelector.listIsError(state)).toBe(true)
    expect(toolsetSelector.listFilters(state)).toEqual({ limit: 10 })
  })

  it("[tag:toolset][tag:selector] returns add tool, edit, and detail selectors", () => {
    const state = createRootState()

    expect(toolsetSelector.addToolFormState(state).activeTabId).toBe("custom")
    expect(toolsetSelector.editToolFormState(state).toolId).toBe("tool-mcp-01")
    expect(toolsetSelector.detail(state).tool?.name).toBe("tool-mcp-01")
    expect(toolsetSelector.detailTool(state)?.name).toBe("tool-mcp-01")
    expect(toolsetSelector.detailAgents(state)).toHaveLength(1)
    expect(toolsetSelector.detailIsLoading(state)).toBe(true)
    expect(toolsetSelector.detailIsError(state)).toBe(true)
    expect(toolsetSelector.detailOverviewTimeRange(state)).toBe("Last month")
    expect(toolsetSelector.detailIsMetricsCollapsed(state)).toBe(true)
    expect(toolsetSelector.detailMcpExpanded(state)).toBe(false)
  })
})
