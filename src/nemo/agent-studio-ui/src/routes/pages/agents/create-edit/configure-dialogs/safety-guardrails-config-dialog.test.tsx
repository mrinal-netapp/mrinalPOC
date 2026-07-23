import React, { useState } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import {
  DEFAULT_SAFETY_GUARDRAILS_CONFIG,
  SAFETY_GUARDRAILS_CONFIG_STRINGS,
} from "./configure-dialogs.consts"
import type { SafetyGuardrailsConfig } from "./configure-dialogs.types"
import { SafetyGuardrailsConfigDialog } from "./safety-guardrails-config-dialog"

const handlers = () => ({
  onClose: vi.fn(),
  onDraftChange: vi.fn(),
  onSave: vi.fn(),
})

function renderDialog(
  draft: SafetyGuardrailsConfig,
  extra?: Partial<ReturnType<typeof handlers>>,
) {
  const h = { ...handlers(), ...extra }
  const result = render(
    <SafetyGuardrailsConfigDialog open draft={draft} {...h} />,
  )
  return { ...result, ...h }
}

describe("SafetyGuardrailsConfigDialog", () => {
  it("[tag:safety-guardrails-config-dialog] renders nothing when closed", () => {
    const { container } = render(
      <SafetyGuardrailsConfigDialog
        open={false}
        draft={DEFAULT_SAFETY_GUARDRAILS_CONFIG}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    expect(container.querySelector(".safety-guardrails-config-dialog")).not.toBeInTheDocument()
  })

  it("[tag:safety-guardrails-config-dialog] renders title, description, and all three section headings", () => {
    renderDialog(DEFAULT_SAFETY_GUARDRAILS_CONFIG)

    expect(screen.getByText(SAFETY_GUARDRAILS_CONFIG_STRINGS.DIALOG_TITLE)).toBeInTheDocument()
    expect(screen.getByText(SAFETY_GUARDRAILS_CONFIG_STRINGS.DESCRIPTION)).toBeInTheDocument()
    expect(screen.getByText(SAFETY_GUARDRAILS_CONFIG_STRINGS.PII_TITLE)).toBeInTheDocument()
    expect(screen.getByText(SAFETY_GUARDRAILS_CONFIG_STRINGS.API_KEY_SCANNER_TITLE)).toBeInTheDocument()
    expect(screen.getByText(SAFETY_GUARDRAILS_CONFIG_STRINGS.SECRET_DETECTION_TITLE)).toBeInTheDocument()
  })

  it("[tag:safety-guardrails-config-dialog] each toggle reflects the controlled state", () => {
    renderDialog({
      piiMaskerEnabled: true,
      apiKeyTokenScannerEnabled: false,
      secretDetectionEnabled: true,
    })

    expect(
      screen.getByRole("switch", { name: SAFETY_GUARDRAILS_CONFIG_STRINGS.PII_TOGGLE_LABEL }),
    ).toBeChecked()
    expect(
      screen.getByRole("switch", { name: SAFETY_GUARDRAILS_CONFIG_STRINGS.API_KEY_SCANNER_TOGGLE_LABEL }),
    ).not.toBeChecked()
    expect(
      screen.getByRole("switch", { name: SAFETY_GUARDRAILS_CONFIG_STRINGS.SECRET_DETECTION_TOGGLE_LABEL }),
    ).toBeChecked()
  })

  it("[tag:safety-guardrails-config-dialog] toggling each switch fires the correct partial onDraftChange", async () => {
    const user = userEvent.setup({ delay: null })
    const onDraftChange = vi.fn()

    renderDialog(
      {
        piiMaskerEnabled: false,
        apiKeyTokenScannerEnabled: false,
        secretDetectionEnabled: false,
      },
      { onDraftChange },
    )

    await user.click(
      screen.getByRole("switch", { name: SAFETY_GUARDRAILS_CONFIG_STRINGS.PII_TOGGLE_LABEL }),
    )
    expect(onDraftChange).toHaveBeenLastCalledWith({ piiMaskerEnabled: true })

    await user.click(
      screen.getByRole("switch", { name: SAFETY_GUARDRAILS_CONFIG_STRINGS.API_KEY_SCANNER_TOGGLE_LABEL }),
    )
    expect(onDraftChange).toHaveBeenLastCalledWith({ apiKeyTokenScannerEnabled: true })

    await user.click(
      screen.getByRole("switch", { name: SAFETY_GUARDRAILS_CONFIG_STRINGS.SECRET_DETECTION_TOGGLE_LABEL }),
    )
    expect(onDraftChange).toHaveBeenLastCalledWith({ secretDetectionEnabled: true })
  })

  it("[tag:safety-guardrails-config-dialog] Save always succeeds — no validation gating", async () => {
    const user = userEvent.setup({ delay: null })
    const onSave = vi.fn()

    renderDialog(
      {
        piiMaskerEnabled: false,
        apiKeyTokenScannerEnabled: false,
        secretDetectionEnabled: false,
      },
      { onSave },
    )

    await user.click(
      screen.getByRole("button", { name: SAFETY_GUARDRAILS_CONFIG_STRINGS.SAVE_ACTION_LABEL }),
    )

    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("[tag:safety-guardrails-config-dialog] Cancel fires onClose", async () => {
    const user = userEvent.setup({ delay: null })
    const onClose = vi.fn()

    renderDialog(DEFAULT_SAFETY_GUARDRAILS_CONFIG, { onClose })

    await user.click(
      screen.getByRole("button", { name: SAFETY_GUARDRAILS_CONFIG_STRINGS.CANCEL_ACTION_LABEL }),
    )

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("[tag:safety-guardrails-config-dialog] state-managed integration: every toggle independently flips", async () => {
    const user = userEvent.setup({ delay: null })

    function Harness(): React.ReactElement {
      const [draft, setDraft] = useState<SafetyGuardrailsConfig>({
        piiMaskerEnabled: false,
        apiKeyTokenScannerEnabled: false,
        secretDetectionEnabled: false,
      })
      return (
        <SafetyGuardrailsConfigDialog
          open
          draft={draft}
          onClose={vi.fn()}
          onSave={vi.fn()}
          onDraftChange={(next) => setDraft((prev) => ({ ...prev, ...next }))}
        />
      )
    }

    render(<Harness />)

    const piiToggle = screen.getByRole("switch", {
      name: SAFETY_GUARDRAILS_CONFIG_STRINGS.PII_TOGGLE_LABEL,
    })
    const apiKeyToggle = screen.getByRole("switch", {
      name: SAFETY_GUARDRAILS_CONFIG_STRINGS.API_KEY_SCANNER_TOGGLE_LABEL,
    })

    await user.click(piiToggle)
    expect(piiToggle).toBeChecked()
    expect(apiKeyToggle).not.toBeChecked()

    await user.click(apiKeyToggle)
    expect(piiToggle).toBeChecked()
    expect(apiKeyToggle).toBeChecked()

    await user.click(piiToggle)
    expect(piiToggle).not.toBeChecked()
    expect(apiKeyToggle).toBeChecked()
  })
})
