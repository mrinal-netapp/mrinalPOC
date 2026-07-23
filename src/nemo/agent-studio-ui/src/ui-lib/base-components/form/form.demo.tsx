import { useState } from "react"
import type { ReactElement } from "react"
import { useForm } from "@tanstack/react-form"

import { asFormApi } from "./form.utils.demo"

import { Button } from "@/ui-lib/base-components/button/button"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { Form } from "./form"
import { InputField } from "./form-field.input"
import { CheckboxField } from "./form-field.checkbox"
import { ToggleField } from "./form-field.toggle"
import { RadioGroupField } from "./form-field.radio-group"
import { SelectDropdownField } from "./form-field.select-dropdown"
import { SliderField } from "./form-field.slider"
import "./form.demo.scss"

// -- Data

const FRAMEWORK_ITEMS = [
  { key: "react", value: "react", label: "React" },
  { key: "vue", value: "vue", label: "Vue" },
  { key: "svelte", value: "svelte", label: "Svelte" },
  { key: "angular", value: "angular", label: "Angular" },
  { key: "solid", value: "solid", label: "SolidJS" },
]

const PRIORITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
]

const INTEREST_OPTIONS = [
  { value: "frontend", label: "Frontend" },
  { value: "backend", label: "Backend" },
  { value: "devops", label: "DevOps" },
  { value: "design", label: "Design" },
]

// -- Validators

function required(value: string): string | undefined {
  return value.trim() ? undefined : "This field is required"
}

function email(value: string): string | undefined {
  if (!value.trim()) return "Email is required"
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? undefined : "Enter a valid email address"
}

function mustAccept(value: boolean): string | undefined {
  return value ? undefined : "You must accept the terms"
}

function minSelection(min: number) {
  return (value: string[]): string | undefined =>
    value.length >= min ? undefined : `Select at least ${min}`
}

// -- Default values

const DEFAULT_VALUES = {
  username: "",
  email: "",
  agreedToTerms: false,
  notifications: true,
  priority: "medium",
  interests: ["frontend"] as string[],
  framework: "",
  volume: 50,
}

const OVERRIDE_DEFAULTS = {
  name: "acme-prod",
  email: "admin@acme.io",
  priority: "high",
  framework: "react",
  notifications: true,
  volume: 70,
}

// -- Component

type FormMode = "normal" | "readonly" | "disabled"

export default function FormDemo(): ReactElement {
  const [formMode, setFormMode] = useState<FormMode>("normal")
  const [submittedData, setSubmittedData] = useState<typeof DEFAULT_VALUES | null>(null)

  const form = asFormApi(useForm({
    defaultValues: DEFAULT_VALUES,
    onSubmit: async ({ value }) => {
      setSubmittedData(value)
    },
  }))

  const readOnlyForm = asFormApi(useForm({ defaultValues: OVERRIDE_DEFAULTS }))
  const editableForm = asFormApi(useForm({ defaultValues: OVERRIDE_DEFAULTS }))

  const handleReset = (): void => {
    form.reset()
    setSubmittedData(null)
  }

  return (
    <div className="form-demo">
      <Typography Component="h1" fontSize="fs20" boldness="semibold" className="form-demo__title">
        Form Field Adapters
      </Typography>
      <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)" className="form-demo__subtitle">
        All 7 pre-wired adapters with validation, submit, and reset.
      </Typography>

      <div className="form-demo__mode-toggle">
        <Button variant={formMode === "normal" ? "solid" : "outline"} label="Normal" onClick={() => setFormMode("normal")} />
        <Button variant={formMode === "readonly" ? "solid" : "outline"} label="Read Only" onClick={() => setFormMode("readonly")} />
        <Button variant={formMode === "disabled" ? "solid" : "outline"} label="Disabled" onClick={() => setFormMode("disabled")} />
      </div>

      <div className="form-demo__body">
        <Form form={form} isReadOnly={formMode === "readonly"} isDisabled={formMode === "disabled"} className="form-demo__form">
          {/* -- Text inputs */}
          <section className="form-demo__section">
            <Typography Component="h2" fontSize="fs16" boldness="semibold" className="form-demo__section-title">
              Text Inputs
            </Typography>

            <div className="form-demo__row">
              <div className="form-demo__field">
                <InputField
                  form={form}
                  name="username"
                  label="Username"
                  placeholder="Enter username"
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  validators={{ onBlur: ({ value }: { value: string }) => required(value) } as any}
                />
              </div>
              <div className="form-demo__field">
                <InputField
                  form={form}
                  name="email"
                  label="Email"
                  type="email"
                  placeholder="user@example.com"
                  tooltip="We'll never share your email"
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  validators={{ onBlur: ({ value }: { value: string }) => email(value) } as any}
                />
              </div>
            </div>
          </section>

          {/* -- Selectors */}
          <section className="form-demo__section">
            <Typography Component="h2" fontSize="fs16" boldness="semibold" className="form-demo__section-title">
              Selectors
            </Typography>

            <div className="form-demo__row">
              <CheckboxField
                form={form}
                name="agreedToTerms"
                label="I agree to the terms and conditions"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                validators={{ onSubmit: ({ value }: { value: boolean }) => mustAccept(value) } as any}
              />
            </div>
            <div className="form-demo__row">
              <ToggleField
                form={form}
                name="notifications"
                label="Enable email notifications"
                description="Receive updates about your account"
              />
            </div>
          </section>

          {/* -- Radio groups */}
          <section className="form-demo__section">
            <Typography Component="h2" fontSize="fs16" boldness="semibold" className="form-demo__section-title">
              Radio Groups
            </Typography>

            <div className="form-demo__row">
              <div className="form-demo__field">
                <RadioGroupField
                  form={form}
                  name="priority"
                  label="Priority"
                  description="Select a priority level"
                  options={PRIORITY_OPTIONS}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  validators={{ onSubmit: ({ value }: { value: string }) => required(value) } as any}
                />
              </div>
              <div className="form-demo__field">
                <RadioGroupField
                  form={form}
                  name="interests"
                  label="Interests"
                  description="Select 1–4 topics"
                  options={INTEREST_OPTIONS}
                  min={1}
                  max={4}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  validators={{ onChange: ({ value }: { value: string[] }) => minSelection(1)(value) } as any}
                />
              </div>
            </div>
          </section>

          {/* -- Dropdown */}
          <section className="form-demo__section">
            <Typography Component="h2" fontSize="fs16" boldness="semibold" className="form-demo__section-title">
              Select Dropdown
            </Typography>

            <div className="form-demo__row">
              <div className="form-demo__field">
                <SelectDropdownField
                  form={form}
                  name="framework"
                  label="Framework"
                  tooltip="Choose your preferred framework"
                  items={FRAMEWORK_ITEMS}
                  placeholder="Select a framework"
                  size="fill"
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  validators={{ onSubmit: ({ value }: { value: string }) => required(value) } as any}
                />
              </div>
            </div>
          </section>

          {/* -- Slider */}
          <section className="form-demo__section">
            <Typography Component="h2" fontSize="fs16" boldness="semibold" className="form-demo__section-title">
              Slider
            </Typography>

            <div className="form-demo__row">
              <div className="form-demo__field">
                <SliderField
                  form={form}
                  name="volume"
                  label="Volume"
                  min={0}
                  max={100}
                  step={5}
                />
              </div>
            </div>
          </section>

          {/* -- Actions */}
          <div className="form-demo__actions">
            <Button variant="solid" label="Submit" type="submit" />
            <Button variant="outline" label="Reset" type="button" onClick={handleReset} />
          </div>
        </Form>

        {/* -- Submitted data */}
        {submittedData !== null && (
          <div className="form-demo__output">
            <Typography Component="h3" fontSize="fs14" boldness="semibold">
              Submitted Values
            </Typography>
            <pre className="form-demo__pre">{JSON.stringify(submittedData, null, 2)}</pre>
          </div>
        )}
      </div>

      {/* ── Override demo 1: Form read-only, some fields editable ── */}
      <hr className="form-demo__divider" />

      <Typography Component="h2" fontSize="fs16" boldness="semibold" className="form-demo__title">
        Read-only form with per-field editable overrides
      </Typography>
      <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)" className="form-demo__subtitle">
        The form is <code>isReadOnly</code> — all fields are locked except Email and Framework which override with <code>isReadOnly=false</code>.
      </Typography>

      <Form form={readOnlyForm} isReadOnly className="form-demo__form">
        <div className="form-demo__row">
          <div className="form-demo__field">
            <InputField form={readOnlyForm} name="name" label="Name (locked)" placeholder="Name" />
          </div>
          <div className="form-demo__field">
            <InputField form={readOnlyForm} name="email" label="Email (editable override)" placeholder="user@example.com" isReadOnly={false} />
          </div>
        </div>

        <div className="form-demo__row">
          <div className="form-demo__field">
            <RadioGroupField form={readOnlyForm} name="priority" label="Priority (locked)" options={PRIORITY_OPTIONS} />
          </div>
          <div className="form-demo__field">
            <SelectDropdownField form={readOnlyForm} name="framework" label="Framework (editable override)" items={FRAMEWORK_ITEMS} placeholder="Select a framework" size="fill" isReadOnly={false} />
          </div>
        </div>

        <div className="form-demo__row">
          <ToggleField form={readOnlyForm} name="notifications" label="Notifications (locked)" />
        </div>

        <div className="form-demo__row">
          <div className="form-demo__field">
            <SliderField form={readOnlyForm} name="volume" label="Volume (locked)" min={0} max={100} step={5} />
          </div>
        </div>
      </Form>

      {/* ── Override demo 2: Form editable, some fields read-only ── */}
      <hr className="form-demo__divider" />

      <Typography Component="h2" fontSize="fs16" boldness="semibold" className="form-demo__title">
        Editable form with per-field read-only locks
      </Typography>
      <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)" className="form-demo__subtitle">
        The form is editable — all fields are interactive except Name and Priority which are individually locked with <code>isReadOnly</code>.
      </Typography>

      <Form form={editableForm} className="form-demo__form">
        <div className="form-demo__row">
          <div className="form-demo__field">
            <InputField form={editableForm} name="name" label="Name (locked)" placeholder="Name" isReadOnly />
          </div>
          <div className="form-demo__field">
            <InputField form={editableForm} name="email" label="Email (editable)" placeholder="user@example.com" />
          </div>
        </div>

        <div className="form-demo__row">
          <div className="form-demo__field">
            <RadioGroupField form={editableForm} name="priority" label="Priority (locked)" options={PRIORITY_OPTIONS} isReadOnly />
          </div>
          <div className="form-demo__field">
            <SelectDropdownField form={editableForm} name="framework" label="Framework (editable)" items={FRAMEWORK_ITEMS} placeholder="Select a framework" size="fill" />
          </div>
        </div>

        <div className="form-demo__row">
          <ToggleField form={editableForm} name="notifications" label="Notifications (editable)" />
        </div>

        <div className="form-demo__row">
          <div className="form-demo__field">
            <SliderField form={editableForm} name="volume" label="Volume (editable)" min={0} max={100} step={5} />
          </div>
        </div>
      </Form>
    </div>
  )
}
