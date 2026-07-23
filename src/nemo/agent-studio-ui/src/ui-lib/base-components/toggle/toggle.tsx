import { Switch } from "@base-ui/react/switch"
import type { SwitchRootChangeEventDetails } from "@base-ui/react/switch"
import type { CSSProperties, ReactElement, ReactNode, Ref } from "react"

import { cn } from "@/ui-lib/lib/utils"
import "./toggle.scss"

interface ToggleProps {
  checked?: boolean
  onCheckedChange?: (checked: boolean, eventDetails: SwitchRootChangeEventDetails) => void
  colorOn?: string
  colorOff?: string
  icon?: ReactNode
  iconColorOn?: string
  iconColorOff?: string
  isDisabled?: boolean
  isWarning?: boolean
  isError?: boolean
  ariaLabel?: string
  ariaLabelledBy?: string
  className?: string
  ref?: Ref<HTMLButtonElement>
}

function Toggle({
  checked,
  onCheckedChange,
  colorOn,
  colorOff,
  icon,
  iconColorOn,
  iconColorOff,
  isDisabled = false,
  isWarning = false,
  isError = false,
  ariaLabel,
  ariaLabelledBy,
  className,
  ref,
}: ToggleProps): ReactElement {
  const style = {
    ...(colorOn && { "--toggle-color-on": colorOn }),
    ...(colorOff && { "--toggle-color-off": colorOff }),
    ...(iconColorOn && { "--toggle-icon-color-on": iconColorOn }),
    ...(iconColorOff && { "--toggle-icon-color-off": iconColorOff }),
  } as CSSProperties

  return (
    <Switch.Root
      ref={ref}
      data-slot="toggle"
      checked={checked}
      disabled={isDisabled}
      onCheckedChange={onCheckedChange}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-invalid={isError || undefined}
      className={cn(
        "toggle",
        isError && "toggle--error",
        isWarning && "toggle--warning",
        className,
      )}
      style={(colorOn || colorOff || iconColorOn || iconColorOff) ? style : undefined}
    >
      <Switch.Thumb className="toggle__thumb">
        {icon && <span className="toggle__icon">{icon}</span>}
      </Switch.Thumb>
    </Switch.Root>
  )
}

export { Toggle }
export type { ToggleProps }
