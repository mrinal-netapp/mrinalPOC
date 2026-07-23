import { useState } from "react"
import type { ReactElement } from "react"
import { useForm } from "@tanstack/react-form"
import { z } from "zod"

import { Button } from "@/ui-lib/base-components/button/button"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { Form } from "./form"
import { InputField } from "./form-field.input"
import { CheckboxField } from "./form-field.checkbox"
import { ToggleField } from "./form-field.toggle"
import { RadioGroupField } from "./form-field.radio-group"
import { SelectDropdownField } from "./form-field.select-dropdown"
import { SliderField } from "./form-field.slider"
import { asFormApi } from "./form.utils.demo"
import "./form.zod.demo.scss"

// -- Zod schema

const CRON_REGEX = /^([*0-9,\-/]+\s+){4}[*0-9,\-/]+$/

const fieldSchemas = {
  fullName: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().min(1, "Email is required").email("Enter a valid email address"),
  cron: z.string().min(1, "Cron expression is required").regex(CRON_REGEX, "Invalid cron — use 5 fields (min hour dom mon dow)"),
} as const

const formSchema = z.object({
  fullName: fieldSchemas.fullName,
  email: fieldSchemas.email,
  role: z.string().min(1, "Please select a role"),
  experience: z.string().min(1, "Please select an experience level"),
  cron: fieldSchemas.cron,
  teamSize: z.number().min(1).max(50),
  newsletter: z.boolean(),
  acceptTerms: z.boolean().refine((v) => v, { message: "You must accept the terms" }),
})

type FormValues = z.infer<typeof formSchema>

// -- Data

const ROLE_ITEMS = [
  { key: "developer", value: "developer", label: "Developer" },
  { key: "designer", value: "designer", label: "Designer" },
  { key: "pm", value: "pm", label: "Product Manager" },
  { key: "qa", value: "qa", label: "QA Engineer" },
  { key: "devops", value: "devops", label: "DevOps" },
]

const EXPERIENCE_OPTIONS = [
  { value: "junior", label: "Junior (0–2 yrs)" },
  { value: "mid", label: "Mid-level (3–5 yrs)" },
  { value: "senior", label: "Senior (6+ yrs)" },
]

const DEFAULT_VALUES: FormValues = {
  fullName: "",
  email: "",
  role: "",
  experience: "",
  cron: "",
  teamSize: 5,
  newsletter: true,
  acceptTerms: false,
}

// -- Component

type FormMode = "normal" | "readonly" | "disabled"

export default function ZodFormDemo(): ReactElement {
  const [formMode, setFormMode] = useState<FormMode>("normal")
  const [submittedData, setSubmittedData] = useState<FormValues | null>(null)

  const form = asFormApi(useForm({
    defaultValues: DEFAULT_VALUES,
    validators: {
      onSubmit: formSchema,
    },
    onSubmit: async ({ value }) => {
      setSubmittedData(value as FormValues)
    },
  }))

  const handleReset = (): void => {
    form.reset()
    setSubmittedData(null)
  }

  return (
    <div className="zod-demo">
      <Typography Component="h1" fontSize="fs20" boldness="semibold" className="zod-demo__title">
        Zod Schema Validation
      </Typography>
      <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)" className="zod-demo__subtitle">
        Form-level validation powered by a single Zod schema via Standard Schema.
        Errors are automatically distributed to matching fields on submit.
      </Typography>

      <div className="zod-demo__mode-toggle">
        <Button variant={formMode === "normal" ? "solid" : "outline"} label="Normal" onClick={() => setFormMode("normal")} />
        <Button variant={formMode === "readonly" ? "solid" : "outline"} label="Read Only" onClick={() => setFormMode("readonly")} />
        <Button variant={formMode === "disabled" ? "solid" : "outline"} label="Disabled" onClick={() => setFormMode("disabled")} />
      </div>

      <div className="zod-demo__body">
        <Form form={form} isReadOnly={formMode === "readonly"} isDisabled={formMode === "disabled"} className="zod-demo__form">
          {/* -- Identity */}
          <section className="zod-demo__section">
            <Typography Component="h2" fontSize="fs16" boldness="semibold" className="zod-demo__section-title">
              Identity
            </Typography>

            <div className="zod-demo__row">
              <div className="zod-demo__field">
                <InputField
                  form={form}
                  name="fullName"
                  label="Full name"
                  placeholder="Jane Doe"
                  validators={{ onBlur: fieldSchemas.fullName } as never}
                />
              </div>
              <div className="zod-demo__field">
                <InputField
                  form={form}
                  name="email"
                  label="Email"
                  type="email"
                  placeholder="jane@example.com"
                  tooltip="We'll never share your email"
                  validators={{ onBlur: fieldSchemas.email } as never}
                />
              </div>
            </div>
          </section>

          {/* -- Role & Experience */}
          <section className="zod-demo__section">
            <Typography Component="h2" fontSize="fs16" boldness="semibold" className="zod-demo__section-title">
              Role & Experience
            </Typography>

            <div className="zod-demo__row">
              <div className="zod-demo__field">
                <SelectDropdownField
                  form={form}
                  name="role"
                  label="Role"
                  items={ROLE_ITEMS}
                  placeholder="Select a role"
                  size="fill"
                />
              </div>
            </div>

            <div className="zod-demo__row">
              <div className="zod-demo__field">
                <RadioGroupField
                  form={form}
                  name="experience"
                  label="Experience level"
                  options={EXPERIENCE_OPTIONS}
                />
              </div>
            </div>
          </section>

          {/* -- Scheduling */}
          <section className="zod-demo__section">
            <Typography Component="h2" fontSize="fs16" boldness="semibold" className="zod-demo__section-title">
              Scheduling
            </Typography>

            <div className="zod-demo__row">
              <div className="zod-demo__field--wide">
                <InputField
                  form={form}
                  name="cron"
                  label="Cron expression"
                  placeholder="*/15 * * * *"
                  tooltip="5 fields: minute hour day-of-month month day-of-week"
                  validators={{ onBlur: fieldSchemas.cron } as never}
                />
              </div>
            </div>
          </section>

          {/* -- Preferences */}
          <section className="zod-demo__section">
            <Typography Component="h2" fontSize="fs16" boldness="semibold" className="zod-demo__section-title">
              Preferences
            </Typography>

            <div className="zod-demo__row">
              <div className="zod-demo__field">
                <SliderField
                  form={form}
                  name="teamSize"
                  label="Team size"
                  min={1}
                  max={50}
                  step={1}
                />
              </div>
            </div>

            <div className="zod-demo__row">
              <ToggleField
                form={form}
                name="newsletter"
                label="Subscribe to newsletter"
                description="Receive product updates and tips"
              />
            </div>
          </section>

          {/* -- Terms */}
          <section className="zod-demo__section">
            <div className="zod-demo__row">
              <CheckboxField
                form={form}
                name="acceptTerms"
                label="I accept the terms and conditions"
              />
            </div>
          </section>

          {/* -- Actions */}
          <div className="zod-demo__actions">
            <Button variant="solid" label="Submit" type="submit" />
            <Button variant="outline" label="Reset" type="button" onClick={handleReset} />
          </div>
        </Form>

        {submittedData !== null && (
          <div className="zod-demo__output">
            <Typography Component="h3" fontSize="fs14" boldness="semibold">
              Submitted Values
            </Typography>
            <pre className="zod-demo__pre">{JSON.stringify(submittedData, null, 2)}</pre>
          </div>
        )}
      </div>

      {/* -- Schema preview */}
      <hr className="zod-demo__divider" />

      <Typography Component="h2" fontSize="fs16" boldness="semibold" className="zod-demo__title">
        Schema Definition
      </Typography>
      <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)" className="zod-demo__subtitle">
        The single Zod schema that drives all validation above.
      </Typography>

      <pre className="zod-demo__schema">{`const CRON_REGEX = /^([*0-9,\\-/]+\\s+){4}[*0-9,\\-/]+$/

z.object({
  fullName:    z.string().min(2, "Name must be at least 2 characters"),
  email:       z.string().min(1, "Email is required").email("Enter a valid email address"),
  role:        z.string().min(1, "Please select a role"),
  experience:  z.string().min(1, "Please select an experience level"),
  cron:        z.string().min(1, "Required").regex(CRON_REGEX, "Invalid cron"),
  teamSize:    z.number().min(1).max(50),
  newsletter:  z.boolean(),
  acceptTerms: z.boolean().refine((v) => v, { message: "You must accept the terms" }),
})`}</pre>
    </div>
  )
}
