import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"

import { Button } from "@/ui-lib/base-components/button/button"
import { TooltipProvider, Tooltip } from "./tooltip"

// -- helpers

function renderTooltip(
  overrides: {
    content?: string | React.ReactNode
    trigger?: React.ReactElement
    className?: string
    side?: "top" | "right" | "bottom" | "left"
  } = {},
) {
  const {
    content = "Tooltip text",
    trigger = <Button label="Hover me" />,
    className,
    side,
  } = overrides
  return renderWithProviders(
    <TooltipProvider>
      <Tooltip content={content} trigger={trigger} className={className} side={side} />
    </TooltipProvider>,
  )
}

// ===== Tooltip =====

describe("Tooltip", () => {
  // 1 — Trigger rendering

  // 1.1
  it("[tag:tooltip][tag:rendering] should render trigger with data-slot and BEM class", () => {
    renderTooltip()

    const trigger = screen.getByRole("button", { name: "Hover me" })
    expect(trigger).toBeInTheDocument()
    expect(trigger).toHaveAttribute("data-slot", "tooltip-trigger")
    expect(trigger).toHaveClass("tooltip__trigger")
  })

  // 1.2
  it("[tag:tooltip][tag:rendering] should render default info icon trigger when no trigger is provided", () => {
    renderWithProviders(
      <TooltipProvider>
        <Tooltip content="Info text" />
      </TooltipProvider>,
    )

    const trigger = screen.getByRole("button", { name: "More information" })
    expect(trigger).toHaveAttribute("data-slot", "tooltip-trigger")
    expect(trigger).toHaveClass("tooltip__trigger--icon")
  })

  // 2 — Content rendering

  // 2.1
  it("[tag:tooltip][tag:rendering] should not show content by default", () => {
    renderTooltip()

    expect(screen.queryByText("Tooltip text")).not.toBeInTheDocument()
  })

  // 2.2
  it("[tag:tooltip][tag:hover] should show content on hover", async () => {
    const user = userEvent.setup()
    renderTooltip()

    await user.hover(screen.getByRole("button", { name: "Hover me" }))

    const content = await screen.findByText("Tooltip text")
    expect(content).toBeInTheDocument()

    const popup = content.closest("[data-slot='tooltip-content']")
    expect(popup).toBeInTheDocument()
    expect(popup).toHaveClass("tooltip__popup")
  })

  // 2.3
  it("[tag:tooltip][tag:typography][tag:rendering] should wrap string content in Typography", async () => {
    const user = userEvent.setup()
    renderTooltip()

    await user.hover(screen.getByRole("button", { name: "Hover me" }))
    const content = await screen.findByText("Tooltip text")

    expect(content.tagName).toBe("SPAN")
  })

  // 2.4
  it("[tag:tooltip][tag:rendering] should render ReactNode content directly", async () => {
    const user = userEvent.setup()
    renderTooltip({
      content: <div data-testid="rich-content">Rich tooltip</div>,
    })

    await user.hover(screen.getByRole("button", { name: "Hover me" }))
    const rich = await screen.findByTestId("rich-content")
    expect(rich).toBeInTheDocument()
    expect(rich.textContent).toBe("Rich tooltip")
  })

  // 3 — Keyboard

  // 3.1
  it("[tag:tooltip][tag:keyboard][tag:a11y] should show content when trigger receives keyboard focus", async () => {
    const user = userEvent.setup()
    renderTooltip()

    await user.tab()

    const content = await screen.findByText("Tooltip text")
    expect(content).toBeInTheDocument()
  })

  // 3.2
  it("[tag:tooltip][tag:keyboard][tag:a11y] should hide content when trigger loses focus", async () => {
    const user = userEvent.setup()
    renderTooltip()

    await user.tab()
    await screen.findByText("Tooltip text")

    await user.tab()

    await waitFor(() => {
      expect(screen.queryByText("Tooltip text")).not.toBeInTheDocument()
    })
  })

  // 3.3
  it("[tag:tooltip][tag:keyboard] should close on Escape", async () => {
    const user = userEvent.setup()
    renderTooltip()

    await user.hover(screen.getByRole("button", { name: "Hover me" }))
    await screen.findByText("Tooltip text")

    await user.keyboard("{Escape}")

    await waitFor(() => {
      expect(screen.queryByText("Tooltip text")).not.toBeInTheDocument()
    })
  })

  // 4 — className

  // 4.1
  it("[tag:tooltip][tag:className] should forward className to the popup", async () => {
    const user = userEvent.setup()
    renderTooltip({ className: "my-custom-tooltip" })

    await user.hover(screen.getByRole("button", { name: "Hover me" }))
    const content = await screen.findByText("Tooltip text")

    const popup = content.closest("[data-slot='tooltip-content']")
    expect(popup).toHaveClass("tooltip__popup", "my-custom-tooltip")
  })

  // 5 — Accessibility

  // 5.1
  it("[tag:tooltip][tag:a11y] should associate trigger with popup via data-popup-open", async () => {
    const user = userEvent.setup()
    renderTooltip()

    const trigger = screen.getByRole("button", { name: "Hover me" })
    await user.hover(trigger)
    await screen.findByText("Tooltip text")

    expect(trigger).toHaveAttribute("data-popup-open")
  })
})
