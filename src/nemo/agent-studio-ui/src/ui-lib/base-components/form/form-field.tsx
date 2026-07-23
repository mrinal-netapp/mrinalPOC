import { useId, useMemo } from "react"
import type { ReactElement } from "react"

import { cn } from "@/ui-lib/lib/utils"
import { FormFieldContext } from "./form-field.context"
import { FormFieldLabel } from "./form-field.label"
import { FormFieldMessage } from "./form-field.message"
import { useFormContext } from "./form.hook"
import type { FormFieldContextValue, FormFieldProps } from "./form.types"

function FormField({
  field,
  label,
  description,
  warning,
  isOptional = false,
  isReadOnly,
  isDisabled,
  tooltip,
  hasHtmlFor = true,
  className,
  children,
}: FormFieldProps): ReactElement {
  const autoId = useId()
  const fieldId = `ff-${autoId}`
  const labelId = `ff-label-${autoId}`
  const messageId = `ff-msg-${autoId}`
  const formCtx = useFormContext()

  const resolvedReadOnly = isReadOnly ?? formCtx.isReadOnly
  const resolvedDisabled = isDisabled ?? formCtx.isDisabled

  const errors = field.state.meta.errors.flatMap((e: unknown) => {
    if (e == null) return []
    if (typeof e === "string") return e ? [e] : []
    if (Array.isArray(e)) return e.filter((item): item is string => typeof item === "string" && item.length > 0)
    if (typeof e === "object" && "message" in e) return [(e as { message: string }).message]
    return [String(e)]
  }).filter(Boolean)
  const hasError = errors.length > 0 && (
    field.state.meta.isTouched
    || field.state.meta.isBlurred
    || field.form.state.isSubmitted
  )
  const hasMessage = hasError || warning !== undefined || description !== undefined

  const contextValue = useMemo<FormFieldContextValue>(
    () => ({ fieldId, labelId, messageId, hasError, hasMessage, isReadOnly: resolvedReadOnly, isDisabled: resolvedDisabled }),
    [fieldId, labelId, messageId, hasError, hasMessage, resolvedReadOnly, resolvedDisabled],
  )

  return (
    <FormFieldContext.Provider value={contextValue}>
      <div
        data-slot="form-field"
        className={cn("form-field", resolvedReadOnly && "form-field--read-only", className)}
      >
        {label !== undefined && (
          <FormFieldLabel
            id={labelId}
            htmlFor={hasHtmlFor ? fieldId : undefined}
            label={label}
            isOptional={isOptional}
            tooltip={tooltip}
            isDisabled={resolvedDisabled || resolvedReadOnly}
          />
        )}

        {children}

        <FormFieldMessage
          errors={errors}
          warning={warning}
          description={description}
          isTouched={field.state.meta.isTouched}
          isBlurred={field.state.meta.isBlurred}
          isSubmitted={field.form.state.isSubmitted}
          id={messageId}
        />
      </div>
    </FormFieldContext.Provider>
  )
}

export { FormField }
