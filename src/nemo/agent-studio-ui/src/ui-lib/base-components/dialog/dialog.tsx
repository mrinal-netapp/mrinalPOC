import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { IconX } from "@tabler/icons-react"
import React from "react"

import { cn } from "@/ui-lib/lib/utils"
import { FloatingLayerContext } from "@/ui-lib/lib/floating-layer-context"
import { Button } from "@/ui-lib/base-components/button/button"
import { dialogPopupVariants, dialogBackdropVariants } from "./dialog.variants"
import type {
  DialogProps,
  DialogTriggerProps,
  DialogPopupProps,
  DialogBackdropProps,
  DialogHeaderProps,
  DialogFooterProps,
  DialogTitleProps,
  DialogDescriptionProps,
  DialogCloseProps,
  DialogOpenChangeReason,
  DialogSize,
  DialogAnimation,
  DialogBackdropAnimation,
  DialogBackdropColor,
} from "./dialog.types"
import "./dialog.scss"

// ---------------------------------------------------------------------------
// Dialog (root)
// ---------------------------------------------------------------------------

function Dialog({
  open,
  onOpenChange,
  hasBackdrop = true,
  isDismissOnOutsideClick = true,
  isDefaultOpen = false,
  isEscapeDisabled = false,
  size = "md",
  animation = "fade",
  backdropAnimation = "fade",
  backdropColor = "default",
  handle,
  container,
  children,
}: DialogProps): React.JSX.Element {
  const handleOpenChange = React.useCallback(
    (nextOpen: boolean, eventDetails: DialogPrimitive.Root.ChangeEventDetails) => {
      if (!nextOpen && isEscapeDisabled && eventDetails.reason === "escape-key") {
        eventDetails.cancel()
        return
      }

      onOpenChange?.(
        nextOpen,
        eventDetails.event,
        eventDetails.reason as DialogOpenChangeReason | undefined,
      )
    },
    [isEscapeDisabled, onOpenChange],
  )

  const ctxValue = React.useMemo<DialogContextValue>(
    () => ({ hasBackdrop, backdropAnimation, backdropColor, size, animation, container }),
    [hasBackdrop, backdropAnimation, backdropColor, size, animation, container],
  )

  return (
    <DialogContext.Provider value={ctxValue}>
      <DialogPrimitive.Root
        open={open}
        defaultOpen={isDefaultOpen}
        modal
        onOpenChange={handleOpenChange}
        disablePointerDismissal={!isDismissOnOutsideClick}
        handle={handle}
      >
        {children}
      </DialogPrimitive.Root>
    </DialogContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Internal context — passes root-level config to child sub-components
// ---------------------------------------------------------------------------

interface DialogContextValue {
  hasBackdrop: boolean
  backdropAnimation: DialogBackdropAnimation
  backdropColor: DialogBackdropColor
  size: DialogSize
  animation: DialogAnimation
  container?: HTMLElement | null
}

const DialogContext = React.createContext<DialogContextValue>({
  hasBackdrop: true,
  backdropAnimation: "fade",
  backdropColor: "default",
  size: "md",
  animation: "fade",
  container: null,
})

function useDialogContext(): DialogContextValue {
  return React.useContext(DialogContext)
}

// ---------------------------------------------------------------------------
// DialogTrigger
// ---------------------------------------------------------------------------

function DialogTrigger({
  triggerComponent,
  variant = "solid",
  size = "large",
  label,
  icon,
  className,
}: DialogTriggerProps): React.JSX.Element {
  if (triggerComponent) {
    return (
      <DialogPrimitive.Trigger render={triggerComponent} nativeButton={false} />
    )
  }

  return (
    <DialogPrimitive.Trigger
      render={
        <Button
          variant={variant}
          size={size}
          label={label}
          icon={icon}
          className={className}
        />
      }
    />
  )
}

// ---------------------------------------------------------------------------
// DialogPopup
// ---------------------------------------------------------------------------

// Must match --zindex-dialog-floating in variables.scss
const DIALOG_FLOATING_Z_INDEX = 102

const DialogPopup = React.forwardRef<HTMLDivElement, DialogPopupProps>(
  function DialogPopup(
    { size: sizeProp, animation: animationProp, showCloseButton = true, className, style, children },
    ref,
  ) {
    const ctx = useDialogContext()
    const size = sizeProp ?? ctx.size
    const animation = animationProp ?? ctx.animation

    const portalContainer = React.useMemo(
      () => (ctx.container === undefined ? getContentContainer() : ctx.container),
      [ctx.container],
    )
    const floatingCtx = React.useMemo(() => ({ zIndex: DIALOG_FLOATING_Z_INDEX }), [])

    return (
      <DialogPrimitive.Portal container={portalContainer}>
        <DialogBackdropInner />

        <DialogPrimitive.Popup
          ref={ref}
          className={cn(dialogPopupVariants({ size, animation }), className)}
          style={style}
        >
          {showCloseButton && <DialogClose className="dialog-close--header" />}
          <FloatingLayerContext.Provider value={floatingCtx}>
            {children}
          </FloatingLayerContext.Provider>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    )
  },
)

function getContentContainer(): HTMLElement | undefined {
  if (typeof document === "undefined") {
    return undefined
  }

  return document.querySelector<HTMLElement>("[data-slot='main-content']") ?? undefined
}

// ---------------------------------------------------------------------------
// DialogBackdrop (internal — rendered inside the portal by DialogPopup)
// ---------------------------------------------------------------------------

function DialogBackdropInner(): React.JSX.Element | null {
  const { hasBackdrop, backdropAnimation, backdropColor } = useDialogContext()

  if (!hasBackdrop) {
    return null
  }

  return (
    <DialogPrimitive.Backdrop
      className={cn(dialogBackdropVariants({ animation: backdropAnimation, color: backdropColor }))}
    />
  )
}

// Public DialogBackdrop — allows standalone usage if needed
function DialogBackdrop({
  animation: animationProp,
  color: colorProp,
  className,
}: DialogBackdropProps): React.JSX.Element {
  const ctx = useDialogContext()
  const animation = animationProp ?? ctx.backdropAnimation
  const color = colorProp ?? ctx.backdropColor

  return (
    <DialogPrimitive.Backdrop
      className={cn(dialogBackdropVariants({ animation, color }), className)}
    />
  )
}

// ---------------------------------------------------------------------------
// Thin sub-components
// ---------------------------------------------------------------------------

function DialogHeader({ className, children }: DialogHeaderProps): React.JSX.Element {
  return (
    <div data-slot="dialog-header" className={cn("dialog-header", className)}>
      {children}
    </div>
  )
}

function DialogFooter({ className, children }: DialogFooterProps): React.JSX.Element {
  return (
    <div data-slot="dialog-footer" className={cn("dialog-footer", className)}>
      {children}
    </div>
  )
}

function DialogTitle({ className, children }: DialogTitleProps): React.JSX.Element {
  return (
    <DialogPrimitive.Title className={cn("dialog-title", className)}>
      {children}
    </DialogPrimitive.Title>
  )
}

function DialogDescription({ className, children }: DialogDescriptionProps): React.JSX.Element {
  return (
    <DialogPrimitive.Description className={cn("dialog-description", className)}>
      {children}
    </DialogPrimitive.Description>
  )
}

function DialogClose({ className, label }: DialogCloseProps): React.JSX.Element {
  return (
    <DialogPrimitive.Close
      render={
        <Button
          variant="icon"
          icon={<IconX size={20} />}
          className={cn("dialog-close", className)}
          aria-label={label ?? "Close dialog"}
        />
      }
    />
  )
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogBackdrop,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
}
