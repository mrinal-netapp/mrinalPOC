import { useContext } from "react"

import type { FormFieldContextValue } from "./form.types"
import { FormFieldContext } from "./form-field.context"

// Returns null when used outside a FormField — safe for standalone base components
// (e.g. SelectorWrapper) that optionally integrate with the form system.
function useFormFieldContext(): FormFieldContextValue | null {
  return useContext(FormFieldContext)
}

export { useFormFieldContext }
