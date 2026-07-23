import { cva } from "class-variance-authority"

const typographyVariants = cva("typography", {
  variants: {
    fontSize: {
      fs12: "typography--12",
      fs13: "typography--13",
      fs14: "typography--14",
      fs16: "typography--16",
      fs20: "typography--20",
      fs24: "typography--24",
      fs32: "typography--32",
      fs40: "typography--40",
    },
    boldness: {
      regular: "typography--regular",
      semibold: "typography--semibold",
    },
    fontFamily: {
      regular: null,
      monospace: "typography--monospace",
    },
  },
  defaultVariants: {
    fontSize: "fs16",
    boldness: "regular",
    fontFamily: "regular",
  },
});

export { typographyVariants };
