import { useId, useState, type ChangeEvent, type ReactElement } from "react"

import { Card } from "@/ui-lib/base-components/card/card"
import { CardContent } from "@/ui-lib/base-components/card/card.content"
import { CardFooter } from "@/ui-lib/base-components/card/card.footer"
import { CardHeader } from "@/ui-lib/base-components/card/card.header"
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog"
import { Toggle } from "@/ui-lib/base-components/toggle/toggle"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { FormFieldErrorBlock } from "@/ui-lib/base-components/form"

import {
  DEFAULT_OUTPUT_RESPONSE_CONFIG,
  OUTPUT_RESPONSE_CONFIG_STRINGS,
  OUTPUT_RESPONSE_MAX_LENGTH,
} from "./configure-dialogs.consts"
import type { OutputResponseConfig } from "./configure-dialogs.types"

import "./output-response-config-dialog.scss"

type OutputResponseConfigDialogProps = {
  open: boolean
  draft: OutputResponseConfig
  onClose: () => void
  onDraftChange: (next: Partial<OutputResponseConfig>) => void
  onSave: () => void
}

/**
 * Self-contained dialog for the create-agent form's "Output response"
 * configure step.
 *
 * The example text stays in the draft even while the toggle is off so
 * users can flip it back on and recover their work. The textarea hard
 * caps at `OUTPUT_RESPONSE_MAX_LENGTH`; the counter is purely
 * informational because `maxLength` already prevents over-typing.
 *
 * Note: we don't reuse `Input` here because it's single-line only and
 * exposes no `rows`/`resize` controls — a small native `<textarea>`
 * wrapper styled via the shared `fieldStyling()` mixin is simpler and
 * keeps the dialog dependency-light.
 */
function OutputResponseConfigDialog({
  open,
  draft = DEFAULT_OUTPUT_RESPONSE_CONFIG,
  onClose,
  onDraftChange,
  onSave,
}: OutputResponseConfigDialogProps): ReactElement {
  const [submitted, setSubmitted] = useState(false)
  const textareaId = useId()

  const charCount = draft.exampleResponse.length
  const isEmptyWhenEnabled = draft.enabled && draft.exampleResponse.trim().length === 0
  const errorMessage = isEmptyWhenEnabled
    ? OUTPUT_RESPONSE_CONFIG_STRINGS.EXAMPLE_REQUIRED_ERROR
    : undefined

  const handleTextChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    // Browser already enforces maxLength via the attribute, but slice
    // defensively in case the value arrives from a paste handler that
    // bypassed the cap.
    const next = e.target.value.slice(0, OUTPUT_RESPONSE_MAX_LENGTH)
    onDraftChange({ exampleResponse: next })
  }

  const handleToggle = (checked: boolean): void => {
    onDraftChange({ enabled: checked })
  }

  const handleSave = (): void => {
    setSubmitted(true)
    if (errorMessage) return
    setSubmitted(false)
    onSave()
  }

  const handleCancel = (): void => {
    setSubmitted(false)
    onClose()
  }

  const showError = submitted && Boolean(errorMessage)

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleCancel()
      }}
      size="lg"
    >
      <DialogPopup showCloseButton={false}>
        <Card className="output-response-config-dialog">
          <CardHeader
            title={OUTPUT_RESPONSE_CONFIG_STRINGS.DIALOG_TITLE}
            hasSeparator
          />

          <CardContent>
            <div className="output-response-config-dialog__content">
              <Typography
                Component="p"
                fontSize="fs14"
                color="var(--text-secondary)"
              >
                {OUTPUT_RESPONSE_CONFIG_STRINGS.DESCRIPTION}
              </Typography>

              <div className="output-response-config-dialog__toggle-row">
                <Toggle
                  checked={draft.enabled}
                  onCheckedChange={handleToggle}
                  ariaLabel={OUTPUT_RESPONSE_CONFIG_STRINGS.TOGGLE_LABEL}
                />
                <Typography Component="span" fontSize="fs14">
                  {OUTPUT_RESPONSE_CONFIG_STRINGS.TOGGLE_LABEL}
                </Typography>
              </div>

              {draft.enabled && (
                <div className="output-response-config-dialog__field">
                  <Typography
                    Component="label"
                    htmlFor={textareaId}
                    fontSize="fs14"
                    boldness="semibold"
                  >
                    {OUTPUT_RESPONSE_CONFIG_STRINGS.EXAMPLE_LABEL}
                  </Typography>

                  <textarea
                    id={textareaId}
                    className={
                      "output-response-config-dialog__textarea" +
                      (showError ? " output-response-config-dialog__textarea--error" : "")
                    }
                    value={draft.exampleResponse}
                    onChange={handleTextChange}
                    placeholder={OUTPUT_RESPONSE_CONFIG_STRINGS.EXAMPLE_PLACEHOLDER}
                    rows={10}
                    maxLength={OUTPUT_RESPONSE_MAX_LENGTH}
                    aria-label={OUTPUT_RESPONSE_CONFIG_STRINGS.EXAMPLE_LABEL}
                    aria-invalid={showError || undefined}
                  />

                  <div className="output-response-config-dialog__counter-row">
                    <Typography
                      Component="span"
                      fontSize="fs13"
                      color="var(--text-secondary)"
                    >
                      {charCount}/{OUTPUT_RESPONSE_MAX_LENGTH}
                    </Typography>
                  </div>

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
                label: OUTPUT_RESPONSE_CONFIG_STRINGS.SAVE_ACTION_LABEL,
                onClick: handleSave,
              },
              {
                variant: "outline",
                label: OUTPUT_RESPONSE_CONFIG_STRINGS.CANCEL_ACTION_LABEL,
                onClick: handleCancel,
              },
            ]}
          />
        </Card>
      </DialogPopup>
    </Dialog>
  )
}

export { OutputResponseConfigDialog }
export type { OutputResponseConfigDialogProps }
