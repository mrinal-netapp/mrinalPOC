import { cva } from "class-variance-authority"

const buttonVariants = cva("btn", {
  variants: {
    variant: {
      solid: "btn-variant-solid",
      "solid-destructive": "btn-variant-solid-destructive",
      outline: "btn-variant-outline",
      flat: "btn-variant-flat",
      icon: "btn-variant-icon",
    },
    size: {
      large: "btn-size-large",
      medium: "btn-size-medium",
      small: "btn-size-small",
    },
  },
  defaultVariants: {
    variant: "solid",
    size: "large",
  },
})

export { buttonVariants }
