import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createElement, type ReactNode } from "react"
import { Provider } from "react-redux"
import { describe, expect, it, vi } from "vitest"

import { createMockStore } from "@test/mocks"
import { renderWithProviders } from "@test/render"

import { toolsetSelector } from "../selectors"
import { ToolsetOverviewPanel } from "./toolset-overview-panel"

const metrics = [{ icon: <span />, value: "6", subtitle: "Tools" }]
const detailRows = [{ label: "Name", value: "tool-mcp-01" }]

describe("ToolsetOverviewPanel", () => {
  it("[tag:toolset-overview] renders filter bar and detail card", () => {
    renderWithProviders(
      <ToolsetOverviewPanel metrics={metrics} detailRows={detailRows} />,
    )

    expect(screen.getByText("Filters:")).toBeInTheDocument()
    expect(screen.getByText(/Time range: Last month/)).toBeInTheDocument()
    expect(screen.getByText("tool-mcp-01")).toBeInTheDocument()
  })

  it("[tag:toolset-overview] shows empty state when no agents use the tool", () => {
    renderWithProviders(
      <ToolsetOverviewPanel metrics={metrics} detailRows={detailRows} agents={[]} />,
    )

    expect(screen.getByText("Associated agents")).toBeInTheDocument()
    expect(screen.getByText("No agents are using this tool yet.")).toBeInTheDocument()
  })

  it("[tag:toolset-overview] lists associated agents and navigates on click", async () => {
    const user = userEvent.setup({ delay: null })
    const onAgentClick = vi.fn()
    const agents = [
      { id: "ag-1", name: "testagent", status: "-", labels: [], created: "-" },
    ]

    renderWithProviders(
      <ToolsetOverviewPanel
        metrics={metrics}
        detailRows={detailRows}
        agents={agents}
        onAgentClick={onAgentClick}
      />,
    )

    const agentButton = screen.getByRole("button", { name: "testagent" })
    expect(agentButton).toBeInTheDocument()

    await user.click(agentButton)
    expect(onAgentClick).toHaveBeenCalledWith("ag-1")
  })

  it("[tag:toolset-overview] updates time range and collapse state in redux", async () => {
    const store = createMockStore()
    const user = userEvent.setup({ delay: null })

    const Wrapper = ({ children }: { children: ReactNode }) =>
      createElement(Provider, { store, children })

    render(
      createElement(
        Wrapper,
        null,
        createElement(ToolsetOverviewPanel, { metrics, detailRows }),
      ),
    )

    await user.click(screen.getByRole("button", { name: /Collapse metrics/i }))

    expect(toolsetSelector.detailIsMetricsCollapsed(store.getState())).toBe(true)
  })

  it("[tag:toolset-overview] sets time range and clears filter chip", async () => {
    const store = createMockStore()
    const user = userEvent.setup({ delay: null })

    const Wrapper = ({ children }: { children: ReactNode }) =>
      createElement(Provider, { store, children })

    render(
      createElement(
        Wrapper,
        null,
        createElement(ToolsetOverviewPanel, { metrics, detailRows }),
      ),
    )

    await user.click(screen.getByRole("button", { name: /Time range: Last month/i }))
    const lastWeekItem = await screen.findByText("Last week")
    await user.click(lastWeekItem)
    expect(toolsetSelector.detailOverviewTimeRange(store.getState())).toBe("Last week")

    await user.click(screen.getByRole("button", { name: "Clear time range filter" }))
    expect(toolsetSelector.detailOverviewTimeRange(store.getState())).toBeNull()
  })
})
