import { useCallback, useState, type ReactElement } from "react"
import { IconAlertTriangle } from "@tabler/icons-react"

import { Card } from "@/ui-lib/base-components/card/card"
import { CardContent } from "@/ui-lib/base-components/card/card.content"
import { CardFooter } from "@/ui-lib/base-components/card/card.footer"
import { CardHeader } from "@/ui-lib/base-components/card/card.header"
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog"
import { FormFieldErrorBlock } from "@/ui-lib/base-components/form"
import { Input } from "@/ui-lib/base-components/input/input"
import { SelectDropdown } from "@/ui-lib/base-components/select-dropdown/select-dropdown"
import { LABEL_FIELD_SELECT_OPTIONS } from "@/ui-lib/base-components/select-dropdown/select-dropdown.types"
import { Typography } from "@/ui-lib/base-components/typography/typography"

import {
  DEFAULT_SAVE_AGENT_VALUES,
  SAVE_AGENT_DIALOG_STRINGS,
  type SaveAgentMode,
  type SaveAgentValues,
} from "./save-agent-dialog.consts"

import "./save-agent-dialog.scss"

type SaveAgentDialogProps = {
  open: boolean
  /** Determines title, primary-action label, and the accent stripe at the top. */
  mode: SaveAgentMode
  /** Pre-fills the form when the dialog opens; ignored while open. */
  initialValues?: SaveAgentValues
  /** Unconfigured template dependencies that will be omitted when deploying. */
  unresolvedDependencies?: SaveAgentUnresolvedDependency[]
  onClose: () => void
  onSubmit: (values: SaveAgentValues, mode: SaveAgentMode) => void | Promise<void>
}

type SaveAgentUnresolvedDependency = {
  type: "Knowledge base" | "Toolset"
  label: string
}

type LabelItem = { key: string; value: string; label: string }

function buildLabelItems(labels: string[]): LabelItem[] {
  return labels.map((label) => ({ key: label, value: label, label }))
}

/**
 * Identity-confirmation dialog the user sees after picking "Save as draft" or
 * "Save and deploy" from the page's Save dropdown. Owns its own draft state so
 * a Cancel never leaks half-typed values back into the form; the parent caches
 * the most recently committed values to repopulate on the next open.
 */
function SaveAgentDialog({
  open,
  mode,
  initialValues = DEFAULT_SAVE_AGENT_VALUES,
  unresolvedDependencies = [],
  onClose,
  onSubmit,
}: SaveAgentDialogProps): ReactElement {
  const [draft, setDraft] = useState<SaveAgentValues>(initialValues)
  const [labelItems, setLabelItems] = useState<LabelItem[]>(() =>
    buildLabelItems(initialValues.labels),
  )
  const [submitted, setSubmitted] = useState(false)

  // Re-seeding on open is handled by the parent passing a key that changes
  // on each open (e.g. `key={saveMode ?? "closed"}`). That forces a remount
  // and avoids the eager setState-in-effect anti-pattern.

  const isDeploy = mode === "deploy"
  const showUnresolvedDraftWarning = !isDeploy && unresolvedDependencies.length > 0
  const title = isDeploy
    ? SAVE_AGENT_DIALOG_STRINGS.TITLE_DEPLOY
    : SAVE_AGENT_DIALOG_STRINGS.TITLE_DRAFT
  const primaryLabel = isDeploy
    ? SAVE_AGENT_DIALOG_STRINGS.PRIMARY_ACTION_DEPLOY
    : SAVE_AGENT_DIALOG_STRINGS.PRIMARY_ACTION_DRAFT

  const trimmedName = draft.name.trim()
  const nameError = trimmedName.length === 0
    ? SAVE_AGENT_DIALOG_STRINGS.NAME_REQUIRED_ERROR
    : undefined

  const handleAddLabel = useCallback((value: string): void => {
    const trimmed = value.trim()
    if (!trimmed) return
    setLabelItems((prev) => {
      if (prev.some((item) => item.value === trimmed)) return prev
      return [...prev, { key: trimmed, value: trimmed, label: trimmed }]
    })
    setDraft((prev) => ({
      ...prev,
      labels: prev.labels.includes(trimmed) ? prev.labels : [...prev.labels, trimmed],
    }))
  }, [])

  const handleLabelsChange = useCallback((val: unknown): void => {
    const labels = Array.isArray(val) ? val.map(String) : []
    setDraft((prev) => ({ ...prev, labels }))
  }, [])

  const handleCancel = (): void => {
    onClose()
  }

  const handleSubmit = async (): Promise<void> => {
    setSubmitted(true)
    if (nameError) return
    await onSubmit({ ...draft, name: trimmedName }, mode)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleCancel()
      }}
      size="md"
    >
      <DialogPopup showCloseButton={false}>
        <Card
          className={
            isDeploy
              ? "save-agent-dialog save-agent-dialog--deploy"
              : "save-agent-dialog"
          }
        >
          <CardHeader title={title} hasSeparator />

          <CardContent>
            <div className="save-agent-dialog__content">
              <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
                {SAVE_AGENT_DIALOG_STRINGS.DESCRIPTION}
              </Typography>

              <div className="save-agent-dialog__field">
                <Input
                  label={SAVE_AGENT_DIALOG_STRINGS.NAME_LABEL}
                  placeholder={SAVE_AGENT_DIALOG_STRINGS.NAME_PLACEHOLDER}
                  value={draft.name}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, name: e.target.value }))
                  }
                  isError={submitted && Boolean(nameError)}
                />
                {submitted && nameError && (
                  <FormFieldErrorBlock message={nameError} />
                )}
              </div>

              <div className="save-agent-dialog__field">
                <Input
                  label={SAVE_AGENT_DIALOG_STRINGS.DESCRIPTION_LABEL}
                  placeholder={SAVE_AGENT_DIALOG_STRINGS.DESCRIPTION_PLACEHOLDER}
                  isOptional
                  value={draft.description}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      description: e.target.value,
                    }))
                  }
                />
              </div>

              <div className="save-agent-dialog__field">
                <SelectDropdown
                  label={SAVE_AGENT_DIALOG_STRINGS.LABELS_LABEL}
                  tooltip={SAVE_AGENT_DIALOG_STRINGS.LABELS_TOOLTIP}
                  items={labelItems}
                  value={draft.labels}
                  onValueChange={handleLabelsChange}
                  placeholder={SAVE_AGENT_DIALOG_STRINGS.LABELS_PLACEHOLDER}
                  size="fill"
                  emptyMessage=""
                  options={{ ...LABEL_FIELD_SELECT_OPTIONS, isOptional: true }}
                  onAddNew={handleAddLabel}
                />
              </div>

              {showUnresolvedDraftWarning && (
                <div className="save-agent-dialog__unresolved-warning" role="alert">
                  <div className="save-agent-dialog__unresolved-message">
                    <IconAlertTriangle
                      size={18}
                      className="save-agent-dialog__unresolved-icon"
                      aria-hidden="true"
                    />
                    <div>
                      <Typography Component="p" fontSize="fs14">
                        {SAVE_AGENT_DIALOG_STRINGS.UNRESOLVED_DRAFT_WARNING_INTRO}
                      </Typography>
                      <ul className="save-agent-dialog__unresolved-list">
                        {unresolvedDependencies.map((dependency) => (
                          <li key={`${dependency.type}-${dependency.label}`}>
                            <Typography Component="span" fontSize="fs14">
                              {dependency.type}: {dependency.label}
                            </Typography>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
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
                label: primaryLabel,
                onClick: handleSubmit,
              },
              {
                variant: "outline",
                label: SAVE_AGENT_DIALOG_STRINGS.CANCEL_ACTION,
                onClick: handleCancel,
              },
            ]}
          />
        </Card>
      </DialogPopup>
    </Dialog>
  )
}

export { SaveAgentDialog }
export type { SaveAgentDialogProps }
