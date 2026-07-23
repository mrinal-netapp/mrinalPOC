import type { ReactElement } from "react"
import type { AnyFieldApi, DeepKeys } from "@tanstack/form-core"

import { SelectorWrapper } from "@/ui-lib/base-components/selector-wrapper/selector-wrapper"
import type { SelectorType } from "@/ui-lib/base-components/selector-wrapper/selector-wrapper"
import { useFormFieldContext } from "./form-field.hook"
import { FormField } from "./form-field"
import type { SelectorWrapperFieldProps } from "./form.types"

function SelectorWrapperField<
  TFormValues,
  TName extends DeepKeys<TFormValues>,
  T extends SelectorType = SelectorType,
>({
  form,
  name,
  validators,
  label,
  description,
  warning,
  isReadOnly,
  isDisabled,
  className,
  selectorType,
  selectorProps = {} as NonNullable<SelectorWrapperFieldProps<TFormValues, TName, T>["selectorProps"]>,
  onCheckedChange,
}: SelectorWrapperFieldProps<TFormValues, TName, T>): ReactElement {
  return (
    <form.Field name={name} validators={validators}>
      {(field: AnyFieldApi) => (
        <FormField
          field={field}
          warning={warning}
          isReadOnly={isReadOnly}
          isDisabled={isDisabled}
          className={className}
        >
          <SelectorWrapperFieldInner
            field={field}
            selectorType={selectorType}
            selectorProps={selectorProps}
            label={label}
            description={description}
            onCheckedChange={onCheckedChange}
          />
        </FormField>
      )}
    </form.Field>
  )
}

function SelectorWrapperFieldInner({
  field,
  selectorType,
  selectorProps,
  label,
  description,
  onCheckedChange,
}: {
  field: AnyFieldApi
  selectorType: SelectorType
  selectorProps: Record<string, unknown>
  label?: string
  description?: string
  onCheckedChange?: (checked: boolean, eventDetails: unknown) => void
}): ReactElement {
  const formField = useFormFieldContext()

  const handleCheckedChange = (checked: boolean, eventDetails: unknown): void => {
    field.handleChange(checked)
    onCheckedChange?.(checked, eventDetails)
  }

  const isReadOnly = formField?.isReadOnly
  const isDisabled = formField?.isDisabled

  const mergedSelectorProps = {
    ...selectorProps,
    checked: field.state.value as boolean,
    onCheckedChange: isReadOnly || isDisabled ? undefined : handleCheckedChange,
    isDisabled: isDisabled,
  }

  return (
    <SelectorWrapper
      selectorType={selectorType}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      selectorProps={mergedSelectorProps as any}
      isReadOnly={isReadOnly}
      label={label}
      labelBoldness="semibold"
      description={description}
    />
  )
}

export { SelectorWrapperField }
