import { act, renderHook } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { Provider } from "react-redux"
import { describe, expect, it } from "vitest"

import { createMockStore } from "@test/mocks"

import { loadToolsetDetail } from "../actions"
import { setDetailData } from "../reducer"
import type { McpServerSummary } from "@/routes/pages/agents/api/agents-config.types"
import { TOOLSET_AGENTS_FIXTURE, TOOLSET_DETAIL_FIXTURE } from "./toolset-detail.fixtures"
import { mapServerToToolsetDetail, useToolsetDetail } from "./toolset-detail.actions"

describe("useToolsetDetail", () => {
  it("[tag:toolset-detail-state] hydrates metrics and rows when detail data is in redux", () => {
    const store = createMockStore()
    store.dispatch(
      setDetailData({
        toolId: TOOLSET_DETAIL_FIXTURE.id,
        tool: TOOLSET_DETAIL_FIXTURE,
        agents: TOOLSET_AGENTS_FIXTURE,
      }),
    )

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(Provider, { store, children })

    const { result } = renderHook(() => useToolsetDetail(undefined), { wrapper })

    expect(result.current.tool?.name).toBe("tool-mcp-01")
    expect(result.current.agents).toHaveLength(1)
    expect(result.current.metrics).toHaveLength(4)
    expect(result.current.detailRows.some((row) => row.label === "Name")).toBe(true)
  })

  it("[tag:toolset-detail-state] toggles overview ui state via redux actions", () => {
    const store = createMockStore()
    store.dispatch(loadToolsetDetail("tool-mcp-01"))

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(Provider, { store, children })

    const { result } = renderHook(() => useToolsetDetail("tool-mcp-01"), { wrapper })

    act(() => {
      result.current.setOverviewTimeRange("Last week")
      result.current.toggleMetricsCollapsed()
      result.current.setMcpExpanded(false)
    })

    expect(result.current.overviewTimeRange).toBe("Last week")
    expect(result.current.isMetricsCollapsed).toBe(true)
    expect(result.current.mcpExpanded).toBe(false)
  })

  it("[tag:toolset-detail-state] omits dash metrics and zero latency from metrics list", () => {
    const store = createMockStore()
    store.dispatch(
      setDetailData({
        toolId: TOOLSET_DETAIL_FIXTURE.id,
        tool: {
          ...TOOLSET_DETAIL_FIXTURE,
          metrics: {
            toolsCount: 2,
            successRate: "—",
            calls: "—",
            avgLatencyMs: 0,
          },
        },
        agents: TOOLSET_AGENTS_FIXTURE,
      }),
    )

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(Provider, { store, children })

    const { result } = renderHook(() => useToolsetDetail(undefined), { wrapper })

    expect(result.current.metrics).toHaveLength(1)
    expect(result.current.metrics[0]?.subtitle).toBe("Tools")
  })
})

describe("mapServerToToolsetDetail", () => {
  const baseServer: McpServerSummary = {
    id: "srv-1",
    name: "analytics_datasets_mcp",
    status: "connected",
    transport: "streamable-http",
    deploymentType: "platform",
    createdAt: "2026-02-10T09:30:00.000Z",
    updatedAt: "2026-02-11T15:45:00.000Z",
  }

  it("[tag:toolset-detail-map] formats created / updated / validated timestamps from the server row", () => {
    const detail = mapServerToToolsetDetail(baseServer, 6)

    expect(detail.created).toContain("Feb 10, 2026")
    expect(detail.lastUpdated).toContain("Feb 11, 2026")
    // No dedicated validation column — falls back to updatedAt.
    expect(detail.lastValidated).toContain("Feb 11, 2026")
  })

  it("[tag:toolset-detail-map] falls back to dash when timestamps are absent", () => {
    const detail = mapServerToToolsetDetail(
      { ...baseServer, createdAt: undefined, updatedAt: undefined },
      6,
    )

    expect(detail.created).toBe("-")
    expect(detail.lastUpdated).toBe("-")
    expect(detail.lastValidated).toBe("-")
  })

  it("[tag:toolset-detail-map] shows platform default forwarded headers when none are stored", () => {
    const detail = mapServerToToolsetDetail(baseServer, 6)

    expect(detail.forwardedHeaders).toContain("X-Project-ID")
  })
})
