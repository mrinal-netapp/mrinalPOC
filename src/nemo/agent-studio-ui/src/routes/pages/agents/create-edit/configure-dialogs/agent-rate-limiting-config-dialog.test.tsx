import React, { useState } from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import {
  AGENT_RATE_LIMITING_CONFIG_STRINGS,
  DEFAULT_AGENT_RATE_LIMITING_CONFIG,
  MAX_REQUESTS_PER_MINUTE_RANGE,
} from "./configure-dialogs.consts"
import type { AgentRateLimitingConfig } from "./configure-dialogs.types"
import { AgentRateLimitingConfigDialog } from "./agent-rate-limiting-config-dialog"

const handlers = () => ({
  onClose: vi.fn(),
  onDraftChange: vi.fn(),
  onSave: vi.fn(),
})

function renderDialog(
  draft: AgentRateLimitingConfig,
  extra?: Partial<ReturnType<typeof handlers>>,
) {
  const h = { ...handlers(), ...extra }
  const result = render(
    <AgentRateLimitingConfigDialog open draft={draft} {...h} />,
  )
  return { ...result, ...h }
}

const getRpmInput = (): HTMLInputElement =>
  screen.getByLabelText(AGENT_RATE_LIMITING_CONFIG_STRINGS.MAX_RPM_LABEL) as HTMLInputElement

describe("AgentRateLimitingConfigDialog", () => {
  it("[tag:agent-rate-limiting-config-dialog] renders nothing when closed", () => {
    const { container } = render(
      <AgentRateLimitingConfigDialog
        open={false}
        draft={DEFAULT_AGENT_RATE_LIMITING_CONFIG}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    expect(container.querySelector(".agent-rate-limiting-config-dialog")).not.toBeInTheDocument()
  })

  it("[tag:agent-rate-limiting-config-dialog] renders title, description, and toggle", () => {
    renderDialog(DEFAULT_AGENT_RATE_LIMITING_CONFIG)

    expect(screen.getByText(AGENT_RATE_LIMITING_CONFIG_STRINGS.DIALOG_TITLE)).toBeInTheDocument()
    expect(screen.getByText(AGENT_RATE_LIMITING_CONFIG_STRINGS.DESCRIPTION)).toBeInTheDocument()
    expect(
      screen.getByRole("switch", { name: AGENT_RATE_LIMITING_CONFIG_STRINGS.TOGGLE_LABEL }),
    ).toBeInTheDocument()
  })

  it("[tag:agent-rate-limiting-config-dialog] numeric input is hidden when toggle is off", () => {
    renderDialog({ ...DEFAULT_AGENT_RATE_LIMITING_CONFIG, enabled: false })
    expect(
      screen.queryByLabelText(AGENT_RATE_LIMITING_CONFIG_STRINGS.MAX_RPM_LABEL),
    ).not.toBeInTheDocument()
  })

  it("[tag:agent-rate-limiting-config-dialog] input reflects controlled value and lifts changes", () => {
    const onDraftChange = vi.fn()
    renderDialog(
      { ...DEFAULT_AGENT_RATE_LIMITING_CONFIG, maxRequestsPerMinute: 120 },
      { onDraftChange },
    )

    expect(getRpmInput()).toHaveValue(120)

    fireEvent.change(getRpmInput(), { target: { value: "240" } })
    expect(onDraftChange).toHaveBeenCalledWith({ maxRequestsPerMinute: 240 })
  })

  it("[tag:agent-rate-limiting-config-dialog] empty input lifts as 0 so range validator fires", () => {
    const onDraftChange = vi.fn()
    renderDialog(DEFAULT_AGENT_RATE_LIMITING_CONFIG, { onDraftChange })

    fireEvent.change(getRpmInput(), { target: { value: "" } })
    expect(onDraftChange).toHaveBeenCalledWith({ maxRequestsPerMinute: 0 })
  })

  it("[tag:agent-rate-limiting-config-dialog] keeps the field blank while typing after it is cleared", () => {
    renderDialog({ ...DEFAULT_AGENT_RATE_LIMITING_CONFIG, maxRequestsPerMinute: 120 })
    const input = getRpmInput()

    fireEvent.change(input, { target: { value: "" } })

    // The field stays blank instead of snapping back to 0, so the user
    // can freely type a fresh value.
    expect(input.value).toBe("")
  })

  it("[tag:agent-rate-limiting-config-dialog] surfaces the range error live without waiting for Save", () => {
    renderDialog({
      enabled: true,
      maxRequestsPerMinute: MAX_REQUESTS_PER_MINUTE_RANGE.max + 1,
    })

    expect(
      screen.getByText(AGENT_RATE_LIMITING_CONFIG_STRINGS.MAX_RPM_ERROR),
    ).toBeInTheDocument()
  })

  it("[tag:agent-rate-limiting-config-dialog] blocks Save when RPM is out of range", async () => {
    const user = userEvent.setup({ delay: null })
    const onSave = vi.fn()

    renderDialog(
      { enabled: true, maxRequestsPerMinute: MAX_REQUESTS_PER_MINUTE_RANGE.max + 1 },
      { onSave },
    )

    await user.click(
      screen.getByRole("button", { name: AGENT_RATE_LIMITING_CONFIG_STRINGS.SAVE_ACTION_LABEL }),
    )

    expect(onSave).not.toHaveBeenCalled()
    expect(
      screen.getByText(AGENT_RATE_LIMITING_CONFIG_STRINGS.MAX_RPM_ERROR),
    ).toBeInTheDocument()
  })

  it("[tag:agent-rate-limiting-config-dialog] allows Save when toggle is off regardless of RPM", async () => {
    const user = userEvent.setup({ delay: null })
    const onSave = vi.fn()

    renderDialog({ enabled: false, maxRequestsPerMinute: 99999 }, { onSave })

    await user.click(
      screen.getByRole("button", { name: AGENT_RATE_LIMITING_CONFIG_STRINGS.SAVE_ACTION_LABEL }),
    )

    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("[tag:agent-rate-limiting-config-dialog] fires onSave when RPM is in range", async () => {
    const user = userEvent.setup({ delay: null })
    const onSave = vi.fn()

    renderDialog(DEFAULT_AGENT_RATE_LIMITING_CONFIG, { onSave })

    await user.click(
      screen.getByRole("button", { name: AGENT_RATE_LIMITING_CONFIG_STRINGS.SAVE_ACTION_LABEL }),
    )

    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("[tag:agent-rate-limiting-config-dialog] Cancel fires onClose", async () => {
    const user = userEvent.setup({ delay: null })
    const onClose = vi.fn()

    renderDialog(DEFAULT_AGENT_RATE_LIMITING_CONFIG, { onClose })

    await user.click(
      screen.getByRole("button", { name: AGENT_RATE_LIMITING_CONFIG_STRINGS.CANCEL_ACTION_LABEL }),
    )

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("[tag:agent-rate-limiting-config-dialog] state-managed integration: RPM persists across toggle off/on", async () => {
    const user = userEvent.setup({ delay: null })

    function Harness(): React.ReactElement {
      const [draft, setDraft] = useState<AgentRateLimitingConfig>({
        enabled: true,
        maxRequestsPerMinute: 250,
      })
      return (
        <AgentRateLimitingConfigDialog
          open
          draft={draft}
          onClose={vi.fn()}
          onSave={vi.fn()}
          onDraftChange={(next) => setDraft((prev) => ({ ...prev, ...next }))}
        />
      )
    }

    render(<Harness />)
    expect(getRpmInput()).toHaveValue(250)

    await user.click(
      screen.getByRole("switch", { name: AGENT_RATE_LIMITING_CONFIG_STRINGS.TOGGLE_LABEL }),
    )
    expect(
      screen.queryByLabelText(AGENT_RATE_LIMITING_CONFIG_STRINGS.MAX_RPM_LABEL),
    ).not.toBeInTheDocument()

    await user.click(
      screen.getByRole("switch", { name: AGENT_RATE_LIMITING_CONFIG_STRINGS.TOGGLE_LABEL }),
    )
    expect(getRpmInput()).toHaveValue(250)
  })

  it("[tag:agent-rate-limiting-config-dialog] refreshes visible value from draft when reopened after closed-state reseed", () => {
    const { rerender } = render(
      <AgentRateLimitingConfigDialog
        open
        draft={{ enabled: true, maxRequestsPerMinute: 120 }}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    expect(getRpmInput()).toHaveValue(120)

    rerender(
      <AgentRateLimitingConfigDialog
        open={false}
        draft={{ enabled: true, maxRequestsPerMinute: 333 }}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    rerender(
      <AgentRateLimitingConfigDialog
        open
        draft={{ enabled: true, maxRequestsPerMinute: 333 }}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )

    expect(getRpmInput()).toHaveValue(333)
  })

  it("[tag:agent-rate-limiting-config-dialog] Save reset keeps next open aligned with parent-reseeded draft", async () => {
    const user = userEvent.setup({ delay: null })

    function Harness(): React.ReactElement {
      const [open, setOpen] = useState(true)
      const [draft, setDraft] = useState<AgentRateLimitingConfig>({
        enabled: true,
        maxRequestsPerMinute: 120,
      })

      return (
        <>
          <AgentRateLimitingConfigDialog
            open={open}
            draft={draft}
            onClose={() => setOpen(false)}
            onSave={() => {
              setOpen(false)
              setDraft({ enabled: true, maxRequestsPerMinute: 333 })
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

    fireEvent.change(getRpmInput(), { target: { value: "240" } })
    await user.click(
      screen.getByRole("button", { name: AGENT_RATE_LIMITING_CONFIG_STRINGS.SAVE_ACTION_LABEL }),
    )
    await user.click(screen.getByRole("button", { name: "Reopen" }))

    expect(getRpmInput()).toHaveValue(333)
  })
})
