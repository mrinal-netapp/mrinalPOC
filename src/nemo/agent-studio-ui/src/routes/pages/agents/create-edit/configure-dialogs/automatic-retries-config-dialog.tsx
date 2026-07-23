import { useState, type ChangeEvent, type ReactElement } from "react"

import { Card } from "@/ui-lib/base-components/card/card"
import { CardContent } from "@/ui-lib/base-components/card/card.content"
import { CardFooter } from "@/ui-lib/base-components/card/card.footer"
import { CardHeader } from "@/ui-lib/base-components/card/card.header"
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog"
import { Input } from "@/ui-lib/base-components/input/input"
import { Toggle } from "@/ui-lib/base-components/toggle/toggle"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { FormFieldErrorBlock } from "@/ui-lib/base-components/form"

import {
  AUTOMATIC_RETRIES_CONFIG_STRINGS,
  DEFAULT_AUTOMATIC_RETRIES_CONFIG,
  MAX_RETRIES_RANGE,
} from "./configure-dialogs.consts"
import type { AutomaticRetriesConfig } from "./configure-dialogs.types"

import "./automatic-retries-config-dialog.scss"

type AutomaticRetriesConfigDialogProps = {
  open: boolean
  draft: AutomaticRetriesConfig
  onClose: () => void
  onDraftChange: (next: Partial<AutomaticRetriesConfig>) => void
  onSave: () => void
}

/**
 * Self-contained dialog for the create-agent form's "Automatic retries"
 * configure step.
 *
 * `maxRetries` survives across toggle off → on so users can flip the
 * feature back on without re-entering the count.
 *
 * The visible field is driven by a local text buffer (`retriesText`) so
 * the user can type freely — including clearing it to an empty string —
 * without the controlled draft snapping the caret back to a coerced
 * number on every keystroke. Each edit still parses into the draft
 * (empty / non-numeric → a sentinel out-of-range value) so validation
 * has something concrete to fail on. Validation is live and strict: the
 * range error surfaces the moment the value is empty or out of range,
 * and Save stays blocked as a final backstop.
 */
function AutomaticRetriesConfigDialog({
  open,
  draft = DEFAULT_AUTOMATIC_RETRIES_CONFIG,
  onClose,
  onDraftChange,
  onSave,
}: AutomaticRetriesConfigDialogProps): ReactElement {
  const [retriesText, setRetriesText] = useState(() => String(draft.maxRetries))
  const [isRetriesDirty, setIsRetriesDirty] = useState(false)
  const retriesInputValue = isRetriesDirty ? retriesText : String(draft.maxRetries)

  const errorMessage =
    draft.enabled && !isIntegerInRange(draft.maxRetries, MAX_RETRIES_RANGE)
      ? AUTOMATIC_RETRIES_CONFIG_STRINGS.MAX_RETRIES_ERROR
      : undefined

  const handleNumberChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const raw = e.target.value
    setIsRetriesDirty(true)
    setRetriesText(raw)
    // Empty input → -1 so the range validator fails visibly; otherwise
    // truncate to an integer.
    const next = raw.trim() === "" ? -1 : Math.trunc(Number(raw))
    onDraftChange({ maxRetries: Number.isFinite(next) ? next : -1 })
  }

  const handleSave = (): void => {
    if (errorMessage) return
    setIsRetriesDirty(false)
    onSave()
  }

  const handleCancel = (): void => {
    setIsRetriesDirty(false)
    onClose()
  }

  const showError = Boolean(errorMessage)

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleCancel()
      }}
      size="lg"
    >
      <DialogPopup showCloseButton={false}>
        <Card className="automatic-retries-config-dialog">
          <CardHeader
            title={AUTOMATIC_RETRIES_CONFIG_STRINGS.DIALOG_TITLE}
            hasSeparator
          />

          <CardContent>
            <div className="automatic-retries-config-dialog__content">
              <Typography
                Component="p"
                fontSize="fs14"
                color="var(--text-secondary)"
              >
                {AUTOMATIC_RETRIES_CONFIG_STRINGS.DESCRIPTION}
              </Typography>

              <div className="automatic-retries-config-dialog__toggle-row">
                <Toggle
                  checked={draft.enabled}
                  onCheckedChange={(checked) => onDraftChange({ enabled: checked })}
                  ariaLabel={AUTOMATIC_RETRIES_CONFIG_STRINGS.TOGGLE_LABEL}
                />
                <Typography Component="span" fontSize="fs14">
                  {AUTOMATIC_RETRIES_CONFIG_STRINGS.TOGGLE_LABEL}
                </Typography>
              </div>

              {draft.enabled && (
                <div className="automatic-retries-config-dialog__field">
                  <Input
                    type="number"
                    label={AUTOMATIC_RETRIES_CONFIG_STRINGS.MAX_RETRIES_LABEL}
                    value={retriesInputValue}
                    min={MAX_RETRIES_RANGE.min}
                    max={MAX_RETRIES_RANGE.max}
                    step={1}
                    isError={showError}
                    onChange={handleNumberChange}
                  />
                  {showError && errorMessage && (
                    <FormFieldErrorBlock message={errorMessage} />
                  )}
                </div>
              )}
            </div>
          </CardContent>

          <CardFooter
            hasSeparator
            alignment="end"
            actions={[
              {
                variant: "solid",
                label: AUTOMATIC_RETRIES_CONFIG_STRINGS.SAVE_ACTION_LABEL,
                onClick: handleSave,
              },
              {
                variant: "outline",
                label: AUTOMATIC_RETRIES_CONFIG_STRINGS.CANCEL_ACTION_LABEL,
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
  return Number.isInteger(value) && value >= range.min && value <= range.max
}

export { AutomaticRetriesConfigDialog }
export type { AutomaticRetriesConfigDialogProps }
