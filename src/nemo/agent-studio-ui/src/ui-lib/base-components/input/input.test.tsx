import { createRef } from "react"
import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"

import { Input } from "./input"
import type { InputProps } from "./input"

function renderInput(overrides: Partial<InputProps> = {}) {
  return renderWithProviders(<Input {...overrides} />)
}

describe("Input", () => {
  // -- 1.1 Default rendering
  it("[tag:input][tag:rendering] should render an input with data-slot input and no placeholder by default", () => {
    renderInput()

    const input = screen.getByRole("textbox")
    expect(input).toHaveAttribute("data-slot", "input")
    expect(input).not.toHaveAttribute("placeholder")
  })

  // -- 1.2 Placeholder present
  it("[tag:input][tag:placeholder] should have a placeholder attribute when placeholder is provided", () => {
    renderInput({ placeholder: "Enter text" })

    expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", "Enter text")
  })

  // -- 1.3 Label present
  it("[tag:input][tag:label] should render a label when label prop is provided", () => {
    renderInput({ label: "Username" })

    expect(screen.getByText("Username")).toBeInTheDocument()
  })

  // -- 1.3a Label click focuses input
  it("[tag:input][tag:label][tag:a11y] should focus the input when the label is clicked", async () => {
    const user = userEvent.setup()

    renderInput({ label: "Username" })

    await user.click(screen.getByText("Username"))

    expect(screen.getByRole("textbox")).toHaveFocus()
  })

  // -- 1.4 No label-area when all omitted
  it("[tag:input][tag:label] should not render a label-area when label, isOptional, and tooltip are all omitted", () => {
    const { container } = renderInput()

    expect(container.querySelector(".input-wrapper__label-area")).not.toBeInTheDocument()
  })

  // -- 1.5 Optional with label
  it("[tag:input][tag:optional] should render Optional text when isOptional is true and label is present", () => {
    renderInput({ label: "Email", isOptional: true })

    expect(screen.getByText("Optional")).toBeInTheDocument()
  })

  // -- 1.6 Optional without label
  it("[tag:input][tag:optional] should render Optional text without a label when isOptional is true and label is omitted", () => {
    renderInput({ isOptional: true })

    expect(screen.getByText("Optional")).toBeInTheDocument()
  })

  // -- 1.7 Optional false
  it("[tag:input][tag:optional] should not render Optional text when isOptional is false", () => {
    renderInput({ label: "Email", isOptional: false })

    expect(screen.queryByText("Optional")).not.toBeInTheDocument()
  })

  // -- 1.8 Tooltip with label
  it("[tag:input][tag:tooltip] should render a tooltip icon when tooltip prop is provided with a label", () => {
    const { container } = renderInput({ label: "Name", tooltip: "Your full name" })

    const tooltipIcon = container.querySelector(".input-wrapper__tooltip-icon")
    expect(tooltipIcon).toBeInTheDocument()
    expect(tooltipIcon).toHaveAttribute("title", "Your full name")
  })

  // -- 1.9 Tooltip without label
  it("[tag:input][tag:tooltip] should render a tooltip icon without a label when tooltip is provided and label is omitted", () => {
    const { container } = renderInput({ tooltip: "Help text" })

    const tooltipIcon = container.querySelector(".input-wrapper__tooltip-icon")
    expect(tooltipIcon).toBeInTheDocument()
    expect(tooltipIcon).toHaveAttribute("title", "Help text")
  })

  // -- 1.10 Tooltip absent
  it("[tag:input][tag:tooltip] should not render a tooltip icon when tooltip prop is omitted", () => {
    const { container } = renderInput({ label: "Name" })

    expect(container.querySelector(".input-wrapper__tooltip-icon")).not.toBeInTheDocument()
  })

  // -- 1.11 Counter rendered
  it("[tag:input][tag:counter] should render a character counter when isShowCount is true", () => {
    renderInput({ isShowCount: true, max: 100 })

    expect(screen.getByText("0/100")).toBeInTheDocument()
  })

  // -- 1.12 Counter updates on typing
  it("[tag:input][tag:counter] should update the counter when typing", async () => {
    const user = userEvent.setup()

    renderInput({ isShowCount: true, max: 50 })

    await user.type(screen.getByRole("textbox"), "Hello")

    expect(screen.getByText("5/50")).toBeInTheDocument()
  })

  // -- 1.13 Counter not rendered
  it("[tag:input][tag:counter] should not render a counter when isShowCount is false", () => {
    const { container } = renderInput({ isShowCount: false })

    expect(container.querySelector(".input-wrapper__counter")).not.toBeInTheDocument()
  })

  // -- 1.14 Input types (merged: 1.14 + 1.15 + 1.16)
  it.each(["text", "password", "email", "search", "url", "tel", "number", "file"] as const)(
    "[tag:input][tag:type] should render with type %s",
    (type) => {
      const { container } = renderInput({ type })

      const input = container.querySelector("input")
      expect(input).toHaveAttribute("type", type)
    },
  )

  // -- 1.17 Disabled state
  it("[tag:input][tag:disabled] should have the disabled attribute when isDisabled is true", () => {
    const { container } = renderInput({ isDisabled: true })

    const input = container.querySelector("input")
    expect(input).toBeDisabled()
  })

  // -- 1.18 Read-only state
  it("[tag:input][tag:readonly] should have the readonly attribute when readOnly is true", () => {
    renderInput({ readOnly: true })

    expect(screen.getByRole("textbox")).toHaveAttribute("readonly")
  })

  // -- 1.19 Error state
  it("[tag:input][tag:error] should apply error class and aria-invalid when isError is true", () => {
    renderInput({ isError: true })

    const input = screen.getByRole("textbox")
    expect(input).toHaveClass("error")
    expect(input).toHaveAttribute("aria-invalid", "true")
  })

  // -- 1.20 Warning state
  it("[tag:input][tag:warning] should apply warning class when isWarning is true", () => {
    renderInput({ isWarning: true })

    expect(screen.getByRole("textbox")).toHaveClass("warning")
  })

  // -- 1.21 onChange callback
  it("[tag:input][tag:callback] should fire onChange when the user types", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()

    renderInput({ onChange: handleChange })

    await user.type(screen.getByRole("textbox"), "a")

    expect(handleChange).toHaveBeenCalledOnce()
  })

  // -- 1.22 Ref forwarding
  it("[tag:input][tag:ref] should forward ref to the underlying input element", () => {
    const ref = createRef<HTMLInputElement>()

    renderInput({ ref })

    expect(ref.current).toBeInstanceOf(HTMLInputElement)
    expect(ref.current?.tagName).toBe("INPUT")
  })

  // -- 1.23 className forwarding
  it("[tag:input][tag:className] should append a custom className to the wrapper element", () => {
    const { container } = renderInput({ className: "my-custom-input" })

    expect(container.querySelector(".input-wrapper.my-custom-input")).toBeInTheDocument()
  })

  // -- 1.24 Max enforcement
  it("[tag:input][tag:max] should set maxLength attribute on the input element", () => {
    renderInput({ max: 20 })

    expect(screen.getByRole("textbox")).toHaveAttribute("maxLength", "20")
  })

  // -- 1.25 Counter from controlled value
  it("[tag:input][tag:counter] should initialize counter from value when value is a string", () => {
    renderInput({ isShowCount: true, max: 50, value: "Hello", onChange: vi.fn() })

    expect(screen.getByText("5/50")).toBeInTheDocument()
  })

  // -- 1.26 Counter from defaultValue
  it("[tag:input][tag:counter] should initialize counter from defaultValue when value is not provided", () => {
    renderInput({ isShowCount: true, max: 50, defaultValue: "Hi" })

    expect(screen.getByText("2/50")).toBeInTheDocument()
  })

  // -- 1.27 Counter without max
  it("[tag:input][tag:counter] should show only the char count without slash when max is not provided", () => {
    renderInput({ isShowCount: true })

    const counter = screen.getByText("0")
    expect(counter).toBeInTheDocument()
    expect(screen.queryByText(/\//)).not.toBeInTheDocument()
  })

  // -- 1.28 Counter tracks typing and deletion
  it("[tag:input][tag:counter] should increment counter to 6 when typing 6 chars then decrement to 5 after deleting one", async () => {
    const user = userEvent.setup()

    renderInput({ isShowCount: true })

    await user.type(screen.getByRole("textbox"), "abcdef")
    expect(screen.getByText("6")).toBeInTheDocument()

    await user.keyboard("{Backspace}")
    expect(screen.getByText("5")).toBeInTheDocument()
  })

  // -- 1.29 Counter updates when controlled value changes
  it("[tag:input][tag:counter] should update counter to reflect new controlled value when value prop changes", () => {
    const { rerender } = renderInput({ isShowCount: true, max: 20, value: "Hello" })

    expect(screen.getByText("5/20")).toBeInTheDocument()

    rerender(<Input isShowCount max={20} value="Hello World" />)

    expect(screen.getByText("11/20")).toBeInTheDocument()
  })

  // -- 1.30 onChange fires in controlled mode without updating internal count
  it("[tag:input][tag:callback] should call onChange when typing in controlled mode without updating internal count", async () => {
    const user = userEvent.setup()
    const handleChange = vi.fn()

    renderInput({ value: "initial", onChange: handleChange })

    await user.type(screen.getByRole("textbox"), "a")

    expect(handleChange).toHaveBeenCalled()
  })
})
