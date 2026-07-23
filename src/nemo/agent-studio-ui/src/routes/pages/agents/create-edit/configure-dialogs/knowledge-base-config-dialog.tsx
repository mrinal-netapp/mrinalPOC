import { useMemo, useState, type ReactElement } from "react"
import { IconCircleCheck } from "@tabler/icons-react"

import { Card } from "@/ui-lib/base-components/card/card"
import { CardContent } from "@/ui-lib/base-components/card/card.content"
import { CardFooter } from "@/ui-lib/base-components/card/card.footer"
import { CardHeader } from "@/ui-lib/base-components/card/card.header"
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog"
import { SelectDropdown } from "@/ui-lib/base-components/select-dropdown/select-dropdown"
import { Slider } from "@/ui-lib/base-components/slider/slider"
import { Toggle } from "@/ui-lib/base-components/toggle/toggle"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { FormFieldErrorBlock } from "@/ui-lib/base-components/form"

import {
  KNOWLEDGE_BASE_CONFIG_STRINGS,
  KNOWLEDGE_BASE_STATUS_LABEL,
  SIMILARITY_RANGE,
  TOP_K_RANGE,
} from "./configure-dialogs.consts"
import type {
  KnowledgeBaseConfig,
  KnowledgeBaseOption,
} from "./configure-dialogs.types"

import "./knowledge-base-config-dialog.scss"

// Static version options. KB versioning is not yet wired to a data source, so
// the dropdown is presentational for now.
const KB_VERSION_ITEMS = [{ key: "latest", value: "latest", label: "Latest" }]

type KnowledgeBaseConfigDialogProps = {
  open: boolean
  draft: KnowledgeBaseConfig
  /** Catalog of knowledge bases to choose from (live project KBs). */
  knowledgeBases?: KnowledgeBaseOption[]
  onClose: () => void
  onDraftChange: (next: Partial<KnowledgeBaseConfig>) => void
  onSave: () => void
}

/**
 * Self-contained dialog for the create-agent form's "Knowledge base"
 * configure step.
 *
 * The similarity slider stays in the draft even when its toggle is off so
 * that re-enabling the threshold restores the last-used value.
 */
function KnowledgeBaseConfigDialog({
  open,
  draft,
  knowledgeBases = [],
  onClose,
  onDraftChange,
  onSave,
}: KnowledgeBaseConfigDialogProps): ReactElement {
  const [submitted, setSubmitted] = useState(false)
  // Presentational only — see KB_VERSION_ITEMS.
  const [version, setVersion] = useState<string>(KB_VERSION_ITEMS[0].value)

  const kbItems = useMemo(
    () => knowledgeBases.map((kb) => ({ key: kb.id, value: kb.id, label: kb.name })),
    [knowledgeBases],
  )

  const selectedKb = draft.knowledgeBaseId
    ? knowledgeBases.find((kb) => kb.id === draft.knowledgeBaseId)
    : undefined

  const errors: Record<string, string> = {}
  if (!draft.knowledgeBaseId.trim()) {
    errors.kb = KNOWLEDGE_BASE_CONFIG_STRINGS.KB_REQUIRED_ERROR
  }
  const hasErrors = Object.keys(errors).length > 0

  const handleKbChange = (nextId: string): void => {
    if (nextId === draft.knowledgeBaseId) return
    onDraftChange({ knowledgeBaseId: nextId })
  }

  const handleSliderValue = (
    raw: number | readonly number[],
    field: "topKChunks" | "similarity",
  ): void => {
    const next = Array.isArray(raw) ? (raw[0] as number) : (raw as number)
    onDraftChange({ [field]: next } as Partial<KnowledgeBaseConfig>)
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

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleCancel()
      }}
      size="lg"
    >
      <DialogPopup showCloseButton={false}>
        <Card className="knowledge-base-config-dialog">
          <CardHeader
            title={KNOWLEDGE_BASE_CONFIG_STRINGS.DIALOG_TITLE}
            hasSeparator
          />

          <CardContent>
            <div className="knowledge-base-config-dialog__content">
              {/* -- Knowledge base details ------------------------------- */}
              <section className="knowledge-base-config-dialog__section">
                <div className="knowledge-base-config-dialog__heading">
                  <Typography Component="h3" fontSize="fs14" boldness="semibold">
                    {KNOWLEDGE_BASE_CONFIG_STRINGS.KB_SECTION_TITLE}
                  </Typography>
                  <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
                    {KNOWLEDGE_BASE_CONFIG_STRINGS.KB_SECTION_SUBTITLE}
                  </Typography>
                </div>

                <div className="knowledge-base-config-dialog__field">
                  <SelectDropdown
                    label={KNOWLEDGE_BASE_CONFIG_STRINGS.KB_LABEL}
                    placeholder={KNOWLEDGE_BASE_CONFIG_STRINGS.KB_PLACEHOLDER}
                    items={kbItems}
                    value={draft.knowledgeBaseId || null}
                    onValueChange={(next) => handleKbChange(String(next ?? ""))}
                    error={submitted ? errors.kb : undefined}
                  />
                  {submitted && errors.kb && (
                    <FormFieldErrorBlock message={errors.kb} />
                  )}
                </div>

                {selectedKb && <KnowledgeBaseMeta kb={selectedKb} />}

                <div className="knowledge-base-config-dialog__field">
                  <SelectDropdown
                    label={KNOWLEDGE_BASE_CONFIG_STRINGS.VERSION_LABEL}
                    placeholder={KNOWLEDGE_BASE_CONFIG_STRINGS.VERSION_PLACEHOLDER}
                    items={KB_VERSION_ITEMS}
                    value={version}
                    onValueChange={(next) => setVersion(String(next ?? KB_VERSION_ITEMS[0].value))}
                  />
                </div>
              </section>

              {/* -- Top K chunks ----------------------------------------- */}
              <section className="knowledge-base-config-dialog__section">
                <div className="knowledge-base-config-dialog__heading">
                  <Typography Component="h3" fontSize="fs14" boldness="semibold">
                    {KNOWLEDGE_BASE_CONFIG_STRINGS.TOP_K_TITLE}
                  </Typography>
                  <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
                    {KNOWLEDGE_BASE_CONFIG_STRINGS.TOP_K_DESCRIPTION}
                  </Typography>
                </div>
                <div className="knowledge-base-config-dialog__slider">
                  <Slider
                    value={draft.topKChunks}
                    onValueChange={(raw) => handleSliderValue(raw, "topKChunks")}
                    min={TOP_K_RANGE.min}
                    max={TOP_K_RANGE.max}
                    step={TOP_K_RANGE.step}
                    isShowCurrent
                    isEditInput
                    isShowLimits
                  />
                </div>
              </section>

              {/* -- Reranking -------------------------------------------- */}
              <section className="knowledge-base-config-dialog__section">
                <div className="knowledge-base-config-dialog__heading">
                  <Typography Component="h3" fontSize="fs14" boldness="semibold">
                    {KNOWLEDGE_BASE_CONFIG_STRINGS.RERANKING_TITLE}
                  </Typography>
                  <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
                    {KNOWLEDGE_BASE_CONFIG_STRINGS.RERANKING_DESCRIPTION}
                  </Typography>
                </div>
                <div className="knowledge-base-config-dialog__toggle-row">
                  <Toggle
                    checked={draft.rerankingEnabled}
                    onCheckedChange={(checked) => onDraftChange({ rerankingEnabled: checked })}
                    ariaLabel={KNOWLEDGE_BASE_CONFIG_STRINGS.RERANKING_TOGGLE_LABEL}
                  />
                  <Typography Component="span" fontSize="fs14">
                    {KNOWLEDGE_BASE_CONFIG_STRINGS.RERANKING_TOGGLE_LABEL}
                  </Typography>
                </div>
              </section>

              {/* -- Similarity threshold --------------------------------- */}
              <section className="knowledge-base-config-dialog__section">
                <div className="knowledge-base-config-dialog__heading">
                  <Typography Component="h3" fontSize="fs14" boldness="semibold">
                    {KNOWLEDGE_BASE_CONFIG_STRINGS.SIMILARITY_THRESHOLD_TITLE}
                  </Typography>
                  <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
                    {KNOWLEDGE_BASE_CONFIG_STRINGS.SIMILARITY_THRESHOLD_DESCRIPTION}
                  </Typography>
                </div>
                <div className="knowledge-base-config-dialog__toggle-row">
                  <Toggle
                    checked={draft.similarityThresholdEnabled}
                    onCheckedChange={(checked) =>
                      onDraftChange({ similarityThresholdEnabled: checked })
                    }
                    ariaLabel={KNOWLEDGE_BASE_CONFIG_STRINGS.SIMILARITY_THRESHOLD_TOGGLE_LABEL}
                  />
                  <Typography Component="span" fontSize="fs14">
                    {KNOWLEDGE_BASE_CONFIG_STRINGS.SIMILARITY_THRESHOLD_TOGGLE_LABEL}
                  </Typography>
                </div>

                {draft.similarityThresholdEnabled && (
                  <div className="knowledge-base-config-dialog__sub-field">
                    <Typography Component="h4" fontSize="fs14" boldness="semibold">
                      {KNOWLEDGE_BASE_CONFIG_STRINGS.SIMILARITY_LABEL}
                    </Typography>
                    <div className="knowledge-base-config-dialog__slider">
                      <Slider
                        value={draft.similarity}
                        onValueChange={(raw) => handleSliderValue(raw, "similarity")}
                        min={SIMILARITY_RANGE.min}
                        max={SIMILARITY_RANGE.max}
                        step={SIMILARITY_RANGE.step}
                        isShowCurrent
                        isEditInput
                        isShowLimits
                      />
                    </div>
                  </div>
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
                label: KNOWLEDGE_BASE_CONFIG_STRINGS.SAVE_ACTION_LABEL,
                onClick: handleSave,
              },
              {
                variant: "outline",
                label: KNOWLEDGE_BASE_CONFIG_STRINGS.CANCEL_ACTION_LABEL,
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
 * Status + Labels rows shown below the KB dropdown once one is picked.
 * Inlined (rather than its own file) — tiny presentational helper tightly
 * coupled to the dialog's data shape.
 */
function KnowledgeBaseMeta({ kb }: { kb: KnowledgeBaseOption }): ReactElement {
  return (
    <dl className="knowledge-base-config-dialog__meta">
      <div className="knowledge-base-config-dialog__meta-row">
        <dt className="knowledge-base-config-dialog__meta-label">
          <Typography fontSize="fs14" color="var(--text-secondary)">
            {KNOWLEDGE_BASE_CONFIG_STRINGS.STATUS_LABEL}
          </Typography>
        </dt>
        <dd className="knowledge-base-config-dialog__meta-value">
          <span
            className={`knowledge-base-config-dialog__status knowledge-base-config-dialog__status--${kb.status}`}
          >
            <IconCircleCheck size={16} aria-hidden="true" />
            <Typography fontSize="fs14">
              {KNOWLEDGE_BASE_STATUS_LABEL[kb.status]}
            </Typography>
          </span>
        </dd>
      </div>

      <div className="knowledge-base-config-dialog__meta-row">
        <dt className="knowledge-base-config-dialog__meta-label">
          <Typography fontSize="fs14" color="var(--text-secondary)">
            {KNOWLEDGE_BASE_CONFIG_STRINGS.LABELS_LABEL}
          </Typography>
        </dt>
        <dd className="knowledge-base-config-dialog__meta-value">
          <Typography fontSize="fs14">
            {kb.labels.length > 0 ? kb.labels.join(", ") : "—"}
          </Typography>
        </dd>
      </div>
    </dl>
  )
}

export { KnowledgeBaseConfigDialog }
export type { KnowledgeBaseConfigDialogProps }
