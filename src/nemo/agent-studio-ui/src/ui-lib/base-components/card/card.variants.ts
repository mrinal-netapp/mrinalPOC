import { cva } from "class-variance-authority"

const cardBlockVariants = cva("card-block", {
  variants: {
    type: {
      "key-value": "card-block-type-key-value",
      metric: "card-block-type-metric",
      description: "card-block-type-description",
      status: "card-block-type-status",
      list: "card-block-type-list",
      "info-row": "card-block-type-info-row",
      "link-row": "card-block-type-link-row",
      progress: "card-block-type-progress",
    },
  },
})

const cardFooterVariants = cva("card-footer", {
  variants: {
    alignment: {
      start: "card-footer-alignment-start",
      center: "card-footer-alignment-center",
      end: "card-footer-alignment-end",
    },
    variant: {
      default: "card-footer--default",
      fill: "card-footer--fill",
    },
  },
  defaultVariants: {
    alignment: "end",
    variant: "default",
  },
})

export { cardBlockVariants, cardFooterVariants }
