import { useState } from "react"
import type { ReactElement } from "react"
import { useForm } from "@tanstack/react-form"

import { Button } from "@/ui-lib/base-components/button/button"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { Card } from "@/ui-lib/base-components/card/card"
import { Form } from "./form"
import { InputField } from "./form-field.input"
import { SelectDropdownField } from "./form-field.select-dropdown"
import { asFormApi } from "./form.utils.demo"
import "./form.datasource.demo.scss"

// -- Data

const LABEL_ITEMS = [
  { key: "staging", value: "staging", label: "Staging" },
  { key: "nfs", value: "nfs", label: "NFS" },
  { key: "production", value: "production", label: "Production" },
  { key: "development", value: "development", label: "Development" },
  { key: "backup", value: "backup", label: "Backup" },
]

// -- Validators

function required(value: string): string | undefined {
  return value.trim() ? undefined : "This field is required"
}

// -- Icons (inline SVGs matching Figma design intent)

function VolumeIcon(): ReactElement {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M4 7h16v2H4V7Zm0 4h16v2H4v-2Zm0 4h16v2H4v-2Z"
        fill="currentColor"
      />
      <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </svg>
  )
}

function InfoCircleIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 7v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="8" cy="5" r="0.75" fill="currentColor" />
    </svg>
  )
}

// -- Default values

const DEFAULT_VALUES = {
  name: "",
  description: "",
  labels: ["staging", "nfs"] as (string | number)[],
}

// -- Component

type FormMode = "normal" | "readonly" | "disabled"

export default function DatasourceFormDemo(): ReactElement {
  const [formMode, setFormMode] = useState<FormMode>("normal")
  const [scanningEnabled, setScanningEnabled] = useState(false)
  const [submittedData, setSubmittedData] = useState<typeof DEFAULT_VALUES | null>(null)

  const form = asFormApi(useForm({
    defaultValues: DEFAULT_VALUES,
    onSubmit: async ({ value }) => {
      setSubmittedData(value)
    },
  }))

  return (
    <div className="ds-form">
      <div className="ds-form__mode-toggle">
        <Button variant={formMode === "normal" ? "solid" : "outline"} label="Normal" onClick={() => setFormMode("normal")} />
        <Button variant={formMode === "readonly" ? "solid" : "outline"} label="Read Only" onClick={() => setFormMode("readonly")} />
        <Button variant={formMode === "disabled" ? "solid" : "outline"} label="Disabled" onClick={() => setFormMode("disabled")} />
      </div>

      <Form form={form} isReadOnly={formMode === "readonly"} isDisabled={formMode === "disabled"}>
        {/* ── Details ── */}
        <section className="ds-form__section">
          <Typography Component="h2" fontSize="fs14" boldness="semibold" className="ds-form__section-title">
            Details
          </Typography>
          <Typography Component="p" fontSize="fs14" boldness="regular" className="ds-form__section-subtitle">
            Provide the identifying information for this data source.
          </Typography>

          <div className="ds-form__fields">
            <div className="ds-form__field">
              <InputField
                form={form}
                name="name"
                label="Name"
                placeholder="Enter data source name"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                validators={{ onBlur: ({ value }: { value: string }) => required(value) } as any}
              />
            </div>

            <div className="ds-form__field">
              <InputField
                form={form}
                name="description"
                label="Description"
                isOptional
                placeholder="Enter description"
              />
            </div>

            <div className="ds-form__field">
              <SelectDropdownField
                form={form}
                name="labels"
                label="Labels"
                isOptional
                tooltip="Assign labels to categorize this data source"
                items={LABEL_ITEMS}
                placeholder="Select labels"
                size="fill"
                options={{
                  isMultiSelect: true,
                  isChipDisplay: true,
                  isClearable: true,
                }}
              />
            </div>
          </div>
        </section>

        {/* ── Access configuration ── */}
        <hr className="ds-form__divider" />

        <section className="ds-form__section">
          <div className="ds-form__section-header">
            <Typography Component="h2" fontSize="fs14" boldness="semibold" className="ds-form__section-title">
              Access configuration
            </Typography>
            <Typography Component="p" fontSize="fs14" boldness="regular" className="ds-form__section-subtitle">
              Connect the data source by specifying configuration details to access it.
            </Typography>
          </div>

          <Card className="ds-form__source-card">
            <div className="card-header card-header--separator">
              <div className="card-header__left">
                <div className="card-header__icon">
                  <VolumeIcon />
                </div>
                <Typography Component="span" fontSize="fs16" boldness="regular">
                  Data source
                </Typography>
              </div>
              <div className="card-header__actions">
                <Button variant="flat" label="Add" />
              </div>
            </div>
          </Card>
        </section>

        {/* ── Scanning ── */}
        <hr className="ds-form__divider" />

        <section className="ds-form__section">
          <div className="ds-form__section-header">
            <Typography Component="h2" fontSize="fs14" boldness="semibold" className="ds-form__section-title">
              Scanning
            </Typography>
            <Typography Component="p" fontSize="fs14" boldness="regular" className="ds-form__section-subtitle">
              Scan this data source to pre-load metadata with real-time file statistics and visual folder browsing.
            </Typography>
          </div>

          <div className="ds-form__notice">
            <span className="ds-form__notice-icon">
              <InfoCircleIcon />
            </span>
            <Typography Component="p" fontSize="fs14" boldness="regular" className="ds-form__notice-text">
              {scanningEnabled
                ? "Scanning is enabled on this data source."
                : "Scanning is disabled on this data source."}
            </Typography>
          </div>

          <div>
            <Button
              variant="outline"
              label={scanningEnabled ? "Disable" : "Enable"}
              onClick={() => setScanningEnabled((prev) => !prev)}
            />
          </div>
        </section>

        {/* ── Actions ── */}
        <hr className="ds-form__divider" />

        <div style={{ display: "flex", gap: 12 }}>
          <Button variant="solid" label="Save" type="submit" />
          <Button
            variant="outline"
            label="Reset"
            type="button"
            onClick={() => {
              form.reset()
              setSubmittedData(null)
              setScanningEnabled(false)
            }}
          />
        </div>

        {submittedData !== null && (
          <div className="ds-form__output">
            <Typography Component="h3" fontSize="fs14" boldness="semibold">
              Saved Values
            </Typography>
            <pre className="ds-form__pre">
              {JSON.stringify({ ...submittedData, scanningEnabled }, null, 2)}
            </pre>
          </div>
        )}
      </Form>
    </div>
  )
}
