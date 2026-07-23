import { useState, type ReactElement } from "react"
import { screen } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"
import { TabDetailCard } from "./tab-detail-card"

const TABS = [
  { id: "details", label: "Details" },
  { id: "advanced", label: "Advanced" },
]

const PANELS = [
  { tabId: "details", content: <div>Details content</div> },
  { tabId: "advanced", content: <div>Advanced content</div> },
]

const baseProps = {
  title: "Tool details",
  subtitle: "Configure tool basics",
  ariaLabel: "Tool detail tabs",
  tabs: TABS,
  panels: PANELS,
}

describe("TabDetailCard", () => {
  it("[tag:tab-detail-card] renders title and subtitle", () => {
    renderWithProviders(<TabDetailCard {...baseProps} />)
    expect(screen.getByText("Tool details")).toBeInTheDocument()
    expect(screen.getByText("Configure tool basics")).toBeInTheDocument()
  })

  it("[tag:tab-detail-card] renders all tab buttons", () => {
    renderWithProviders(<TabDetailCard {...baseProps} />)
    expect(screen.getByRole("tab", { name: "Details" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Advanced" })).toBeInTheDocument()
  })

  it("[tag:tab-detail-card] shows the first tab's panel by default", () => {
    renderWithProviders(<TabDetailCard {...baseProps} />)
    expect(screen.getByText("Details content")).toBeInTheDocument()
    expect(screen.queryByText("Advanced content")).not.toBeInTheDocument()
  })

  it("[tag:tab-detail-card] uncontrolled — switching tabs updates the visible panel", async () => {
    renderWithProviders(<TabDetailCard {...baseProps} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole("tab", { name: "Advanced" }))
    expect(screen.getByText("Advanced content")).toBeInTheDocument()
    expect(screen.queryByText("Details content")).not.toBeInTheDocument()
  })

  it("[tag:tab-detail-card] controlled — respects activeTabId from props", () => {
    renderWithProviders(<TabDetailCard {...baseProps} activeTabId="advanced" />)
    expect(screen.getByText("Advanced content")).toBeInTheDocument()
  })

  it("[tag:tab-detail-card] controlled — fires onTabChange on tab click", async () => {
    const onTabChange = vi.fn()

    function Wrapper(): ReactElement {
      const [active, setActive] = useState("details")
      return (
        <TabDetailCard
          {...baseProps}
          activeTabId={active}
          onTabChange={(id) => {
            onTabChange(id)
            setActive(id)
          }}
        />
      )
    }

    renderWithProviders(<Wrapper />)
    await userEvent.setup().click(screen.getByRole("tab", { name: "Advanced" }))
    expect(onTabChange).toHaveBeenCalledWith("advanced")
    expect(screen.getByText("Advanced content")).toBeInTheDocument()
  })

  it("[tag:tab-detail-card] applies cardClassName to the root card", () => {
    const { container } = renderWithProviders(
      <TabDetailCard {...baseProps} cardClassName="my-card" />,
    )
    expect(container.querySelector(".my-card")).toBeInTheDocument()
  })

  it("[tag:tab-detail-card] applies panelClassName to the tab body wrapper", () => {
    const { container } = renderWithProviders(
      <TabDetailCard
        {...baseProps}
        panels={[
          { tabId: "details", content: <span>D</span>, panelClassName: "panel-custom" },
          { tabId: "advanced", content: <span>A</span> },
        ]}
      />,
    )
    expect(container.querySelector(".tab-detail-card__tab-body.panel-custom")).toBeInTheDocument()
  })

  it("[tag:tab-detail-card] honors a non-default variant", () => {
    /*
     * The variant prop must propagate to the TabGroup root and tab strip.
     * The base class `.tab-detail-card__tabs` is always present regardless
     * of variant, so a test asserting only that wouldn't fail if the
     * variant prop stopped being forwarded. The TabGroup applies
     * `tab-group--<variant>` to the Tabs.Root and `tab-group__list--<variant>`
     * to the Tabs.List — asserting on those catches the regression
     * directly.
     */
    const { container, rerender } = renderWithProviders(
      <TabDetailCard {...baseProps} variant="card" />,
    )
    expect(
      container.querySelector(".tab-detail-card__tabs.tab-group--card"),
    ).toBeInTheDocument()
    expect(container.querySelector(".tab-group__list--card")).toBeInTheDocument()
    expect(
      container.querySelector(".tab-group--general"),
    ).not.toBeInTheDocument()

    rerender(<TabDetailCard {...baseProps} variant="general" />)
    expect(
      container.querySelector(".tab-detail-card__tabs.tab-group--general"),
    ).toBeInTheDocument()
    expect(container.querySelector(".tab-group--card")).not.toBeInTheDocument()
  })

  it("[tag:tab-detail-card] renders without subtitle when omitted", () => {
    /*
     * `subtitle` is optional (mirrors CardHeaderProps.subtitle). Callers
     * with a title-only header must compile and render with no console
     * errors and no leftover subtitle text. Pass props explicitly rather
     * than destructuring `subtitle` out of `baseProps` so we don't have
     * to ignore a "destructured but unused" lint warning.
     */
    renderWithProviders(
      <TabDetailCard
        title={baseProps.title}
        ariaLabel={baseProps.ariaLabel}
        tabs={baseProps.tabs}
        panels={baseProps.panels}
      />,
    )
    expect(screen.getByText("Tool details")).toBeInTheDocument()
    expect(screen.queryByText("Configure tool basics")).not.toBeInTheDocument()
  })
})
