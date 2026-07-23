import { useId, type ChangeEvent, type ReactElement } from "react"

import { Card } from "@/ui-lib/base-components/card/card"
import { CardContent } from "@/ui-lib/base-components/card/card.content"
import { CardFooter } from "@/ui-lib/base-components/card/card.footer"
import { CardHeader } from "@/ui-lib/base-components/card/card.header"
import { Dialog, DialogPopup } from "@/ui-lib/base-components/dialog/dialog"
import { SelectDropdown } from "@/ui-lib/base-components/select-dropdown/select-dropdown"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { FormFieldErrorBlock } from "@/ui-lib/base-components/form"

import {
  DEFAULT_STRUCTURED_OUTPUT_CONFIG,
  STRUCTURED_OUTPUT_CONFIG_STRINGS,
  STRUCTURED_OUTPUT_MAX_LENGTH,
} from "./configure-dialogs.consts"
import type { StructuredOutputConfig } from "./configure-dialogs.types"
import { isValidJsonSchema } from "../../utils/json-schema-validation"

import "./structured-output-config-dialog.scss"

type StructuredOutputConfigDialogProps = {
  open: boolean
  draft: StructuredOutputConfig
  onClose: () => void
  onDraftChange: (next: Partial<StructuredOutputConfig>) => void
  onSave: () => void
}

type SchemaValidation =
  | { kind: "ok" }
  | { kind: "empty" }
  | { kind: "invalid" }

/**
 * Self-contained dialog for the create-agent form's "Structured output"
 * configure step.
 *
 * The dialog stores the draft as raw text — not a parsed object — so
 * formatting, partial keystrokes, and trailing whitespace survive
 * re-renders. Validation depends on responseFormat:
 * - text: non-empty guidelines are accepted
 * - json_object: text must parse to a valid JSON Schema object
 *   (non-array, non-null) to match backend validation.
 */
function StructuredOutputConfigDialog({
  open,
  draft = DEFAULT_STRUCTURED_OUTPUT_CONFIG,
  onClose,
  onDraftChange,
  onSave,
}: StructuredOutputConfigDialogProps): ReactElement {
  const textareaId = useId()

  const charCount = draft.schema.length
  const validation = validateSchema(draft)
  const schemaLabel =
    draft.responseFormat === "json_object"
      ? STRUCTURED_OUTPUT_CONFIG_STRINGS.SCHEMA_LABEL
      : STRUCTURED_OUTPUT_CONFIG_STRINGS.TEXT_LABEL
  const schemaPlaceholder =
    draft.responseFormat === "json_object"
      ? STRUCTURED_OUTPUT_CONFIG_STRINGS.SCHEMA_PLACEHOLDER
      : STRUCTURED_OUTPUT_CONFIG_STRINGS.TEXT_PLACEHOLDER
  const errorMessage =
    validation.kind === "empty" && draft.responseFormat === "text"
      ? STRUCTURED_OUTPUT_CONFIG_STRINGS.TEXT_REQUIRED_ERROR
      : validation.kind === "empty"
        ? STRUCTURED_OUTPUT_CONFIG_STRINGS.SCHEMA_REQUIRED_ERROR
      : validation.kind === "invalid"
        ? STRUCTURED_OUTPUT_CONFIG_STRINGS.SCHEMA_INVALID_ERROR
        : undefined

  const handleTextChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    const next = e.target.value.slice(0, STRUCTURED_OUTPUT_MAX_LENGTH)
    onDraftChange({ schema: next })
  }

  const handleResponseFormatChange = (next: unknown): void => {
    const raw = Array.isArray(next) ? next[0] : next
    const nextValue = String(raw ?? "")
    if (nextValue !== "text" && nextValue !== "json_object") return
    if (nextValue === draft.responseFormat) return
    onDraftChange({ responseFormat: nextValue })
  }

  const handleSave = (): void => {
    if (errorMessage) return
    onSave()
  }

  const handleCancel = (): void => {
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
        <Card className="structured-output-config-dialog">
          <CardHeader
            title={STRUCTURED_OUTPUT_CONFIG_STRINGS.DIALOG_TITLE}
            hasSeparator
          />

          <CardContent>
            <div className="structured-output-config-dialog__content">
              <Typography
                Component="p"
                fontSize="fs14"
                color="var(--text-secondary)"
              >
                {STRUCTURED_OUTPUT_CONFIG_STRINGS.DESCRIPTION}
              </Typography>

              <div className="structured-output-config-dialog__field">
                <SelectDropdown
                  label={STRUCTURED_OUTPUT_CONFIG_STRINGS.RESPONSE_FORMAT_LABEL}
                  value={draft.responseFormat}
                  onValueChange={handleResponseFormatChange}
                  items={[
                    {
                      key: "json_object",
                      value: "json_object",
                      label: STRUCTURED_OUTPUT_CONFIG_STRINGS.RESPONSE_FORMAT_JSON_OBJECT_OPTION,
                    },
                    {
                      key: "text",
                      value: "text",
                      label: STRUCTURED_OUTPUT_CONFIG_STRINGS.RESPONSE_FORMAT_TEXT_OPTION,
                    },
                  ]}
                />
              </div>

              <div className="structured-output-config-dialog__field">
                <Typography
                  Component="label"
                  htmlFor={textareaId}
                  fontSize="fs14"
                  boldness="semibold"
                >
                  {schemaLabel}
                </Typography>

                <textarea
                  id={textareaId}
                  className={
                    "structured-output-config-dialog__textarea" +
                    (showError ? " structured-output-config-dialog__textarea--error" : "")
                  }
                  value={draft.schema}
                  onChange={handleTextChange}
                  placeholder={schemaPlaceholder}
                  rows={200}
                  maxLength={STRUCTURED_OUTPUT_MAX_LENGTH}
                  spellCheck={false}
                  aria-label={schemaLabel}
                  aria-invalid={showError || undefined}
                />

                <div className="structured-output-config-dialog__counter-row">
                  <Typography
                    Component="span"
                    fontSize="fs13"
                    color="var(--text-secondary)"
                  >
                    {charCount}/{STRUCTURED_OUTPUT_MAX_LENGTH}
                  </Typography>
                </div>

                {showError && errorMessage && (
                  <FormFieldErrorBlock message={errorMessage} />
                )}
              </div>
            </div>
          </CardContent>

          <CardFooter
            hasSeparator
            alignment="end"
            actions={[
              {
                variant: "solid",
                label: STRUCTURED_OUTPUT_CONFIG_STRINGS.SAVE_ACTION_LABEL,
                onClick: handleSave,
              },
              {
                variant: "outline",
                label: STRUCTURED_OUTPUT_CONFIG_STRINGS.CANCEL_ACTION_LABEL,
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
 * Returns the validation kind for the current draft:
 * - text mode accepts any non-empty guidelines
 * - json_object mode requires a valid JSON Schema object
 */
function validateSchema(draft: StructuredOutputConfig): SchemaValidation {
  const trimmed = draft.schema.trim()
  if (trimmed.length === 0) return { kind: "empty" }
  if (draft.responseFormat === "text") return { kind: "ok" }
  try {
    return isValidJsonSchema(trimmed) ? { kind: "ok" } : { kind: "invalid" }
  } catch {
    return { kind: "invalid" }
  }
}

export { StructuredOutputConfigDialog }
export type { StructuredOutputConfigDialogProps }
