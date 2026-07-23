import type { ReactElement } from "react"
import type { AnyFieldApi, DeepKeys } from "@tanstack/form-core"

import { SelectDropdown } from "@/ui-lib/base-components/select-dropdown/select-dropdown"
import type { SelectDropdownValue } from "@/ui-lib/base-components/select-dropdown/select-dropdown.types"
import { useFormFieldContext } from "./form-field.hook"
import { FormField } from "./form-field"
import type { SelectDropdownFieldInnerProps, SelectDropdownFieldProps } from "./form.types"

function SelectDropdownField<TFormValues, TName extends DeepKeys<TFormValues>>({
  form,
  name,
  validators,
  label,
  description,
  warning,
  isOptional,
  isReadOnly,
  isDisabled,
  tooltip,
  className,
  ...selectProps
}: SelectDropdownFieldProps<TFormValues, TName>): ReactElement {
  return (
    <form.Field name={name} validators={validators}>
      {(field: AnyFieldApi) => (
        <FormField
          field={field}
          label={label}
          description={description}
          warning={warning}
          isOptional={isOptional}
          isReadOnly={isReadOnly}
          isDisabled={isDisabled}
          tooltip={tooltip}
          className={className}
        >
          <SelectDropdownFieldInner field={field} selectProps={selectProps} />
        </FormField>
      )}
    </form.Field>
  )
}

function SelectDropdownFieldInner({
  field,
  selectProps,
}: {
  field: AnyFieldApi
  selectProps: SelectDropdownFieldInnerProps
}): ReactElement {
  const formField = useFormFieldContext()

  return (
    <SelectDropdown
      {...selectProps}
      id={formField?.fieldId}
      size={selectProps.size ?? "fill"}
      options={{ ...selectProps.options, isReadOnly: selectProps.options?.isReadOnly ?? formField?.isReadOnly }}
      value={field.state.value as SelectDropdownValue}
      onValueChange={(value: SelectDropdownValue) => field.handleChange(value)}
      disabled={formField?.isDisabled}
      label={undefined}
      tooltip={undefined}
      error={undefined}
      warning={undefined}
      aria-describedby={formField?.hasMessage ? formField.messageId : undefined}
      aria-invalid={formField?.hasError || undefined}
    />
  )
}

export { SelectDropdownField }
