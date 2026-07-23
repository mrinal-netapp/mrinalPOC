// Barrel file — the form module has many files due to the adapter-per-control
// pattern and its generic type complexity. This index provides a single public
// entry point so consumers don't need to know the internal file layout.

// components
export { Form } from "./form"
export {
  runFormHandleSubmit,
  collectFormValidationErrors,
  collectFirstFormValidationError,
  scrollToFirstFormError,
} from "./form-submit.util"
export { FormField } from "./form-field"
export { FormFieldLabel } from "./form-field.label"
export { FormFieldErrorBlock, FormFieldMessage } from "./form-field.message"

// field adapters
export { InputField } from "./form-field.input"
export { CronExpressionField } from "./form-field.cron-expression"
export { CheckboxField } from "./form-field.checkbox"
export { ToggleField } from "./form-field.toggle"
export { RadioGroupField } from "./form-field.radio-group"
export { SelectDropdownField } from "./form-field.select-dropdown"
export { SelectorWrapperField } from "./form-field.selector-wrapper"
export { SliderField } from "./form-field.slider"

// hooks
export { useFormContext } from "./form.hook"
export { useFormFieldContext } from "./form-field.hook"

// types
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
  CronExpressionFieldInnerProps,
  CronExpressionFieldProps,
  SelectorWrapperFieldProps,
  CheckboxFieldProps,
  ToggleFieldProps,
  RadioGroupFieldOption,
  RadioGroupFieldProps,
  SelectDropdownFieldInnerProps,
  SelectDropdownFieldProps,
  SliderFieldInnerProps,
  SliderFieldProps,
} from "./form.types"
