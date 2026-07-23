import { Tabs } from "@base-ui/react/tabs"
import { screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"

import { Tab } from "./tab"
import { TabGroup, TabContent } from "./tab-group"
import type { TabGroupProps } from "./tab-group"

// -- helpers

function renderTab(overrides: Partial<Parameters<typeof Tab>[0]> = {}) {
  const defaultProps = { id: "tab-1", label: "Tab One" }
  return renderWithProviders(
    <Tabs.Root defaultValue="tab-1">
      <Tabs.List>
        <Tab {...defaultProps} {...overrides} />
      </Tabs.List>
    </Tabs.Root>,
  )
}

const sampleTabs: TabGroupProps["tabs"] = [
  { id: "alpha", label: "Alpha" },
  { id: "beta", label: "Beta" },
  { id: "gamma", label: "Gamma" },
]

function renderTabGroup(overrides: Partial<TabGroupProps> = {}) {
  const defaultProps: TabGroupProps = { tabs: sampleTabs }
  return renderWithProviders(<TabGroup {...defaultProps} {...overrides} />)
}

// ===== Tab =====

describe("Tab", () => {
  // -- 1.1 Default rendering (merged: 1.1 + 1.2 + 1.5 + 1.8 + 1.10 + 1.12)
  it("[tag:tab][tag:rendering] should render with correct defaults: label, data-slot, general variant, hug fitting, no icon, no count", () => {
    const { container } = renderTab()

    const tab = screen.getByRole("tab")
    expect(tab).toBeInTheDocument()
    expect(screen.getByText("Tab One")).toBeInTheDocument()
    expect(tab).toHaveAttribute("data-slot", "tab")
    expect(tab).toHaveClass("tab-variant-general")
    expect(tab).toHaveClass("tab-fitting-hug")
    expect(container.querySelector(".tab__icon")).not.toBeInTheDocument()
    expect(container.querySelector(".tab__count")).not.toBeInTheDocument()
  })

  // -- 1.3 Variant: general (explicit)
  it("[tag:tab][tag:variant][tag:general] should apply tab-variant-general class when variant is general", () => {
    renderTab({ variant: "general" })

    expect(screen.getByRole("tab")).toHaveClass("tab-variant-general")
  })

  // -- 1.4 Variant: card (merged: 1.4 + 1.14 + 1.19)
  it("[tag:tab][tag:variant][tag:card] should apply card class and size 16 regular typography when variant is card", () => {
    const { container } = renderTab({ variant: "card" })

    const tab = screen.getByRole("tab")
    expect(tab).toHaveClass("tab-variant-card")

    const label = container.querySelector(".tab__label")
    expect(label).toHaveClass("typography--16")
    expect(label).toHaveClass("typography--regular")
  })

  // -- 1.6 Fitting: fit-content
  it("[tag:tab][tag:fitting] should apply tab-fitting-hug class when fitting is fit-content", () => {
    renderTab({ fitting: "fit-content" })

    expect(screen.getByRole("tab")).toHaveClass("tab-fitting-hug")
  })

  // -- 1.7 Fitting: fill-container
  it("[tag:tab][tag:fitting] should apply tab-fitting-fill class when fitting is fill-container", () => {
    renderTab({ fitting: "fill-container" })

    expect(screen.getByRole("tab")).toHaveClass("tab-fitting-fill")
  })

  // -- 1.9 Icon present
  it("[tag:tab][tag:icon] should render a tab__icon span wrapping the icon when icon prop is provided", () => {
    const { container } = renderTab({ icon: <svg data-testid="tab-icon" /> })

    const icon = screen.getByTestId("tab-icon")
    expect(icon.parentElement).toHaveClass("tab__icon")
    expect(container.querySelector(".tab__icon")).toBeInTheDocument()
  })

  // -- 1.11 Count present
  it("[tag:tab][tag:count] should render the count wrapped in parentheses when count is provided", () => {
    renderTab({ count: 42 })

    expect(screen.getByText("(42)")).toBeInTheDocument()
  })

  // -- 1.13 Count typography in card variant
  it("[tag:tab][tag:count][tag:card] should render count with size 16 typography when variant is card", () => {
    const { container } = renderTab({ variant: "card", count: 5 })

    const count = container.querySelector(".tab__count")
    expect(count).toHaveClass("typography--16")
    expect(count).toHaveClass("typography--regular")
  })

  // -- 1.16 Disabled state
  it("[tag:tab][tag:disabled] should have aria-disabled attribute when disabled is true", () => {
    renderTab({ isDisabled: true })

    expect(screen.getByRole("tab")).toHaveAttribute("aria-disabled", "true")
  })

  // -- 1.17 Not disabled
  it("[tag:tab][tag:disabled] should not have aria-disabled when disabled is false", () => {
    renderTab({ isDisabled: false })

    expect(screen.getByRole("tab")).not.toHaveAttribute("aria-disabled", "true")
  })

  // -- 1.18 General typography
  it("[tag:tab][tag:variant][tag:general] should render label with size 14 and semibold typography when variant is general", () => {
    const { container } = renderTab({ variant: "general" })

    const label = container.querySelector(".tab__label")
    expect(label).toHaveClass("typography--14")
    expect(label).toHaveClass("typography--semibold")
  })

  // -- 1.20 className forwarding
  it("[tag:tab][tag:className] should append a custom className to the root element", () => {
    renderTab({ className: "my-custom-tab" })

    expect(screen.getByRole("tab")).toHaveClass("my-custom-tab")
  })
})

// ===== TabGroup =====

describe("TabGroup", () => {
  // -- 2.0 Empty tabs guard
  it("[tag:tab-group][tag:rendering] should render nothing when tabs array is empty", () => {
    const { container } = renderTabGroup({ tabs: [] })

    expect(container.querySelector("[data-slot='tab-group']")).not.toBeInTheDocument()
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument()
  })

  // -- 2.1 Default rendering (merged: 2.1 + 2.2 + 2.3 + 2.13)
  it("[tag:tab-group][tag:rendering] should render with correct defaults: all tabs, data-slot, first tab active, horizontal orientation", () => {
    const { container } = renderTabGroup()

    const tablist = screen.getByRole("tablist")
    const tabs = within(tablist).getAllByRole("tab")
    expect(tabs).toHaveLength(3)
    expect(screen.getByText("Alpha")).toBeInTheDocument()
    expect(screen.getByText("Beta")).toBeInTheDocument()
    expect(screen.getByText("Gamma")).toBeInTheDocument()

    expect(container.querySelector("[data-slot='tab-group']")).toBeInTheDocument()

    expect(tabs[0]).toHaveAttribute("aria-selected", "true")
    expect(tabs[1]).toHaveAttribute("aria-selected", "false")

    expect(container.querySelector(".tab-group--horizontal")).toBeInTheDocument()
  })

  // -- 2.4 First non-disabled tab active
  it("[tag:tab-group][tag:uncontrolled] should activate the first non-disabled tab when the first tab is disabled", () => {
    const tabs = [
      { id: "alpha", label: "Alpha", isDisabled: true },
      { id: "beta", label: "Beta" },
      { id: "gamma", label: "Gamma" },
    ]
    renderTabGroup({ tabs })

    const renderedTabs = screen.getAllByRole("tab")
    expect(renderedTabs[0]).toHaveAttribute("aria-selected", "false")
    expect(renderedTabs[1]).toHaveAttribute("aria-selected", "true")
  })

  // -- 2.5 Controlled mode
  it("[tag:tab-group][tag:controlled] should activate the tab matching activeTabId", () => {
    renderTabGroup({ activeTabId: "beta" })

    const tabs = screen.getAllByRole("tab")
    expect(tabs[0]).toHaveAttribute("aria-selected", "false")
    expect(tabs[1]).toHaveAttribute("aria-selected", "true")
  })

  // -- 2.6 onTabChange callback
  it("[tag:tab-group][tag:callback] should fire onTabChange with the tab id when a tab is clicked", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()

    renderTabGroup({ onTabChange: handleChange })

    await user.click(screen.getByText("Beta"))

    expect(handleChange).toHaveBeenCalledOnce()
    expect(handleChange).toHaveBeenCalledWith("beta")
  })

  // -- 2.7 Click updates active (uncontrolled)
  it("[tag:tab-group][tag:uncontrolled] should change active tab when clicking a different tab in uncontrolled mode", async () => {
    const user = userEvent.setup()

    renderTabGroup()

    await user.click(screen.getByText("Gamma"))

    const tabs = screen.getAllByRole("tab")
    expect(tabs[2]).toHaveAttribute("aria-selected", "true")
    expect(tabs[0]).toHaveAttribute("aria-selected", "false")
  })

  // -- 2.8 Disabled tab click blocked
  it("[tag:tab-group][tag:disabled] should not fire onTabChange when clicking a disabled tab", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const handleChange = vi.fn()

    const tabs = [
      { id: "alpha", label: "Alpha" },
      { id: "beta", label: "Beta", isDisabled: true },
      { id: "gamma", label: "Gamma" },
    ]

    renderTabGroup({ tabs, onTabChange: handleChange })

    await user.click(screen.getByText("Beta"))

    expect(handleChange).not.toHaveBeenCalled()
  })

  // -- 2.9 disableAll
  it("[tag:tab-group][tag:disabled] should disable all tabs when disableAll is true", () => {
    renderTabGroup({ disableAll: true })

    const tabs = screen.getAllByRole("tab")
    tabs.forEach((tab) => {
      expect(tab).toHaveAttribute("aria-disabled", "true")
    })
  })

  // -- 2.10 Individual isDisabled flag
  it("[tag:tab-group][tag:disabled] should disable only specific tabs when their isDisabled flag is true", () => {
    const tabs = [
      { id: "alpha", label: "Alpha" },
      { id: "beta", label: "Beta", isDisabled: true },
      { id: "gamma", label: "Gamma" },
    ]
    renderTabGroup({ tabs })

    const renderedTabs = screen.getAllByRole("tab")
    expect(renderedTabs[0]).not.toHaveAttribute("aria-disabled", "true")
    expect(renderedTabs[1]).toHaveAttribute("aria-disabled", "true")
    expect(renderedTabs[2]).not.toHaveAttribute("aria-disabled", "true")
  })

  // -- 2.11 Variant: general
  it("[tag:tab-group][tag:variant] should apply tab-group--general class when variant is general", () => {
    const { container } = renderTabGroup({ variant: "general" })

    expect(container.querySelector(".tab-group--general")).toBeInTheDocument()
  })

  // -- 2.12 Variant: card
  it("[tag:tab-group][tag:variant] should apply tab-group--card class when variant is card", () => {
    const { container } = renderTabGroup({ variant: "card" })

    expect(container.querySelector(".tab-group--card")).toBeInTheDocument()
  })

  // -- 2.14 Orientation: vertical (merged: 2.14 + 2.15)
  it("[tag:tab-group][tag:orientation] should apply vertical class and aria-orientation when orientation is vertical", () => {
    const { container } = renderTabGroup({ orientation: "vertical" })

    expect(container.querySelector(".tab-group--vertical")).toBeInTheDocument()

    const tablist = screen.getByRole("tablist")
    expect(tablist).toHaveAttribute("aria-orientation", "vertical")
  })

  // -- 2.16 className forwarding
  it("[tag:tab-group][tag:className] should append a custom className to the root element", () => {
    const { container } = renderTabGroup({ className: "custom-group" })

    expect(container.querySelector(".tab-group.custom-group")).toBeInTheDocument()
  })
})

// ===== TabContent =====

describe("TabContent", () => {
  // -- 3.1 Renders panel with children
  it("[tag:tab-content][tag:rendering] should render a tabpanel with the children when the parent tab is active", () => {
    renderWithProviders(
      <TabGroup tabs={sampleTabs} activeTabId="alpha">
        <TabContent tabId="alpha">
          <p>Alpha content</p>
        </TabContent>
      </TabGroup>,
    )

    expect(screen.getByRole("tabpanel")).toBeInTheDocument()
    expect(screen.getByText("Alpha content")).toBeInTheDocument()
  })

  // -- 3.2 className forwarding
  it("[tag:tab-content][tag:className] should append a custom className to the tabpanel element", () => {
    renderWithProviders(
      <TabGroup tabs={sampleTabs} activeTabId="alpha">
        <TabContent tabId="alpha" className="custom-panel">
          <p>Content</p>
        </TabContent>
      </TabGroup>,
    )

    expect(screen.getByRole("tabpanel")).toHaveClass("tab-content", "custom-panel")
  })
})
