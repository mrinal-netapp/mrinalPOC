import React from "react"
import { useForm } from "@tanstack/react-form"

import { Button } from "@/ui-lib/base-components/button/button"
import { CardHeader } from "@/ui-lib/base-components/card/card.header"
import { CardFooter } from "@/ui-lib/base-components/card/card.footer"
import { CardContent } from "@/ui-lib/base-components/card/card.content"
import { Card } from "@/ui-lib/base-components/card/card"
import {
  CardBlock,
  CardBlockLabel,
  CardBlockValue,
} from "@/ui-lib/base-components/card/card.block"
import { Form, InputField, RadioGroupField, CheckboxField, SliderField } from "@/ui-lib/base-components/form"
import { SelectDropdown } from "@/ui-lib/base-components/select-dropdown/select-dropdown"
import type { SelectDropdownValue } from "@/ui-lib/base-components/select-dropdown/select-dropdown.types"
import { asFormApi } from "@/ui-lib/base-components/form/form.utils.demo"
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogPrimitive,
} from "./index"
import type { DialogAnimation, DialogBackdropAnimation, DialogBackdropColor } from "./dialog.types"
import "./dialog.demo.scss"

export default function DialogDemo(): React.JSX.Element {
  return (
    <div className="dialog-demo">
      <h1 className="dialog-demo__title">Dialog Component</h1>

      <BasicDialog />
      <MultiTriggerDialog />
      <DetachedTriggerDialog />
      <NestedDialogs />
      <AlertDialog />
      <ControlledDialog />
      <FormPageDemo />
      <AnimationVariants />
      <SizeVariants />
      <CustomTriggerDialog />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Basic
// ---------------------------------------------------------------------------

function BasicDialog(): React.JSX.Element {
  return (
    <section className="dialog-demo__section">
      <h2 className="dialog-demo__section-title">Basic Dialog</h2>
      <p className="dialog-demo__section-desc">
        Default button trigger, title, description, and close button.
      </p>
      <Dialog>
        <DialogTrigger label="Open basic dialog" />
        <DialogPopup>
          <Card>
            <CardHeader
              title="Basic Dialog"
              subtitle="This is a basic dialog with a title, description, and close button."
              hasSeparator
            />
            <CardContent>
              <CardBlock type="key-value" hasSeparator>
                <CardBlockLabel>Status</CardBlockLabel>
                <CardBlockValue>Active</CardBlockValue>
              </CardBlock>
              <CardBlock type="key-value" hasSeparator>
                <CardBlockLabel>Environment</CardBlockLabel>
                <CardBlockValue>Production</CardBlockValue>
              </CardBlock>
              <CardBlock type="description">
                <CardBlockLabel>
                  This is a basic dialog demonstrating how Card blocks render inside a dialog popup.
                </CardBlockLabel>
              </CardBlock>
            </CardContent>
            <CardFooter hasSeparator>
              <DialogPrimitive.Close render={<Button variant="outline" size="medium" label="Close" />} />
              <Button variant="solid" size="medium" label="Confirm" />
            </CardFooter>
          </Card>
        </DialogPopup>
      </Dialog>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Multi-trigger
// ---------------------------------------------------------------------------

function MultiTriggerDialog(): React.JSX.Element {
  return (
    <section className="dialog-demo__section">
      <h2 className="dialog-demo__section-title">Multi-trigger</h2>
      <p className="dialog-demo__section-desc">
        Two triggers share one dialog. Press <strong>Escape</strong> to close — no X button or outside click.
      </p>
      <Dialog isDismissOnOutsideClick={false}>
        <div className="dialog-demo__row">
          <DialogTrigger label="Trigger A" variant="solid" />
          <DialogTrigger label="Trigger B" variant="outline" />
        </div>
        <DialogPopup showCloseButton={false}>
          <CardHeader
            title="Shared Dialog"
            subtitle="Press Escape to dismiss this dialog."
          />
        </DialogPopup>
      </Dialog>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Detached trigger
// ---------------------------------------------------------------------------

function DetachedTriggerDialog(): React.JSX.Element {
  const handle = React.useMemo(() => DialogPrimitive.createHandle(), [])

  return (
    <section className="dialog-demo__section">
      <h2 className="dialog-demo__section-title">Detached Trigger</h2>
      <p className="dialog-demo__section-desc">
        The trigger lives outside the Dialog tree, connected via a handle.
      </p>
      <div className="dialog-demo__row">
        <DialogPrimitive.Trigger
          handle={handle}
          render={<Button variant="outline" label="Detached trigger" />}
        />
      </div>

      <Dialog handle={handle}>
        <DialogPopup>
          <CardHeader
            title="Detached Trigger Dialog"
            subtitle="Opened by a trigger placed outside the Dialog root."
          />
          <CardFooter hasSeparator>
            <DialogPrimitive.Close render={<Button variant="outline" size="medium" label="Close" />} />
          </CardFooter>
        </DialogPopup>
      </Dialog>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Nested dialogs
// ---------------------------------------------------------------------------

function NestedDialogs(): React.JSX.Element {
  return (
    <section className="dialog-demo__section">
      <h2 className="dialog-demo__section-title">Nested Dialogs</h2>
      <p className="dialog-demo__section-desc">
        A dialog within a dialog — z-index stacks automatically via DOM order.
      </p>
      <Dialog>
        <DialogTrigger label="Open outer dialog" />
        <DialogPopup>
          <CardHeader
            title="Outer Dialog"
            subtitle="This dialog can open another one inside."
            hasSeparator
          />
          <CardContent>
            <CardBlock type="description">
              <CardBlockLabel>
                Open the nested dialog below to see how z-index stacking works.
              </CardBlockLabel>
            </CardBlock>
            <Dialog>
              <DialogTrigger label="Open inner dialog" variant="outline" size="medium" />
              <DialogPopup size="sm">
                <CardHeader
                  title="Inner Dialog"
                  subtitle="This is the nested dialog."
                  hasSeparator
                />
                <CardContent>
                  <CardBlock type="key-value">
                    <CardBlockLabel>Depth</CardBlockLabel>
                    <CardBlockValue>Level 2</CardBlockValue>
                  </CardBlock>
                </CardContent>
                <CardFooter hasSeparator>
                  <DialogPrimitive.Close render={<Button variant="outline" size="medium" label="Close" />} />
                </CardFooter>
              </DialogPopup>
            </Dialog>
          </CardContent>
          <CardFooter hasSeparator>
            <DialogPrimitive.Close render={<Button variant="outline" size="medium" label="Close" />} />
          </CardFooter>
        </DialogPopup>
      </Dialog>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Alert dialog (footer buttons only — must pick an action)
// ---------------------------------------------------------------------------

function AlertDialog(): React.JSX.Element {
  return (
    <section className="dialog-demo__section">
      <h2 className="dialog-demo__section-title">Alert Dialog</h2>
      <p className="dialog-demo__section-desc">
        You <strong>must</strong> pick an action — no X button, escape, or outside click.
      </p>
      <Dialog isEscapeDisabled isDismissOnOutsideClick={false}>
        <DialogTrigger label="Open alert" variant="solid-destructive" />
        <DialogPopup showCloseButton={false} size="md">
          <CardHeader
            title="Delete item?"
            subtitle="This action cannot be undone. Choose Cancel or Delete."
          />
          <CardFooter hasSeparator>
            <DialogPrimitive.Close render={<Button variant="outline" size="medium" label="Cancel" />} />
            <DialogPrimitive.Close render={<Button variant="solid-destructive" size="medium" label="Delete" />} />
          </CardFooter>
        </DialogPopup>
      </Dialog>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Controlled dialog
// ---------------------------------------------------------------------------

function ControlledDialog(): React.JSX.Element {
  const [isOpen, setIsOpen] = React.useState(false)

  return (
    <section className="dialog-demo__section">
      <h2 className="dialog-demo__section-title">Controlled Dialog</h2>
      <p className="dialog-demo__section-desc">
        State managed externally. The badge shows the current state.
      </p>
      <div className="dialog-demo__row">
        <Button label="Toggle dialog" onClick={() => setIsOpen((prev) => !prev)} />
        <span className="dialog-demo__state-label">
          {isOpen ? "Open" : "Closed"}
        </span>
      </div>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogPopup>
          <CardHeader
            title="Controlled Dialog"
            subtitle="This dialog's open state is managed externally."
          />
          <CardFooter hasSeparator>
            <DialogPrimitive.Close render={<Button variant="outline" size="medium" label="Close" />} />
          </CardFooter>
        </DialogPopup>
      </Dialog>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Form page with nested dialog (select dropdown inside a popup)
// ---------------------------------------------------------------------------

const ROLE_ITEMS = [
  { key: "developer", value: "developer", label: "Developer" },
  { key: "designer", value: "designer", label: "Designer" },
  { key: "pm", value: "pm", label: "Product Manager" },
  { key: "qa", value: "qa", label: "QA Engineer" },
  { key: "devops", value: "devops", label: "DevOps" },
]

const DEPARTMENT_OPTIONS = [
  { value: "engineering", label: "Engineering" },
  { value: "design", label: "Design" },
  { value: "product", label: "Product" },
]

interface FormValues {
  fullName: string
  email: string
  department: string
  role: string
  agreeToTerms: boolean
  experienceLevel: number
}

const DEFAULT_FORM_VALUES: FormValues = {
  fullName: "",
  email: "",
  department: "",
  role: "",
  agreeToTerms: false,
  experienceLevel: 3,
}

function requiredValidator(value: string): string | undefined {
  return value.trim() ? undefined : "This field is required"
}

function emailValidator(value: string): string | undefined {
  if (!value.trim()) return "Email is required"
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? undefined : "Enter a valid email"
}

function FormPageDemo(): React.JSX.Element {
  const [submittedData, setSubmittedData] = React.useState<FormValues | null>(null)
  const [roleDialogOpen, setRoleDialogOpen] = React.useState(false)
  const [pendingRole, setPendingRole] = React.useState<string>("")
  const [confirmedRole, setConfirmedRole] = React.useState<string>("")
  const [roleError, setRoleError] = React.useState("")

  const form = asFormApi(useForm({
    defaultValues: DEFAULT_FORM_VALUES,
    onSubmit: async ({ value }) => {
      setSubmittedData(value)
    },
  }))

  const handleRoleConfirm = (): void => {
    if (!pendingRole) {
      setRoleError("Please select a role")
      return
    }
    setRoleError("")
    form.setFieldValue("role", pendingRole)
    setConfirmedRole(pendingRole)
    setRoleDialogOpen(false)
  }

  const handleRoleDialogOpen = (open: boolean): void => {
    if (open) {
      setPendingRole(String(form.getFieldValue("role") ?? ""))
      setRoleError("")
    }
    setRoleDialogOpen(open)
  }

  const handleReset = (): void => {
    form.reset()
    setConfirmedRole("")
    setSubmittedData(null)
  }

  return (
    <section className="dialog-demo__section">
      <h2 className="dialog-demo__section-title">Form with Nested Dialog</h2>
      <p className="dialog-demo__section-desc">
        A page-level form with inputs, a radio group, a nested dialog for selecting a role,
        a checkbox, and a slider. The role field opens a popup with a <code>SelectDropdown</code> and validation.
      </p>

      <Form form={form} className="dialog-demo__page-form">
        {/* -- Text inputs */}
        <div className="dialog-demo__form-row">
          <div className="dialog-demo__form-field">
            <InputField
              form={form}
              name="fullName"
              label="Full Name"
              placeholder="John Doe"
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              validators={{ onBlur: ({ value }: { value: string }) => requiredValidator(value) } as any}
            />
          </div>
          <div className="dialog-demo__form-field">
            <InputField
              form={form}
              name="email"
              label="Email"
              type="email"
              placeholder="john@example.com"
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              validators={{ onBlur: ({ value }: { value: string }) => emailValidator(value) } as any}
            />
          </div>
        </div>

        {/* -- Radio group */}
        <div className="dialog-demo__form-row">
          <div className="dialog-demo__form-field">
            <RadioGroupField
              form={form}
              name="department"
              label="Department"
              description="Choose your department"
              options={DEPARTMENT_OPTIONS}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              validators={{ onSubmit: ({ value }: { value: string }) => requiredValidator(value) } as any}
            />
          </div>
        </div>

        {/* -- Role via nested dialog */}
        <div className="dialog-demo__form-row">
          <div className="dialog-demo__form-field">
            <span className="dialog-demo__field-label">Role</span>
            <div className="dialog-demo__role-row">
              <Dialog open={roleDialogOpen} onOpenChange={handleRoleDialogOpen}>
                <DialogTrigger label="Select role…" variant="outline" size="medium" />
                <DialogPopup size="sm">
                  <Card>
                    <CardHeader
                      title="Select Role"
                      subtitle="Choose your role from the dropdown below."
                      hasSeparator
                    />
                    <CardContent>
                      <div className="dialog-demo__role-select">
                        <SelectDropdown
                          items={ROLE_ITEMS}
                          placeholder="Pick a role"
                          value={pendingRole || null}
                          onValueChange={(val: SelectDropdownValue) => {
                            setPendingRole(val as string)
                            if (val) setRoleError("")
                          }}
                          size="fill"
                          label="Role"
                          error={roleError || undefined}
                        />
                      </div>
                    </CardContent>
                    <CardFooter hasSeparator>
                      <DialogPrimitive.Close render={<Button variant="outline" size="medium" label="Cancel" />} />
                      <Button variant="solid" size="medium" label="Confirm" onClick={handleRoleConfirm} />
                    </CardFooter>
                  </Card>
                </DialogPopup>
              </Dialog>

              {confirmedRole ? (
                <span className="dialog-demo__state-label">
                  {ROLE_ITEMS.find((r) => r.value === confirmedRole)?.label ?? confirmedRole}
                </span>
              ) : (
                <span className="dialog-demo__role-hint">No role selected</span>
              )}
            </div>
          </div>
        </div>

        {/* -- Checkbox */}
        <div className="dialog-demo__form-row">
          <CheckboxField
            form={form}
            name="agreeToTerms"
            label="I agree to the terms and conditions"
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            validators={{ onSubmit: ({ value }: { value: boolean }) => (value ? undefined : "You must agree") } as any}
          />
        </div>

        {/* -- Slider */}
        <div className="dialog-demo__form-row">
          <div className="dialog-demo__form-field">
            <SliderField
              form={form}
              name="experienceLevel"
              label="Experience Level (years)"
              min={0}
              max={10}
              step={1}
            />
          </div>
        </div>

        {/* -- Actions */}
        <div className="dialog-demo__form-actions">
          <Button variant="solid" label="Submit" type="submit" />
          <Button variant="outline" label="Reset" type="button" onClick={handleReset} />
        </div>
      </Form>

      {submittedData && (
        <div className="dialog-demo__output">
          <h3 className="dialog-demo__section-title">Submitted Values</h3>
          <pre className="dialog-demo__pre">{JSON.stringify(submittedData, null, 2)}</pre>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Animation variants
// ---------------------------------------------------------------------------

interface AnimationConfig {
  label: string
  animation: DialogAnimation
  backdropAnimation: DialogBackdropAnimation
  backdropColor: DialogBackdropColor
  subtitle: string
}

const ANIMATION_CONFIGS: AnimationConfig[] = [
  {
    label: "Fade (default)",
    animation: "fade",
    backdropAnimation: "fade",
    backdropColor: "default",
    subtitle: "Popup: fade | Backdrop anim: fade | Backdrop color: default",
  },
  {
    label: "Scale",
    animation: "scale",
    backdropAnimation: "fade",
    backdropColor: "default",
    subtitle: "Popup: scale | Backdrop anim: fade | Backdrop color: default",
  },
  {
    label: "Slide Up",
    animation: "slideUp",
    backdropAnimation: "fade",
    backdropColor: "default",
    subtitle: "Popup: slideUp | Backdrop anim: fade | Backdrop color: default",
  },
  {
    label: "Fade + No Backdrop Anim",
    animation: "fade",
    backdropAnimation: "none",
    backdropColor: "default",
    subtitle: "Popup: fade | Backdrop anim: none (instant) | Backdrop color: default",
  },
  {
    label: "Scale + No Backdrop Anim",
    animation: "scale",
    backdropAnimation: "none",
    backdropColor: "default",
    subtitle: "Popup: scale | Backdrop anim: none (instant) | Backdrop color: default",
  },
  {
    label: "Slide Up + No Backdrop Anim",
    animation: "slideUp",
    backdropAnimation: "none",
    backdropColor: "default",
    subtitle: "Popup: slideUp | Backdrop anim: none (instant) | Backdrop color: default",
  },
  {
    label: "Fade + Transparent",
    animation: "fade",
    backdropAnimation: "fade",
    backdropColor: "none",
    subtitle: "Popup: fade | Backdrop anim: fade | Backdrop color: none (transparent)",
  },
  {
    label: "Scale + Transparent",
    animation: "scale",
    backdropAnimation: "fade",
    backdropColor: "none",
    subtitle: "Popup: scale | Backdrop anim: fade | Backdrop color: none (transparent)",
  },
  {
    label: "Slide Up + Transparent",
    animation: "slideUp",
    backdropAnimation: "fade",
    backdropColor: "none",
    subtitle: "Popup: slideUp | Backdrop anim: fade | Backdrop color: none (transparent)",
  },
]

function AnimationVariants(): React.JSX.Element {
  return (
    <section className="dialog-demo__section">
      <h2 className="dialog-demo__section-title">Animation Variants</h2>
      <p className="dialog-demo__section-desc">
        Each popup animation (<code>fade</code>, <code>scale</code>, <code>slideUp</code>)
        paired with each backdrop animation (<code>fade</code>, <code>none</code>)
        and backdrop color (<code>default</code>, <code>none</code>).
      </p>
      <div className="dialog-demo__row">
        {ANIMATION_CONFIGS.map(({ label, animation, backdropAnimation, backdropColor, subtitle }) => (
          <Dialog key={label} animation={animation} backdropAnimation={backdropAnimation} backdropColor={backdropColor}>
            <DialogTrigger label={label} variant="outline" />
            <DialogPopup>
              <CardHeader
                title={label}
                subtitle={subtitle}
              />
              <CardFooter hasSeparator>
                <DialogPrimitive.Close render={<Button variant="outline" size="medium" label="Close" />} />
              </CardFooter>
            </DialogPopup>
          </Dialog>
        ))}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Size variants
// ---------------------------------------------------------------------------

const SIZES = ["sm", "md", "lg", "full"] as const

function SizeVariants(): React.JSX.Element {
  return (
    <section className="dialog-demo__section">
      <h2 className="dialog-demo__section-title">Size Variants</h2>
      <p className="dialog-demo__section-desc">
        Small, medium, large, and full-width popup sizes.
      </p>
      <div className="dialog-demo__row">
        {SIZES.map((size) => (
          <Dialog key={size} size={size}>
            <DialogTrigger label={`Size: ${size}`} variant="outline" />
            <DialogPopup>
              <CardHeader
                title={`Size: ${size}`}
                subtitle={`This popup uses the ${size} size variant.`}
              />
              <CardFooter hasSeparator>
                <DialogPrimitive.Close render={<Button variant="outline" size="medium" label="Close" />} />
              </CardFooter>
            </DialogPopup>
          </Dialog>
        ))}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Custom trigger
// ---------------------------------------------------------------------------

function CustomTriggerDialog(): React.JSX.Element {
  return (
    <section className="dialog-demo__section">
      <h2 className="dialog-demo__section-title">Custom Trigger</h2>
      <p className="dialog-demo__section-desc">
        Custom inline trigger. <strong>Click outside</strong> the popup to close — no X, escape, or buttons.
      </p>
      <Dialog isEscapeDisabled>
        <DialogTrigger
          triggerComponent={
            <span
              style={{
                cursor: "pointer",
                textDecoration: "underline",
                color: "var(--text-button-primary)",
              }}
            >
              Click this text to open
            </span>
          }
        />
        <DialogPopup size="sm" showCloseButton={false}>
          <CardHeader
            title="Custom Trigger"
            subtitle="Click anywhere outside this popup to dismiss it."
          />
        </DialogPopup>
      </Dialog>
    </section>
  )
}
