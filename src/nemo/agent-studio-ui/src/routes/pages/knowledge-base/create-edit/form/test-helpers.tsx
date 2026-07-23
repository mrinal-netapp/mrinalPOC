import type { ReactElement, ReactNode } from "react"
import { useForm } from "@tanstack/react-form"

import type { AnyReactFormApi } from "@/ui-lib/base-components/form/form.types"
import { Form } from "@/ui-lib/base-components/form"
import type { KBFormValues } from "./kb-form.consts"
import { buildKBDefaultValues } from "./kb-form.utils"

/**
 * Wrapper component that creates a real TanStack form and passes it
 * to children via render prop. Use this to test individual form sections
 * in isolation with a fully functional form instance.
 */
function TestFormWrapper({
  overrides = {},
  children,
}: {
  overrides?: Partial<KBFormValues>
  children: (form: AnyReactFormApi) => ReactNode
}): ReactElement {
  const defaults = { ...buildKBDefaultValues(), ...overrides }
  const form = useForm({ defaultValues: defaults }) as unknown as AnyReactFormApi

  return <Form form={form}>{children(form)}</Form>
}

export { TestFormWrapper }
