import { type ChangeEvent, type ReactElement } from "react"

import { Card } from "@/ui-lib/base-components/card/card"
import { CardContent } from "@/ui-lib/base-components/card/card.content"
import { CardFooter } from "@/ui-lib/base-components/card/card.footer"
import { CardHeader } from "@/ui-lib/base-components/card/card.header"
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog"
import { Typography } from "@/ui-lib/base-components/typography/typography"

import {
  GOAL_MAX_LENGTH,
  GOAL_PLACEHOLDER,
  INSTRUCTIONS_MAX_LENGTH,
  INSTRUCTIONS_PLACEHOLDER,
} from "../../form/agent-form.consts"

import {
  AGENT_PROFILE_CONFIG_STRINGS,
  type AgentProfileDraft,
} from "./agent-profile-config-dialog.consts"

import "./agent-profile-config-dialog.scss"

type AgentProfileConfigDialogProps = {
  open: boolean
  draft: AgentProfileDraft
  primaryFieldLabel?: string
  primaryFieldPlaceholder?: string
  primaryFieldTooltip?: string
  primaryFieldMaxLength?: number
  sectionDescription?: string
  showDescription?: boolean
  descriptionMaxLength?: number
  onClose: () => void
  onDraftChange: (next: Partial<AgentProfileDraft>) => void
  onSave: () => void
}

/**
 * Self-contained "Configure agent profile" dialog. Owns no validation today
 * (both Goal and Instructions are optional per the design), but enforces the
 * agreed character limits via `maxLength` on the textareas, with the same
 * `<count>/<limit>` counters the inline form used to render.
 *
 * The parent owns the draft so reopening the dialog after a Cancel restores
 * the form's last-saved values, not whatever was last typed.
 */
function AgentProfileConfigDialog({
  open,
  draft,
  primaryFieldLabel = AGENT_PROFILE_CONFIG_STRINGS.GOAL_LABEL,
  primaryFieldPlaceholder = GOAL_PLACEHOLDER,
  primaryFieldTooltip = AGENT_PROFILE_CONFIG_STRINGS.GOAL_TOOLTIP,
  primaryFieldMaxLength = GOAL_MAX_LENGTH,
  sectionDescription = AGENT_PROFILE_CONFIG_STRINGS.SECTION_DESCRIPTION,
  showDescription = false,
  descriptionMaxLength,
  onClose,
  onDraftChange,
  onSave,
}: AgentProfileConfigDialogProps): ReactElement {
  const handleGoalChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    onDraftChange({ goal: e.target.value })
  }

  const handleInstructionsChange = (
    e: ChangeEvent<HTMLTextAreaElement>,
  ): void => {
    onDraftChange({ instructions: e.target.value })
  }

  const handleDescriptionChange = (
    e: ChangeEvent<HTMLTextAreaElement>,
  ): void => {
    onDraftChange({ description: e.target.value })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
      size="lg"
    >
      <DialogPopup showCloseButton={false}>
        <Card className="agent-profile-config-dialog">
          <CardHeader
            title={AGENT_PROFILE_CONFIG_STRINGS.DIALOG_TITLE}
            hasSeparator
          />

          <CardContent>
            <div className="agent-profile-config-dialog__content">
              <div className="agent-profile-config-dialog__heading">
                <Typography Component="h3" fontSize="fs14" boldness="semibold">
                  {AGENT_PROFILE_CONFIG_STRINGS.SECTION_TITLE}
                </Typography>
                <Typography
                  Component="p"
                  fontSize="fs14"
                  color="var(--text-secondary)"
                >
                  {sectionDescription}
                </Typography>
              </div>

              <ProfileTextareaField
                label={primaryFieldLabel}
                tooltip={primaryFieldTooltip}
                value={draft.goal}
                onChange={handleGoalChange}
                placeholder={primaryFieldPlaceholder}
                maxLength={primaryFieldMaxLength}
              />

              {showDescription && (
                <ProfileTextareaField
                  label={AGENT_PROFILE_CONFIG_STRINGS.DESCRIPTION_LABEL}
                  tooltip={AGENT_PROFILE_CONFIG_STRINGS.DESCRIPTION_TOOLTIP}
                  value={draft.description ?? ""}
                  onChange={handleDescriptionChange}
                  placeholder={AGENT_PROFILE_CONFIG_STRINGS.DESCRIPTION_PLACEHOLDER}
                  maxLength={descriptionMaxLength}
                />
              )}

              <ProfileTextareaField
                label={AGENT_PROFILE_CONFIG_STRINGS.INSTRUCTIONS_LABEL}
                tooltip={AGENT_PROFILE_CONFIG_STRINGS.INSTRUCTIONS_TOOLTIP}
                value={draft.instructions}
                onChange={handleInstructionsChange}
                placeholder={INSTRUCTIONS_PLACEHOLDER}
                maxLength={INSTRUCTIONS_MAX_LENGTH}
                isTall
              />
            </div>
          </CardContent>

          <CardFooter
            hasSeparator
            alignment="end"
            actions={[
              {
                variant: "solid",
                label: AGENT_PROFILE_CONFIG_STRINGS.SAVE_ACTION_LABEL,
                onClick: onSave,
              },
              {
                variant: "outline",
                label: AGENT_PROFILE_CONFIG_STRINGS.CANCEL_ACTION_LABEL,
                onClick: onClose,
              },
            ]}
          />
        </Card>
      </DialogPopup>
    </Dialog>
  )
}

type ProfileTextareaFieldProps = {
  label: string
  value: string
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void
  placeholder?: string
  maxLength?: number
  tooltip?: string
  isTall?: boolean
}

function ProfileTextareaField({
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  tooltip,
  isTall = false,
}: ProfileTextareaFieldProps): ReactElement {
  return (
    <div className="agent-profile-config-dialog__field">
      <div className="agent-profile-config-dialog__field-label-row">
        <Typography Component="label" fontSize="fs14" boldness="regular">
          {label}
        </Typography>
        {tooltip !== undefined && (
          <span
            className="agent-profile-config-dialog__field-tooltip"
            aria-label={tooltip}
            data-tooltip={tooltip}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <circle
                cx="8"
                cy="8"
                r="7"
                stroke="var(--text-secondary)"
                strokeWidth="1.2"
              />
              <text
                x="8"
                y="12"
                textAnchor="middle"
                fontSize="10"
                fill="var(--text-secondary)"
              >
                i
              </text>
            </svg>
          </span>
        )}
      </div>
      <div className="agent-profile-config-dialog__textarea-wrapper">
        <textarea
          className={
            isTall
              ? "agent-profile-config-dialog__textarea agent-profile-config-dialog__textarea--tall"
              : "agent-profile-config-dialog__textarea"
          }
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          maxLength={maxLength}
        />
        {maxLength !== undefined && (
          <div className="agent-profile-config-dialog__textarea-meta">
            {value.length}/{maxLength}
          </div>
        )}
      </div>
    </div>
  )
}

export { AgentProfileConfigDialog }
export type { AgentProfileConfigDialogProps }
