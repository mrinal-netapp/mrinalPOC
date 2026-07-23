import { cva } from "class-variance-authority"

const chipVariants = cva("chip", {
  variants: {
    type: {
      tag: "chip--type-tag",
    },
    color: {
      tag1: "chip--color-tag1",
    },
    size: {
      regular: "chip--size-regular",
    },
  },
  defaultVariants: {
    type: "tag",
    color: "tag1",
    size: "regular",
  },
})

const chipListVariants = cva("chip-list", {
  variants: {
    orientation: {
      row: "chip-list--row",
      column: "chip-list--column",
    },
  },
  defaultVariants: {
    orientation: "row",
  },
})

export { chipVariants, chipListVariants }
