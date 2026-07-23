import { useMemo, useState, type ReactElement } from "react"
import { IconCircleCheck, IconInfoCircle } from "@tabler/icons-react"

import { Card } from "@/ui-lib/base-components/card/card"
import { CardContent } from "@/ui-lib/base-components/card/card.content"
import { CardFooter } from "@/ui-lib/base-components/card/card.footer"
import { CardHeader } from "@/ui-lib/base-components/card/card.header"
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog"
import { SelectDropdown } from "@/ui-lib/base-components/select-dropdown/select-dropdown"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { FormFieldErrorBlock } from "@/ui-lib/base-components/form"

import {
  TOOLSET_CONFIG_STRINGS,
  TOOLSET_STATUS_LABEL,
} from "./configure-dialogs.consts"
import type {
  ToolsetConfig,
  ToolsetOption,
} from "./configure-dialogs.types"
import { ToolsSelectionTable } from "./toolset-config-dialog.tools-table"

import "./toolset-config-dialog.scss"

type ToolsetConfigDialogProps = {
  open: boolean
  draft: ToolsetConfig
  /** Catalog of toolsets to choose from (live project MCP servers). */
  toolsets?: ToolsetOption[]
  /** True while the selected toolset's live tool catalog is loading. */
  toolsLoading?: boolean
  /** True when the live tool catalog failed to load (shows allowlist fallback). */
  toolsError?: boolean
  onClose: () => void
  onDraftChange: (next: Partial<ToolsetConfig>) => void
  onSave: () => void
}

/**
 * Self-contained dialog for the create-agent form's "Toolset" configure step.
 *
 * Controlled via `draft` + `onDraftChange`; emits the saved value through
 * `onSave`. The parent owns persistence and toggling the dialog `open` state.
 * Picking a new toolset clears `selectedToolIds` to avoid stale selections
 * pointing at tools the new toolset doesn't expose.
 */
function ToolsetConfigDialog({
  open,
  draft,
  toolsets = [],
  toolsLoading = false,
  toolsError = false,
  onClose,
  onDraftChange,
  onSave,
}: ToolsetConfigDialogProps): ReactElement {
  const [submitted, setSubmitted] = useState(false)

  const dropdownItems = useMemo(
    () => toolsets.map((t) => ({ key: t.id, value: t.id, label: t.name })),
    [toolsets],
  )

  const selectedToolset = draft.toolsetId
    ? toolsets.find((t) => t.id === draft.toolsetId)
    : undefined

  // Inline validation: "no tools selected" only flagged once a toolset is
  // chosen, otherwise the user gets two cascading errors for one missing
  // input.
  const errors: Record<string, string> = {}
  if (!draft.toolsetId.trim()) {
    errors.toolset = TOOLSET_CONFIG_STRINGS.TOOLSET_REQUIRED_ERROR
  } else if (draft.selectedToolIds.length === 0) {
    errors.tools = TOOLSET_CONFIG_STRINGS.NO_TOOLS_SELECTED_ERROR
  }
  const hasErrors = Object.keys(errors).length > 0

  const handleToolsetChange = (nextId: string): void => {
    if (nextId === draft.toolsetId) return
    onDraftChange({ toolsetId: nextId, selectedToolIds: [] })
  }

  const handleSelectionChange = (nextIds: string[]): void => {
    onDraftChange({ selectedToolIds: nextIds })
  }

  const handleSave = (): void => {
    setSubmitted(true)
    if (hasErrors) return
    setSubmitted(false)
    onSave()
  }

  const handleCancel = (): void => {
    setSubmitted(false)
    onClose()
  }

  const selectionCountLabel = selectedToolset
    ? TOOLSET_CONFIG_STRINGS.TOOLS_SELECTION_COUNT_TEMPLATE
      .replace("{selected}", String(draft.selectedToolIds.length))
      .replace("{total}", String(selectedToolset.tools.length))
    : ""

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleCancel()
      }}
      size="lg"
    >
      <DialogPopup showCloseButton={false}>
        <Card className="toolset-config-dialog">
          <CardHeader title={TOOLSET_CONFIG_STRINGS.DIALOG_TITLE} hasSeparator />

          <CardContent>
            <div className="toolset-config-dialog__content">
              {/* -- Toolset details ----------------------------------------- */}
              <section className="toolset-config-dialog__section">
                <div className="toolset-config-dialog__heading">
                  <Typography Component="h3" fontSize="fs14" boldness="semibold">
                    {TOOLSET_CONFIG_STRINGS.TOOLSET_SECTION_TITLE}
                  </Typography>
                  <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
                    {TOOLSET_CONFIG_STRINGS.TOOLSET_SECTION_SUBTITLE}
                  </Typography>
                </div>

                <div className="toolset-config-dialog__field">
                  <SelectDropdown
                    label={TOOLSET_CONFIG_STRINGS.TOOLSET_LABEL}
                    placeholder={TOOLSET_CONFIG_STRINGS.TOOLSET_PLACEHOLDER}
                    items={dropdownItems}
                    value={draft.toolsetId || null}
                    onValueChange={(next) => handleToolsetChange(String(next ?? ""))}
                    error={submitted ? errors.toolset : undefined}
                  />
                  {submitted && errors.toolset && (
                    <FormFieldErrorBlock message={errors.toolset} />
                  )}
                </div>

                {selectedToolset && <ToolsetMeta toolset={selectedToolset} />}
              </section>

              {/* -- Tools --------------------------------------------------- */}
              <section className="toolset-config-dialog__section">
                <div className="toolset-config-dialog__heading">
                  <Typography Component="h3" fontSize="fs14" boldness="semibold">
                    {TOOLSET_CONFIG_STRINGS.TOOLS_SECTION_TITLE}
                  </Typography>
                  <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
                    {TOOLSET_CONFIG_STRINGS.TOOLS_SECTION_SUBTITLE}
                  </Typography>
                </div>

                {!selectedToolset ? (
                  <Typography fontSize="fs14" color="var(--text-secondary)">
                    {TOOLSET_CONFIG_STRINGS.SELECT_TOOLSET_FIRST_MESSAGE}
                  </Typography>
                ) : toolsLoading ? (
                  <Typography fontSize="fs14" color="var(--text-secondary)">
                    {TOOLSET_CONFIG_STRINGS.TOOLS_LOADING_MESSAGE}
                  </Typography>
                ) : (
                  <>
                    {toolsError && (
                      <div className="toolset-config-dialog__selection-banner toolset-config-dialog__selection-banner--error">
                        <IconInfoCircle
                          size={16}
                          className="toolset-config-dialog__selection-banner-icon"
                          aria-hidden="true"
                        />
                        <Typography fontSize="fs14">
                          {TOOLSET_CONFIG_STRINGS.TOOLS_ERROR_MESSAGE}
                        </Typography>
                      </div>
                    )}

                    <div className="toolset-config-dialog__selection-banner">
                      <IconInfoCircle
                        size={16}
                        className="toolset-config-dialog__selection-banner-icon"
                        aria-hidden="true"
                      />
                      <Typography fontSize="fs14">{selectionCountLabel}</Typography>
                    </div>

                    <ToolsSelectionTable
                      tools={selectedToolset.tools}
                      selectedToolIds={draft.selectedToolIds}
                      onSelectionChange={handleSelectionChange}
                    />

                    {submitted && errors.tools && (
                      <FormFieldErrorBlock message={errors.tools} />
                    )}
                  </>
                )}
              </section>
            </div>
          </CardContent>

          <CardFooter
            hasSeparator
            alignment="end"
            actions={[
              {
                variant: "solid",
                label: TOOLSET_CONFIG_STRINGS.SAVE_ACTION_LABEL,
                onClick: handleSave,
              },
              {
                variant: "outline",
                label: TOOLSET_CONFIG_STRINGS.CANCEL_ACTION_LABEL,
                onClick: handleCancel,
              },
            ]}
          />
        </Card>
      </DialogPopup>
    </Dialog>
  )
}

/**
 * Status + Labels rows shown below the dropdown once a toolset is picked.
 * Inlined here (rather than its own file) because it's a tiny presentational
 * helper tightly coupled to the dialog's data shape.
 */
function ToolsetMeta({ toolset }: { toolset: ToolsetOption }): ReactElement {
  return (
    <dl className="toolset-config-dialog__meta">
      <div className="toolset-config-dialog__meta-row">
        <dt className="toolset-config-dialog__meta-label">
          <Typography fontSize="fs14" color="var(--text-secondary)">
            {TOOLSET_CONFIG_STRINGS.STATUS_LABEL}
          </Typography>
        </dt>
        <dd className="toolset-config-dialog__meta-value">
          <span
            className={`toolset-config-dialog__status toolset-config-dialog__status--${toolset.status}`}
          >
            <IconCircleCheck size={16} aria-hidden="true" />
            <Typography fontSize="fs14">
              {TOOLSET_STATUS_LABEL[toolset.status]}
            </Typography>
          </span>
        </dd>
      </div>

      <div className="toolset-config-dialog__meta-row">
        <dt className="toolset-config-dialog__meta-label">
          <Typography fontSize="fs14" color="var(--text-secondary)">
            {TOOLSET_CONFIG_STRINGS.LABELS_LABEL}
          </Typography>
        </dt>
        <dd className="toolset-config-dialog__meta-value">
          <Typography fontSize="fs14">
            {toolset.labels.length > 0 ? toolset.labels.join(", ") : "—"}
          </Typography>
        </dd>
      </div>

      {toolset.description && (
        <div className="toolset-config-dialog__meta-row">
          <dt className="toolset-config-dialog__meta-label">
            <Typography fontSize="fs14" color="var(--text-secondary)">
              {TOOLSET_CONFIG_STRINGS.DESCRIPTION_LABEL}
            </Typography>
          </dt>
          <dd className="toolset-config-dialog__meta-value">
            <Typography fontSize="fs14">{toolset.description}</Typography>
          </dd>
        </div>
      )}
    </dl>
  )
}

export { ToolsetConfigDialog }
export type { ToolsetConfigDialogProps }
