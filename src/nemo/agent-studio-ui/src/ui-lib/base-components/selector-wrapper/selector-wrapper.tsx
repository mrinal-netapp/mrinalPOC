import { useCallback, useRef } from "react"
import type { KeyboardEvent, ReactElement } from "react"

import { cn } from "@/ui-lib/lib/utils"
import { useFormFieldContext } from "@/ui-lib/base-components/form/form-field.hook"
import { Checkbox } from "@/ui-lib/base-components/checkbox/checkbox"
import type { CheckboxProps } from "@/ui-lib/base-components/checkbox/checkbox"
import { RadioButton } from "@/ui-lib/base-components/radio-button/radio-button"
import type { RadioButtonProps } from "@/ui-lib/base-components/radio-button/radio-button"
import { Toggle } from "@/ui-lib/base-components/toggle/toggle"
import type { ToggleProps } from "@/ui-lib/base-components/toggle/toggle"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import "./selector-wrapper.scss"

type SelectorType = "checkbox" | "radioButton" | "toggle"

type SelectorSpecificProps = {
  checkbox: Omit<CheckboxProps, "className" | "ariaLabel" | "ariaLabelledBy">
  radioButton: Omit<RadioButtonProps, "className" | "ariaLabel" | "ariaLabelledBy">
  toggle: Omit<ToggleProps, "className" | "ariaLabel" | "ariaLabelledBy">
}

type SelectorWrapperBoldness = 'regular' | 'semibold'

type SelectorWrapperProps<T extends SelectorType = SelectorType> = {
  label?: string
  labelBoldness?: SelectorWrapperBoldness
  description?: string
  descriptionBoldness?: SelectorWrapperBoldness
  selectorType: T
  selectorProps: SelectorSpecificProps[T]
  isReadOnly?: boolean
  isDisabled?: boolean
  className?: string
}

function SelectorWrapper({
  label,
  labelBoldness = 'regular',
  description,
  descriptionBoldness = 'regular',
  selectorType,
  selectorProps,
  isReadOnly = false,
  isDisabled: isDisabledFromWrapper,
  className,
}: SelectorWrapperProps): ReactElement {
  const isDisabledFromSelector = Boolean(
    "isDisabled" in selectorProps && selectorProps.isDisabled,
  )
  const isDisabled = Boolean(isDisabledFromWrapper) || isDisabledFromSelector
  const selectorRef = useRef<HTMLElement>(null)
  const formField = useFormFieldContext()

  const handleLabelClick = useCallback((): void => {
    if (isReadOnly) return
    selectorRef.current?.click()
  }, [isReadOnly])

  const handleLabelKeyDown = useCallback((e: KeyboardEvent): void => {
    if (isReadOnly) return
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      selectorRef.current?.click()
    }
  }, [isReadOnly])

  return (
    <div
      className={cn(
        "selector-wrapper",
        isDisabled && "selector-wrapper--disabled",
        isReadOnly && "selector-wrapper--read-only",
        className,
      )}
      aria-describedby={formField?.hasMessage ? formField.messageId : undefined}
      aria-invalid={formField?.hasError || undefined}
      aria-readonly={isReadOnly || undefined}
    >
      <span className="selector-wrapper__selector">
        {selectorType === "checkbox" && (
          <Checkbox
            ref={selectorRef as React.RefObject<HTMLButtonElement>}
            ariaLabel={label}
            {...selectorProps as CheckboxProps}
            isDisabled={isDisabled}
          />
        )}
        {selectorType === "radioButton" && (
          <RadioButton
            ref={selectorRef as React.RefObject<HTMLSpanElement>}
            ariaLabel={label}
            {...selectorProps as RadioButtonProps}
            isDisabled={isDisabled}
          />
        )}
        {selectorType === "toggle" && (
          <Toggle
            ref={selectorRef as React.RefObject<HTMLButtonElement>}
            ariaLabel={label}
            {...selectorProps as ToggleProps}
            isDisabled={isDisabled}
          />
        )}
      </span>

      {(label || description) && (
        <span className="selector-wrapper__text">
          {label && (
            <Typography
              fontSize="fs14"
              boldness={labelBoldness}
              isDisabled={isDisabled}
              Component="span"
              role={isReadOnly ? undefined : "button"}
              tabIndex={0}
              aria-readonly={isReadOnly || undefined}
              className="selector-wrapper__label"
              onClick={handleLabelClick}
              onKeyDown={handleLabelKeyDown}
            >
              {label}
            </Typography>
          )}
          {description && (
            <Typography
              fontSize="fs14"
              boldness={descriptionBoldness}
              isDisabled={isDisabled}
              Component="span"
            >
              {description}
            </Typography>
          )}
        </span>
      )}
    </div>
  )
}

export { SelectorWrapper }
export type { SelectorWrapperProps, SelectorType, SelectorWrapperBoldness }
