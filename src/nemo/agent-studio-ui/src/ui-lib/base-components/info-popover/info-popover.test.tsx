import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"

import { Button } from "@/ui-lib/base-components/button/button"
import { InfoPopover } from "./info-popover"

function renderInfoPopover(
  overrides: {
    content?: string | React.ReactNode
    trigger?: React.ReactElement
    className?: string
    side?: "top" | "right" | "bottom" | "left"
  } = {},
) {
  const {
    content = "Popover text",
    trigger = <Button label="Click me" />,
    className,
    side,
  } = overrides
  return renderWithProviders(
    <InfoPopover content={content} trigger={trigger} className={className} side={side} />,
  )
}

describe("InfoPopover", () => {
  it("[tag:info-popover][tag:rendering] should render trigger with data-slot and BEM class", () => {
    renderInfoPopover()

    const trigger = screen.getByRole("button", { name: "Click me" })
    expect(trigger).toBeInTheDocument()
    expect(trigger).toHaveAttribute("data-slot", "info-popover-trigger")
    expect(trigger).toHaveClass("info-popover__trigger")
  })

  it("[tag:info-popover][tag:rendering] should render default info icon trigger when no trigger is provided", () => {
    renderWithProviders(<InfoPopover content="Info text" />)

    const trigger = screen.getByRole("button", { name: "More information" })
    expect(trigger).toHaveAttribute("data-slot", "info-popover-trigger")
    expect(trigger).toHaveClass("info-popover__trigger--icon")
  })

  it("[tag:info-popover][tag:rendering] should not show content by default", () => {
    renderInfoPopover()

    expect(screen.queryByText("Popover text")).not.toBeInTheDocument()
  })

  it("[tag:info-popover][tag:click] should show content on click", async () => {
    const user = userEvent.setup()
    renderInfoPopover()

    await user.click(screen.getByRole("button", { name: "Click me" }))

    const content = await screen.findByText("Popover text")
    expect(content).toBeInTheDocument()

    const popup = content.closest("[data-slot='info-popover-content']")
    expect(popup).toBeInTheDocument()
    expect(popup).toHaveClass("info-popover__popup")
  })

  it("[tag:info-popover][tag:hover] should show content on hover", async () => {
    const user = userEvent.setup()
    renderInfoPopover()

    await user.hover(screen.getByRole("button", { name: "Click me" }))

    const content = await screen.findByText("Popover text")
    expect(content).toBeInTheDocument()
  })

  it("[tag:info-popover][tag:typography][tag:rendering] should wrap string content in Typography", async () => {
    const user = userEvent.setup()
    renderInfoPopover()

    await user.click(screen.getByRole("button", { name: "Click me" }))
    const content = await screen.findByText("Popover text")

    expect(content.tagName).toBe("SPAN")
  })

  it("[tag:info-popover][tag:rendering] should render ReactNode content directly", async () => {
    const user = userEvent.setup()
    renderInfoPopover({
      content: <div data-testid="rich-content">Rich popover</div>,
    })

    await user.click(screen.getByRole("button", { name: "Click me" }))
    const rich = await screen.findByTestId("rich-content")
    expect(rich).toBeInTheDocument()
    expect(rich.textContent).toBe("Rich popover")
  })

  it("[tag:info-popover][tag:keyboard] should close on Escape", async () => {
    const user = userEvent.setup()
    renderInfoPopover()

    await user.click(screen.getByRole("button", { name: "Click me" }))
    await screen.findByText("Popover text")

    await user.keyboard("{Escape}")

    await waitFor(() => {
      expect(screen.queryByText("Popover text")).not.toBeInTheDocument()
    })
  })

  it("[tag:info-popover][tag:className] should forward className to the popup", async () => {
    const user = userEvent.setup()
    renderInfoPopover({ className: "my-custom-popover" })

    await user.click(screen.getByRole("button", { name: "Click me" }))
    const content = await screen.findByText("Popover text")

    const popup = content.closest("[data-slot='info-popover-content']")
    expect(popup).toHaveClass("info-popover__popup", "my-custom-popover")
  })

  it("[tag:info-popover][tag:a11y] should associate trigger with popup via data-popup-open", async () => {
    const user = userEvent.setup()
    renderInfoPopover()

    const trigger = screen.getByRole("button", { name: "Click me" })
    await user.click(trigger)
    await screen.findByText("Popover text")

    expect(trigger).toHaveAttribute("data-popup-open")
  })
})
