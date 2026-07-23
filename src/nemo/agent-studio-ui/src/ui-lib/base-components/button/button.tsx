import { Button as ButtonPrimitive } from "@base-ui/react/button"
import type { VariantProps } from "class-variance-authority"
import React, { type ReactNode } from "react"

import { cn } from "@/ui-lib/lib/utils"
import { Spinner } from "@/ui-lib/base-components/spinner/spinner"
import { buttonVariants } from "./button.variants"
import "./button.scss"

interface BaseButtonProps extends Omit<ButtonPrimitive.Props, "children" | "disabled"> {
  icon?: ReactNode
  iconPosition?: "left" | "right"
  loading?: boolean
  isDisabled?: boolean
  size?: VariantProps<typeof buttonVariants>["size"]
}

interface IconButtonProps extends BaseButtonProps {
  variant: "icon"
  label?: never
}

interface LabelButtonProps extends BaseButtonProps {
  variant?: Exclude<VariantProps<typeof buttonVariants>["variant"], "icon">
  label?: string
}

type ButtonProps = IconButtonProps | LabelButtonProps

function Button({
  className,
  variant,
  size,
  label,
  icon,
  iconPosition = "left",
  loading = false,
  isDisabled = false,
  ...props
}: ButtonProps): React.JSX.Element {
  const iconEl = icon !== undefined ? <span className="btn-icon">{icon}</span> : null
  const labelEl = label !== undefined ? <span className="btn-label">{label}</span> : null

  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={isDisabled || loading}
      aria-busy={loading || undefined}
      aria-label={label ?? undefined}
      {...props}
    >
      {loading ? (
        <Spinner size="inline" className="btn-spinner" />
      ) : (
        <>
          {iconPosition === "left" ? iconEl : labelEl}
          {iconPosition === "left" ? labelEl : iconEl}
        </>
      )}
    </ButtonPrimitive>
  )
}

export { Button }
export type { ButtonProps }
