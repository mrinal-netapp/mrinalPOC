import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"

import { Toggle } from "./toggle"

describe("Toggle", () => {
  // -- 2.2 Default rendering
  it("[tag:toggle][tag:rendering] should render with data-slot toggle and base toggle class when no props are given", () => {
    renderWithProviders(<Toggle />)

    const toggle = screen.getByRole("switch")
    expect(toggle).toHaveAttribute("data-slot", "toggle")
    expect(toggle).toHaveClass("toggle")
  })

  // -- 2.3 Checked state
  it("[tag:toggle][tag:checked] should have data-checked attribute when checked is true", () => {
    renderWithProviders(<Toggle checked={true} />)

    expect(screen.getByRole("switch")).toHaveAttribute("data-checked", "")
  })

  // -- 2.4 Unchecked state
  it("[tag:toggle][tag:unchecked] should not have data-checked attribute when checked is false", () => {
    renderWithProviders(<Toggle checked={false} />)

    expect(screen.getByRole("switch")).not.toHaveAttribute("data-checked")
  })

  // -- 2.5 onCheckedChange callback
  it("[tag:toggle][tag:callback] should fire onCheckedChange when toggled", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()

    renderWithProviders(<Toggle checked={false} onCheckedChange={handleChange} />)
    await user.click(screen.getByRole("switch"))

    expect(handleChange).toHaveBeenCalledOnce()
    expect(handleChange).toHaveBeenCalledWith(true, expect.anything())
  })

  // -- 2.6 + 2.7 Disabled state and interaction
  it("[tag:toggle][tag:disabled] should have data-disabled attribute and not fire onCheckedChange when isDisabled is true", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const handleChange = vi.fn()

    renderWithProviders(<Toggle isDisabled={true} onCheckedChange={handleChange} />)

    expect(screen.getByRole("switch")).toHaveAttribute("data-disabled", "")

    await user.click(screen.getByRole("switch"))

    expect(handleChange).not.toHaveBeenCalled()
  })

  // -- 2.8 Error state
  it("[tag:toggle][tag:error] should apply toggle--error class and aria-invalid true when isError is true", () => {
    renderWithProviders(<Toggle isError={true} />)

    const toggle = screen.getByRole("switch")
    expect(toggle).toHaveClass("toggle--error")
    expect(toggle).toHaveAttribute("aria-invalid", "true")
  })

  // -- 2.9 Warning state
  it("[tag:toggle][tag:warning] should apply toggle--warning class when isWarning is true", () => {
    renderWithProviders(<Toggle isWarning={true} />)

    expect(screen.getByRole("switch")).toHaveClass("toggle--warning")
  })

  // -- 2.10 Custom colorOn
  it("[tag:toggle][tag:cssVar] should set --toggle-color-on CSS variable via inline style when colorOn is provided", () => {
    renderWithProviders(<Toggle colorOn="#00ff00" />)

    expect(screen.getByRole("switch")).toHaveStyle({ "--toggle-color-on": "#00ff00" })
  })

  // -- 2.11 Custom colorOff
  it("[tag:toggle][tag:cssVar] should set --toggle-color-off CSS variable via inline style when colorOff is provided", () => {
    renderWithProviders(<Toggle colorOff="#ff0000" />)

    expect(screen.getByRole("switch")).toHaveStyle({ "--toggle-color-off": "#ff0000" })
  })

  // -- 2.12a Custom iconColorOn
  it("[tag:toggle][tag:cssVar] should set --toggle-icon-color-on CSS variable via inline style when iconColorOn is provided", () => {
    renderWithProviders(<Toggle iconColorOn="#0000ff" />)

    expect(screen.getByRole("switch")).toHaveStyle({ "--toggle-icon-color-on": "#0000ff" })
  })

  // -- 2.12b Custom iconColorOff
  it("[tag:toggle][tag:cssVar] should set --toggle-icon-color-off CSS variable via inline style when iconColorOff is provided", () => {
    renderWithProviders(<Toggle iconColorOff="#aaaaaa" />)

    expect(screen.getByRole("switch")).toHaveStyle({ "--toggle-icon-color-off": "#aaaaaa" })
  })

  // -- 2.13 No inline style when no custom colors
  it("[tag:toggle][tag:cssVar] should not set style attribute when colorOn, colorOff, iconColorOn, and iconColorOff are all omitted", () => {
    renderWithProviders(<Toggle />)

    expect(screen.getByRole("switch")).not.toHaveAttribute("style")
  })

  // -- 2.14 Icon rendering
  it("[tag:toggle][tag:icon] should render a toggle__icon span wrapping the icon when icon is provided", () => {
    const { container } = renderWithProviders(
      <Toggle icon={<span data-testid="my-icon" />} />,
    )

    expect(screen.getByTestId("my-icon")).toBeInTheDocument()
    expect(container.querySelector(".toggle__icon")).toBeInTheDocument()
  })

  // -- 2.15 No icon
  it("[tag:toggle][tag:icon] should not render a toggle__icon span when icon is omitted", () => {
    const { container } = renderWithProviders(<Toggle />)

    expect(container.querySelector(".toggle__icon")).not.toBeInTheDocument()
  })

  // -- 2.16 aria-labelledby
  it("[tag:toggle][tag:a11y] should forward ariaLabelledBy to aria-labelledby on root", () => {
    renderWithProviders(<Toggle ariaLabelledBy="label-id" />)

    expect(screen.getByRole("switch")).toHaveAttribute("aria-labelledby", "label-id")
  })

  // -- 2.17 className forwarding
  it("[tag:toggle][tag:className] should append a custom className to the root element", () => {
    renderWithProviders(<Toggle className="my-custom-class" />)

    expect(screen.getByRole("switch")).toHaveClass("my-custom-class")
  })
})
