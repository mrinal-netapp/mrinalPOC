import { screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"

import { renderWithProviders, userEvent } from "@test/render"

import { CronExpressionInput } from "./cron-expression-input"

// ---------------------------------------------------------------------------
// CronExpressionInput
// ---------------------------------------------------------------------------

describe("CronExpressionInput", () => {
  const onChange = vi.fn()
  const onBlur = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("wires value, onChange, onBlur, and applies className + isError to Input", async () => {
    const onKeyDown = vi.fn()
    const user = userEvent.setup()
    const { container } = renderWithProviders(
      <CronExpressionInput
        className="extra"
        value="0 0 * * *"
        onChange={onChange}
        onBlur={onBlur}
        isError
        id="sched"
        onKeyDown={onKeyDown}
        data-testid="cron"
      />,
    )

    const input = screen.getByTestId("cron")
    expect(container.querySelector(".cron-expression-input")).toHaveClass("cron-expression-input", "extra")
    expect(input).toHaveAttribute("id", "sched")
    expect(input).toHaveAttribute("autocomplete", "off")
    expect(input).toHaveAttribute("spellcheck", "false")
    expect(input).toHaveAttribute("type", "text")
    expect(container.querySelector(".cron-expression-input")).toBeInTheDocument()

    await user.type(input, "1")
    expect(onChange).toHaveBeenCalled()
    expect(onKeyDown).toHaveBeenCalled()
    await user.tab()
    expect(onBlur).toHaveBeenCalled()
  })

  it("supports readOnly and isDisabled for Input", () => {
    renderWithProviders(
      <CronExpressionInput
        value=""
        onChange={onChange}
        onBlur={onBlur}
        readOnly
        isDisabled
        data-testid="cron-rd"
      />,
    )
    const input = screen.getByTestId("cron-rd")
    expect(input).toHaveAttribute("readOnly")
    expect(input).toBeDisabled()
  })

  it("allows overriding type, autoComplete, and spellCheck", () => {
    renderWithProviders(
      <CronExpressionInput
        value=""
        onChange={onChange}
        onBlur={onBlur}
        type="text"
        autoComplete="on"
        spellCheck
        data-testid="cron-2"
      />,
    )
    const input = screen.getByTestId("cron-2")
    expect(input).toHaveAttribute("autocomplete", "on")
    expect(input).toHaveAttribute("spellcheck", "true")
  })

  it("fires onKeyDown when no custom handler is passed", () => {
    renderWithProviders(
      <CronExpressionInput
        value=""
        onChange={onChange}
        onBlur={onBlur}
        data-testid="cron-3"
      />,
    )
    const input = screen.getByTestId("cron-3")
    fireEvent.keyDown(input, { key: "Escape" })
  })
})
