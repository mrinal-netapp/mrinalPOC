import { screen } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { ActivityPanel } from "./activity-panel"
import type { ActivityEvent } from "../../model-detail-page.types"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_EVENTS: ActivityEvent[] = [
  {
    id: "evt-01",
    event: "API request failed",
    status: "error",
    details: "Rate limit exceeded",
    timestamp: "Feb 10, 2026, 7:15:06 AM",
  },
  {
    id: "evt-02",
    event: "API key validated",
    status: "success",
    details: "Key successfully validated",
    timestamp: "Feb 10, 2026, 7:15:00 AM",
  },
  {
    id: "evt-03",
    event: "Throttle warning",
    status: "warning",
    details: "Approaching rate limit",
    timestamp: "Feb 10, 2026, 7:14:00 AM",
  },
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ActivityPanel", () => {
  it("[tag:activity-panel] renders the Activity heading", () => {
    renderWithProviders(<ActivityPanel events={MOCK_EVENTS} onRefresh={vi.fn()} />)
    expect(screen.getByText("Activity")).toBeInTheDocument()
  })

  it("[tag:activity-panel] renders column headers", () => {
    renderWithProviders(<ActivityPanel events={MOCK_EVENTS} onRefresh={vi.fn()} />)
    expect(screen.getByText("Event")).toBeInTheDocument()
    expect(screen.getByText("Status")).toBeInTheDocument()
    expect(screen.getByText("Details")).toBeInTheDocument()
    expect(screen.getByText("Timestamp")).toBeInTheDocument()
  })

  it("[tag:activity-panel] renders event names in the table", () => {
    renderWithProviders(<ActivityPanel events={MOCK_EVENTS} onRefresh={vi.fn()} />)
    expect(screen.getByText("API request failed")).toBeInTheDocument()
    expect(screen.getByText("API key validated")).toBeInTheDocument()
  })

  it("[tag:activity-panel] renders all three status labels", () => {
    renderWithProviders(<ActivityPanel events={MOCK_EVENTS} onRefresh={vi.fn()} />)
    expect(screen.getByText("Error")).toBeInTheDocument()
    expect(screen.getByText("Success")).toBeInTheDocument()
    expect(screen.getByText("Warning")).toBeInTheDocument()
  })

  it("[tag:activity-panel] Refresh button calls onRefresh", async () => {
    const onRefresh = vi.fn()
    renderWithProviders(<ActivityPanel events={MOCK_EVENTS} onRefresh={onRefresh} />)
    const user = userEvent.setup({ delay: null })
    await user.click(screen.getByRole("button", { name: "Refresh" }))
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it("[tag:activity-panel] renders empty table when no events", () => {
    renderWithProviders(<ActivityPanel events={[]} onRefresh={vi.fn()} />)
    expect(screen.getByText("Activity")).toBeInTheDocument()
  })
})
