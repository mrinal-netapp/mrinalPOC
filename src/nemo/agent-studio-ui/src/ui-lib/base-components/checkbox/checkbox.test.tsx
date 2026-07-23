import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"

import { Checkbox } from "./checkbox"

describe("Checkbox", () => {
  // -- 1.2 Default rendering
  it("[tag:checkbox][tag:rendering] should render with data-slot checkbox and default variant class checkbox-variant-solid when no props are given", () => {
    renderWithProviders(<Checkbox />)

    const checkbox = screen.getByRole("checkbox")
    expect(checkbox).toHaveAttribute("data-slot", "checkbox")
    expect(checkbox).toHaveClass("checkbox-variant-solid")
  })

  // -- 1.3 Variant: solid
  it("[tag:checkbox][tag:variant][tag:solid] should apply checkbox-variant-solid class when variant is solid", () => {
    renderWithProviders(<Checkbox variant="solid" />)

    expect(screen.getByRole("checkbox")).toHaveClass("checkbox-variant-solid")
  })

  // -- 1.4 Variant: table
  it("[tag:checkbox][tag:variant][tag:table] should apply checkbox-variant-table class when variant is table", () => {
    renderWithProviders(<Checkbox variant="table" />)

    expect(screen.getByRole("checkbox")).toHaveClass("checkbox-variant-table")
  })

  // -- 1.5 Checked state
  it("[tag:checkbox][tag:checked] should have data-checked attribute when checked is true", () => {
    renderWithProviders(<Checkbox checked={true} />)

    expect(screen.getByRole("checkbox")).toHaveAttribute("data-checked", "")
  })

  // -- 1.6 Unchecked state
  it("[tag:checkbox][tag:unchecked] should not have data-checked attribute when checked is false", () => {
    renderWithProviders(<Checkbox checked={false} />)

    expect(screen.getByRole("checkbox")).not.toHaveAttribute("data-checked")
  })

  // -- 1.7 Indeterminate state
  it("[tag:checkbox][tag:indeterminate] should render the minus svg with a rect element and have data-indeterminate when indeterminate is true", () => {
    const { container } = renderWithProviders(<Checkbox indeterminate={true} />)

    expect(screen.getByRole("checkbox")).toHaveAttribute("data-indeterminate", "")

    const rect = container.querySelector(".checkbox__icon rect")
    expect(rect).toBeInTheDocument()
  })

  // -- 1.8 Checked indicator
  it("[tag:checkbox][tag:checked] should render the checkmark svg with a path element when checked is true and indeterminate is false", () => {
    const { container } = renderWithProviders(<Checkbox checked={true} indeterminate={false} />)

    const path = container.querySelector(".checkbox__icon path")
    expect(path).toBeInTheDocument()
  })

  // -- 1.9 onCheckedChange callback
  it("[tag:checkbox][tag:callback] should fire onCheckedChange with the new value when clicked", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()

    renderWithProviders(<Checkbox checked={false} onCheckedChange={handleChange} />)
    await user.click(screen.getByRole("checkbox"))

    expect(handleChange).toHaveBeenCalledOnce()
    expect(handleChange).toHaveBeenCalledWith(true, expect.anything())
  })

  // -- 1.10 + 1.11 Disabled state and interaction
  it("[tag:checkbox][tag:disabled] should have data-disabled attribute and not fire onCheckedChange when isDisabled is true", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const handleChange = vi.fn()

    renderWithProviders(<Checkbox isDisabled={true} onCheckedChange={handleChange} />)

    expect(screen.getByRole("checkbox")).toHaveAttribute("data-disabled", "")

    await user.click(screen.getByRole("checkbox"))

    expect(handleChange).not.toHaveBeenCalled()
  })

  // -- 1.12 Error state
  it("[tag:checkbox][tag:error] should apply checkbox--error class and aria-invalid true when isError is true", () => {
    renderWithProviders(<Checkbox isError={true} />)

    const checkbox = screen.getByRole("checkbox")
    expect(checkbox).toHaveClass("checkbox--error")
    expect(checkbox).toHaveAttribute("aria-invalid", "true")
  })

  // -- 1.13 Warning state
  it("[tag:checkbox][tag:warning] should apply checkbox--warning class when isWarning is true", () => {
    renderWithProviders(<Checkbox isWarning={true} />)

    expect(screen.getByRole("checkbox")).toHaveClass("checkbox--warning")
  })

  // -- 1.14 aria-label
  it("[tag:checkbox][tag:a11y] should forward ariaLabel to aria-label on the root element", () => {
    renderWithProviders(<Checkbox ariaLabel="Accept terms" />)

    expect(screen.getByRole("checkbox")).toHaveAttribute("aria-label", "Accept terms")
  })

  // -- 1.15 aria-labelledby
  it("[tag:checkbox][tag:a11y] should forward ariaLabelledBy to aria-labelledby on the root element", () => {
    renderWithProviders(<Checkbox ariaLabelledBy="label-id" />)

    expect(screen.getByRole("checkbox")).toHaveAttribute("aria-labelledby", "label-id")
  })

  // -- 1.16 className forwarding
  it("[tag:checkbox][tag:className] should append a custom className to the root element", () => {
    renderWithProviders(<Checkbox className="my-custom-class" />)

    expect(screen.getByRole("checkbox")).toHaveClass("my-custom-class")
  })
})
