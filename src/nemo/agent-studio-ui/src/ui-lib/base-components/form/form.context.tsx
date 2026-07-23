import { createContext } from "react"

import type { FormContextValue } from "./form.types"

const FormContext = createContext<FormContextValue>({ isReadOnly: false, isDisabled: false })

export { FormContext }
