import { useState } from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

// Stub SelectDropdown: a labelled button that cycles to the next item on
// click. Lets us drive the dropdown deterministically without mounting
// the real popover.
vi.mock("@/ui-lib/base-components/select-dropdown/select-dropdown", () => ({
  SelectDropdown: ({
    label,
    value,
    items,
    onValueChange,
  }: {
    label?: string
    value?: string | number | null
    items: Array<{ key: string; value: string | number; label: string }>
    onValueChange?: (next: string | number | null) => void
  }) => {
    const idx = items.findIndex((i) => i.value === value)
    const next = items[(idx + 1) % Math.max(items.length, 1)]
    return (
      <button
        type="button"
        aria-label={label}
        onClick={() => onValueChange?.(next?.value ?? null)}
      >
        {label}: {String(value ?? "(none)")}
      </button>
    )
  },
}))

import {
  CONVERSATION_MEMORY_CONFIG_STRINGS,
  DEFAULT_CONVERSATION_MEMORY_CONFIG,
  MESSAGE_RETENTION_METHOD_HELPER_TEXT,
  MESSAGE_RETENTION_METHOD_LABEL,
} from "./configure-dialogs.consts"
import type { ConversationMemoryConfig } from "./configure-dialogs.types"
import { ConversationMemoryConfigDialog } from "./conversation-memory-config-dialog"

const handlers = () => ({
  onClose: vi.fn(),
  onDraftChange: vi.fn(),
  onSave: vi.fn(),
})

function renderDialog(
  draft: ConversationMemoryConfig,
  extra?: Partial<ReturnType<typeof handlers>>,
) {
  const h = { ...handlers(), ...extra }
  const result = render(
    <ConversationMemoryConfigDialog open draft={draft} {...h} />,
  )
  return { ...result, ...h }
}

const getMessageInput = (): HTMLInputElement =>
  screen.getByLabelText(
    CONVERSATION_MEMORY_CONFIG_STRINGS.MESSAGE_HISTORY_LIMIT_LABEL,
  ) as HTMLInputElement

const getSummaryInput = (): HTMLInputElement =>
  screen.getByLabelText(
    CONVERSATION_MEMORY_CONFIG_STRINGS.SUMMARY_TOKEN_LIMIT_LABEL,
  ) as HTMLInputElement

const SLIDING_DRAFT: ConversationMemoryConfig = {
  ...DEFAULT_CONVERSATION_MEMORY_CONFIG,
  retentionMethod: "sliding_window",
}

const SUMMARIZED_DRAFT: ConversationMemoryConfig = {
  ...DEFAULT_CONVERSATION_MEMORY_CONFIG,
  retentionMethod: "summarized",
}

describe("ConversationMemoryConfigDialog", () => {
  it("[tag:conversation-memory-config-dialog] renders nothing when closed", () => {
    const { container } = render(
      <ConversationMemoryConfigDialog
        open={false}
        draft={DEFAULT_CONVERSATION_MEMORY_CONFIG}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    // The Dialog component portals into document.body when open; when
    // closed neither the container nor the body should hold the title.
    expect(container).toBeEmptyDOMElement()
    expect(
      document.body.querySelector(
        `[data-title="${CONVERSATION_MEMORY_CONFIG_STRINGS.DIALOG_TITLE}"]`,
      ),
    ).toBeNull()
  })

  it("[tag:conversation-memory-config-dialog] renders title, description, and the retention dropdown", () => {
    renderDialog(SLIDING_DRAFT)
    expect(
      screen.getByText(CONVERSATION_MEMORY_CONFIG_STRINGS.DIALOG_TITLE),
    ).toBeInTheDocument()
    expect(
      screen.getByText(CONVERSATION_MEMORY_CONFIG_STRINGS.DESCRIPTION),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", {
        name: CONVERSATION_MEMORY_CONFIG_STRINGS.RETENTION_METHOD_LABEL,
      }),
    ).toBeInTheDocument()
  })

  it("[tag:conversation-memory-config-dialog] message-history input visible for sliding_window, hidden for summarized", () => {
    const { rerender } = render(
      <ConversationMemoryConfigDialog
        open
        draft={SLIDING_DRAFT}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    expect(getMessageInput()).toBeInTheDocument()

    rerender(
      <ConversationMemoryConfigDialog
        open
        draft={SUMMARIZED_DRAFT}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    expect(
      screen.queryByLabelText(
        CONVERSATION_MEMORY_CONFIG_STRINGS.MESSAGE_HISTORY_LIMIT_LABEL,
      ),
    ).toBeNull()
    // ...and the summary-token input takes its place.
    expect(getSummaryInput()).toBeInTheDocument()
  })

  it("[tag:conversation-memory-config-dialog] summary-token input visible only when summarized", () => {
    renderDialog(SLIDING_DRAFT)
    expect(
      screen.queryByLabelText(
        CONVERSATION_MEMORY_CONFIG_STRINGS.SUMMARY_TOKEN_LIMIT_LABEL,
      ),
    ).toBeNull()
  })

  it("[tag:conversation-memory-config-dialog] message-history input reflects the controlled value", () => {
    renderDialog({ ...SLIDING_DRAFT, messageHistoryLimit: 42 })
    expect(getMessageInput().value).toBe("42")
  })

  it("[tag:conversation-memory-config-dialog] typing into message-history lifts the new integer up", () => {
    const { onDraftChange } = renderDialog(SLIDING_DRAFT)
    fireEvent.change(getMessageInput(), { target: { value: "37" } })
    expect(onDraftChange).toHaveBeenCalledWith({ messageHistoryLimit: 37 })
  })

  it("[tag:conversation-memory-config-dialog] typing into summary-token lifts the new integer up", () => {
    const { onDraftChange } = renderDialog(SUMMARIZED_DRAFT)
    fireEvent.change(getSummaryInput(), { target: { value: "1500" } })
    expect(onDraftChange).toHaveBeenCalledWith({ summaryTokenLimit: 1500 })
  })

  it("[tag:conversation-memory-config-dialog] non-integer typing is truncated, not propagated as NaN", () => {
    const { onDraftChange } = renderDialog(SLIDING_DRAFT)
    fireEvent.change(getMessageInput(), { target: { value: "12.7abc" } })
    // Number("12.7abc") is NaN → coerced to 0 per the dialog's contract.
    expect(onDraftChange).toHaveBeenCalledWith({ messageHistoryLimit: 0 })
  })

  it("[tag:conversation-memory-config-dialog] empty input lifts as 0 (so the validator fails visibly)", () => {
    const { onDraftChange } = renderDialog(SLIDING_DRAFT)
    fireEvent.change(getMessageInput(), { target: { value: "" } })
    expect(onDraftChange).toHaveBeenCalledWith({ messageHistoryLimit: 0 })
  })

  it("[tag:conversation-memory-config-dialog] keeps message-history blank while typing after it is cleared", () => {
    renderDialog({ ...SLIDING_DRAFT, messageHistoryLimit: 42 })
    const input = getMessageInput()

    fireEvent.change(input, { target: { value: "" } })

    // The field stays blank instead of snapping back to 0, so the user
    // can freely type a fresh value.
    expect(input.value).toBe("")
  })

  it("[tag:conversation-memory-config-dialog] surfaces the range error live without waiting for Save", () => {
    renderDialog({ ...SLIDING_DRAFT, messageHistoryLimit: 0 })

    expect(
      screen.getByText(
        CONVERSATION_MEMORY_CONFIG_STRINGS.MESSAGE_HISTORY_REQUIRED_ERROR,
      ),
    ).toBeInTheDocument()
  })

  it("[tag:conversation-memory-config-dialog] helper text follows the selected retention method", async () => {
    function Controlled() {
      const [draft, setDraft] = useState<ConversationMemoryConfig>(SLIDING_DRAFT)
      return (
        <ConversationMemoryConfigDialog
          open
          draft={draft}
          onClose={vi.fn()}
          onDraftChange={(next) => setDraft((prev) => ({ ...prev, ...next }))}
          onSave={vi.fn()}
        />
      )
    }
    render(<Controlled />)
    expect(
      screen.getByText(MESSAGE_RETENTION_METHOD_HELPER_TEXT.sliding_window),
    ).toBeInTheDocument()

    // Cycle the dropdown to advance to the next item.
    await userEvent.click(
      screen.getByRole("button", {
        name: CONVERSATION_MEMORY_CONFIG_STRINGS.RETENTION_METHOD_LABEL,
      }),
    )
    expect(
      screen.getByText(MESSAGE_RETENTION_METHOD_HELPER_TEXT.summarized),
    ).toBeInTheDocument()
  })

  it("[tag:conversation-memory-config-dialog] blocks Save when message-history is out of range", async () => {
    const onSave = vi.fn()
    renderDialog({ ...SLIDING_DRAFT, messageHistoryLimit: 0 }, { onSave })
    await userEvent.click(
      screen.getByRole("button", {
        name: CONVERSATION_MEMORY_CONFIG_STRINGS.SAVE_ACTION_LABEL,
      }),
    )
    expect(onSave).not.toHaveBeenCalled()
    expect(
      screen.getByText(
        CONVERSATION_MEMORY_CONFIG_STRINGS.MESSAGE_HISTORY_REQUIRED_ERROR,
      ),
    ).toBeInTheDocument()
  })

  it("[tag:conversation-memory-config-dialog] blocks Save when summary-token is out of range", async () => {
    const onSave = vi.fn()
    // 30 is below the floor of 64 — should be rejected by the input range.
    renderDialog({ ...SUMMARIZED_DRAFT, summaryTokenLimit: 30 }, { onSave })
    await userEvent.click(
      screen.getByRole("button", {
        name: CONVERSATION_MEMORY_CONFIG_STRINGS.SAVE_ACTION_LABEL,
      }),
    )
    expect(onSave).not.toHaveBeenCalled()
    expect(
      screen.getByText(
        CONVERSATION_MEMORY_CONFIG_STRINGS.SUMMARY_TOKEN_LIMIT_REQUIRED_ERROR,
      ),
    ).toBeInTheDocument()
  })

  it("[tag:conversation-memory-config-dialog] does not block Save on message-history when method is summarized", async () => {
    // Even an invalid messageHistoryLimit shouldn't fail Save when the
    // active method doesn't surface that input — its validation is
    // scoped to the visible field.
    const onSave = vi.fn()
    renderDialog(
      { ...SUMMARIZED_DRAFT, messageHistoryLimit: 0, summaryTokenLimit: 2000 },
      { onSave },
    )
    await userEvent.click(
      screen.getByRole("button", {
        name: CONVERSATION_MEMORY_CONFIG_STRINGS.SAVE_ACTION_LABEL,
      }),
    )
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("[tag:conversation-memory-config-dialog] fires onSave when the visible limit is valid", async () => {
    const onSave = vi.fn()
    renderDialog({ ...SLIDING_DRAFT, messageHistoryLimit: 10 }, { onSave })
    await userEvent.click(
      screen.getByRole("button", {
        name: CONVERSATION_MEMORY_CONFIG_STRINGS.SAVE_ACTION_LABEL,
      }),
    )
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("[tag:conversation-memory-config-dialog] Cancel fires onClose", async () => {
    const onClose = vi.fn()
    renderDialog(SLIDING_DRAFT, { onClose })
    await userEvent.click(
      screen.getByRole("button", {
        name: CONVERSATION_MEMORY_CONFIG_STRINGS.CANCEL_ACTION_LABEL,
      }),
    )
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("[tag:conversation-memory-config-dialog] cycling method swaps the visible input", async () => {
    function Controlled() {
      const [draft, setDraft] = useState<ConversationMemoryConfig>(SLIDING_DRAFT)
      return (
        <ConversationMemoryConfigDialog
          open
          draft={draft}
          onClose={vi.fn()}
          onDraftChange={(next) => setDraft((prev) => ({ ...prev, ...next }))}
          onSave={vi.fn()}
        />
      )
    }
    render(<Controlled />)
    // Starts as sliding_window — message input is visible.
    expect(
      screen.getByLabelText(
        CONVERSATION_MEMORY_CONFIG_STRINGS.MESSAGE_HISTORY_LIMIT_LABEL,
      ),
    ).toBeInTheDocument()
    expect(
      screen.queryByLabelText(
        CONVERSATION_MEMORY_CONFIG_STRINGS.SUMMARY_TOKEN_LIMIT_LABEL,
      ),
    ).toBeNull()

    // Cycle to summarized.
    await userEvent.click(
      screen.getByRole("button", {
        name: CONVERSATION_MEMORY_CONFIG_STRINGS.RETENTION_METHOD_LABEL,
      }),
    )

    // Now the summary-token input is visible and the message input is gone.
    expect(
      screen.queryByLabelText(
        CONVERSATION_MEMORY_CONFIG_STRINGS.MESSAGE_HISTORY_LIMIT_LABEL,
      ),
    ).toBeNull()
    expect(
      screen.getByLabelText(
        CONVERSATION_MEMORY_CONFIG_STRINGS.SUMMARY_TOKEN_LIMIT_LABEL,
      ),
    ).toBeInTheDocument()
  })

  it("[tag:conversation-memory-config-dialog] both labels match the locked retention map", () => {
    expect(MESSAGE_RETENTION_METHOD_LABEL.sliding_window).toBe("Sliding window")
    expect(MESSAGE_RETENTION_METHOD_LABEL.summarized).toBe("Summarization")
  })

  it("[tag:conversation-memory-config-dialog] refreshes visible limits from draft when reopened after closed-state reseed", () => {
    const { rerender } = render(
      <ConversationMemoryConfigDialog
        open
        draft={{ ...SLIDING_DRAFT, messageHistoryLimit: 42 }}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    expect(getMessageInput()).toHaveValue(42)

    rerender(
      <ConversationMemoryConfigDialog
        open={false}
        draft={{ ...SUMMARIZED_DRAFT, summaryTokenLimit: 1500 }}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )
    rerender(
      <ConversationMemoryConfigDialog
        open
        draft={{ ...SUMMARIZED_DRAFT, summaryTokenLimit: 1500 }}
        onClose={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
      />,
    )

    expect(getSummaryInput()).toHaveValue(1500)
  })

  it("[tag:conversation-memory-config-dialog] Save reset keeps next open aligned with parent-reseeded draft", async () => {
    const user = userEvent.setup({ delay: null })

    function Harness(): React.ReactElement {
      const [open, setOpen] = useState(true)
      const [draft, setDraft] = useState<ConversationMemoryConfig>({
        ...SLIDING_DRAFT,
        messageHistoryLimit: 42,
      })
      return (
        <>
          <ConversationMemoryConfigDialog
            open={open}
            draft={draft}
            onClose={() => setOpen(false)}
            onSave={() => {
              setOpen(false)
              setDraft({ ...SUMMARIZED_DRAFT, summaryTokenLimit: 1500 })
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

    fireEvent.change(getMessageInput(), { target: { value: "55" } })
    await user.click(
      screen.getByRole("button", {
        name: CONVERSATION_MEMORY_CONFIG_STRINGS.SAVE_ACTION_LABEL,
      }),
    )
    await user.click(screen.getByRole("button", { name: "Reopen" }))

    expect(getSummaryInput()).toHaveValue(1500)
  })
})
