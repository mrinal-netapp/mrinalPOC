import React, { useState } from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import {
  AUTOMATIC_RETRIES_CONFIG_STRINGS,
  DEFAULT_AUTOMATIC_RETRIES_CONFIG,
  MAX_RETRIES_RANGE,
} from "./configure-dialogs.consts"
import type { AutomaticRetriesConfig } from "./configure-dialogs.types"
import { AutomaticRetriesConfigDialog } from "./automatic-retries-config-dialog"

const handlers = () => ({
  onClose: vi.fn(),
  onDraftChange: vi.fn(),
  onSave: vi.fn(),
})

function renderDialog(
  draft: AutomaticRetriesConfig,
  extra?: Partial<ReturnType<typeof handlers>>,
) {
  const h = { ...handlers(), ...extra }
  const result = render(
    <AutomaticRetriesConfigDialog open draft={draft} {...h} />,
  )
  return { ...result, ...h }
}

const getRetriesInput = (): HTMLInputElement =>
  screen.getByLabelText(AUTOMATIC_RETRIES_CONFIG_STRINGS.MAX_RETRIES_LABEL) as HTMLInputElement

describe("AutomaticRetriesConfigDialog", () => {
  it("[tag:automatic-retries-config-dialog] renders nothing when closed", () => {
    const { container } = render(
      <AutomaticRetriesConfigDialog
        open={false}
        draft={DEFAULT_AUTOMATIC_RETRIES_CONFIG}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    expect(container.querySelector(".automatic-retries-config-dialog")).not.toBeInTheDocument()
  })

  it("[tag:automatic-retries-config-dialog] renders title, description, and the toggle", () => {
    renderDialog(DEFAULT_AUTOMATIC_RETRIES_CONFIG)

    expect(screen.getByText(AUTOMATIC_RETRIES_CONFIG_STRINGS.DIALOG_TITLE)).toBeInTheDocument()
    expect(screen.getByText(AUTOMATIC_RETRIES_CONFIG_STRINGS.DESCRIPTION)).toBeInTheDocument()
    expect(
      screen.getByRole("switch", { name: AUTOMATIC_RETRIES_CONFIG_STRINGS.TOGGLE_LABEL }),
    ).toBeInTheDocument()
  })

  it("[tag:automatic-retries-config-dialog] numeric input is hidden when toggle is off", () => {
    renderDialog({ ...DEFAULT_AUTOMATIC_RETRIES_CONFIG, enabled: false })
    expect(
      screen.queryByLabelText(AUTOMATIC_RETRIES_CONFIG_STRINGS.MAX_RETRIES_LABEL),
    ).not.toBeInTheDocument()
  })

  it("[tag:automatic-retries-config-dialog] retries input reflects controlled value and lifts changes", () => {
    const onDraftChange = vi.fn()
    renderDialog({ ...DEFAULT_AUTOMATIC_RETRIES_CONFIG, maxRetries: 5 }, { onDraftChange })

    expect(getRetriesInput()).toHaveValue(5)

    fireEvent.change(getRetriesInput(), { target: { value: "7" } })
    expect(onDraftChange).toHaveBeenCalledWith({ maxRetries: 7 })
  })

  it("[tag:automatic-retries-config-dialog] empty input lifts as -1 so range validator fires", () => {
    const onDraftChange = vi.fn()
    renderDialog(DEFAULT_AUTOMATIC_RETRIES_CONFIG, { onDraftChange })

    fireEvent.change(getRetriesInput(), { target: { value: "" } })

    expect(onDraftChange).toHaveBeenCalledWith({ maxRetries: -1 })
  })

  it("[tag:automatic-retries-config-dialog] keeps the field blank while typing after it is cleared", () => {
    renderDialog({ ...DEFAULT_AUTOMATIC_RETRIES_CONFIG, maxRetries: 5 })
    const input = getRetriesInput()

    fireEvent.change(input, { target: { value: "" } })

    // The field stays blank instead of snapping back to the -1 sentinel,
    // so the user can freely type a fresh value.
    expect(input.value).toBe("")
  })

  it("[tag:automatic-retries-config-dialog] surfaces the range error live without waiting for Save", () => {
    renderDialog({ enabled: true, maxRetries: MAX_RETRIES_RANGE.max + 5 })

    expect(
      screen.getByText(AUTOMATIC_RETRIES_CONFIG_STRINGS.MAX_RETRIES_ERROR),
    ).toBeInTheDocument()
  })

  it("[tag:automatic-retries-config-dialog] blocks Save when retries are out of range", async () => {
    const user = userEvent.setup({ delay: null })
    const onSave = vi.fn()

    renderDialog({ enabled: true, maxRetries: MAX_RETRIES_RANGE.max + 5 }, { onSave })

    await user.click(
      screen.getByRole("button", { name: AUTOMATIC_RETRIES_CONFIG_STRINGS.SAVE_ACTION_LABEL }),
    )

    expect(onSave).not.toHaveBeenCalled()
    expect(
      screen.getByText(AUTOMATIC_RETRIES_CONFIG_STRINGS.MAX_RETRIES_ERROR),
    ).toBeInTheDocument()
  })

  it("[tag:automatic-retries-config-dialog] allows Save when toggle is off regardless of retries value", async () => {
    const user = userEvent.setup({ delay: null })
    const onSave = vi.fn()

    renderDialog({ enabled: false, maxRetries: 99999 }, { onSave })

    await user.click(
      screen.getByRole("button", { name: AUTOMATIC_RETRIES_CONFIG_STRINGS.SAVE_ACTION_LABEL }),
    )

    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("[tag:automatic-retries-config-dialog] fires onSave when retries are in range", async () => {
    const user = userEvent.setup({ delay: null })
    const onSave = vi.fn()

    renderDialog(DEFAULT_AUTOMATIC_RETRIES_CONFIG, { onSave })

    await user.click(
      screen.getByRole("button", { name: AUTOMATIC_RETRIES_CONFIG_STRINGS.SAVE_ACTION_LABEL }),
    )

    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("[tag:automatic-retries-config-dialog] Cancel fires onClose", async () => {
    const user = userEvent.setup({ delay: null })
    const onClose = vi.fn()

    renderDialog(DEFAULT_AUTOMATIC_RETRIES_CONFIG, { onClose })

    await user.click(
      screen.getByRole("button", { name: AUTOMATIC_RETRIES_CONFIG_STRINGS.CANCEL_ACTION_LABEL }),
    )

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("[tag:automatic-retries-config-dialog] state-managed integration: maxRetries persists across toggle off/on", async () => {
    const user = userEvent.setup({ delay: null })

    function Harness(): React.ReactElement {
      const [draft, setDraft] = useState<AutomaticRetriesConfig>({
        enabled: true,
        maxRetries: 7,
      })
      return (
        <AutomaticRetriesConfigDialog
          open
          draft={draft}
          onClose={vi.fn()}
          onSave={vi.fn()}
          onDraftChange={(next) => setDraft((prev) => ({ ...prev, ...next }))}
        />
      )
    }

    render(<Harness />)
    expect(getRetriesInput()).toHaveValue(7)

    await user.click(
      screen.getByRole("switch", { name: AUTOMATIC_RETRIES_CONFIG_STRINGS.TOGGLE_LABEL }),
    )
    expect(
      screen.queryByLabelText(AUTOMATIC_RETRIES_CONFIG_STRINGS.MAX_RETRIES_LABEL),
    ).not.toBeInTheDocument()

    await user.click(
      screen.getByRole("switch", { name: AUTOMATIC_RETRIES_CONFIG_STRINGS.TOGGLE_LABEL }),
    )
    expect(getRetriesInput()).toHaveValue(7)
  })

  it("[tag:automatic-retries-config-dialog] refreshes visible value from draft when reopened after closed-state reseed", () => {
    const { rerender } = render(
      <AutomaticRetriesConfigDialog
        open
        draft={{ enabled: true, maxRetries: 5 }}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    expect(getRetriesInput()).toHaveValue(5)

    rerender(
      <AutomaticRetriesConfigDialog
        open={false}
        draft={{ enabled: true, maxRetries: 11 }}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    rerender(
      <AutomaticRetriesConfigDialog
        open
        draft={{ enabled: true, maxRetries: 11 }}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )

    expect(getRetriesInput()).toHaveValue(11)
  })

  it("[tag:automatic-retries-config-dialog] Save reset keeps next open aligned with parent-reseeded draft", async () => {
    const user = userEvent.setup({ delay: null })

    function Harness(): React.ReactElement {
      const [open, setOpen] = useState(true)
      const [draft, setDraft] = useState<AutomaticRetriesConfig>({
        enabled: true,
        maxRetries: 5,
      })

      return (
        <>
          <AutomaticRetriesConfigDialog
            open={open}
            draft={draft}
            onClose={() => setOpen(false)}
            onSave={() => {
              setOpen(false)
              setDraft({ enabled: true, maxRetries: 11 })
            }}
            onDraftChange={(next) => setDraft((prev) => ({ ...prev, ...next }))}
          />
          <button type="button" onClick={() => setOpen(true)}>
            Reopen
          </button>
        </>
      )
    }

    render(<Harness />)

    fireEvent.change(getRetriesInput(), { target: { value: "7" } })
    await user.click(
      screen.getByRole("button", { name: AUTOMATIC_RETRIES_CONFIG_STRINGS.SAVE_ACTION_LABEL }),
    )
    await user.click(screen.getByRole("button", { name: "Reopen" }))

    expect(getRetriesInput()).toHaveValue(11)
  })
})
