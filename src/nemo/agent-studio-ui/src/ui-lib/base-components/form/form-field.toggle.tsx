import type { ReactElement } from "react"
import type { DeepKeys } from "@tanstack/form-core"

import { SelectorWrapperField } from "./form-field.selector-wrapper"
import type { ToggleFieldProps } from "./form.types"

function ToggleField<TFormValues, TName extends DeepKeys<TFormValues>>({
  colorOn,
  colorOff,
  icon,
  onCheckedChange,
  ...adapterProps
}: ToggleFieldProps<TFormValues, TName>): ReactElement {
  return (
    <SelectorWrapperField<TFormValues, TName, "toggle">
      {...adapterProps}
      selectorType="toggle"
      selectorProps={{ colorOn, colorOff, icon }}
      onCheckedChange={onCheckedChange}
    />
  )
}

export { ToggleField }
