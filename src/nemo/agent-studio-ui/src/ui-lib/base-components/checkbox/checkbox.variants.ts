import { cva } from "class-variance-authority"

const checkboxVariants = cva("checkbox", {
  variants: {
    variant: {
      solid: "checkbox-variant-solid",
      table: "checkbox-variant-table",
    },
  },
  defaultVariants: {
    variant: "solid",
  },
})

export { checkboxVariants }
