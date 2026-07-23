import type { ReactElement } from "react"

import { Typography } from "@/ui-lib/base-components/typography/typography"
import type { FormFieldLabelProps } from "./form.types"

function FormFieldLabel({
  id,
  htmlFor,
  label,
  isOptional = false,
  tooltip,
  isDisabled = false,
}: FormFieldLabelProps): ReactElement {
  return (
    <div className="form-field__label-area">
      <Typography
        Component="label"
        id={id}
        htmlFor={htmlFor}
        fontSize="fs14"
        boldness="regular"
        className="form-field__label"
        isDisabled={isDisabled}
      >
        {label}
      </Typography>

      <div className="form-field__label-meta">
        {isOptional && (
          <Typography
            Component="span"
            fontSize="fs14"
            boldness="regular"
            color="var(--text-secondary)"
            className="form-field__optional"
          >
            Optional
          </Typography>
        )}
        {tooltip !== undefined && (
          <span className="form-field__tooltip-icon" data-tooltip={tooltip} aria-label={tooltip}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="8" cy="8" r="7" stroke="var(--text-secondary)" strokeWidth="1.2" />
              <text x="8" y="12" textAnchor="middle" fontSize="10" fill="var(--text-secondary)" fontFamily="var(--font-family)">i</text>
            </svg>
          </span>
        )}
      </div>
    </div>
  )
}

export { FormFieldLabel }
