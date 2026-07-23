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
  AGENT_RATE_LIMITING_CONFIG_STRINGS,
  DEFAULT_AGENT_RATE_LIMITING_CONFIG,
  MAX_REQUESTS_PER_MINUTE_RANGE,
} from "./configure-dialogs.consts"
import type { AgentRateLimitingConfig } from "./configure-dialogs.types"

import "./agent-rate-limiting-config-dialog.scss"

type AgentRateLimitingConfigDialogProps = {
  open: boolean
  draft: AgentRateLimitingConfig
  onClose: () => void
  onDraftChange: (next: Partial<AgentRateLimitingConfig>) => void
  onSave: () => void
}

/**
 * Self-contained dialog for the create-agent form's "Rate limiting"
 * configure step. Same off-preserves-value contract as
 * AutomaticRetriesConfigDialog; see that file for the broader rationale,
 * including the local text buffer that keeps the number field freely
 * typeable and the live/strict validation.
 */
function AgentRateLimitingConfigDialog({
  open,
  draft = DEFAULT_AGENT_RATE_LIMITING_CONFIG,
  onClose,
  onDraftChange,
  onSave,
}: AgentRateLimitingConfigDialogProps): ReactElement {
  const [rpmText, setRpmText] = useState(() =>
    String(draft.maxRequestsPerMinute),
  )
  const [isRpmDirty, setIsRpmDirty] = useState(false)
  const rpmInputValue = isRpmDirty ? rpmText : String(draft.maxRequestsPerMinute)

  const errorMessage =
    draft.enabled &&
    !isIntegerInRange(draft.maxRequestsPerMinute, MAX_REQUESTS_PER_MINUTE_RANGE)
      ? AGENT_RATE_LIMITING_CONFIG_STRINGS.MAX_RPM_ERROR
      : undefined

  const handleNumberChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const raw = e.target.value
    setIsRpmDirty(true)
    setRpmText(raw)
    // Empty input → 0 so the range validator (min 1) fails visibly.
    const next = raw.trim() === "" ? 0 : Math.trunc(Number(raw))
    onDraftChange({
      maxRequestsPerMinute: Number.isFinite(next) ? next : 0,
    })
  }

  const handleSave = (): void => {
    if (errorMessage) return
    setIsRpmDirty(false)
    onSave()
  }

  const handleCancel = (): void => {
    setIsRpmDirty(false)
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
        <Card className="agent-rate-limiting-config-dialog">
          <CardHeader
            title={AGENT_RATE_LIMITING_CONFIG_STRINGS.DIALOG_TITLE}
            hasSeparator
          />

          <CardContent>
            <div className="agent-rate-limiting-config-dialog__content">
              <Typography
                Component="p"
                fontSize="fs14"
                color="var(--text-secondary)"
              >
                {AGENT_RATE_LIMITING_CONFIG_STRINGS.DESCRIPTION}
              </Typography>

              <div className="agent-rate-limiting-config-dialog__toggle-row">
                <Toggle
                  checked={draft.enabled}
                  onCheckedChange={(checked) => onDraftChange({ enabled: checked })}
                  ariaLabel={AGENT_RATE_LIMITING_CONFIG_STRINGS.TOGGLE_LABEL}
                />
                <Typography Component="span" fontSize="fs14">
                  {AGENT_RATE_LIMITING_CONFIG_STRINGS.TOGGLE_LABEL}
                </Typography>
              </div>

              {draft.enabled && (
                <div className="agent-rate-limiting-config-dialog__field">
                  <Input
                    type="number"
                    label={AGENT_RATE_LIMITING_CONFIG_STRINGS.MAX_RPM_LABEL}
                    value={rpmInputValue}
                    min={MAX_REQUESTS_PER_MINUTE_RANGE.min}
                    max={MAX_REQUESTS_PER_MINUTE_RANGE.max}
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
                label: AGENT_RATE_LIMITING_CONFIG_STRINGS.SAVE_ACTION_LABEL,
                onClick: handleSave,
              },
              {
                variant: "outline",
                label: AGENT_RATE_LIMITING_CONFIG_STRINGS.CANCEL_ACTION_LABEL,
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

export { AgentRateLimitingConfigDialog }
export type { AgentRateLimitingConfigDialogProps }
