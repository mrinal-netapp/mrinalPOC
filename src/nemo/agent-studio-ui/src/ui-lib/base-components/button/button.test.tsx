import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"

import { Button } from "./button"

describe("Button", () => {
  // -- 2.1 Default rendering
  it("[tag:button][tag:variant][tag:solid][tag:large] should render with default variant and size classes when no variant or size props are given", () => {
    // Execute
    renderWithProviders(<Button label="Default" />)

    // Validate
    const button = screen.getByRole("button")
    expect(button).toHaveAttribute("data-slot", "button")
    expect(button).toHaveClass("btn-variant-solid")
    expect(button).toHaveClass("btn-size-large")
  })

  // -- 2.2 Variant classes
  it("[tag:button][tag:variant][tag:solid] should apply btn-variant-solid class when variant is solid", () => {
    renderWithProviders(<Button variant="solid" label="Solid" />)

    expect(screen.getByRole("button")).toHaveClass("btn-variant-solid")
  })

  it("[tag:button][tag:variant][tag:solid-destructive] should apply btn-variant-solid-destructive class when variant is solid-destructive", () => {
    renderWithProviders(<Button variant="solid-destructive" label="Destructive" />)

    expect(screen.getByRole("button")).toHaveClass("btn-variant-solid-destructive")
  })

  it("[tag:button][tag:variant][tag:outline] should apply btn-variant-outline class when variant is outline", () => {
    renderWithProviders(<Button variant="outline" label="Outline" />)

    expect(screen.getByRole("button")).toHaveClass("btn-variant-outline")
  })

  it("[tag:button][tag:variant][tag:flat] should apply btn-variant-flat class when variant is flat", () => {
    renderWithProviders(<Button variant="flat" label="Flat" />)

    expect(screen.getByRole("button")).toHaveClass("btn-variant-flat")
  })

  it("[tag:button][tag:variant][tag:icon] should apply btn-variant-icon class when variant is icon", () => {
    renderWithProviders(<Button variant="icon" icon={<svg data-testid="icon-svg" />} />)

    expect(screen.getByRole("button")).toHaveClass("btn-variant-icon")
  })

  // -- 2.3 Size classes
  it("[tag:button][tag:variant][tag:large] should apply btn-size-large class when size is large", () => {
    renderWithProviders(<Button size="large" label="Large" />)

    expect(screen.getByRole("button")).toHaveClass("btn-size-large")
  })

  it("[tag:button][tag:variant][tag:medium] should apply btn-size-medium class when size is medium", () => {
    renderWithProviders(<Button size="medium" label="Medium" />)

    expect(screen.getByRole("button")).toHaveClass("btn-size-medium")
  })

  it("[tag:button][tag:variant][tag:small] should apply btn-size-small class when size is small", () => {
    renderWithProviders(<Button size="small" label="Small" />)

    expect(screen.getByRole("button")).toHaveClass("btn-size-small")
  })

  // -- 2.4 Label rendering
  it("[tag:button] should render a btn-label span containing the text when label prop is provided", () => {
    renderWithProviders(<Button label="Click" />)

    const labelSpan = screen.getByText("Click")
    expect(labelSpan).toHaveClass("btn-label")
  })

  it("[tag:button] should not render a btn-label span when label prop is omitted", () => {
    const { container } = renderWithProviders(<Button variant="icon" icon={<svg />} />)

    expect(container.querySelector(".btn-label")).not.toBeInTheDocument()
  })

  // -- 2.5 Icon rendering
  it("[tag:button] should render a btn-icon span wrapping the icon when icon prop is provided", () => {
    renderWithProviders(<Button variant="icon" icon={<svg data-testid="icon-svg" />} />)

    const icon = screen.getByTestId("icon-svg")
    expect(icon.parentElement).toHaveClass("btn-icon")
  })

  it("[tag:button] should not render a btn-icon span when icon prop is omitted", () => {
    const { container } = renderWithProviders(<Button label="No Icon" />)

    expect(container.querySelector(".btn-icon")).not.toBeInTheDocument()
  })

  // -- 2.6 Icon + label combined
  it("[tag:button] should render both btn-icon and btn-label spans when both icon and label props are provided", () => {
    const { container } = renderWithProviders(
      <Button label="With Icon" icon={<svg data-testid="icon-svg" />} />,
    )

    expect(container.querySelector(".btn-icon")).toBeInTheDocument()
    expect(container.querySelector(".btn-label")).toBeInTheDocument()
  })

  // -- 2.7 Loading state
  it("[tag:button][tag:loading][tag:spinner] should show spinner, hide icon and label, set aria-busy, and disable button when loading is true", () => {
    const { container } = renderWithProviders(
      <Button label="Loading" icon={<svg data-testid="icon-svg" />} loading={true} />,
    )

    const button = screen.getByRole("button")
    const spinner = screen.getByRole("status")
    expect(spinner).toBeInTheDocument()
    expect(spinner).toHaveClass("btn-spinner")
    expect(container.querySelector(".btn-icon")).not.toBeInTheDocument()
    expect(container.querySelector(".btn-label")).not.toBeInTheDocument()
    expect(button).toHaveAttribute("aria-busy", "true")
    expect(button).toBeDisabled()
  })

  it("[tag:button][tag:loading][tag:spinner] should not render spinner when loading is false", () => {
    renderWithProviders(<Button label="Ready" loading={false} />)

    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  // -- 2.8 Disabled state
  it("[tag:button][tag:disabled] should have the disabled attribute when isDisabled is true", () => {
    renderWithProviders(<Button label="Disabled" isDisabled={true} />)

    expect(screen.getByRole("button")).toBeDisabled()
  })

  // -- 2.9 Loading overrides disabled
  it("[tag:button][tag:loading][tag:disabled] should still be disabled when loading is true and isDisabled is false", () => {
    renderWithProviders(<Button label="Still Disabled" loading={true} isDisabled={false} />)

    expect(screen.getByRole("button")).toBeDisabled()
  })

  // -- 2.10 Click handler
  it("[tag:button] should fire the onClick callback when the button is clicked", async () => {
    // Setup
    const user = userEvent.setup()
    const handleClick = vi.fn()

    // Execute
    renderWithProviders(<Button label="Click Me" onClick={handleClick} />)
    await user.click(screen.getByRole("button"))

    // Validate
    expect(handleClick).toHaveBeenCalledOnce()
  })

  it("[tag:button][tag:disabled] should not fire onClick when the button is disabled", async () => {
    // Setup
    // pointerEventsCheck: 0 skips the CSS pointer-events guard (Base UI sets
    // pointer-events:none on disabled buttons) so we can simulate the interaction;
    // the native `disabled` attribute still prevents the React onClick from firing.
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const handleClick = vi.fn()

    // Execute
    renderWithProviders(<Button label="Disabled" onClick={handleClick} isDisabled={true} />)
    await user.click(screen.getByRole("button"))

    // Validate
    expect(handleClick).not.toHaveBeenCalled()
  })

  it("[tag:button][tag:loading][tag:spinner] should not fire onClick when the button is loading", async () => {
    // Setup
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const handleClick = vi.fn()

    // Execute
    renderWithProviders(<Button label="Loading" onClick={handleClick} loading={true} />)
    await user.click(screen.getByRole("button"))

    // Validate
    expect(handleClick).not.toHaveBeenCalled()
  })

  // -- 2.11 className forwarding
  it("[tag:button] should append a custom className to the button's class list", () => {
    renderWithProviders(<Button label="Custom" className="my-custom-class" />)

    expect(screen.getByRole("button")).toHaveClass("my-custom-class")
  })

  // -- 2.12 Prop forwarding
  it("[tag:button] should forward aria-label and id attributes to the underlying button element", () => {
    renderWithProviders(
      <Button variant="icon" icon={<svg />} aria-label="Close dialog" id="close-btn" />,
    )

    const button = screen.getByRole("button")
    expect(button).toHaveAttribute("aria-label", "Close dialog")
    expect(button).toHaveAttribute("id", "close-btn")
  })
})
