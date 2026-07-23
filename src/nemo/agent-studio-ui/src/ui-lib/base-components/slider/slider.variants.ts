import { cva } from "class-variance-authority"

const sliderVariants = cva("slider", {
  variants: {
    orientation: {
      horizontal: "slider--horizontal",
      vertical: "slider--vertical",
    },
    size: {
      small: "slider--small",
      medium: "slider--medium",
    },
  },
  defaultVariants: {
    orientation: "horizontal",
    size: "medium",
  },
})

export { sliderVariants }
