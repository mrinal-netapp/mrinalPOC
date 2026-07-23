import type { ReactElement } from "react"
import type { AnyFieldApi, DeepKeys } from "@tanstack/form-core"

import { Slider } from "@/ui-lib/base-components/slider/slider"
import { useFormFieldContext } from "./form-field.hook"
import { FormField } from "./form-field"
import type { SliderFieldInnerProps, SliderFieldProps } from "./form.types"

function SliderField<TFormValues, TName extends DeepKeys<TFormValues>>({
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
  ...sliderProps
}: SliderFieldProps<TFormValues, TName>): ReactElement {
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
          hasHtmlFor={false}
          className={className}
        >
          <SliderFieldInner field={field} sliderProps={sliderProps} />
        </FormField>
      )}
    </form.Field>
  )
}

function SliderFieldInner({
  field,
  sliderProps,
}: {
  field: AnyFieldApi
  sliderProps: SliderFieldInnerProps
}): ReactElement {
  const formField = useFormFieldContext()

  return (
    <Slider
      {...sliderProps}
      ariaLabelledBy={formField?.labelId}
      value={field.state.value as number | readonly number[]}
      onValueChange={(value: number | readonly number[]) => field.handleChange(value)}
      // Slider has no native readOnly visual — fall back to disabled appearance
      isDisabled={formField?.isDisabled || formField?.isReadOnly}
      label={undefined}
    />
  )
}

export { SliderField }
