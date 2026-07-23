import type { ReactElement } from "react"
import { IconCircleX, IconAlertTriangle } from "@tabler/icons-react"

import { cn } from "@/ui-lib/lib/utils"
import type { FormFieldMessageProps } from "./form.types"

type FormFieldErrorBlockProps = {
  message: string
  id?: string
  className?: string
}

/**
 * Same visual as an error in {@link FormFieldMessage}, for use when the error
 * is not bound to a `form.Field` (e.g. form-level validation under a table).
 */
function FormFieldErrorBlock({ message, id, className }: FormFieldErrorBlockProps): ReactElement {
  return (
    <div id={id} className={cn("form-field__message", className)} aria-live="assertive">
      <div className="form-field__message--error">
        <IconCircleX size={16} className="form-field__message-icon" />
        <span className="form-field__message-label">Error:</span>
        <span className="form-field__message-text">{message}</span>
      </div>
    </div>
  )
}

function FormFieldMessage({
  errors,
  warning,
  description,
  isTouched,
  isBlurred,
  isSubmitted,
  id,
}: FormFieldMessageProps): ReactElement | null {
  const showErrors = errors.length > 0 && (isTouched || isBlurred || isSubmitted)
  const showWarning = !showErrors && warning !== undefined
  const showDescription = !showErrors && !showWarning && description !== undefined

  if (!showErrors && !showWarning && !showDescription) {
    return null
  }

  if (showErrors) {
    return <FormFieldErrorBlock id={id} message={errors[0]!} />
  }

  return (
    <div id={id} className="form-field__message" aria-live="polite">
      {showWarning && (
        <div className="form-field__message--warning">
          <IconAlertTriangle size={16} className="form-field__message-icon" />
          <span className="form-field__message-label">Warning:</span>
          <span className="form-field__message-text">{warning}</span>
        </div>
      )}

      {showDescription && (
        <div className="form-field__message--description">
          <span className="form-field__message-text">{description}</span>
        </div>
      )}
    </div>
  )
}

export { FormFieldErrorBlock, FormFieldMessage }
