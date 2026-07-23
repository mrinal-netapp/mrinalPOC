import { cva } from "class-variance-authority"

const spinnerVariants = cva("spinner", {
  variants: {
    size: {
      fullScreen: "spinner-size-full-screen",
      inline: "spinner-size-inline",
      fitContent: "spinner-size-fit-content",
      cell: "spinner-size-cell",
    },
  },
  defaultVariants: {
    size: "inline",
  },
})

export { spinnerVariants }
