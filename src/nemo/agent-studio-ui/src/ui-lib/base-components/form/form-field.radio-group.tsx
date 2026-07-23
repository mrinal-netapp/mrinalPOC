import type { ReactElement } from "react"
import type { AnyFieldApi, DeepKeys } from "@tanstack/form-core"

import { RadioGroup } from "@/ui-lib/base-components/radio-button/radio-button"
import { SelectorWrapper } from "@/ui-lib/base-components/selector-wrapper/selector-wrapper"
import { useFormFieldContext } from "./form-field.hook"
import { FormField } from "./form-field"
import type { RadioGroupFieldProps } from "./form.types"

function RadioGroupField<TFormValues, TName extends DeepKeys<TFormValues>>({
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
  options,
  min = 1,
  max = 1,
}: RadioGroupFieldProps<TFormValues, TName>): ReactElement {
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
          <RadioGroupFieldInner
            field={field}
            options={options}
            min={min}
            max={max}
          />
        </FormField>
      )}
    </form.Field>
  )
}

function RadioGroupFieldInner({
  field,
  options,
  min,
  max,
}: {
  field: AnyFieldApi
  options: RadioGroupFieldProps<unknown, never>["options"]
  min: number
  max: number
}): ReactElement {
  const formField = useFormFieldContext()
  const isReadOnly = formField?.isReadOnly
  const isDisabled = formField?.isDisabled

  return (
    <RadioGroup
      ariaLabelledBy={formField?.labelId}
      value={field.state.value as string | string[]}
      onValueChange={isReadOnly || isDisabled ? undefined : (value: string | string[]) => field.handleChange(value)}
      min={min}
      max={max}
      disabled={isDisabled}
    >
      {options.map((option) => (
        <SelectorWrapper
          key={option.value}
          selectorType="radioButton"
          selectorProps={{ value: option.value, canUnselect: max > 1 }}
          isReadOnly={isReadOnly}
          label={option.label}
          labelBoldness="semibold"
          description={option.description}
        />
      ))}
    </RadioGroup>
  )
}

export { RadioGroupField }
