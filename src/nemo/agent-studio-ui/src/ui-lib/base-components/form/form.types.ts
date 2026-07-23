import type { ReactNode } from "react"
import type { AnyFieldApi, DeepKeys, DeepValue, FieldAsyncValidateOrFn, FieldValidateOrFn, FieldValidators } from "@tanstack/form-core"
import type { ReactFormExtendedApi } from "@tanstack/react-form"

import type { CronExpressionInputRestProps } from "@/ui-lib/base-components/cron-expression-input/cron-expression-input"
import type { InputProps } from "@/ui-lib/base-components/input/input"
import type { SliderProps } from "@/ui-lib/base-components/slider/slider"
import type { SelectDropdownProps } from "@/ui-lib/base-components/select-dropdown/select-dropdown.types"
import type { SelectorType, SelectorWrapperProps } from "@/ui-lib/base-components/selector-wrapper/selector-wrapper"

/**
 * Convenience alias for a React form instance with .Field, .Subscribe, etc.
 * All generics are relaxed to `any` so layout components don't need to
 * thread the full 12-param generic chain.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyReactFormApi = ReactFormExtendedApi<any, any, any, any, any, any, any, any, any, any, any, any>

// -- Form

interface FormContextValue {
  isReadOnly: boolean
  isDisabled: boolean
}

interface FormProps {
  form: AnyReactFormApi
  isReadOnly?: boolean
  isDisabled?: boolean
  className?: string
  children: ReactNode
}

// -- FormField (layout wrapper)

interface FormFieldProps {
  field: AnyFieldApi
  label?: string
  description?: string
  warning?: string
  isOptional?: boolean
  isReadOnly?: boolean
  isDisabled?: boolean
  tooltip?: string
  /** Set to false for controls that are not native labelable elements (e.g. sliders).
   *  Omits htmlFor from the label so the browser doesn't raise an a11y warning,
   *  while aria-labelledby on the control continues to work for screen readers. */
  hasHtmlFor?: boolean
  className?: string
  children: ReactNode
}

// -- FormField sub-components

interface FormFieldContextValue {
  fieldId: string
  labelId: string
  messageId: string
  hasError: boolean
  hasMessage: boolean
  isReadOnly: boolean
  isDisabled: boolean
}

interface FormFieldMessageProps {
  errors: string[]
  warning?: string
  description?: string
  isTouched: boolean
  /** Shown with errors as soon as the user blurs, even if `isTouched` lags a frame. */
  isBlurred: boolean
  isSubmitted: boolean
  id: string
}

interface FormFieldLabelProps {
  id: string
  htmlFor?: string
  label: string
  isOptional?: boolean
  tooltip?: string
  isDisabled?: boolean
}

// -- Field Adapters

/**
 * Shared layout props that every field adapter accepts.
 * These get forwarded to `<FormField />` for label/message rendering.
 */
interface FieldAdapterLayoutProps {
  label?: string
  description?: string
  warning?: string
  isOptional?: boolean
  isReadOnly?: boolean
  isDisabled?: boolean
  tooltip?: string
  className?: string
}

/**
 * Base adapter props generic over form data shape and field name.
 * `TExtra` represents the base component's own props with auto-wired
 * props (value, onChange, etc.) omitted.
 */
type FieldAdapterBaseProps<
  TFormValues,
  TName extends DeepKeys<TFormValues>,
> = FieldAdapterLayoutProps & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  form: ReactFormExtendedApi<TFormValues, any, any, any, any, any, any, any, any, any, any, any>
  name: TName
  validators?: FieldValidators<
    TFormValues, TName, DeepValue<TFormValues, TName>,
    undefined | FieldValidateOrFn<TFormValues, TName, DeepValue<TFormValues, TName>>,
    undefined | FieldValidateOrFn<TFormValues, TName, DeepValue<TFormValues, TName>>,
    undefined | FieldAsyncValidateOrFn<TFormValues, TName, DeepValue<TFormValues, TName>>,
    undefined | FieldValidateOrFn<TFormValues, TName, DeepValue<TFormValues, TName>>,
    undefined | FieldAsyncValidateOrFn<TFormValues, TName, DeepValue<TFormValues, TName>>,
    undefined | FieldValidateOrFn<TFormValues, TName, DeepValue<TFormValues, TName>>,
    undefined | FieldAsyncValidateOrFn<TFormValues, TName, DeepValue<TFormValues, TName>>,
    undefined | FieldValidateOrFn<TFormValues, TName, DeepValue<TFormValues, TName>>,
    undefined | FieldAsyncValidateOrFn<TFormValues, TName, DeepValue<TFormValues, TName>>
  >
}

type FieldAdapterProps<
  TFormValues,
  TName extends DeepKeys<TFormValues>,
  TExtra extends object = object,
> = FieldAdapterBaseProps<TFormValues, TName> & TExtra

// -- Adapter-specific prop types

type InputFieldOmitted = "value" | "onChange" | "onBlur" | "isError" | "label" | "isOptional" | "tooltip" | "form" | "name"
type InputFieldInnerProps = Omit<InputProps, InputFieldOmitted>
type InputFieldProps<TFormValues, TName extends DeepKeys<TFormValues>> =
  FieldAdapterProps<TFormValues, TName, InputFieldInnerProps>

type CronExpressionFieldInnerProps = CronExpressionInputRestProps
type CronExpressionFieldProps<TFormValues, TName extends DeepKeys<TFormValues>> =
  FieldAdapterProps<TFormValues, TName, CronExpressionFieldInnerProps>

type SelectorFieldAdapterProps<
  TFormValues,
  TName extends DeepKeys<TFormValues>,
> = Omit<FieldAdapterBaseProps<TFormValues, TName>, "isOptional" | "tooltip">

type SelectorWrapperFieldProps<
  TFormValues,
  TName extends DeepKeys<TFormValues>,
  T extends SelectorType = SelectorType,
> = SelectorFieldAdapterProps<TFormValues, TName> & {
  selectorType: T
  selectorProps?: Omit<SelectorWrapperProps<T>["selectorProps"], "checked" | "onCheckedChange" | "value">
  onCheckedChange?: (checked: boolean, eventDetails: unknown) => void
}

type CheckboxFieldProps<TFormValues, TName extends DeepKeys<TFormValues>> =
  SelectorFieldAdapterProps<TFormValues, TName> & {
    variant?: SelectorWrapperProps<"checkbox">["selectorProps"] extends { variant?: infer V } ? V : never
    indeterminate?: boolean
    onCheckedChange?: (checked: boolean, eventDetails: unknown) => void
  }

type ToggleFieldProps<TFormValues, TName extends DeepKeys<TFormValues>> =
  SelectorFieldAdapterProps<TFormValues, TName> & {
    colorOn?: string
    colorOff?: string
    icon?: ReactNode
    onCheckedChange?: (checked: boolean, eventDetails: unknown) => void
  }

interface RadioGroupFieldOption {
  value: string
  label?: string
  description?: string
}

type RadioGroupFieldProps<TFormValues, TName extends DeepKeys<TFormValues>> =
  FieldAdapterProps<TFormValues, TName> & {
    options: RadioGroupFieldOption[]
    min?: number
    max?: number
  }

type SelectDropdownFieldOmitted = "value" | "defaultValue" | "onValueChange" | "label" | "tooltip" | "error" | "warning"
type SelectDropdownFieldInnerProps = Omit<SelectDropdownProps, SelectDropdownFieldOmitted>
type SelectDropdownFieldProps<TFormValues, TName extends DeepKeys<TFormValues>> =
  FieldAdapterProps<TFormValues, TName, SelectDropdownFieldInnerProps>

type SliderFieldOmitted = "value" | "defaultValue" | "onValueChange" | "label"
type SliderFieldInnerProps = Omit<SliderProps, SliderFieldOmitted>
type SliderFieldProps<TFormValues, TName extends DeepKeys<TFormValues>> =
  FieldAdapterProps<TFormValues, TName, SliderFieldInnerProps>

export type {
  AnyReactFormApi,
  FormContextValue,
  FormProps,
  FormFieldProps,
  FormFieldContextValue,
  FormFieldMessageProps,
  FormFieldLabelProps,
  FieldAdapterLayoutProps,
  FieldAdapterProps,
  InputFieldInnerProps,
  InputFieldProps,
  SelectorFieldAdapterProps,
  SelectorWrapperFieldProps,
  CheckboxFieldProps,
  ToggleFieldProps,
  RadioGroupFieldOption,
  RadioGroupFieldProps,
  SelectDropdownFieldInnerProps,
  SelectDropdownFieldProps,
  SliderFieldInnerProps,
  SliderFieldProps,
  CronExpressionFieldInnerProps,
  CronExpressionFieldProps,
}
