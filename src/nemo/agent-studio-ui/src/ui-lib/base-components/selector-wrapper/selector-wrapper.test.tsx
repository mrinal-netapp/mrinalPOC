import { fireEvent, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"

import { RadioGroup } from "@/ui-lib/base-components/radio-button/radio-button"
import { SelectorWrapper } from "./selector-wrapper"

describe("SelectorWrapper", () => {
  // -- 5.2 Renders checkbox
  it("[tag:selectorWrapper][tag:checkbox] should render a role checkbox element inside selector-wrapper__selector when selectorType is checkbox", () => {
    renderWithProviders(
      <SelectorWrapper selectorType="checkbox" selectorProps={{}} />,
    )

    expect(screen.getByRole("checkbox")).toBeInTheDocument()
  })

  // -- 5.3 Renders radioButton
  it("[tag:selectorWrapper][tag:radioButton] should render a role radio element when selectorType is radioButton wrapped in RadioGroup", () => {
    renderWithProviders(
      <RadioGroup>
        <SelectorWrapper selectorType="radioButton" selectorProps={{ value: "a" }} />
      </RadioGroup>,
    )

    expect(screen.getByRole("radio")).toBeInTheDocument()
  })

  // -- 5.4 Renders toggle
  it("[tag:selectorWrapper][tag:toggle] should render a role switch element when selectorType is toggle", () => {
    renderWithProviders(
      <SelectorWrapper selectorType="toggle" selectorProps={{}} />,
    )

    expect(screen.getByRole("switch")).toBeInTheDocument()
  })

  // -- 5.5 Forwards selectorProps to checkbox
  it("[tag:selectorWrapper][tag:checkbox] should forward selectorProps to the underlying Checkbox", () => {
    renderWithProviders(
      <SelectorWrapper
        selectorType="checkbox"
        selectorProps={{ checked: true, variant: "table" }}
      />,
    )

    const checkbox = screen.getByRole("checkbox")
    expect(checkbox).toHaveAttribute("data-checked", "")
    expect(checkbox).toHaveClass("checkbox-variant-table")
  })

  // -- 5.6 Forwards selectorProps to toggle
  it("[tag:selectorWrapper][tag:toggle] should forward selectorProps to the underlying Toggle", () => {
    renderWithProviders(
      <SelectorWrapper
        selectorType="toggle"
        selectorProps={{ checked: true, colorOn: "#00ff00" }}
      />,
    )

    const toggle = screen.getByRole("switch")
    expect(toggle).toHaveAttribute("data-checked", "")
    expect(toggle).toHaveStyle({ "--toggle-color-on": "#00ff00" })
  })

  // -- 5.7 Label rendering
  it("[tag:selectorWrapper][tag:label][tag:typography] should render a selector-wrapper__label span containing the label text when label is provided", () => {
    const { container } = renderWithProviders(
      <SelectorWrapper selectorType="checkbox" selectorProps={{}} label="My label" />,
    )

    const labelEl = container.querySelector(".selector-wrapper__label")
    expect(labelEl).toBeInTheDocument()
    expect(screen.getByText("My label")).toBeInTheDocument()
  })

  // -- 5.8 Description rendering
  it("[tag:selectorWrapper][tag:description][tag:typography] should render description text inside selector-wrapper__text when description is provided", () => {
    const { container } = renderWithProviders(
      <SelectorWrapper selectorType="checkbox" selectorProps={{}} description="Help text" />,
    )

    const textSection = container.querySelector(".selector-wrapper__text")
    expect(textSection).toBeInTheDocument()
    expect(screen.getByText("Help text")).toBeInTheDocument()
  })

  // -- 5.9 Label and description
  it("[tag:selectorWrapper][tag:label][tag:description][tag:typography] should render both label and description inside selector-wrapper__text when both are provided", () => {
    const { container } = renderWithProviders(
      <SelectorWrapper
        selectorType="checkbox"
        selectorProps={{}}
        label="My label"
        description="Help text"
      />,
    )

    const textSection = container.querySelector(".selector-wrapper__text")
    expect(textSection).toBeInTheDocument()
    expect(screen.getByText("My label")).toBeInTheDocument()
    expect(screen.getByText("Help text")).toBeInTheDocument()
  })

  // -- 5.10 No text section
  it("[tag:selectorWrapper][tag:label] should not render selector-wrapper__text when both label and description are omitted", () => {
    const { container } = renderWithProviders(
      <SelectorWrapper selectorType="checkbox" selectorProps={{}} />,
    )

    expect(container.querySelector(".selector-wrapper__text")).not.toBeInTheDocument()
  })

  // -- 5.11 Label click delegates to selector
  it("[tag:selectorWrapper][tag:label][tag:typography] should programmatically click the selector when the label text is clicked", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()

    renderWithProviders(
      <SelectorWrapper
        selectorType="checkbox"
        selectorProps={{ checked: false, onCheckedChange: handleChange }}
        label="Click me"
      />,
    )

    await user.click(screen.getByText("Click me"))

    expect(handleChange).toHaveBeenCalledOnce()
  })

  // -- 5.12 Disabled state
  it("[tag:selectorWrapper][tag:disabled] should apply selector-wrapper--disabled class when selectorProps.isDisabled is true", () => {
    const { container } = renderWithProviders(
      <SelectorWrapper selectorType="checkbox" selectorProps={{ isDisabled: true }} />,
    )

    expect(container.querySelector(".selector-wrapper")).toHaveClass("selector-wrapper--disabled")
  })

  it("[tag:selectorWrapper][tag:disabled] should pass root isDisabled to the underlying Checkbox", () => {
    renderWithProviders(
      <SelectorWrapper selectorType="checkbox" selectorProps={{}} isDisabled />,
    )

    expect(screen.getByRole("checkbox")).toHaveAttribute("data-disabled")
  })

  // -- 5.13 Not disabled by default
  it("[tag:selectorWrapper][tag:disabled] should not apply selector-wrapper--disabled class when isDisabled is not set", () => {
    const { container } = renderWithProviders(
      <SelectorWrapper selectorType="checkbox" selectorProps={{}} />,
    )

    expect(container.querySelector(".selector-wrapper")).not.toHaveClass("selector-wrapper--disabled")
  })

  // -- 5.14 ariaLabel forwarded from label
  it("[tag:selectorWrapper][tag:a11y] should forward the label prop as ariaLabel to the rendered selector", () => {
    renderWithProviders(
      <SelectorWrapper selectorType="checkbox" selectorProps={{}} label="Accept" />,
    )

    expect(screen.getByRole("checkbox")).toHaveAttribute("aria-label", "Accept")
  })

  // -- 5.15 ariaLabel undefined when no label
  it("[tag:selectorWrapper][tag:a11y] should not set aria-label on the selector when label is omitted", () => {
    renderWithProviders(
      <SelectorWrapper selectorType="checkbox" selectorProps={{}} />,
    )

    expect(screen.getByRole("checkbox")).not.toHaveAttribute("aria-label")
  })

  // -- 5.16 className forwarding
  it("[tag:selectorWrapper][tag:className] should append a custom className to the root selector-wrapper div", () => {
    const { container } = renderWithProviders(
      <SelectorWrapper selectorType="checkbox" selectorProps={{}} className="my-custom-class" />,
    )

    expect(container.querySelector(".selector-wrapper")).toHaveClass("my-custom-class")
  })

  // -- 5.17 Label Enter/Space activates selector via click
  it("[tag:selectorWrapper][tag:label][tag:keyboard] should click the selector when Enter is pressed on the label", async () => {
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <SelectorWrapper
        selectorType="checkbox"
        selectorProps={{ checked: false }}
        label="Press key"
      />,
    )

    const selector = container.querySelector(".checkbox") as HTMLElement
    const clickSpy = vi.spyOn(selector, "click")

    screen.getByText("Press key").focus()
    await user.keyboard("{Enter}")

    expect(clickSpy).toHaveBeenCalledOnce()
  })

  it("[tag:selectorWrapper][tag:label][tag:keyboard] should click the selector when Space is pressed on the label", async () => {
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <SelectorWrapper
        selectorType="checkbox"
        selectorProps={{ checked: false }}
        label="Press key"
      />,
    )

    const selector = container.querySelector(".checkbox") as HTMLElement
    const clickSpy = vi.spyOn(selector, "click")

    screen.getByText("Press key").focus()
    await user.keyboard(" ")

    expect(clickSpy).toHaveBeenCalledOnce()
  })

  it("[tag:selectorWrapper][tag:label][tag:keyboard] should not click the selector when a non-activation key is pressed on the label", async () => {
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <SelectorWrapper
        selectorType="checkbox"
        selectorProps={{ checked: false }}
        label="Press key"
      />,
    )

    const selector = container.querySelector(".checkbox") as HTMLElement
    const clickSpy = vi.spyOn(selector, "click")

    screen.getByText("Press key").focus()
    await user.keyboard("a")

    expect(clickSpy).not.toHaveBeenCalled()
  })

  // -- 5.19 readOnly class
  it("[tag:selectorWrapper][tag:readOnly] should apply selector-wrapper--read-only class when isReadOnly is true", () => {
    const { container } = renderWithProviders(
      <SelectorWrapper selectorType="checkbox" selectorProps={{}} isReadOnly />,
    )

    expect(container.querySelector(".selector-wrapper")).toHaveClass("selector-wrapper--read-only")
  })

  // -- 5.20 readOnly label click no-op
  it("[tag:selectorWrapper][tag:readOnly][tag:label] should not click the selector when label is clicked in readOnly mode", () => {
    const { container } = renderWithProviders(
      <SelectorWrapper
        selectorType="checkbox"
        selectorProps={{ checked: false, onCheckedChange: vi.fn() }}
        isReadOnly
        label="Click me"
      />,
    )

    const selector = container.querySelector(".checkbox") as HTMLElement
    const clickSpy = vi.spyOn(selector, "click")

    // CSS pointer-events:none blocks userEvent; use fireEvent to test JS guard
    fireEvent.click(screen.getByText("Click me"))

    expect(clickSpy).not.toHaveBeenCalled()
  })

  // -- 5.22 labelBoldness default (regular)
  it("[tag:selectorWrapper][tag:label][tag:typography] should render label with regular font weight by default when labelBoldness is not provided", () => {
    const { container } = renderWithProviders(
      <SelectorWrapper selectorType="checkbox" selectorProps={{}} label="Default label" />,
    )

    const labelEl = container.querySelector(".selector-wrapper__label")
    expect(labelEl).toHaveClass("typography--regular")
    expect(labelEl).not.toHaveClass("typography--semibold")
  })

  // -- 5.23 labelBoldness semibold
  it("[tag:selectorWrapper][tag:label][tag:typography] should render label with semibold font weight when labelBoldness is semibold", () => {
    const { container } = renderWithProviders(
      <SelectorWrapper selectorType="checkbox" selectorProps={{}} label="Bold label" labelBoldness="semibold" />,
    )

    const labelEl = container.querySelector(".selector-wrapper__label")
    expect(labelEl).toHaveClass("typography--semibold")
    expect(labelEl).not.toHaveClass("typography--regular")
  })

  // -- 5.24 descriptionBoldness default (regular)
  it("[tag:selectorWrapper][tag:description][tag:typography] should render description with regular font weight by default when descriptionBoldness is not provided", () => {
    const { container } = renderWithProviders(
      <SelectorWrapper selectorType="checkbox" selectorProps={{}} description="Default description" />,
    )

    const textSection = container.querySelector(".selector-wrapper__text")
    const descEl = textSection?.querySelector(".typography-base:not(.selector-wrapper__label)")
    expect(descEl).toHaveClass("typography--regular")
    expect(descEl).not.toHaveClass("typography--semibold")
  })

  // -- 5.25 descriptionBoldness semibold
  it("[tag:selectorWrapper][tag:description][tag:typography] should render description with semibold font weight when descriptionBoldness is semibold", () => {
    const { container } = renderWithProviders(
      <SelectorWrapper selectorType="checkbox" selectorProps={{}} description="Bold description" descriptionBoldness="semibold" />,
    )

    const textSection = container.querySelector(".selector-wrapper__text")
    const descEl = textSection?.querySelector(".typography-base:not(.selector-wrapper__label)")
    expect(descEl).toHaveClass("typography--semibold")
    expect(descEl).not.toHaveClass("typography--regular")
  })

  // -- 5.21 readOnly keyboard no-op
  it("[tag:selectorWrapper][tag:readOnly][tag:keyboard] should not click the selector on Enter or Space when isReadOnly is true", () => {
    const { container } = renderWithProviders(
      <SelectorWrapper
        selectorType="checkbox"
        selectorProps={{ checked: false }}
        isReadOnly
        label="Press key"
      />,
    )

    const selector = container.querySelector(".checkbox") as HTMLElement
    const clickSpy = vi.spyOn(selector, "click")

    const label = screen.getByText("Press key")
    fireEvent.keyDown(label, { key: "Enter" })
    fireEvent.keyDown(label, { key: " " })

    expect(clickSpy).not.toHaveBeenCalled()
  })
})
