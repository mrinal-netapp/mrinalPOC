import { Input as InputPrimitive } from "@base-ui/react/input"
import type { ChangeEvent, InputHTMLAttributes, ReactElement, Ref } from "react"
import { useId, useState } from "react"

import { cn } from "@/ui-lib/lib/utils"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import "./input.scss"

type InputType = "text" | "number" | "password" | "email" | "file" | "search" | "url" | "tel"

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "defaultValue" | "disabled"> {
  type?: InputType
  value?: string
  defaultValue?: string
  label?: string
  isOptional?: boolean
  tooltip?: string
  isShowCount?: boolean
  max?: number
  multiple?: boolean
  isError?: boolean
  isWarning?: boolean
  isDisabled?: boolean
  ref?: Ref<HTMLInputElement>
}

function Input({
  type = "text",
  defaultValue,
  placeholder,
  label,
  isOptional = false,
  tooltip,
  isShowCount = false,
  max,
  isError = false,
  isWarning = false,
  isDisabled = false,
  readOnly = false,
  className,
  value,
  onChange,
  ref,
  ...props
}: InputProps): ReactElement {
  const autoId = useId()
  const inputId = props.id ?? autoId
  const isControlled = value !== undefined
  const [internalCount, setInternalCount] = useState(
    () => (defaultValue?.length ?? 0),
  )
  const charCount = isControlled ? value.length : internalCount

  const handleChange = (e: ChangeEvent<HTMLInputElement>): void => {
    if (!isControlled) setInternalCount(e.target.value.length)
    onChange?.(e)
  }

  return (
    <div className={cn("input-wrapper", className)}>
      {(label !== undefined || isOptional || tooltip !== undefined) && (
        <div className="input-wrapper__label-area">
          {label !== undefined && (
            <Typography
              Component="label"
              htmlFor={inputId}
              fontSize="fs14"
              boldness="regular"
              className="input-wrapper__label"
              isDisabled={isDisabled}
            >
              {label}
            </Typography>
          )}
          <div className="input-wrapper__label-meta">
            {isOptional && (
              <Typography
                Component="span"
                fontSize="fs14"
                boldness="regular"
                color="var(--text-secondary)"
                className="input-wrapper__optional"
              >
                Optional
              </Typography>
            )}
            {tooltip !== undefined && (
              <span className="input-wrapper__tooltip-icon" title={tooltip}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="8" cy="8" r="7" stroke="var(--text-secondary)" strokeWidth="1.2" />
                  <text x="8" y="12" textAnchor="middle" fontSize="10" fill="var(--text-secondary)" fontFamily="var(--font-family)">i</text>
                </svg>
              </span>
            )}
          </div>
        </div>
      )}

      <InputPrimitive
        ref={ref}
        id={inputId}
        type={type}
        value={value}
        defaultValue={defaultValue}
        data-slot="input"
        placeholder={placeholder}
        disabled={isDisabled}
        readOnly={readOnly}
        maxLength={max}
        max={max}
        aria-invalid={isError || undefined}
        className={cn(
          "input-field",
          isError && "error",
          isWarning && "warning",
        )}
        onChange={handleChange}
        {...props}
      />

      {isShowCount && type !== "file" && type !== "number" && (
        <div className="input-wrapper__counter">
          <Typography
            Component="span"
            fontSize="fs13"
            boldness="regular"
            className="input-wrapper__counter-text"
          >
            {max !== undefined ? `${charCount}/${max}` : charCount}
          </Typography>
        </div>
      )}
    </div>
  )
}

export { Input }
export type { InputProps }
