import { act, screen } from "@testing-library/react"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"

import { Slider } from "./slider"
import type { SliderProps } from "./slider"

// jsdom does not implement pointer capture APIs used by Base UI internally
const originalSetPointerCapture = Element.prototype.setPointerCapture
const originalReleasePointerCapture = Element.prototype.releasePointerCapture

beforeAll(() => {
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
})

afterAll(() => {
  Element.prototype.setPointerCapture = originalSetPointerCapture
  Element.prototype.releasePointerCapture = originalReleasePointerCapture
})

// -- helpers

function renderSlider(overrides: Partial<SliderProps> = {}) {
  const defaultProps: SliderProps = { defaultValue: 50, min: 0, max: 100 }
  return renderWithProviders(<Slider {...defaultProps} {...overrides} />)
}

function getThumbInput(): HTMLInputElement {
  return screen.getByRole("slider") as HTMLInputElement
}

// ===== Slider =====

describe("Slider", () => {
  // 1 — Rendering / anatomy

  // 1.1
  it("[tag:slider][tag:rendering] should render with data-slot, default variant classes, and a single thumb", () => {
    const { container } = renderSlider()

    const root = container.querySelector("[data-slot='slider']")
    expect(root).toBeInTheDocument()
    expect(container.querySelector(".slider")).toBeInTheDocument()
    expect(container.querySelector(".slider--horizontal")).toBeInTheDocument()
    expect(container.querySelector(".slider--medium")).toBeInTheDocument()
    expect(container.querySelectorAll(".slider__thumb")).toHaveLength(1)
  })

  // 1.2
  it("[tag:slider][tag:rendering] should render two thumbs for range value with distinct aria-labels", () => {
    renderSlider({ defaultValue: [20, 80] })

    const thumbs = screen.getAllByRole("slider")
    expect(thumbs).toHaveLength(2)
    expect(thumbs[0]).toHaveAttribute("aria-label", "Minimum value")
    expect(thumbs[1]).toHaveAttribute("aria-label", "Maximum value")
  })

  // 1.2a
  it("[tag:slider][tag:rendering][tag:a11y] should not set aria-label on a single thumb", () => {
    renderSlider({ defaultValue: 50 })

    const thumb = screen.getByRole("slider")
    expect(thumb).not.toHaveAttribute("aria-label")
  })

  // 1.3
  it("[tag:slider][tag:rendering] should render one thumb for controlled single number value", () => {
    const { container } = renderWithProviders(
      <Slider value={30} min={0} max={100} />,
    )

    const thumbs = container.querySelectorAll(".slider__thumb")
    expect(thumbs).toHaveLength(1)
  })

  // 1.4
  it("[tag:slider][tag:rendering] should render two thumbs for controlled array value", () => {
    const { container } = renderWithProviders(
      <Slider value={[20, 80]} min={0} max={100} />,
    )

    const thumbs = container.querySelectorAll(".slider__thumb")
    expect(thumbs).toHaveLength(2)
  })

  // 1.5
  it("[tag:slider][tag:rendering] should fallback to [min] when no value or defaultValue is provided", () => {
    const { container } = renderWithProviders(
      <Slider min={10} max={100} />,
    )

    const thumbs = container.querySelectorAll(".slider__thumb")
    expect(thumbs).toHaveLength(1)
  })

  // 2 — Disabled

  // 2.1
  it("[tag:slider][tag:disabled] should apply disabled state via data-disabled on root", () => {
    const { container } = renderSlider({ isDisabled: true })

    const root = container.querySelector("[data-slot='slider']")
    expect(root).toHaveAttribute("data-disabled", "")
  })

  // 3 — Orientation variants

  // 3.1
  it("[tag:slider][tag:variant][tag:vertical] should apply vertical orientation variant class", () => {
    const { container } = renderSlider({ orientation: "vertical" })

    expect(container.querySelector(".slider--vertical")).toBeInTheDocument()
    expect(container.querySelector(".slider--horizontal")).not.toBeInTheDocument()
  })

  // 4 — Size variants

  // 4.1
  it("[tag:slider][tag:variant][tag:small] should apply small size variant class", () => {
    const { container } = renderSlider({ size: "small" })

    expect(container.querySelector(".slider--small")).toBeInTheDocument()
    expect(container.querySelector(".slider--medium")).not.toBeInTheDocument()
  })

  // 5 — Label

  // 5.1
  it("[tag:slider][tag:typography][tag:label] should render label via Typography when label prop is provided", () => {
    renderSlider({ label: "Volume" })

    expect(screen.getByText("Volume")).toBeInTheDocument()
  })

  // 5.2
  it("[tag:slider][tag:typography][tag:label] should not render label when label prop is omitted", () => {
    const { container } = renderSlider()

    expect(container.querySelector(".slider__label")).not.toBeInTheDocument()
  })

  // 5.3
  it("[tag:slider][tag:a11y][tag:label] should associate label with slider via aria-labelledby", () => {
    const { container } = renderSlider({ label: "Volume" })

    const label = screen.getByText("Volume").closest("label")
    const labelId = label?.getAttribute("id")
    expect(labelId).toBeTruthy()

    const root = container.querySelector("[data-slot='slider']")
    expect(root).toHaveAttribute("aria-labelledby", labelId)
  })

  // 5.4
  it("[tag:slider][tag:a11y][tag:label] should not set aria-labelledby when label is omitted", () => {
    const { container } = renderSlider()

    const root = container.querySelector("[data-slot='slider']")
    expect(root).not.toHaveAttribute("aria-labelledby")
  })

  // 5.5
  it("[tag:slider][tag:a11y][tag:label] should set aria-labelledby to ariaLabelledBy when no internal label", () => {
    const { container } = renderSlider({ ariaLabelledBy: "external-label" })

    const root = container.querySelector("[data-slot='slider']")
    expect(root).toHaveAttribute("aria-labelledby", "external-label")
  })

  // 5.6
  it("[tag:slider][tag:a11y][tag:label] should merge internal labelId and ariaLabelledBy in aria-labelledby when both are set", () => {
    const { container } = renderSlider({ label: "Volume", ariaLabelledBy: "external-label" })

    const label = screen.getByText("Volume").closest("label")
    const internalLabelId = label?.getAttribute("id")
    expect(internalLabelId).toBeTruthy()

    const root = container.querySelector("[data-slot='slider']")
    expect(root).toHaveAttribute("aria-labelledby", `${internalLabelId} external-label`)
  })

  // 6 — Callback / className

  // 6.0
  it("[tag:slider][tag:callback] should handle array value from range slider in onValueChange", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()
    renderSlider({ defaultValue: [30, 70], isShowCurrent: true, onValueChange: handleChange })

    const thumbs = screen.getAllByRole("slider")
    await act(async () => {
      thumbs[0].focus()
      await user.keyboard("{ArrowRight}")
    })

    expect(handleChange).toHaveBeenCalled()
  })

  // 6.1
  it("[tag:slider][tag:callback] should fire onValueChange when arrow key is pressed on the thumb", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()
    renderSlider({ defaultValue: 50, onValueChange: handleChange })

    const thumb = getThumbInput()
    await act(async () => {
      thumb.focus()
      await user.keyboard("{ArrowRight}")
    })

    expect(handleChange).toHaveBeenCalled()
    const lastCall = handleChange.mock.calls[handleChange.mock.calls.length - 1]
    expect(lastCall[0]).toBeGreaterThan(50)
  })

  // 6.2
  it("[tag:slider][tag:callback] should decrease value with ArrowLeft", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()
    renderSlider({ defaultValue: 50, onValueChange: handleChange })

    const thumb = getThumbInput()
    await act(async () => {
      thumb.focus()
      await user.keyboard("{ArrowLeft}")
    })

    expect(handleChange).toHaveBeenCalled()
    const lastCall = handleChange.mock.calls[handleChange.mock.calls.length - 1]
    expect(lastCall[0]).toBeLessThan(50)
  })

  // 6.3
  it("[tag:slider][tag:callback] should clamp at max and not exceed it", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()
    renderSlider({ defaultValue: 100, max: 100, onValueChange: handleChange })

    const thumb = getThumbInput()
    await act(async () => {
      thumb.focus()
      await user.keyboard("{ArrowRight}")
      await user.keyboard("{ArrowRight}")
    })

    for (const call of handleChange.mock.calls) {
      expect(call[0]).toBeLessThanOrEqual(100)
    }

    expect(thumb).toHaveAttribute("aria-valuenow", "100")
  })

  // 6.4
  it("[tag:slider][tag:callback] should clamp at min and not go below it", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()
    renderSlider({ defaultValue: 0, min: 0, onValueChange: handleChange })

    const thumb = getThumbInput()
    await act(async () => {
      thumb.focus()
      await user.keyboard("{ArrowLeft}")
      await user.keyboard("{ArrowLeft}")
    })

    for (const call of handleChange.mock.calls) {
      expect(call[0]).toBeGreaterThanOrEqual(0)
    }

    expect(thumb).toHaveAttribute("aria-valuenow", "0")
  })

  // 6.5
  it("[tag:slider][tag:callback] should fire onValueCommitted after keyboard interaction", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()
    const handleCommitted = vi.fn()
    renderSlider({
      defaultValue: 50,
      onValueChange: handleChange,
      onValueCommitted: handleCommitted,
    })

    const thumb = getThumbInput()
    await act(async () => {
      thumb.focus()
      await user.keyboard("{ArrowRight}")
    })

    expect(handleChange).toHaveBeenCalled()
    expect(handleCommitted).toHaveBeenCalled()

    const changeCount = handleChange.mock.calls.length
    const commitCount = handleCommitted.mock.calls.length
    expect(commitCount).toBeLessThanOrEqual(changeCount)
  })

  // 6.6
  it("[tag:slider][tag:callback][tag:disabled] should mark thumb as disabled and prevent interaction", () => {
    const { container } = renderSlider({ defaultValue: 50, isDisabled: true })

    const thumb = getThumbInput()
    expect(thumb).toBeDisabled()

    const root = container.querySelector("[data-slot='slider']")
    expect(root).toHaveAttribute("data-disabled", "")
  })

  // 6.7
  it("[tag:slider][tag:className] should forward className to the wrapper root", () => {
    const { container } = renderSlider({ className: "my-custom-slider" })

    expect(container.querySelector(".slider.my-custom-slider")).toBeInTheDocument()
  })

  // 7 — isShowLimits

  // 7.1
  it("[tag:slider][tag:limits] should render min and max labels when isShowLimits is true", () => {
    renderSlider({ min: 5, max: 95, isShowLimits: true })

    expect(screen.getByText("5")).toBeInTheDocument()
    expect(screen.getByText("95")).toBeInTheDocument()
  })

  // 7.2
  it("[tag:slider][tag:limits] should not render limit labels when isShowLimits is false", () => {
    const { container } = renderSlider({ min: 5, max: 95, isShowLimits: false })

    expect(container.querySelector(".slider__limit")).not.toBeInTheDocument()
  })

  // 7.3
  it("[tag:slider][tag:limits] should apply slider--with-limits class when isShowLimits is true", () => {
    const { container } = renderSlider({ isShowLimits: true })

    expect(container.querySelector(".slider--with-limits")).toBeInTheDocument()
  })

  // 8 — isShowCurrent

  // 8.1
  it("[tag:slider][tag:current] should render a readonly current-value input when isShowCurrent is true", () => {
    renderSlider({ defaultValue: 42, isShowCurrent: true })

    const input = screen.getByLabelText("Current slider value") as HTMLInputElement
    expect(input).toBeInTheDocument()
    expect(input.value).toBe("42")
    expect(input).toHaveAttribute("readonly")
    expect(input).toHaveAttribute("tabindex", "-1")
  })

  // 8.2
  it("[tag:slider][tag:current] should not render current-value input when isShowCurrent is false", () => {
    const { container } = renderSlider({ defaultValue: 42 })

    expect(container.querySelector(".slider__current")).not.toBeInTheDocument()
  })

  // 8.3
  it("[tag:slider][tag:current] should reflect value changes in the current-value display", async () => {
    const user = userEvent.setup()
    renderSlider({ defaultValue: 50, isShowCurrent: true })

    const thumb = getThumbInput()
    await act(async () => {
      thumb.focus()
      await user.keyboard("{ArrowRight}")
    })

    const input = screen.getByLabelText("Current slider value") as HTMLInputElement
    expect(Number(input.value)).toBeGreaterThan(50)
  })

  // 9 — isEditInput

  // 9.1
  it("[tag:slider][tag:edit-input] should make the current-value input editable when isEditInput is true", () => {
    renderSlider({ defaultValue: 50, isShowCurrent: true, isEditInput: true })

    const input = screen.getByLabelText("Current slider value") as HTMLInputElement
    expect(input).not.toHaveAttribute("readonly")
    expect(input).toHaveAttribute("tabindex", "0")
  })

  // 9.2
  it("[tag:slider][tag:edit-input] should commit typed value on blur and clamp to range", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()
    renderSlider({
      defaultValue: 50,
      min: 0,
      max: 100,
      isShowCurrent: true,
      isEditInput: true,
      onValueChange: handleChange,
    })

    const input = screen.getByLabelText("Current slider value") as HTMLInputElement
    await act(async () => {
      await user.clear(input)
      await user.type(input, "200")
    })

    await act(async () => {
      await user.tab()
    })

    const lastCall = handleChange.mock.calls[handleChange.mock.calls.length - 1]
    expect(lastCall[0]).toBe(100)
  })

  // 9.3
  it("[tag:slider][tag:edit-input] should commit typed value on Enter key", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()
    renderSlider({
      defaultValue: 50,
      min: 10,
      max: 90,
      isShowCurrent: true,
      isEditInput: true,
      onValueChange: handleChange,
    })

    const input = screen.getByLabelText("Current slider value") as HTMLInputElement
    await act(async () => {
      await user.clear(input)
      await user.type(input, "75")
      await user.keyboard("{Enter}")
    })

    const lastCall = handleChange.mock.calls[handleChange.mock.calls.length - 1]
    expect(lastCall[0]).toBe(75)
  })

  // 9.4
  it("[tag:slider][tag:edit-input] should discard draft and revert on Escape key", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()
    renderSlider({
      defaultValue: 50,
      isShowCurrent: true,
      isEditInput: true,
      onValueChange: handleChange,
    })

    const input = screen.getByLabelText("Current slider value") as HTMLInputElement

    await act(async () => {
      await user.clear(input)
      await user.type(input, "999")
    })

    handleChange.mockClear()

    await act(async () => {
      await user.keyboard("{Escape}")
    })

    expect(handleChange).not.toHaveBeenCalled()
    expect(input.value).toBe("50")
  })

  // 9.5
  it("[tag:slider][tag:edit-input] should discard NaN input on blur without calling onValueChange", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()
    renderSlider({
      defaultValue: 50,
      isShowCurrent: true,
      isEditInput: true,
      onValueChange: handleChange,
    })

    const input = screen.getByLabelText("Current slider value") as HTMLInputElement
    handleChange.mockClear()

    await act(async () => {
      await user.clear(input)
      await user.type(input, "abc")
    })

    await act(async () => {
      await user.tab()
    })

    expect(handleChange).not.toHaveBeenCalled()
    expect(input.value).toBe("50")
  })

  // 9.6
  it("[tag:slider][tag:edit-input] should clamp value below min on commit", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()
    renderSlider({
      defaultValue: 50,
      min: 10,
      max: 100,
      isShowCurrent: true,
      isEditInput: true,
      onValueChange: handleChange,
    })

    const input = screen.getByLabelText("Current slider value") as HTMLInputElement
    await act(async () => {
      await user.clear(input)
      await user.type(input, "3")
      await user.keyboard("{Enter}")
    })

    const lastCall = handleChange.mock.calls[handleChange.mock.calls.length - 1]
    expect(lastCall[0]).toBe(10)
  })

  // 9.7
  it("[tag:slider][tag:edit-input] should disable the current-value input when slider is disabled", () => {
    renderSlider({
      defaultValue: 50,
      isShowCurrent: true,
      isEditInput: true,
      isDisabled: true,
    })

    const input = screen.getByLabelText("Current slider value") as HTMLInputElement
    expect(input).toBeDisabled()
  })

  // 9.8
  it("[tag:slider][tag:edit-input] should handle commit with range (multi-thumb) values", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()
    renderSlider({
      defaultValue: [20, 80],
      min: 0,
      max: 100,
      isShowCurrent: true,
      isEditInput: true,
      onValueChange: handleChange,
    })

    const input = screen.getByLabelText("Current slider value") as HTMLInputElement
    await act(async () => {
      await user.clear(input)
      await user.type(input, "35")
      await user.keyboard("{Enter}")
    })

    const lastCall = handleChange.mock.calls[handleChange.mock.calls.length - 1]
    expect(lastCall[0]).toEqual([35, 80])
  })

  // 9.9
  it("[tag:slider][tag:edit-input] should be a no-op commit when inputDraft is null (blur without typing)", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()
    renderSlider({
      defaultValue: 50,
      isShowCurrent: true,
      isEditInput: true,
      onValueChange: handleChange,
    })

    const input = screen.getByLabelText("Current slider value") as HTMLInputElement
    handleChange.mockClear()

    await act(async () => {
      input.focus()
      await user.tab()
    })

    expect(handleChange).not.toHaveBeenCalled()
    expect(input.value).toBe("50")
  })
})
