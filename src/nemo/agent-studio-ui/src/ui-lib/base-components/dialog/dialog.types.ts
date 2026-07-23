import type { CSSProperties, ReactElement, ReactNode } from "react"
import type { VariantProps } from "class-variance-authority"
import type { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import type { buttonVariants } from "@/ui-lib/base-components/button/button.variants"
import type { dialogPopupVariants, dialogBackdropVariants } from "./dialog.variants"

// Reason strings forwarded from base-ui's onOpenChange callback
type DialogOpenChangeReason =
  | "escape-key"
  | "outside-press"
  | "close-press"
  | "trigger-press"
  | "focus-out"

type DialogSize = NonNullable<VariantProps<typeof dialogPopupVariants>["size"]>
type DialogAnimation = NonNullable<VariantProps<typeof dialogPopupVariants>["animation"]>
type DialogBackdropAnimation = NonNullable<VariantProps<typeof dialogBackdropVariants>["animation"]>
type DialogBackdropColor = NonNullable<VariantProps<typeof dialogBackdropVariants>["color"]>

// -- Dialog (root)

interface DialogProps {
  open?: boolean
  onOpenChange?: (open: boolean, event: Event | undefined, reason: DialogOpenChangeReason | undefined) => void
  hasBackdrop?: boolean
  isDismissOnOutsideClick?: boolean
  isDefaultOpen?: boolean
  isEscapeDisabled?: boolean
  size?: DialogSize
  animation?: DialogAnimation
  backdropAnimation?: DialogBackdropAnimation
  backdropColor?: DialogBackdropColor
  handle?: DialogPrimitive.Handle<unknown>
  container?: HTMLElement | null
  children: ReactNode
}

// -- DialogTrigger

interface DialogTriggerSharedProps {
  variant?: Exclude<VariantProps<typeof buttonVariants>["variant"], "icon">
  size?: VariantProps<typeof buttonVariants>["size"]
  icon?: ReactNode
  className?: string
}

type DialogTriggerProps =
  | (DialogTriggerSharedProps & {
      triggerComponent: ReactElement
      label?: string
    })
  | (DialogTriggerSharedProps & {
      triggerComponent?: undefined
      label: string
    })

// -- DialogPopup

interface DialogPopupProps {
  size?: DialogSize
  animation?: DialogAnimation
  showCloseButton?: boolean
  className?: string
  style?: CSSProperties
  children: ReactNode
}

// -- DialogBackdrop

interface DialogBackdropProps {
  animation?: DialogBackdropAnimation
  color?: DialogBackdropColor
  className?: string
}

// -- Sub-components

interface DialogHeaderProps {
  className?: string
  children: ReactNode
}

interface DialogFooterProps {
  className?: string
  children: ReactNode
}

interface DialogTitleProps {
  className?: string
  children: ReactNode
}

interface DialogDescriptionProps {
  className?: string
  children: ReactNode
}

interface DialogCloseProps {
  className?: string
  label?: string
}

export type {
  DialogOpenChangeReason,
  DialogSize,
  DialogAnimation,
  DialogBackdropAnimation,
  DialogBackdropColor,
  DialogProps,
  DialogTriggerProps,
  DialogPopupProps,
  DialogBackdropProps,
  DialogHeaderProps,
  DialogFooterProps,
  DialogTitleProps,
  DialogDescriptionProps,
  DialogCloseProps,
}
