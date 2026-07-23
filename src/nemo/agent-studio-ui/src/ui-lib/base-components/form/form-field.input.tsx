import type { ChangeEvent, KeyboardEvent, ReactElement } from "react"
import type { AnyFieldApi, DeepKeys } from "@tanstack/form-core"

import { Input } from "@/ui-lib/base-components/input/input"
import { useFormFieldContext } from "./form-field.hook"
import { FormField } from "./form-field"
import type { InputFieldInnerProps, InputFieldProps } from "./form.types"

function InputField<TFormValues, TName extends DeepKeys<TFormValues>>({
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
  ...inputProps
}: InputFieldProps<TFormValues, TName>): ReactElement {
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
          <InputFieldInner field={field} {...inputProps} />
        </FormField>
      )}
    </form.Field>
  )
}

function InputFieldInner({
  field,
  onKeyDown: onKeyDownProp,
  ...inputProps
}: {
  field: AnyFieldApi
} & InputFieldInnerProps): ReactElement {
  const formField = useFormFieldContext()

  // Enter → blur the current input (triggers onBlur validation) and
  // move focus to the next focusable field, mimicking Tab behaviour.
  // preventDefault stops the native <form> submit.
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault()
      const target = e.currentTarget
      target.blur()

      const focusableSelector = 'input:not([disabled]):not([type="hidden"]):not([hidden]), select:not([disabled]):not([hidden]), textarea:not([disabled]):not([hidden]), button:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"]):not([disabled]):not([hidden])'
      const form = target.closest("form")
      if (form) {
        const focusables = Array.from(form.querySelectorAll<HTMLElement>(focusableSelector))
        const currentIndex = focusables.indexOf(target)
        const next = focusables[currentIndex + 1]
        next?.focus()
      }
    }
    onKeyDownProp?.(e)
  }

  return (
    <Input
      {...inputProps}
      id={formField?.fieldId}
      value={field.state.value as string}
      onChange={(e: ChangeEvent<HTMLInputElement>) => field.handleChange(e.target.value)}
      onBlur={field.handleBlur}
      onKeyDown={handleKeyDown}
      isError={formField?.hasError}
      readOnly={formField?.isReadOnly}
      isDisabled={formField?.isDisabled}
      label={undefined}
      isOptional={undefined}
      tooltip={undefined}
    />
  )
}

export { InputField }
