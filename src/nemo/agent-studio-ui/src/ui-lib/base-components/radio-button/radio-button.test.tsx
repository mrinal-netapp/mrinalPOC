import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"

import { RadioButton, RadioGroup } from "./radio-button"

describe("RadioButton", () => {
  // -- 4.2 Default rendering
  it("[tag:radioButton][tag:rendering] should render with role radio, data-slot radio-button, and default variant class radio-button-variant-solid", () => {
    renderWithProviders(
      <RadioGroup>
        <RadioButton value="a" />
      </RadioGroup>,
    )

    const radio = screen.getByRole("radio")
    expect(radio).toHaveAttribute("data-slot", "radio-button")
    expect(radio).toHaveClass("radio-button-variant-solid")
  })

  // -- 4.3 Variant: solid
  it("[tag:radioButton][tag:variant][tag:solid] should apply radio-button-variant-solid class when variant is solid", () => {
    renderWithProviders(
      <RadioGroup>
        <RadioButton value="a" variant="solid" />
      </RadioGroup>,
    )

    expect(screen.getByRole("radio")).toHaveClass("radio-button-variant-solid")
  })

  // -- 4.4 Variant: table
  it("[tag:radioButton][tag:variant][tag:table] should apply radio-button-variant-table class when variant is table", () => {
    renderWithProviders(
      <RadioGroup>
        <RadioButton value="a" variant="table" />
      </RadioGroup>,
    )

    expect(screen.getByRole("radio")).toHaveClass("radio-button-variant-table")
  })

  // -- 4.5 Selected state
  it("[tag:radioButton][tag:selected] should have aria-checked true and data-checked when group value matches", () => {
    renderWithProviders(
      <RadioGroup value="a">
        <RadioButton value="a" />
      </RadioGroup>,
    )

    const radio = screen.getByRole("radio")
    expect(radio).toHaveAttribute("aria-checked", "true")
    expect(radio).toHaveAttribute("data-checked", "")
  })

  // -- 4.6 Unselected state
  it("[tag:radioButton][tag:unselected] should have aria-checked false and no data-checked when group value does not match", () => {
    renderWithProviders(
      <RadioGroup value="b">
        <RadioButton value="a" />
      </RadioGroup>,
    )

    const radio = screen.getByRole("radio")
    expect(radio).toHaveAttribute("aria-checked", "false")
    expect(radio).not.toHaveAttribute("data-checked")
  })

  // -- 4.7 Disabled via prop
  it("[tag:radioButton][tag:disabled] should have aria-disabled true, data-disabled, and tabIndex -1 when isDisabled is true", () => {
    renderWithProviders(
      <RadioGroup>
        <RadioButton value="a" isDisabled={true} />
      </RadioGroup>,
    )

    const radio = screen.getByRole("radio")
    expect(radio).toHaveAttribute("aria-disabled", "true")
    expect(radio).toHaveAttribute("data-disabled", "")
    expect(radio).toHaveAttribute("tabindex", "-1")
  })

  // -- 4.8 Disabled via group
  it("[tag:radioButton][tag:disabled] should inherit disabled state when parent RadioGroup has disabled true", () => {
    renderWithProviders(
      <RadioGroup disabled={true}>
        <RadioButton value="a" />
      </RadioGroup>,
    )

    const radio = screen.getByRole("radio")
    expect(radio).toHaveAttribute("aria-disabled", "true")
    expect(radio).toHaveAttribute("data-disabled", "")
  })

  // -- 4.9 Click selects
  it("[tag:radioButton][tag:click] should fire onValueChange with the clicked value when an unselected radio is clicked", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()

    renderWithProviders(
      <RadioGroup value="" onValueChange={handleChange}>
        <RadioButton value="a" />
      </RadioGroup>,
    )

    await user.click(screen.getByRole("radio"))

    expect(handleChange).toHaveBeenCalledOnce()
    expect(handleChange).toHaveBeenCalledWith("a")
  })

  // -- 4.10 Keyboard: Space selects
  it("[tag:radioButton][tag:keyboard] should select the radio when Space is pressed on a focused radio", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()

    renderWithProviders(
      <RadioGroup value="" onValueChange={handleChange}>
        <RadioButton value="a" />
      </RadioGroup>,
    )

    const radio = screen.getByRole("radio")
    radio.focus()
    await user.keyboard(" ")

    expect(handleChange).toHaveBeenCalledOnce()
    expect(handleChange).toHaveBeenCalledWith("a")
  })

  // -- 4.11 Keyboard: Enter selects
  it("[tag:radioButton][tag:keyboard] should select the radio when Enter is pressed on a focused radio", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()

    renderWithProviders(
      <RadioGroup value="" onValueChange={handleChange}>
        <RadioButton value="a" />
      </RadioGroup>,
    )

    const radio = screen.getByRole("radio")
    radio.focus()
    await user.keyboard("{Enter}")

    expect(handleChange).toHaveBeenCalledOnce()
    expect(handleChange).toHaveBeenCalledWith("a")
  })

  // -- 4.12 Disabled prevents click
  it("[tag:radioButton][tag:disabled] should not fire onValueChange when a disabled radio is clicked", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const handleChange = vi.fn()

    renderWithProviders(
      <RadioGroup value="" onValueChange={handleChange}>
        <RadioButton value="a" isDisabled={true} />
      </RadioGroup>,
    )

    await user.click(screen.getByRole("radio"))

    expect(handleChange).not.toHaveBeenCalled()
  })

  // -- 4.13 Error state
  it("[tag:radioButton][tag:error] should apply radio-button--error class and aria-invalid true when isError is true", () => {
    renderWithProviders(
      <RadioGroup>
        <RadioButton value="a" isError={true} />
      </RadioGroup>,
    )

    const radio = screen.getByRole("radio")
    expect(radio).toHaveClass("radio-button--error")
    expect(radio).toHaveAttribute("aria-invalid", "true")
  })

  // -- 4.14 Warning state
  it("[tag:radioButton][tag:warning] should apply radio-button--warning class when isWarning is true", () => {
    renderWithProviders(
      <RadioGroup>
        <RadioButton value="a" isWarning={true} />
      </RadioGroup>,
    )

    expect(screen.getByRole("radio")).toHaveClass("radio-button--warning")
  })

  // -- 4.15 aria-label
  it("[tag:radioButton][tag:a11y] should forward ariaLabel to aria-label on the root element", () => {
    renderWithProviders(
      <RadioGroup>
        <RadioButton value="a" ariaLabel="Option A" />
      </RadioGroup>,
    )

    expect(screen.getByRole("radio")).toHaveAttribute("aria-label", "Option A")
  })

  // -- 4.16 aria-labelledby
  it("[tag:radioButton][tag:a11y] should forward ariaLabelledBy to aria-labelledby on the root element", () => {
    renderWithProviders(
      <RadioGroup>
        <RadioButton value="a" ariaLabelledBy="label-id" />
      </RadioGroup>,
    )

    expect(screen.getByRole("radio")).toHaveAttribute("aria-labelledby", "label-id")
  })

  // -- 4.17 className forwarding
  it("[tag:radioButton][tag:className] should append a custom className to the root element", () => {
    renderWithProviders(
      <RadioGroup>
        <RadioButton value="a" className="my-custom-class" />
      </RadioGroup>,
    )

    expect(screen.getByRole("radio")).toHaveClass("my-custom-class")
  })

  // -- edge: RadioButton without RadioGroup context defaults
  it("[tag:radioButton][tag:rendering] should default to unchecked and enabled when rendered without a RadioGroup", () => {
    renderWithProviders(<RadioButton value="a" />)

    const radio = screen.getByRole("radio")
    expect(radio).toHaveAttribute("aria-checked", "false")
    expect(radio).not.toHaveAttribute("data-disabled")
  })

  // -- edge: keydown with unrecognized key does nothing
  it("[tag:radioButton][tag:keyboard] should not fire onValueChange when an unrecognized key is pressed", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()

    renderWithProviders(
      <RadioGroup value="" onValueChange={handleChange}>
        <RadioButton value="a" />
      </RadioGroup>,
    )

    const radio = screen.getByRole("radio")
    radio.focus()
    await user.keyboard("{Tab}")

    expect(handleChange).not.toHaveBeenCalled()
  })
})

describe("RadioGroup", () => {
  // -- 4.18 Renders radiogroup role
  it("[tag:radioGroup][tag:rendering] should render with role radiogroup and radio-group class", () => {
    renderWithProviders(
      <RadioGroup>
        <RadioButton value="a" />
      </RadioGroup>,
    )

    const group = screen.getByRole("radiogroup")
    expect(group).toHaveClass("radio-group")
  })

  // -- 4.19 Controlled single-select
  it("[tag:radioGroup][tag:controlled] should call onValueChange with the new value when clicking a different radio in single-select mode", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()

    renderWithProviders(
      <RadioGroup value="a" onValueChange={handleChange}>
        <RadioButton value="a" ariaLabel="A" />
        <RadioButton value="b" ariaLabel="B" />
      </RadioGroup>,
    )

    await user.click(screen.getByLabelText("B"))

    expect(handleChange).toHaveBeenCalledOnce()
    expect(handleChange).toHaveBeenCalledWith("b")
  })

  // -- 4.20 Uncontrolled with defaultValue
  it("[tag:radioGroup][tag:uncontrolled] should initialize selection from defaultValue and update internally on click", async () => {
    const user = userEvent.setup()

    renderWithProviders(
      <RadioGroup defaultValue="a">
        <RadioButton value="a" ariaLabel="A" />
        <RadioButton value="b" ariaLabel="B" />
      </RadioGroup>,
    )

    expect(screen.getByLabelText("A")).toHaveAttribute("aria-checked", "true")
    expect(screen.getByLabelText("B")).toHaveAttribute("aria-checked", "false")

    await user.click(screen.getByLabelText("B"))

    expect(screen.getByLabelText("A")).toHaveAttribute("aria-checked", "false")
    expect(screen.getByLabelText("B")).toHaveAttribute("aria-checked", "true")
  })

  // -- 4.21 canUnselect
  it("[tag:radioGroup][tag:canUnselect] should deselect the selected radio and call onValueChange with empty string when canUnselect is true and min is 0", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()

    renderWithProviders(
      <RadioGroup value="a" onValueChange={handleChange} min={0}>
        <RadioButton value="a" canUnselect={true} />
      </RadioGroup>,
    )

    await user.click(screen.getByRole("radio"))

    expect(handleChange).toHaveBeenCalledOnce()
    expect(handleChange).toHaveBeenCalledWith("")
  })

  // -- 4.22 canUnselect blocked by min
  it("[tag:radioGroup][tag:canUnselect] should not deselect the selected radio when min is 1", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()

    renderWithProviders(
      <RadioGroup value="a" onValueChange={handleChange} min={1}>
        <RadioButton value="a" canUnselect={true} />
      </RadioGroup>,
    )

    await user.click(screen.getByRole("radio"))

    expect(handleChange).not.toHaveBeenCalled()
  })

  // -- 4.26 canUnselect with min=0 max=1
  it("[tag:radioGroup][tag:canUnselect] should deselect then re-select when min is 0 max is 1 and canUnselect is true", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()

    renderWithProviders(
      <RadioGroup defaultValue="a" onValueChange={handleChange} min={0} max={1}>
        <RadioButton value="a" canUnselect={true} />
      </RadioGroup>,
    )

    // Deselect
    await user.click(screen.getByRole("radio"))
    expect(handleChange).toHaveBeenCalledWith("")

    // Re-select
    await user.click(screen.getByRole("radio"))
    expect(handleChange).toHaveBeenCalledWith("a")
    expect(handleChange).toHaveBeenCalledTimes(2)
  })

  // -- 4.23 Multi-select (max > 1)
  it("[tag:radioGroup][tag:multiSelect] should call onValueChange with an array when max is greater than 1 and multiple radios are selected", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()

    renderWithProviders(
      <RadioGroup defaultValue={[]} onValueChange={handleChange} max={3}>
        <RadioButton value="a" ariaLabel="A" />
        <RadioButton value="b" ariaLabel="B" />
        <RadioButton value="c" ariaLabel="C" />
      </RadioGroup>,
    )

    await user.click(screen.getByLabelText("A"))
    expect(handleChange).toHaveBeenLastCalledWith(["a"])

    await user.click(screen.getByLabelText("B"))
    expect(handleChange).toHaveBeenLastCalledWith(["a", "b"])
  })

  // -- 4.24 Multi-select max cap
  it("[tag:radioGroup][tag:multiSelect] should not add another selection when selection count equals max", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()

    renderWithProviders(
      <RadioGroup value={["a", "b"]} onValueChange={handleChange} max={2}>
        <RadioButton value="a" ariaLabel="A" />
        <RadioButton value="b" ariaLabel="B" />
        <RadioButton value="c" ariaLabel="C" />
      </RadioGroup>,
    )

    await user.click(screen.getByLabelText("C"))

    expect(handleChange).not.toHaveBeenCalled()
  })

  // -- 4.25 Group className forwarding
  it("[tag:radioGroup][tag:className] should append a custom className to the radiogroup container", () => {
    renderWithProviders(
      <RadioGroup className="my-group-class">
        <RadioButton value="a" />
      </RadioGroup>,
    )

    expect(screen.getByRole("radiogroup")).toHaveClass("my-group-class")
  })
})
