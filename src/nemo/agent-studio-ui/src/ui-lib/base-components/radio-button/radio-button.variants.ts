import { cva } from "class-variance-authority"

const radioButtonVariants = cva("radio-button", {
  variants: {
    variant: {
      solid: "radio-button-variant-solid",
      table: "radio-button-variant-table",
    },
  },
  defaultVariants: {
    variant: "solid",
  },
})

export { radioButtonVariants }
