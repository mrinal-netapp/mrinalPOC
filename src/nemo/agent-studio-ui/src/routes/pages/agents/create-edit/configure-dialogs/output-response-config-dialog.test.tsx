import React, { useState } from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import {
  DEFAULT_OUTPUT_RESPONSE_CONFIG,
  OUTPUT_RESPONSE_CONFIG_STRINGS,
  OUTPUT_RESPONSE_MAX_LENGTH,
} from "./configure-dialogs.consts"
import type { OutputResponseConfig } from "./configure-dialogs.types"
import { OutputResponseConfigDialog } from "./output-response-config-dialog"

const handlers = () => ({
  onClose: vi.fn(),
  onDraftChange: vi.fn(),
  onSave: vi.fn(),
})

function renderDialog(
  draft: OutputResponseConfig,
  extra?: Partial<ReturnType<typeof handlers>>,
) {
  const h = { ...handlers(), ...extra }
  const result = render(
    <OutputResponseConfigDialog open draft={draft} {...h} />,
  )
  return { ...result, ...h }
}

const getTextarea = (): HTMLTextAreaElement =>
  screen.getByLabelText(OUTPUT_RESPONSE_CONFIG_STRINGS.EXAMPLE_LABEL) as HTMLTextAreaElement

describe("OutputResponseConfigDialog", () => {
  it("[tag:output-response-config-dialog] renders nothing when closed", () => {
    const { container } = render(
      <OutputResponseConfigDialog
        open={false}
        draft={DEFAULT_OUTPUT_RESPONSE_CONFIG}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    expect(
      container.querySelector(".output-response-config-dialog"),
    ).not.toBeInTheDocument()
  })

  it("[tag:output-response-config-dialog] renders title, description, and toggle", () => {
    renderDialog(DEFAULT_OUTPUT_RESPONSE_CONFIG)

    expect(screen.getByText(OUTPUT_RESPONSE_CONFIG_STRINGS.DIALOG_TITLE)).toBeInTheDocument()
    expect(screen.getByText(OUTPUT_RESPONSE_CONFIG_STRINGS.DESCRIPTION)).toBeInTheDocument()
    expect(
      screen.getByRole("switch", { name: OUTPUT_RESPONSE_CONFIG_STRINGS.TOGGLE_LABEL }),
    ).toBeInTheDocument()
  })

  it("[tag:output-response-config-dialog] textarea is hidden when toggle is off", () => {
    renderDialog({ ...DEFAULT_OUTPUT_RESPONSE_CONFIG, enabled: false })

    expect(
      screen.queryByLabelText(OUTPUT_RESPONSE_CONFIG_STRINGS.EXAMPLE_LABEL),
    ).not.toBeInTheDocument()
  })

  it("[tag:output-response-config-dialog] toggling on emits enabled=true via onDraftChange", async () => {
    const user = userEvent.setup({ delay: null })
    const onDraftChange = vi.fn()

    renderDialog({ ...DEFAULT_OUTPUT_RESPONSE_CONFIG, enabled: false }, { onDraftChange })

    await user.click(
      screen.getByRole("switch", { name: OUTPUT_RESPONSE_CONFIG_STRINGS.TOGGLE_LABEL }),
    )

    expect(onDraftChange).toHaveBeenCalledWith({ enabled: true })
  })

  it("[tag:output-response-config-dialog] counter shows 0/MAX when empty", () => {
    renderDialog(DEFAULT_OUTPUT_RESPONSE_CONFIG)
    expect(screen.getByText(`0/${OUTPUT_RESPONSE_MAX_LENGTH}`)).toBeInTheDocument()
  })

  it("[tag:output-response-config-dialog] typing lifts the new value up via onDraftChange", () => {
    const onDraftChange = vi.fn()
    renderDialog(DEFAULT_OUTPUT_RESPONSE_CONFIG, { onDraftChange })

    fireEvent.change(getTextarea(), { target: { value: "Hello world" } })

    expect(onDraftChange).toHaveBeenCalledWith({ exampleResponse: "Hello world" })
  })

  it("[tag:output-response-config-dialog] textarea hard-caps at maxLength", () => {
    const onDraftChange = vi.fn()
    renderDialog(DEFAULT_OUTPUT_RESPONSE_CONFIG, { onDraftChange })

    // The browser truncates via maxLength on real keystrokes; we also slice
    // defensively in the change handler in case of programmatic value
    // sets (e.g. paste handlers). Verify the slice path.
    const overflow = "x".repeat(OUTPUT_RESPONSE_MAX_LENGTH + 50)
    fireEvent.change(getTextarea(), { target: { value: overflow } })

    expect(onDraftChange).toHaveBeenCalledWith({
      exampleResponse: "x".repeat(OUTPUT_RESPONSE_MAX_LENGTH),
    })
  })

  it("[tag:output-response-config-dialog] textarea has the maxLength attribute for browser-level enforcement", () => {
    renderDialog(DEFAULT_OUTPUT_RESPONSE_CONFIG)

    expect(getTextarea()).toHaveAttribute("maxlength", String(OUTPUT_RESPONSE_MAX_LENGTH))
  })

  it("[tag:output-response-config-dialog] blocks Save when toggle is on but example is empty", async () => {
    const user = userEvent.setup({ delay: null })
    const onSave = vi.fn()

    renderDialog({ enabled: true, exampleResponse: "   " }, { onSave })

    await user.click(
      screen.getByRole("button", { name: OUTPUT_RESPONSE_CONFIG_STRINGS.SAVE_ACTION_LABEL }),
    )

    expect(onSave).not.toHaveBeenCalled()
    expect(
      screen.getByText(OUTPUT_RESPONSE_CONFIG_STRINGS.EXAMPLE_REQUIRED_ERROR),
    ).toBeInTheDocument()
    expect(getTextarea()).toHaveAttribute("aria-invalid", "true")
  })

  it("[tag:output-response-config-dialog] allows Save when toggle is off (no text required)", async () => {
    const user = userEvent.setup({ delay: null })
    const onSave = vi.fn()

    renderDialog({ enabled: false, exampleResponse: "" }, { onSave })

    await user.click(
      screen.getByRole("button", { name: OUTPUT_RESPONSE_CONFIG_STRINGS.SAVE_ACTION_LABEL }),
    )

    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("[tag:output-response-config-dialog] fires onSave when enabled with non-empty text", async () => {
    const user = userEvent.setup({ delay: null })
    const onSave = vi.fn()

    renderDialog({ enabled: true, exampleResponse: "Use bullet lists." }, { onSave })

    await user.click(
      screen.getByRole("button", { name: OUTPUT_RESPONSE_CONFIG_STRINGS.SAVE_ACTION_LABEL }),
    )

    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("[tag:output-response-config-dialog] Cancel fires onClose", async () => {
    const user = userEvent.setup({ delay: null })
    const onClose = vi.fn()

    renderDialog(DEFAULT_OUTPUT_RESPONSE_CONFIG, { onClose })

    await user.click(
      screen.getByRole("button", { name: OUTPUT_RESPONSE_CONFIG_STRINGS.CANCEL_ACTION_LABEL }),
    )

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("[tag:output-response-config-dialog] state-managed integration: example text persists across toggle off/on", async () => {
    const user = userEvent.setup({ delay: null })

    function Harness(): React.ReactElement {
      const [draft, setDraft] = useState<OutputResponseConfig>({
        enabled: true,
        exampleResponse: "Sample text the user wrote.",
      })
      return (
        <OutputResponseConfigDialog
          open
          draft={draft}
          onClose={vi.fn()}
          onSave={vi.fn()}
          onDraftChange={(next) => setDraft((prev) => ({ ...prev, ...next }))}
        />
      )
    }

    render(<Harness />)

    expect(getTextarea()).toHaveValue("Sample text the user wrote.")
    expect(screen.getByText(`27/${OUTPUT_RESPONSE_MAX_LENGTH}`)).toBeInTheDocument()

    // Toggle off → textarea disappears but value is preserved in draft.
    await user.click(
      screen.getByRole("switch", { name: OUTPUT_RESPONSE_CONFIG_STRINGS.TOGGLE_LABEL }),
    )
    expect(
      screen.queryByLabelText(OUTPUT_RESPONSE_CONFIG_STRINGS.EXAMPLE_LABEL),
    ).not.toBeInTheDocument()

    // Toggle back on → text + counter restored.
    await user.click(
      screen.getByRole("switch", { name: OUTPUT_RESPONSE_CONFIG_STRINGS.TOGGLE_LABEL }),
    )
    expect(getTextarea()).toHaveValue("Sample text the user wrote.")
    expect(screen.getByText(`27/${OUTPUT_RESPONSE_MAX_LENGTH}`)).toBeInTheDocument()
  })
})
