import React, { useState } from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import {
  DEFAULT_STRUCTURED_OUTPUT_CONFIG,
  STRUCTURED_OUTPUT_CONFIG_STRINGS,
  STRUCTURED_OUTPUT_MAX_LENGTH,
} from "./configure-dialogs.consts"
import type { StructuredOutputConfig } from "./configure-dialogs.types"
import { StructuredOutputConfigDialog } from "./structured-output-config-dialog"

const VALID_SCHEMA = '{"type":"object","properties":{"x":{"type":"string"}}}'
const INVALID_SCHEMA = "{ this is not json"

const handlers = () => ({
  onClose: vi.fn(),
  onDraftChange: vi.fn(),
  onSave: vi.fn(),
})

function renderDialog(
  draft: StructuredOutputConfig,
  extra?: Partial<ReturnType<typeof handlers>>,
) {
  const h = { ...handlers(), ...extra }
  const result = render(
    <StructuredOutputConfigDialog open draft={draft} {...h} />,
  )
  return { ...result, ...h }
}

const getTextarea = (): HTMLTextAreaElement =>
  screen.getByLabelText(STRUCTURED_OUTPUT_CONFIG_STRINGS.SCHEMA_LABEL) as HTMLTextAreaElement

const getTextGuidelinesTextarea = (): HTMLTextAreaElement =>
  screen.getByLabelText(STRUCTURED_OUTPUT_CONFIG_STRINGS.TEXT_LABEL) as HTMLTextAreaElement

describe("StructuredOutputConfigDialog", () => {
  it("[tag:structured-output-config-dialog] renders nothing when closed", () => {
    const { container } = render(
      <StructuredOutputConfigDialog
        open={false}
        draft={DEFAULT_STRUCTURED_OUTPUT_CONFIG}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    expect(
      container.querySelector(".structured-output-config-dialog"),
    ).not.toBeInTheDocument()
  })

  it("[tag:structured-output-config-dialog] renders title, description, and schema editor", () => {
    renderDialog(DEFAULT_STRUCTURED_OUTPUT_CONFIG)
    expect(screen.getByText(STRUCTURED_OUTPUT_CONFIG_STRINGS.DIALOG_TITLE)).toBeInTheDocument()
    expect(screen.getByText(STRUCTURED_OUTPUT_CONFIG_STRINGS.DESCRIPTION)).toBeInTheDocument()
    expect(screen.getByText(STRUCTURED_OUTPUT_CONFIG_STRINGS.RESPONSE_FORMAT_LABEL)).toBeInTheDocument()
    expect(screen.getByRole("combobox")).toBeInTheDocument()
    expect(getTextarea()).toBeInTheDocument()
  })

  it("[tag:structured-output-config-dialog] counter reflects the current char count", () => {
    renderDialog({ enabled: true, responseFormat: "json_object", schema: VALID_SCHEMA })
    expect(
      screen.getByText(`${VALID_SCHEMA.length}/${STRUCTURED_OUTPUT_MAX_LENGTH}`),
    ).toBeInTheDocument()
  })

  it("[tag:structured-output-config-dialog] typing lifts the new value up via onDraftChange", () => {
    const onDraftChange = vi.fn()
    renderDialog(DEFAULT_STRUCTURED_OUTPUT_CONFIG, { onDraftChange })
    fireEvent.change(getTextarea(), { target: { value: VALID_SCHEMA } })
    expect(onDraftChange).toHaveBeenCalledWith({ schema: VALID_SCHEMA })
  })

  it("[tag:structured-output-config-dialog] textarea hard-caps at maxLength even for paste", () => {
    const onDraftChange = vi.fn()
    renderDialog(DEFAULT_STRUCTURED_OUTPUT_CONFIG, { onDraftChange })
    const overflow = "x".repeat(STRUCTURED_OUTPUT_MAX_LENGTH + 50)
    fireEvent.change(getTextarea(), { target: { value: overflow } })
    expect(onDraftChange).toHaveBeenCalledWith({
      schema: "x".repeat(STRUCTURED_OUTPUT_MAX_LENGTH),
    })
  })

  it("[tag:structured-output-config-dialog] textarea has the maxLength attribute for browser-level enforcement", () => {
    renderDialog(DEFAULT_STRUCTURED_OUTPUT_CONFIG)
    expect(getTextarea()).toHaveAttribute("maxlength", String(STRUCTURED_OUTPUT_MAX_LENGTH))
  })

  it("[tag:structured-output-config-dialog] shows required error immediately when schema is empty", () => {
    renderDialog({ enabled: true, responseFormat: "json_object", schema: "   \n  " })
    expect(
      screen.getByText(STRUCTURED_OUTPUT_CONFIG_STRINGS.SCHEMA_REQUIRED_ERROR),
    ).toBeInTheDocument()
    expect(getTextarea()).toHaveAttribute("aria-invalid", "true")
  })

  it("[tag:structured-output-config-dialog] blocks Save when schema is empty", async () => {
    const user = userEvent.setup({ delay: null })
    const onSave = vi.fn()
    renderDialog({ enabled: true, responseFormat: "json_object", schema: "   \n  " }, { onSave })

    await user.click(
      screen.getByRole("button", { name: STRUCTURED_OUTPUT_CONFIG_STRINGS.SAVE_ACTION_LABEL }),
    )

    expect(onSave).not.toHaveBeenCalled()
    expect(
      screen.getByText(STRUCTURED_OUTPUT_CONFIG_STRINGS.SCHEMA_REQUIRED_ERROR),
    ).toBeInTheDocument()
    expect(getTextarea()).toHaveAttribute("aria-invalid", "true")
  })

  it("[tag:structured-output-config-dialog] blocks Save and surfaces invalid-JSON error", async () => {
    const user = userEvent.setup({ delay: null })
    const onSave = vi.fn()
    renderDialog({ enabled: true, responseFormat: "json_object", schema: INVALID_SCHEMA }, { onSave })

    await user.click(
      screen.getByRole("button", { name: STRUCTURED_OUTPUT_CONFIG_STRINGS.SAVE_ACTION_LABEL }),
    )

    expect(onSave).not.toHaveBeenCalled()
    expect(
      screen.getByText(STRUCTURED_OUTPUT_CONFIG_STRINGS.SCHEMA_INVALID_ERROR),
    ).toBeInTheDocument()
  })

  it("[tag:structured-output-config-dialog] rejects arbitrary JSON objects that are not JSON Schema", async () => {
    const user = userEvent.setup({ delay: null })
    const onSave = vi.fn()
    renderDialog(
      {
        enabled: true,
        responseFormat: "json_object",
        schema: '{"message":"hello","count":1,"active":true}',
      },
      { onSave },
    )

    expect(
      screen.getByText(STRUCTURED_OUTPUT_CONFIG_STRINGS.SCHEMA_INVALID_ERROR),
    ).toBeInTheDocument()
    await user.click(
      screen.getByRole("button", { name: STRUCTURED_OUTPUT_CONFIG_STRINGS.SAVE_ACTION_LABEL }),
    )
    expect(onSave).not.toHaveBeenCalled()
  })

  it("[tag:structured-output-config-dialog] fires onSave when schema is a valid JSON Schema", async () => {
    const user = userEvent.setup({ delay: null })
    const onSave = vi.fn()
    renderDialog({ enabled: true, responseFormat: "json_object", schema: VALID_SCHEMA }, { onSave })

    await user.click(
      screen.getByRole("button", { name: STRUCTURED_OUTPUT_CONFIG_STRINGS.SAVE_ACTION_LABEL }),
    )

    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("[tag:structured-output-config-dialog] Cancel fires onClose", async () => {
    const user = userEvent.setup({ delay: null })
    const onClose = vi.fn()
    renderDialog(DEFAULT_STRUCTURED_OUTPUT_CONFIG, { onClose })

    await user.click(
      screen.getByRole("button", { name: STRUCTURED_OUTPUT_CONFIG_STRINGS.CANCEL_ACTION_LABEL }),
    )

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("[tag:structured-output-config-dialog] state-managed integration: schema text round-trips via onDraftChange", () => {
    function Harness(): React.ReactElement {
      const [draft, setDraft] = useState<StructuredOutputConfig>({
        enabled: true,
        responseFormat: "json_object",
        schema: VALID_SCHEMA,
      })
      return (
        <StructuredOutputConfigDialog
          open
          draft={draft}
          onClose={vi.fn()}
          onSave={vi.fn()}
          onDraftChange={(next) => setDraft((prev) => ({ ...prev, ...next }))}
        />
      )
    }

    render(<Harness />)
    expect(getTextarea()).toHaveValue(VALID_SCHEMA)
    fireEvent.change(getTextarea(), { target: { value: '{"type":"object"}' } })
    expect(getTextarea()).toHaveValue('{"type":"object"}')
  })

  it("[tag:structured-output-config-dialog] rejects JSON arrays (backend parity)", async () => {
    const user = userEvent.setup({ delay: null })
    const onSave = vi.fn()
    renderDialog({ enabled: true, responseFormat: "json_object", schema: "[]" }, { onSave })

    expect(
      screen.getByText(STRUCTURED_OUTPUT_CONFIG_STRINGS.SCHEMA_INVALID_ERROR),
    ).toBeInTheDocument()
    await user.click(
      screen.getByRole("button", { name: STRUCTURED_OUTPUT_CONFIG_STRINGS.SAVE_ACTION_LABEL }),
    )
    expect(onSave).not.toHaveBeenCalled()
  })

  it("[tag:structured-output-config-dialog] text mode only requires non-empty guidelines", async () => {
    const user = userEvent.setup({ delay: null })
    const onSave = vi.fn()
    renderDialog({ enabled: true, responseFormat: "text", schema: "Respond in two bullets." }, { onSave })

    await user.click(
      screen.getByRole("button", { name: STRUCTURED_OUTPUT_CONFIG_STRINGS.SAVE_ACTION_LABEL }),
    )

    expect(getTextGuidelinesTextarea()).toBeInTheDocument()
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("[tag:structured-output-config-dialog] blocks text mode save when guidelines are empty", async () => {
    const user = userEvent.setup({ delay: null })
    const onSave = vi.fn()
    renderDialog({ enabled: true, responseFormat: "text", schema: "   " }, { onSave })

    await user.click(
      screen.getByRole("button", { name: STRUCTURED_OUTPUT_CONFIG_STRINGS.SAVE_ACTION_LABEL }),
    )

    expect(onSave).not.toHaveBeenCalled()
    expect(
      screen.getByText(STRUCTURED_OUTPUT_CONFIG_STRINGS.TEXT_REQUIRED_ERROR),
    ).toBeInTheDocument()
  })
})
