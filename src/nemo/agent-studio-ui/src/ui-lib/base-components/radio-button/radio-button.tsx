import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react"
import type { VariantProps } from "class-variance-authority"
import type { KeyboardEvent, ReactElement, ReactNode, Ref } from "react"

import { cn } from "@/ui-lib/lib/utils"
import { radioButtonVariants } from "./radio-button.variants"
import "./radio-button.scss"

// Base UI ships @base-ui/react/radio, but its RadioGroup enforces strict
// single-select semantics. Our design requires a configurable min/max selection
// model (multi-select radio groups), so we implement the group logic manually
// while keeping WAI-ARIA radio role compliance.

// -- Context

interface RadioGroupContextValue {
  selectedValues: string[]
  toggle: (value: string, canUnselect: boolean) => void
  isGroupDisabled: boolean
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null)

// -- RadioButton

interface RadioButtonProps {
  value: string
  variant?: VariantProps<typeof radioButtonVariants>["variant"]
  isDisabled?: boolean
  isWarning?: boolean
  isError?: boolean
  canUnselect?: boolean
  ariaLabel?: string
  ariaLabelledBy?: string
  className?: string
  ref?: Ref<HTMLSpanElement>
}

function RadioButton({
  value,
  variant,
  isDisabled = false,
  isWarning = false,
  isError = false,
  canUnselect = false,
  ariaLabel,
  ariaLabelledBy,
  className,
  ref,
}: RadioButtonProps): ReactElement {
  const group = useContext(RadioGroupContext)
  const isChecked = group?.selectedValues.includes(value) ?? false
  const disabled = isDisabled || (group?.isGroupDisabled ?? false)

  const handleClick = (): void => {
    if (disabled) return
    group?.toggle(value, canUnselect)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLSpanElement>): void => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault()
      handleClick()
    }
  }

  return (
    <span
      ref={ref}
      role="radio"
      aria-checked={isChecked}
      aria-disabled={disabled || undefined}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-invalid={isError || undefined}
      tabIndex={disabled ? -1 : 0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      data-slot="radio-button"
      {...(isChecked && { "data-checked": "" })}
      {...(disabled && { "data-disabled": "" })}
      className={cn(
        radioButtonVariants({ variant }),
        isError && "radio-button--error",
        isWarning && "radio-button--warning",
        className,
      )}
    >
      <span
        className="radio-button__indicator"
        {...(isChecked && { "data-checked": "" })}
      />
    </span>
  )
}

// -- RadioGroup

interface RadioGroupProps {
  /** Applied to the radiogroup container for DOM targeting. */
  id?: string
  /** Controlled selected value(s). String when max=1, string[] when max>1. */
  value?: string | string[]
  defaultValue?: string | string[]
  onValueChange?: (value: string | string[]) => void
  /** Minimum number of selected items. @default 1 */
  min?: number
  /** Maximum number of selected items. @default 1 */
  max?: number
  disabled?: boolean
  ariaLabel?: string
  ariaLabelledBy?: string
  children: ReactNode
  className?: string
}

function normalizeToArray(val?: string | string[]): string[] {
  if (val === undefined || val === "") return []
  return Array.isArray(val) ? val : [val]
}

function RadioGroup({
  id,
  value,
  defaultValue,
  onValueChange,
  min = 1,
  max = 1,
  disabled = false,
  ariaLabel,
  ariaLabelledBy,
  children,
  className,
}: RadioGroupProps): ReactElement {
  const [internalValues, setInternalValues] = useState<string[]>(() =>
    normalizeToArray(defaultValue),
  )

  const selectedValues =
    value !== undefined ? normalizeToArray(value) : internalValues

  const toggle = useCallback(
    (val: string, canUnselect: boolean): void => {
      const isSelected = selectedValues.includes(val)
      let next: string[]

      if (isSelected) {
        if (!canUnselect || selectedValues.length <= min) return
        next = selectedValues.filter((v) => v !== val)
      } else if (max === 1) {
        // Standard radio: replace current selection
        next = [val]
      } else if (selectedValues.length >= max) {
        return
      } else {
        next = [...selectedValues, val]
      }

      if (value === undefined) setInternalValues(next)
      onValueChange?.(max === 1 ? next[0] ?? "" : next)
    },
    [selectedValues, min, max, value, onValueChange],
  )

  const ctx = useMemo<RadioGroupContextValue>(
    () => ({ selectedValues, toggle, isGroupDisabled: disabled }),
    [selectedValues, toggle, disabled],
  )

  return (
    <RadioGroupContext.Provider value={ctx}>
      <div id={id} role="radiogroup" aria-label={ariaLabel} aria-labelledby={ariaLabelledBy} className={cn("radio-group", className)}>
        {children}
      </div>
    </RadioGroupContext.Provider>
  )
}

export { RadioButton, RadioGroup }
export type { RadioButtonProps, RadioGroupProps }
