import { cva } from "class-variance-authority"

const selectDropdownVariants = cva("select-dropdown-trigger", {
  variants: {
    variant: {
      field: "select-dropdown-trigger--field",
      underline: "select-dropdown-trigger--underline",
    },
  },
  defaultVariants: {
    variant: "field",
  },
})

const selectDropdownWrapperVariants = cva("select-dropdown-wrapper", {
  variants: {
    size: {
      fill: "",
      small: "select-dropdown-wrapper--small",
      medium: "select-dropdown-wrapper--medium",
      large: "select-dropdown-wrapper--large",
    },
  },
  defaultVariants: {
    size: "medium",
  },
})

export { selectDropdownVariants, selectDropdownWrapperVariants }
