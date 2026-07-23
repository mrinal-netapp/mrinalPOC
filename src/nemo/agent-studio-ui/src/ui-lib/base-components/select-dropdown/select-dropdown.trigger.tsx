import { Combobox as ComboboxPrimitive } from "@base-ui/react"
import { IconChevronDown } from "@tabler/icons-react"
import type { VariantProps } from "class-variance-authority"
import type { ReactElement, ReactNode } from "react"

import { cn } from "@/ui-lib/lib/utils"
import { selectDropdownVariants } from "./select-dropdown.variants"

function SelectDropdownTrigger({
  isDisabled,
  isReadOnly = false,
  className,
  placeholder = "Select...",
  variant = "field",
  renderValue,
  hideChevron = false,
  ...props
}: ComboboxPrimitive.Trigger.Props &
  VariantProps<typeof selectDropdownVariants> & {
    isDisabled?: boolean
    isReadOnly?: boolean
    placeholder?: string
    renderValue?: (value: unknown) => ReactNode
    hideChevron?: boolean
  }): ReactElement {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="select-dropdown-trigger"
      className={cn(selectDropdownVariants({ variant }), className)}
      disabled={isDisabled}
      data-readonly={isReadOnly || undefined}
      aria-readonly={isReadOnly || undefined}
      tabIndex={isReadOnly ? -1 : undefined}
      {...props}
    >
      <span className="select-dropdown-value">
        <ComboboxPrimitive.Value data-slot="select-dropdown-value" placeholder={placeholder}>
          {renderValue}
        </ComboboxPrimitive.Value>
      </span>
      {!hideChevron && <IconChevronDown className="select-dropdown-trigger-icon" />}
    </ComboboxPrimitive.Trigger>
  )
}

export { SelectDropdownTrigger }
