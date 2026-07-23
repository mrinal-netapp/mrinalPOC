import { cva } from "class-variance-authority"

const tabVariants = cva("tab", {
  variants: {
    variant: {
      general: "tab-variant-general",
      card: "tab-variant-card",
    },
    fitting: {
      "fit-content": "tab-fitting-hug",
      "fill-container": "tab-fitting-fill",
    },
  },
  defaultVariants: {
    variant: "general",
    fitting: "fit-content",
  },
})

export { tabVariants }
