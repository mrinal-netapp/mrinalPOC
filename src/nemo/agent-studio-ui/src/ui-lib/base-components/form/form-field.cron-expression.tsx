import type { ChangeEvent, KeyboardEvent, ReactElement } from "react"
import type { AnyFieldApi, DeepKeys } from "@tanstack/form-core"

import { CronExpressionInput } from "@/ui-lib/base-components/cron-expression-input/cron-expression-input"
import {
  validateCronExpression,
  valueFromFieldValidatorParam,
} from "@/ui-lib/base-components/cron-expression-input/cron-expression-input.util"
import { FormField } from "./form-field"
import { useFormFieldContext } from "./form-field.hook"
import type { CronExpressionFieldInnerProps, CronExpressionFieldProps } from "./form.types"

function runCronFieldValidation(validatorParam: unknown): string | undefined {
  return validateCronExpression(valueFromFieldValidatorParam(validatorParam)) ?? undefined
}

type SingleValidatorFn = (ctx: unknown) => string | undefined;
type ValidatorFn = SingleValidatorFn | SingleValidatorFn[];
type MergedValidators = Record<string, ValidatorFn | undefined>;

// Built-in cron format checks run on blur and on submit (not on every keystroke).
// FieldAdapterBaseProps over-narrows the validators generic; cast to MergedValidators.
function mergeCronOnBlurWithUser<TFormValues, TName extends DeepKeys<TFormValues>>(
  user: CronExpressionFieldProps<TFormValues, TName>["validators"],
): MergedValidators {
  if (user == null) {
    return {
      onBlur: runCronFieldValidation,
    }
  }

  const u = user as MergedValidators
  const { onBlur: userOnBlur, onChange: userOnChange, onSubmit: userOnSubmit, ...rest } = u

  return {
    ...rest,
    onChange: (ctx: unknown) => {
      if (userOnChange == null) {
        return undefined
      }
      if (Array.isArray(userOnChange)) {
        for (const fn of userOnChange) {
          const r = fn(ctx)
          if (r) {
            return r
          }
        }
        return undefined
      }
      return userOnChange(ctx) as string | undefined
    },
    onBlur: (ctx: unknown) => {
      const builtIn = runCronFieldValidation(ctx)
      if (builtIn) {
        return builtIn
      }
      if (userOnBlur == null) {
        return undefined
      }
      if (Array.isArray(userOnBlur)) {
        for (const fn of userOnBlur) {
          const r = fn(ctx)
          if (r) {
            return r
          }
        }
        return undefined
      }
      return userOnBlur(ctx) as string | undefined
    },
    onSubmit: (ctx: unknown) => {
      const builtIn = runCronFieldValidation(ctx)
      if (builtIn) {
        return builtIn
      }
      if (userOnSubmit == null) {
        return undefined
      }
      if (Array.isArray(userOnSubmit)) {
        for (const fn of userOnSubmit) {
          const r = fn(ctx)
          if (r) {
            return r
          }
        }
        return undefined
      }
      return userOnSubmit(ctx) as string | undefined
    },
  }
}

function CronExpressionField<TFormValues, TName extends DeepKeys<TFormValues>>({
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
  ...inputRest
}: CronExpressionFieldProps<TFormValues, TName>): ReactElement {
  return (
    <form.Field name={name} validators={mergeCronOnBlurWithUser(validators)}>
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
          <CronExpressionFieldInner field={field} {...inputRest} />
        </FormField>
      )}
    </form.Field>
  )
}

function CronExpressionFieldInner({
  field,
  onKeyDown: onKeyDownProp,
  ...inputRest
}: {
  field: AnyFieldApi
} & CronExpressionFieldInnerProps): ReactElement {
  const formField = useFormFieldContext()

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault()
      const target = e.currentTarget
      target.blur()
      const focusableSelector =
        'input:not([disabled]):not([type="hidden"]):not([hidden]), select:not([disabled]):not([hidden]), textarea:not([disabled]):not([hidden]), button:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"]):not([disabled]):not([hidden])'
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

  const handleBlur = (): void => {
    // handleBlur() sets isTouched then calls validate("blur"). FieldApi.validate
    // bails with [] if isTouched is still false in the same tick (stale meta).
    // Re-run via validateField after the store has settled.
    field.handleBlur()
    const fieldName = field.name
    const form = field.form
    queueMicrotask(() => {
      void form.validateField(fieldName, "blur")
    })
  }

  return (
    <CronExpressionInput
      {...inputRest}
      id={formField?.fieldId}
      value={field.state.value as string}
      onChange={(e: ChangeEvent<HTMLInputElement>) => field.handleChange(e.target.value)}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      isError={formField?.hasError}
      readOnly={formField?.isReadOnly}
      isDisabled={formField?.isDisabled}
      aria-labelledby={formField?.labelId}
      aria-describedby={formField?.hasMessage ? formField?.messageId : undefined}
    />
  )
}

export { CronExpressionField }
