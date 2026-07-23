import { cva } from "class-variance-authority"

const dialogPopupVariants = cva("dialog-popup", {
  variants: {
    size: {
      sm: "dialog-popup--size-sm",
      md: "dialog-popup--size-md",
      lg: "dialog-popup--size-lg",
      full: "dialog-popup--size-full",
    },
    animation: {
      fade: "dialog-popup--animation-fade",
      scale: "dialog-popup--animation-scale",
      slideUp: "dialog-popup--animation-slideUp",
    },
  },
  defaultVariants: {
    size: "md",
    animation: "fade",
  },
})

const dialogBackdropVariants = cva("dialog-backdrop", {
  variants: {
    animation: {
      fade: "dialog-backdrop--animation-fade",
      none: "dialog-backdrop--animation-none",
    },
    color: {
      default: "dialog-backdrop--color-default",
      none: "dialog-backdrop--color-none",
    },
  },
  defaultVariants: {
    animation: "fade",
    color: "default",
  },
})

export { dialogPopupVariants, dialogBackdropVariants }
