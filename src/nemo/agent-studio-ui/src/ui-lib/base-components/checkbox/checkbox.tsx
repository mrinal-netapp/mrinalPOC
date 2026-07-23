import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"
import type { CheckboxRootChangeEventDetails } from "@base-ui/react/checkbox"
import type { VariantProps } from "class-variance-authority"
import type { ReactElement, Ref } from "react"

import { cn } from "@/ui-lib/lib/utils"
import { checkboxVariants } from "./checkbox.variants"
import "./checkbox.scss"

interface CheckboxProps {
  checked?: boolean
  indeterminate?: boolean
  onCheckedChange?: (checked: boolean, eventDetails: CheckboxRootChangeEventDetails) => void
  variant?: VariantProps<typeof checkboxVariants>["variant"]
  isDisabled?: boolean
  isWarning?: boolean
  isError?: boolean
  ariaLabel?: string
  ariaLabelledBy?: string
  className?: string
  ref?: Ref<HTMLButtonElement>
}

function Checkbox({
  checked,
  indeterminate = false,
  onCheckedChange,
  variant,
  isDisabled = false,
  isWarning = false,
  isError = false,
  ariaLabel,
  ariaLabelledBy,
  className,
  ref,
}: CheckboxProps): ReactElement {
  return (
    <CheckboxPrimitive.Root
      ref={ref}
      data-slot="checkbox"
      checked={checked}
      indeterminate={indeterminate}
      disabled={isDisabled}
      onCheckedChange={onCheckedChange}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-invalid={isError || undefined}
      className={cn(
        checkboxVariants({ variant }),
        isError && "checkbox--error",
        isWarning && "checkbox--warning",
        className,
      )}
    >
      <CheckboxPrimitive.Indicator keepMounted className="checkbox__indicator">
        {indeterminate ? (
          <svg className="checkbox__icon" viewBox="0 0 10 2">
            <rect width="10" height="2" rx="1" />
          </svg>
        ) : (
          <svg className="checkbox__icon" viewBox="0 0 10 8">
            <path d="M1 4L3.5 6.5L9 1" />
          </svg>
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
export type { CheckboxProps }
