import { createContext } from "react"

import type { FormFieldContextValue } from "./form.types"

const FormFieldContext = createContext<FormFieldContextValue | null>(null)

export { FormFieldContext }
