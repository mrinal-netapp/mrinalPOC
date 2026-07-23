// components
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
} from "./dialog"

// handle factory re-exported from base-ui for detached trigger support
export { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

// types
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
} from "./dialog.types"
