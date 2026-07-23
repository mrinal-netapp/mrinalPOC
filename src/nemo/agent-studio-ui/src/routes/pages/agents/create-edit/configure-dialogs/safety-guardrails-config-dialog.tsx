import { type ReactElement } from "react"

import { Card } from "@/ui-lib/base-components/card/card"
import { CardContent } from "@/ui-lib/base-components/card/card.content"
import { CardFooter } from "@/ui-lib/base-components/card/card.footer"
import { CardHeader } from "@/ui-lib/base-components/card/card.header"
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog"
import { Toggle } from "@/ui-lib/base-components/toggle/toggle"
import { Typography } from "@/ui-lib/base-components/typography/typography"

import {
  DEFAULT_SAFETY_GUARDRAILS_CONFIG,
  SAFETY_GUARDRAILS_CONFIG_STRINGS,
} from "./configure-dialogs.consts"
import type { SafetyGuardrailsConfig } from "./configure-dialogs.types"

import "./safety-guardrails-config-dialog.scss"

type SafetyGuardrailsConfigDialogProps = {
  open: boolean
  draft: SafetyGuardrailsConfig
  onClose: () => void
  onDraftChange: (next: Partial<SafetyGuardrailsConfig>) => void
  onSave: () => void
}

/**
 * Self-contained dialog for the create-agent form's "Safety and
 * guardrails" configure step.
 *
 * All three sections share the same shape (title + description + toggle)
 * so they're rendered through a tiny inline `<GuardrailSection>` helper.
 * The helper is purposely local — generalising to a shared component
 * would leak draft typing across dialogs for negligible savings.
 *
 * No validation: every state combination (all on, all off, mixed) is
 * legal so Save always succeeds.
 */
function SafetyGuardrailsConfigDialog({
  open,
  draft = DEFAULT_SAFETY_GUARDRAILS_CONFIG,
  onClose,
  onDraftChange,
  onSave,
}: SafetyGuardrailsConfigDialogProps): ReactElement {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
      size="lg"
    >
      <DialogPopup showCloseButton={false}>
        <Card className="safety-guardrails-config-dialog">
          <CardHeader
            title={SAFETY_GUARDRAILS_CONFIG_STRINGS.DIALOG_TITLE}
            hasSeparator
          />

          <CardContent>
            <div className="safety-guardrails-config-dialog__content">
              <Typography
                Component="p"
                fontSize="fs14"
                color="var(--text-secondary)"
              >
                {SAFETY_GUARDRAILS_CONFIG_STRINGS.DESCRIPTION}
              </Typography>

              <GuardrailSection
                title={SAFETY_GUARDRAILS_CONFIG_STRINGS.PII_TITLE}
                description={SAFETY_GUARDRAILS_CONFIG_STRINGS.PII_DESCRIPTION}
                toggleLabel={SAFETY_GUARDRAILS_CONFIG_STRINGS.PII_TOGGLE_LABEL}
                checked={draft.piiMaskerEnabled}
                onCheckedChange={(checked) =>
                  onDraftChange({ piiMaskerEnabled: checked })
                }
              />

              <GuardrailSection
                title={SAFETY_GUARDRAILS_CONFIG_STRINGS.API_KEY_SCANNER_TITLE}
                description={SAFETY_GUARDRAILS_CONFIG_STRINGS.API_KEY_SCANNER_DESCRIPTION}
                toggleLabel={SAFETY_GUARDRAILS_CONFIG_STRINGS.API_KEY_SCANNER_TOGGLE_LABEL}
                checked={draft.apiKeyTokenScannerEnabled}
                onCheckedChange={(checked) =>
                  onDraftChange({ apiKeyTokenScannerEnabled: checked })
                }
              />

              <GuardrailSection
                title={SAFETY_GUARDRAILS_CONFIG_STRINGS.SECRET_DETECTION_TITLE}
                description={SAFETY_GUARDRAILS_CONFIG_STRINGS.SECRET_DETECTION_DESCRIPTION}
                toggleLabel={SAFETY_GUARDRAILS_CONFIG_STRINGS.SECRET_DETECTION_TOGGLE_LABEL}
                checked={draft.secretDetectionEnabled}
                onCheckedChange={(checked) =>
                  onDraftChange({ secretDetectionEnabled: checked })
                }
              />
            </div>
          </CardContent>

          <CardFooter
            hasSeparator
            alignment="end"
            actions={[
              {
                variant: "solid",
                label: SAFETY_GUARDRAILS_CONFIG_STRINGS.SAVE_ACTION_LABEL,
                onClick: onSave,
              },
              {
                variant: "outline",
                label: SAFETY_GUARDRAILS_CONFIG_STRINGS.CANCEL_ACTION_LABEL,
                onClick: onClose,
              },
            ]}
          />
        </Card>
      </DialogPopup>
    </Dialog>
  )
}

function GuardrailSection({
  title,
  description,
  toggleLabel,
  checked,
  onCheckedChange,
}: {
  title: string
  description: string
  toggleLabel: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}): ReactElement {
  return (
    <section className="safety-guardrails-config-dialog__section">
      <Typography Component="h3" fontSize="fs14" boldness="semibold">
        {title}
      </Typography>
      <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
        {description}
      </Typography>
      <div className="safety-guardrails-config-dialog__toggle-row">
        <Toggle
          checked={checked}
          onCheckedChange={onCheckedChange}
          ariaLabel={toggleLabel}
        />
        <Typography Component="span" fontSize="fs14">
          {toggleLabel}
        </Typography>
      </div>
    </section>
  )
}

export { SafetyGuardrailsConfigDialog }
export type { SafetyGuardrailsConfigDialogProps }
