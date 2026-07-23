import { useMemo } from "react"
import type { FormEvent, ReactElement } from "react"

import { cn } from "@/ui-lib/lib/utils"
import { FormContext } from "./form.context"
import type { FormContextValue, FormProps } from "./form.types"
import { runFormHandleSubmit } from "./form-submit.util"
import "./form.scss"

function Form({ form, isReadOnly = false, isDisabled = false, className, children }: FormProps): ReactElement {
  const handleSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    try {
      await runFormHandleSubmit(form)
    } catch { /* handled by the form's onSubmit */ }
  }

  const contextValue = useMemo<FormContextValue>(
    () => ({ isReadOnly, isDisabled }),
    [isReadOnly, isDisabled],
  )

  return (
    <FormContext.Provider value={contextValue}>
      <form
        data-slot="form"
        noValidate
        onSubmit={handleSubmit}
        className={cn("form", isReadOnly && "form--read-only", className)}
      >
        {children}
      </form>
    </FormContext.Provider>
  )
}

export { Form }
