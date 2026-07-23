import type { ReactElement } from "react"
import type { DeepKeys } from "@tanstack/form-core"

import { SelectorWrapperField } from "./form-field.selector-wrapper"
import type { CheckboxFieldProps } from "./form.types"

function CheckboxField<TFormValues, TName extends DeepKeys<TFormValues>>({
  variant,
  indeterminate,
  onCheckedChange,
  ...adapterProps
}: CheckboxFieldProps<TFormValues, TName>): ReactElement {
  return (
    <SelectorWrapperField<TFormValues, TName, "checkbox">
      {...adapterProps}
      selectorType="checkbox"
      selectorProps={{ variant, indeterminate }}
      onCheckedChange={onCheckedChange}
    />
  )
}

export { CheckboxField }
