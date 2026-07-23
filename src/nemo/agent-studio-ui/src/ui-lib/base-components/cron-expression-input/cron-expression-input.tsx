import type { ChangeEvent, KeyboardEvent, ReactElement } from "react"

import { cn } from "@/ui-lib/lib/utils"
import { Input } from "@/ui-lib/base-components/input/input"
import type { InputProps } from "@/ui-lib/base-components/input/input"

import "./cron-expression-input.scss"

type CronExpressionOmitted =
  | "value"
  | "onChange"
  | "onBlur"
  | "isError"
  | "label"
  | "isOptional"
  | "tooltip"
  | "form"
  | "name"

type CronExpressionInputRestProps = Omit<InputProps, CronExpressionOmitted>

type CronExpressionInputProps = CronExpressionInputRestProps & {
  value: string
  onChange: (e: ChangeEvent<HTMLInputElement>) => void
  onBlur: () => void
  isError?: boolean
  id?: string
  readOnly?: boolean
  isDisabled?: boolean
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void
}

function CronExpressionInput({
  className,
  onKeyDown: onKeyDownProp,
  value,
  onChange,
  onBlur,
  isError,
  id,
  readOnly,
  isDisabled,
  type = "text",
  autoComplete = "off",
  spellCheck = false,
  ...rest
}: CronExpressionInputProps): ReactElement {
  return (
    <Input
      {...rest}
      type={type}
      className={cn("cron-expression-input", className)}
      value={value}
      onChange={onChange}
      onBlur={onBlur}
      isError={isError}
      id={id}
      readOnly={readOnly}
      isDisabled={isDisabled}
      onKeyDown={onKeyDownProp}
      autoComplete={autoComplete}
      spellCheck={spellCheck}
      label={undefined}
      isOptional={undefined}
      tooltip={undefined}
    />
  )
}

export { CronExpressionInput }
export type { CronExpressionInputProps, CronExpressionOmitted, CronExpressionInputRestProps }
