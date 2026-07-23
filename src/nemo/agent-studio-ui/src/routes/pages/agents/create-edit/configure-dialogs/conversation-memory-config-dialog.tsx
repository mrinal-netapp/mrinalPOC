import {
  useMemo,
  useState,
  type ChangeEvent,
  type ReactElement,
} from "react"
import { IconInfoCircle } from "@tabler/icons-react"

import { Card } from "@/ui-lib/base-components/card/card"
import { CardContent } from "@/ui-lib/base-components/card/card.content"
import { CardFooter } from "@/ui-lib/base-components/card/card.footer"
import { CardHeader } from "@/ui-lib/base-components/card/card.header"
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog"
import { Input } from "@/ui-lib/base-components/input/input"
import { SelectDropdown } from "@/ui-lib/base-components/select-dropdown/select-dropdown"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { FormFieldErrorBlock } from "@/ui-lib/base-components/form"

import {
  CONVERSATION_MEMORY_CONFIG_STRINGS,
  DEFAULT_CONVERSATION_MEMORY_CONFIG,
  MESSAGE_HISTORY_LIMIT_RANGE,
  MESSAGE_RETENTION_METHOD_HELPER_TEXT,
  MESSAGE_RETENTION_METHOD_LABEL,
  SUMMARY_TOKEN_LIMIT_RANGE,
} from "./configure-dialogs.consts"
import type {
  ConversationMemoryConfig,
  MessageRetentionMethod,
} from "./configure-dialogs.types"

import "./conversation-memory-config-dialog.scss"

type ConversationMemoryConfigDialogProps = {
  open: boolean
  draft: ConversationMemoryConfig
  onClose: () => void
  onDraftChange: (next: Partial<ConversationMemoryConfig>) => void
  onSave: () => void
}

/**
 * Self-contained dialog for the create-agent form's "Conversation memory
 * and context" configure step.
 *
 * The session-limit field is kept mounted in the draft even while the
 * toggle is off, so flipping it back on restores the prior value — same
 * pattern as the similarity-threshold slider in the KB dialog and the
 * example text in the output-response dialog.
 *
 * Each numeric field is driven by a local text buffer so the user can
 * type freely (including clearing it to empty) without the controlled
 * draft snapping the caret back to a coerced number on every keystroke.
 * Edits still parse into the draft (empty / non-numeric → 0) so the
 * validators have something concrete to fail on rather than seeing `NaN`.
 * Validation is live and strict: the range error surfaces the moment a
 * shown field is empty or out of range, and Save stays blocked as a
 * final backstop.
 */
function ConversationMemoryConfigDialog({
  open,
  draft = DEFAULT_CONVERSATION_MEMORY_CONFIG,
  onClose,
  onDraftChange,
  onSave,
}: ConversationMemoryConfigDialogProps): ReactElement {
  const [messageHistoryText, setMessageHistoryText] = useState(() =>
    String(draft.messageHistoryLimit),
  )
  const [summaryTokenText, setSummaryTokenText] = useState(() =>
    String(draft.summaryTokenLimit),
  )
  const [isMessageHistoryDirty, setIsMessageHistoryDirty] = useState(false)
  const [isSummaryTokenDirty, setIsSummaryTokenDirty] = useState(false)
  const messageHistoryInputValue = isMessageHistoryDirty
    ? messageHistoryText
    : String(draft.messageHistoryLimit)
  const summaryTokenInputValue = isSummaryTokenDirty
    ? summaryTokenText
    : String(draft.summaryTokenLimit)

  const methodItems = useMemo(
    () =>
      (Object.keys(MESSAGE_RETENTION_METHOD_LABEL) as MessageRetentionMethod[]).map(
        (id) => ({
          key: id,
          value: id,
          label: MESSAGE_RETENTION_METHOD_LABEL[id],
        }),
      ),
    [],
  )

  // "Message history limit" only applies to the sliding-window strategy.
  const showMessageHistoryLimit = draft.retentionMethod === "sliding_window"
  // "Summary token limit" only applies to the summarized strategy.
  const showSummaryTokenLimit = draft.retentionMethod === "summarized"

  // No "override" toggles — every visible limit input is unconditionally
  // validated against its range. The user's typed value is what gets
  // saved, so we surface the same range error the backend would return.
  const errors: Record<string, string> = {}
  if (
    showMessageHistoryLimit &&
    !isIntegerInRange(draft.messageHistoryLimit, MESSAGE_HISTORY_LIMIT_RANGE)
  ) {
    errors.messageHistoryLimit =
      CONVERSATION_MEMORY_CONFIG_STRINGS.MESSAGE_HISTORY_REQUIRED_ERROR
  }
  if (
    showSummaryTokenLimit &&
    !isIntegerInRange(draft.summaryTokenLimit, SUMMARY_TOKEN_LIMIT_RANGE)
  ) {
    errors.summaryTokenLimit =
      CONVERSATION_MEMORY_CONFIG_STRINGS.SUMMARY_TOKEN_LIMIT_REQUIRED_ERROR
  }
  const hasErrors = Object.keys(errors).length > 0

  const handleMethodChange = (next: unknown): void => {
    // SelectDropdownValue spans string | number | (string | number)[].
    // The dialog only renders single-select items, so coerce
    // defensively and drop the array shape.
    const raw = Array.isArray(next) ? next[0] : next
    const nextId = String(raw ?? "") as MessageRetentionMethod
    if (nextId === draft.retentionMethod) return
    onDraftChange({ retentionMethod: nextId })
  }

  const handleNumberChange = (
    e: ChangeEvent<HTMLInputElement>,
    field: "messageHistoryLimit" | "sessionHistoryLimit" | "summaryTokenLimit",
  ): void => {
    const raw = e.target.value
    if (field === "messageHistoryLimit") {
      setIsMessageHistoryDirty(true)
      setMessageHistoryText(raw)
    } else if (field === "summaryTokenLimit") {
      setIsSummaryTokenDirty(true)
      setSummaryTokenText(raw)
    }
    // Coerce to integer; empty / non-numeric collapses to 0 so the
    // range validator can fail visibly rather than silently propagating
    // NaN through the draft.
    const next = raw.trim() === "" ? 0 : Math.trunc(Number(raw))
    onDraftChange({ [field]: Number.isFinite(next) ? next : 0 } as Partial<ConversationMemoryConfig>)
  }

  const handleSave = (): void => {
    if (hasErrors) return
    setIsMessageHistoryDirty(false)
    setIsSummaryTokenDirty(false)
    onSave()
  }

  const handleCancel = (): void => {
    setIsMessageHistoryDirty(false)
    setIsSummaryTokenDirty(false)
    onClose()
  }

  const helperText = MESSAGE_RETENTION_METHOD_HELPER_TEXT[draft.retentionMethod]

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleCancel()
      }}
      size="lg"
    >
      <DialogPopup showCloseButton={false}>
        <Card className="conversation-memory-config-dialog">
          <CardHeader
            title={CONVERSATION_MEMORY_CONFIG_STRINGS.DIALOG_TITLE}
            hasSeparator
          />

          <CardContent>
            <div className="conversation-memory-config-dialog__content">
              <Typography
                Component="p"
                fontSize="fs14"
                color="var(--text-secondary)"
              >
                {CONVERSATION_MEMORY_CONFIG_STRINGS.DESCRIPTION}
              </Typography>

              <div className="conversation-memory-config-dialog__field">
                <SelectDropdown
                  label={CONVERSATION_MEMORY_CONFIG_STRINGS.RETENTION_METHOD_LABEL}
                  items={methodItems}
                  value={draft.retentionMethod}
                  onValueChange={(next) => handleMethodChange(next)}
                />
              </div>

              {showMessageHistoryLimit && (
                <div className="conversation-memory-config-dialog__field">
                  <Input
                    type="number"
                    label={CONVERSATION_MEMORY_CONFIG_STRINGS.MESSAGE_HISTORY_LIMIT_LABEL}
                    value={messageHistoryInputValue}
                    min={MESSAGE_HISTORY_LIMIT_RANGE.min}
                    max={MESSAGE_HISTORY_LIMIT_RANGE.max}
                    step={1}
                    isError={Boolean(errors.messageHistoryLimit)}
                    onChange={(e) => handleNumberChange(e, "messageHistoryLimit")}
                  />
                  {errors.messageHistoryLimit && (
                    <FormFieldErrorBlock message={errors.messageHistoryLimit} />
                  )}
                </div>
              )}

              <div
                className="conversation-memory-config-dialog__helper"
                role="note"
              >
                <IconInfoCircle
                  size={16}
                  className="conversation-memory-config-dialog__helper-icon"
                  aria-hidden="true"
                />
                <Typography fontSize="fs14" color="var(--text-secondary)">
                  {helperText}
                </Typography>
              </div>

              {/*
                Summary-token-limit (Summarization only). Default is 2000
                which matches the backend's own default, so a fresh dialog
                that the user just leaves alone produces an explicit `2000`
                on the wire (no difference from omission). Whatever the user
                types is what gets sent.
              */}
              {showSummaryTokenLimit && (
                <div className="conversation-memory-config-dialog__field">
                  <Input
                    type="number"
                    label={CONVERSATION_MEMORY_CONFIG_STRINGS.SUMMARY_TOKEN_LIMIT_LABEL}
                    value={summaryTokenInputValue}
                    min={SUMMARY_TOKEN_LIMIT_RANGE.min}
                    max={SUMMARY_TOKEN_LIMIT_RANGE.max}
                    step={1}
                    isError={Boolean(errors.summaryTokenLimit)}
                    onChange={(e) => handleNumberChange(e, "summaryTokenLimit")}
                  />
                  {errors.summaryTokenLimit && (
                    <FormFieldErrorBlock message={errors.summaryTokenLimit} />
                  )}
                </div>
              )}

              {/*
                `session_history_limit` is documented as out of scope on
                the memory-context wire (deferred for a follow-up). We no
                longer surface a toggle/input for it here — the field is
                retained in the form state only so legacy records read
                via the api-mapper still round-trip without crashing.
              */}
            </div>
          </CardContent>

          <CardFooter
            hasSeparator
            alignment="end"
            actions={[
              {
                variant: "solid",
                label: CONVERSATION_MEMORY_CONFIG_STRINGS.SAVE_ACTION_LABEL,
                onClick: handleSave,
              },
              {
                variant: "outline",
                label: CONVERSATION_MEMORY_CONFIG_STRINGS.CANCEL_ACTION_LABEL,
                onClick: handleCancel,
              },
            ]}
          />
        </Card>
      </DialogPopup>
    </Dialog>
  )
}

function isIntegerInRange(
  value: number,
  range: { min: number; max: number },
): boolean {
  return (
    Number.isInteger(value) && value >= range.min && value <= range.max
  )
}

export { ConversationMemoryConfigDialog }
export type { ConversationMemoryConfigDialogProps }
