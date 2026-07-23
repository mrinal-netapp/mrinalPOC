import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { AnyFieldApi } from "@tanstack/form-core"
import type { ReactElement, ReactNode } from "react"

import { renderWithProviders, useTestForm, userEvent } from "@test/render"

import { Form } from "./form"
import { FormField } from "./form-field"
import { FormFieldMessage } from "./form-field.message"
import { InputField } from "./form-field.input"
import { CheckboxField } from "./form-field.checkbox"

// -- Helpers

function FormTest({
  onSubmit,
  className,
  children,
}: {
  onSubmit?: () => void
  className?: string
  children?: ReactNode
}): ReactElement {
  const form = useTestForm({}, onSubmit)
  return (
    <Form form={form} className={className}>
      {children ?? <span>content</span>}
      <button type="submit">Submit</button>
    </Form>
  )
}

function FormFieldTest({
  label,
  description,
  warning,
  isOptional,
  tooltip,
  defaultValue = "",
  validateOnBlur,
  validateOnSubmit,
}: {
  label?: string
  description?: string
  warning?: string
  isOptional?: boolean
  tooltip?: string
  defaultValue?: string
  validateOnBlur?: boolean
  validateOnSubmit?: boolean
} = {}): ReactElement {
  const form = useTestForm({ test: defaultValue })

  const validators = (() => {
    if (validateOnBlur) {
      return { onBlur: ({ value }: { value: string }) => (!value ? "Required" : undefined) }
    }
    if (validateOnSubmit) {
      return { onSubmit: ({ value }: { value: string }) => (!value ? "Required" : undefined) }
    }
    return undefined
  })()

  return (
    <Form form={form}>
      <form.Field name="test" validators={validators}>
        {(field: AnyFieldApi) => (
          <FormField
            field={field}
            label={label}
            description={description}
            warning={warning}
            isOptional={isOptional}
            tooltip={tooltip}
          >
            <input
              data-testid="test-input"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
            />
          </FormField>
        )}
      </form.Field>
      <button type="submit">Submit</button>
    </Form>
  )
}

// -- Form

describe("Form", () => {
  it("[tag:form][tag:rendering] renders <form> with data-slot and noValidate", () => {
    const { container } = renderWithProviders(<FormTest />)
    const form = container.querySelector("form")
    expect(form).toBeInTheDocument()
    expect(form).toHaveAttribute("data-slot", "form")
    expect(form).toHaveAttribute("novalidate")
  })

  it("[tag:form][tag:submit] calls onSubmit when submitted", async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(<FormTest onSubmit={onSubmit} />)

    await user.click(screen.getByRole("button", { name: "Submit" }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
  })

  it("[tag:form][tag:className] forwards custom className", () => {
    const { container } = renderWithProviders(<FormTest className="my-form" />)
    expect(container.querySelector("form")).toHaveClass("form", "my-form")
  })

  it("[tag:form][tag:children] renders children inside the form", () => {
    renderWithProviders(
      <FormTest>
        <span data-testid="child">Hello</span>
      </FormTest>,
    )
    expect(screen.getByTestId("child")).toBeInTheDocument()
  })

  it("[tag:form][tag:readOnly] applies form--read-only class when isReadOnly is true", () => {
    function ReadOnlyForm(): ReactElement {
      const form = useTestForm({})
      return (
        <Form form={form} isReadOnly>
          <span>content</span>
        </Form>
      )
    }
    const { container } = renderWithProviders(<ReadOnlyForm />)
    expect(container.querySelector("form")).toHaveClass("form", "form--read-only")
  })

  it("[tag:form][tag:submit][tag:validation] submit triggers validate('submit') when canSubmit is false due to prior errors", async () => {
    const user = userEvent.setup()
    function W(): ReactElement {
      const form = useTestForm({ name: "", agree: false })
      return (
        <Form form={form}>
          <InputField
            form={form}
            name="name"
            label="Name"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            validators={{ onBlur: ({ value }: { value: string }) => (!value ? "Name is required" : undefined) } as any}
          />
          <CheckboxField form={form} name="agree" label="I agree" />
          <button type="submit">Submit</button>
        </Form>
      )
    }
    renderWithProviders(<W />)

    const input = screen.getByRole("textbox")
    await user.click(input)
    await user.tab()

    await waitFor(() => expect(screen.getByText("Name is required")).toBeInTheDocument())

    await user.click(screen.getByRole("button", { name: "Submit" }))

    await waitFor(() => expect(screen.getByText("Name is required")).toBeInTheDocument())
  })
})

// -- FormField

describe("FormField", () => {
  it("[tag:form-field][tag:rendering] renders children and no message by default", () => {
    renderWithProviders(<FormFieldTest />)
    expect(screen.getByTestId("test-input")).toBeInTheDocument()
    expect(screen.queryByText("Error:")).not.toBeInTheDocument()
  })

  it("[tag:form-field][tag:label] renders label text", () => {
    renderWithProviders(<FormFieldTest label="Username" />)
    expect(screen.getByText("Username")).toBeInTheDocument()
  })

  it("[tag:form-field][tag:optional] shows Optional when isOptional is true", () => {
    renderWithProviders(<FormFieldTest label="Email" isOptional />)
    expect(screen.getByText("Optional")).toBeInTheDocument()
  })

  it("[tag:form-field][tag:tooltip] shows tooltip icon when tooltip is provided", () => {
    const { container } = renderWithProviders(
      <FormFieldTest label="Name" tooltip="Your name" />,
    )
    const icon = container.querySelector(".form-field__tooltip-icon")
    expect(icon).toBeInTheDocument()
    expect(icon).toHaveAttribute("data-tooltip", "Your name")
    expect(icon).toHaveAttribute("aria-label", "Your name")
  })

  it("[tag:form-field][tag:error] shows error when field is touched and invalid", async () => {
    const user = userEvent.setup()
    renderWithProviders(<FormFieldTest label="Name" validateOnBlur />)

    await user.click(screen.getByTestId("test-input"))
    await user.tab()

    await waitFor(() => {
      expect(screen.getByText("Error:")).toBeInTheDocument()
      expect(screen.getByText("Required")).toBeInTheDocument()
    })
  })

  it("[tag:form-field][tag:error] shows error on submit even if not touched", async () => {
    const user = userEvent.setup()
    renderWithProviders(<FormFieldTest label="Name" validateOnSubmit />)

    await user.click(screen.getByRole("button", { name: "Submit" }))

    await waitFor(() => {
      expect(screen.getByText("Error:")).toBeInTheDocument()
      expect(screen.getByText("Required")).toBeInTheDocument()
    })
  })

  it("[tag:form-field][tag:warning] displays warning when no errors", () => {
    renderWithProviders(<FormFieldTest warning="Double check" />)
    expect(screen.getByText("Warning:")).toBeInTheDocument()
    expect(screen.getByText("Double check")).toBeInTheDocument()
  })

  it("[tag:form-field][tag:description] displays description when no errors or warnings", () => {
    renderWithProviders(<FormFieldTest description="Enter your name" />)
    expect(screen.getByText("Enter your name")).toBeInTheDocument()
  })

  it("[tag:form-field][tag:a11y] message container has aria-live polite", () => {
    const { container } = renderWithProviders(
      <FormFieldTest description="Help text" />,
    )
    expect(container.querySelector(".form-field__message")).toHaveAttribute("aria-live", "polite")
  })

  it("[tag:form-field][tag:error] does not show errors when field has errors but is untouched and unsubmitted", () => {
    const mockField = {
      state: { meta: { errors: ["Hidden error"], isTouched: false } },
      form: { state: { isSubmitted: false } },
    } as unknown as AnyFieldApi

    renderWithProviders(
      <FormField field={mockField} label="Test">
        <span>child</span>
      </FormField>,
    )

    expect(screen.queryByText("Error:")).not.toBeInTheDocument()
    expect(screen.queryByText("Hidden error")).not.toBeInTheDocument()
  })

  it("[tag:form-field][tag:readOnly] applies form-field--read-only when isReadOnly prop is set", () => {
    const mockField = {
      state: { meta: { errors: [], isTouched: false } },
      form: { state: { isSubmitted: false } },
    } as unknown as AnyFieldApi

    const { container } = renderWithProviders(
      <FormField field={mockField} label="Test" isReadOnly>
        <span>child</span>
      </FormField>,
    )
    expect(container.querySelector("[data-slot='form-field']")).toHaveClass("form-field--read-only")
  })

  it("[tag:form-field][tag:readOnly] inherits isReadOnly from Form context", () => {
    function ReadOnlyFormField(): ReactElement {
      const form = useTestForm({ test: "" })
      return (
        <Form form={form} isReadOnly>
          <form.Field name="test">
            {(field: AnyFieldApi) => (
              <FormField field={field} label="Inherited">
                <input data-testid="ro-input" readOnly value={field.state.value} />
              </FormField>
            )}
          </form.Field>
        </Form>
      )
    }
    const { container } = renderWithProviders(<ReadOnlyFormField />)
    expect(container.querySelector("[data-slot='form-field']")).toHaveClass("form-field--read-only")
  })

  it("[tag:form-field][tag:error] coerces non-string errors via String()", async () => {
    const user = userEvent.setup()
    function W(): ReactElement {
      const form = useTestForm({ test: "" })
      return (
        <Form form={form}>
          <form.Field
            name="test"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            validators={{ onBlur: ({ value }: { value: string }) => (!value ? 42 : undefined) } as any}
          >
            {(field: AnyFieldApi) => (
              <FormField field={field} label="Test">
                <input
                  data-testid="coerce-input"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                />
              </FormField>
            )}
          </form.Field>
        </Form>
      )
    }
    renderWithProviders(<W />)

    await user.click(screen.getByTestId("coerce-input"))
    await user.tab()

    await waitFor(() => {
      expect(screen.getByText("42")).toBeInTheDocument()
    })
  })

  it("[tag:form-field][tag:error] handles error objects with { message } property", () => {
    const mockField = {
      state: { meta: { errors: [{ message: "Object error" }], isTouched: true } },
      form: { state: { isSubmitted: false } },
    } as unknown as AnyFieldApi

    renderWithProviders(
      <FormField field={mockField} label="Test">
        <span>child</span>
      </FormField>,
    )

    expect(screen.getByText("Error:")).toBeInTheDocument()
    expect(screen.getByText("Object error")).toBeInTheDocument()
  })

  it("[tag:form-field][tag:error] filters out empty string errors via flatMap", () => {
    const mockField = {
      state: { meta: { errors: ["", "Real error"], isTouched: true } },
      form: { state: { isSubmitted: false } },
    } as unknown as AnyFieldApi

    renderWithProviders(
      <FormField field={mockField} label="Test">
        <span>child</span>
      </FormField>,
    )

    expect(screen.getByText("Error:")).toBeInTheDocument()
    expect(screen.getByText("Real error")).toBeInTheDocument()
  })

  it("[tag:form-field][tag:error] shows no error when all errors are empty strings", () => {
    const mockField = {
      state: { meta: { errors: ["", ""], isTouched: true } },
      form: { state: { isSubmitted: false } },
    } as unknown as AnyFieldApi

    renderWithProviders(
      <FormField field={mockField} label="Test">
        <span>child</span>
      </FormField>,
    )

    expect(screen.queryByText("Error:")).not.toBeInTheDocument()
  })

  it("[tag:form-field][tag:error] silently drops null errors", () => {
    const mockField = {
      state: { meta: { errors: [null, "Valid error"], isTouched: true } },
      form: { state: { isSubmitted: false } },
    } as unknown as AnyFieldApi

    renderWithProviders(
      <FormField field={mockField} label="Test">
        <span>child</span>
      </FormField>,
    )

    expect(screen.getByText("Error:")).toBeInTheDocument()
    expect(screen.getByText("Valid error")).toBeInTheDocument()
    expect(screen.queryByText("null")).not.toBeInTheDocument()
  })

  it("[tag:form-field][tag:error] silently drops undefined errors", () => {
    const mockField = {
      state: { meta: { errors: [undefined, "Valid error"], isTouched: true } },
      form: { state: { isSubmitted: false } },
    } as unknown as AnyFieldApi

    renderWithProviders(
      <FormField field={mockField} label="Test">
        <span>child</span>
      </FormField>,
    )

    expect(screen.getByText("Error:")).toBeInTheDocument()
    expect(screen.getByText("Valid error")).toBeInTheDocument()
    expect(screen.queryByText("undefined")).not.toBeInTheDocument()
  })

  it("[tag:form-field][tag:error] shows no error when all entries are null or undefined", () => {
    const mockField = {
      state: { meta: { errors: [null, undefined], isTouched: true } },
      form: { state: { isSubmitted: false } },
    } as unknown as AnyFieldApi

    renderWithProviders(
      <FormField field={mockField} label="Test">
        <span>child</span>
      </FormField>,
    )

    expect(screen.queryByText("Error:")).not.toBeInTheDocument()
  })

  it("[tag:form-field][tag:error] flattens string[] errors without joining them", () => {
    const mockField = {
      state: { meta: { errors: [["First error", "Second error"]], isTouched: true } },
      form: { state: { isSubmitted: false } },
    } as unknown as AnyFieldApi

    renderWithProviders(
      <FormField field={mockField} label="Test">
        <span>child</span>
      </FormField>,
    )

    expect(screen.getByText("Error:")).toBeInTheDocument()
    expect(screen.getByText("First error")).toBeInTheDocument()
    expect(screen.queryByText("First error,Second error")).not.toBeInTheDocument()
  })

  it("[tag:form-field][tag:error] filters empty strings within string[] errors", () => {
    const mockField = {
      state: { meta: { errors: [["", "Only valid"]], isTouched: true } },
      form: { state: { isSubmitted: false } },
    } as unknown as AnyFieldApi

    renderWithProviders(
      <FormField field={mockField} label="Test">
        <span>child</span>
      </FormField>,
    )

    expect(screen.getByText("Error:")).toBeInTheDocument()
    expect(screen.getByText("Only valid")).toBeInTheDocument()
  })

  it("[tag:form-field][tag:error] does not spread a string into individual characters", () => {
    const mockField = {
      state: { meta: { errors: ["Required"], isTouched: true } },
      form: { state: { isSubmitted: false } },
    } as unknown as AnyFieldApi

    renderWithProviders(
      <FormField field={mockField} label="Test">
        <span>child</span>
      </FormField>,
    )

    expect(screen.getByText("Required")).toBeInTheDocument()
    expect(screen.queryByText("R")).not.toBeInTheDocument()
  })

  it("[tag:form-field][tag:no-label] omits label area when label is undefined", () => {
    const mockField = {
      state: { meta: { errors: [], isTouched: false } },
      form: { state: { isSubmitted: false } },
    } as unknown as AnyFieldApi

    const { container } = renderWithProviders(
      <FormField field={mockField}>
        <span>child</span>
      </FormField>,
    )

    expect(container.querySelector(".form-field__label-area")).not.toBeInTheDocument()
  })
})

// -- FormFieldMessage

describe("FormFieldMessage", () => {
  it("[tag:form-field][tag:message] returns null when errors exist but field is untouched and form is not submitted", () => {
    const { container } = renderWithProviders(
      <FormFieldMessage
        errors={["Some error"]}
        warning={undefined}
        description={undefined}
        isTouched={false}
        isBlurred={false}
        isSubmitted={false}
        id="test-msg"
      />,
    )
    expect(container.querySelector(".form-field__message")).not.toBeInTheDocument()
  })
})
