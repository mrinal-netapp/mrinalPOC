import { fireEvent, render, screen } from "@testing-library/react"
import { describe, it, expect } from "vitest"

import { DetailCard, TabContent } from "./detail-card"
import { DETAILS_TAB } from "./detail-card.consts"
import type { DetailCardRow } from "./detail-card.types"

const ROWS: DetailCardRow[] = [
  { label: "Name", value: "entity-01" },
  { label: "Type", value: "Custom" },
]

describe("DetailCard", () => {
  it("[tag:detail-card] renders every row's label and value in the Details tab", () => {
    render(<DetailCard rows={ROWS} />)
    expect(screen.getByText("Name")).toBeInTheDocument()
    expect(screen.getByText("entity-01")).toBeInTheDocument()
    expect(screen.getByText("Type")).toBeInTheDocument()
    expect(screen.getByText("Custom")).toBeInTheDocument()
  }, 15000)

  it("[tag:detail-card] appends a custom className to the root Card", () => {
    const { container } = render(<DetailCard rows={ROWS} className="custom-card" />)
    const root = container.querySelector(".detail-card")
    expect(root).not.toBeNull()
    expect(root?.className).toContain("custom-card")
  }, 15000)

  it("[tag:detail-card] switching to an extra tab reveals its consumer-supplied content", () => {
    render(
      <DetailCard
        rows={ROWS}
        extraTabs={[{ id: "cost", label: "Cost configuration" }]}
      >
        <TabContent tabId="cost">
          <div data-testid="cost-tab-body">Cost body</div>
        </TabContent>
      </DetailCard>,
    )

    fireEvent.click(screen.getByRole("tab", { name: "Cost configuration" }))
    expect(screen.getByTestId("cost-tab-body")).toBeInTheDocument()
  }, 15000)

  // Regression: duplicate row labels must not collide on React keys.
  // The previous key was `row.label`, so two rows with the same label
  // would mount as one element and lose updates.
  it("[tag:detail-card] renders rows with duplicate labels without key collisions", () => {
    const duplicateLabelRows: DetailCardRow[] = [
      { label: "Label", value: "first-value" },
      { label: "Label", value: "second-value" },
    ]
    render(<DetailCard rows={duplicateLabelRows} />)
    expect(screen.getByText("first-value")).toBeInTheDocument()
    expect(screen.getByText("second-value")).toBeInTheDocument()
  }, 15000)

  // Regression: when the currently-active extra tab disappears or is disabled
  // via props the card must fall back to the built-in Details tab rather than
  // holding a stale id that matches no tab.
  it("[tag:detail-card] falls back to Details when the active extra tab is removed", () => {
    const extraTabs = [{ id: "cost", label: "Cost configuration" }]
    const { rerender } = render(
      <DetailCard rows={ROWS} extraTabs={extraTabs}>
        <TabContent tabId="cost">
          <div data-testid="cost-tab-body">Cost body</div>
        </TabContent>
      </DetailCard>,
    )

    fireEvent.click(screen.getByRole("tab", { name: "Cost configuration" }))
    expect(screen.getByTestId("cost-tab-body")).toBeInTheDocument()

    rerender(<DetailCard rows={ROWS} />)
    const detailsTab = screen.getByRole("tab", { name: DETAILS_TAB.label })
    expect(detailsTab).toHaveAttribute("aria-selected", "true")
  }, 15000)

  it("[tag:detail-card] falls back to Details when the active extra tab becomes disabled", () => {
    const { rerender } = render(
      <DetailCard
        rows={ROWS}
        extraTabs={[{ id: "cost", label: "Cost configuration" }]}
      >
        <TabContent tabId="cost">
          <div data-testid="cost-tab-body">Cost body</div>
        </TabContent>
      </DetailCard>,
    )

    fireEvent.click(screen.getByRole("tab", { name: "Cost configuration" }))
    expect(screen.getByTestId("cost-tab-body")).toBeInTheDocument()

    rerender(
      <DetailCard
        rows={ROWS}
        extraTabs={[{ id: "cost", label: "Cost configuration", isDisabled: true }]}
      >
        <TabContent tabId="cost">
          <div data-testid="cost-tab-body">Cost body</div>
        </TabContent>
      </DetailCard>,
    )

    const detailsTab = screen.getByRole("tab", { name: DETAILS_TAB.label })
    expect(detailsTab).toHaveAttribute("aria-selected", "true")
  }, 15000)
})
