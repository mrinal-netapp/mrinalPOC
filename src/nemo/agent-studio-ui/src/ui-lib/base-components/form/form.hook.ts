import { useContext } from "react"

import type { FormContextValue } from "./form.types"
import { FormContext } from "./form.context"

function useFormContext(): FormContextValue {
  return useContext(FormContext)
}

export { useFormContext }
