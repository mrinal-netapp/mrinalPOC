import { useState } from "react"
import type { ReactElement } from "react"
import { useForm } from "@tanstack/react-form"

import { Button } from "@/ui-lib/base-components/button/button"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { Form } from "./form"
import { InputField } from "./form-field.input"
import { CheckboxField } from "./form-field.checkbox"
import { RadioGroupField } from "./form-field.radio-group"
import { SelectDropdownField } from "./form-field.select-dropdown"
import { asFormApi } from "./form.utils.demo"
import "./form.dataset.demo.scss"

// -- Data

const LABEL_ITEMS = [
  { key: "staging", value: "staging", label: "Staging" },
  { key: "nfs", value: "nfs", label: "NFS" },
  { key: "production", value: "production", label: "Production" },
  { key: "development", value: "development", label: "Development" },
]

const FILE_TYPE_ITEMS = [
  { key: "pdf", value: ".pdf", label: ".pdf" },
  { key: "docx", value: ".docx", label: ".docx" },
  { key: "txt", value: ".txt", label: ".txt" },
  { key: "csv", value: ".csv", label: ".csv" },
  { key: "json", value: ".json", label: ".json" },
  { key: "md", value: ".md", label: ".md" },
]

const LAST_MODIFIED_ITEMS = [
  { key: "any", value: "any", label: "Any time" },
  { key: "24h", value: "24h", label: "Last 24 hours" },
  { key: "7d", value: "7d", label: "Last 7 days" },
  { key: "30d", value: "30d", label: "Last 30 days" },
  { key: "90d", value: "90d", label: "Last 90 days" },
]

const FREQUENCY_OPTIONS = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
]

const SAMPLE_DATASOURCES = [
  { name: "prod-storage-nfs", type: "NFS", protocol: "NFSv3", workEnv: "Production cluster", account: "acme-prod" },
  { name: "dev-s3-bucket", type: "S3", protocol: "S3", workEnv: "Development", account: "acme-dev" },
  { name: "staging-cifs-share", type: "CIFS", protocol: "SMB 3.0", workEnv: "Staging cluster", account: "acme-staging" },
]

const SAMPLE_FOLDERS = [
  "/data/documents/reports",
  "/data/documents/contracts",
]

// -- Validators

function required(value: string): string | undefined {
  return value.trim() ? undefined : "This field is required"
}

// -- Icons

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
  fileTypes: [".pdf", ".docx", ".txt"] as (string | number)[],
  lastModified: "",
  sizeLimitMb: "",
  excludePatterns: "",
  syncEnabled: false,
  syncFrequency: "hourly",
  syncHour: "10",
  syncMinute: "15",
  syncCronExpression: "",
}

// -- Component

type FormMode = "normal" | "readonly" | "disabled"

export default function DatasetFormDemo(): ReactElement {
  const [formMode, setFormMode] = useState<FormMode>("normal")
  const [submittedData, setSubmittedData] = useState<typeof DEFAULT_VALUES | null>(null)
  const [dataSourceMode, setDataSourceMode] = useState<"existing" | "upload">("existing")
  const [folderScope, setFolderScope] = useState<"all" | "custom">("custom")
  const [selectedDatasource, setSelectedDatasource] = useState(0)
  const [scheduleTab, setScheduleTab] = useState<"builder" | "cron">("builder")

  const form = asFormApi(useForm({
    defaultValues: DEFAULT_VALUES,
    onSubmit: async ({ value }) => {
      setSubmittedData(value)
    },
  }))

  return (
    <div className="ds-dataset">
      <div className="ds-dataset__mode-toggle">
        <Button variant={formMode === "normal" ? "solid" : "outline"} label="Normal" onClick={() => setFormMode("normal")} />
        <Button variant={formMode === "readonly" ? "solid" : "outline"} label="Read Only" onClick={() => setFormMode("readonly")} />
        <Button variant={formMode === "disabled" ? "solid" : "outline"} label="Disabled" onClick={() => setFormMode("disabled")} />
      </div>

      <Form form={form} isReadOnly={formMode === "readonly"} isDisabled={formMode === "disabled"}>

        {/* ══════════════════════════════════════════════
            Section 1 — Details
            ══════════════════════════════════════════════ */}
        <section className="ds-dataset__section">
          <Typography Component="h2" fontSize="fs14" boldness="semibold" className="ds-dataset__section-title">
            Details
          </Typography>
          <Typography Component="p" fontSize="fs14" boldness="regular" className="ds-dataset__section-subtitle">
            Enter the identifying information for this dataset.
          </Typography>

          <div className="ds-dataset__fields">
            <div className="ds-dataset__field">
              <InputField
                form={form}
                name="name"
                label="Name"
                placeholder="Enter dataset name"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                validators={{ onBlur: ({ value }: { value: string }) => required(value) } as any}
              />
            </div>
            <div className="ds-dataset__field">
              <InputField
                form={form}
                name="description"
                label="Description"
                isOptional
                placeholder="Enter description"
              />
            </div>
            <div className="ds-dataset__field">
              <SelectDropdownField
                form={form}
                name="labels"
                label="Labels"
                isOptional
                tooltip="Assign labels to categorize this dataset"
                items={LABEL_ITEMS}
                placeholder="Select labels"
                size="fill"
                options={{ isMultiSelect: true, isChipDisplay: true, isClearable: true }}
              />
            </div>
          </div>
        </section>

        {/* ══════════════════════════════════════════════
            Section 2 — Data source configuration
            ══════════════════════════════════════════════ */}
        <hr className="ds-dataset__divider" />

        <section className="ds-dataset__section">
          <div className="ds-dataset__section-header">
            <Typography Component="h2" fontSize="fs14" boldness="semibold" className="ds-dataset__section-title">
              Data source configuration
            </Typography>
            <Typography Component="p" fontSize="fs14" boldness="regular" className="ds-dataset__section-subtitle">
              Select an existing data source or upload files from your local computer.
            </Typography>
          </div>

          {/* Source mode radio */}
          <div className="ds-dataset__fields">
            <div
              className="ds-dataset__radio-option"
              onClick={() => setDataSourceMode("existing")}
            >
              <div className={`ds-dataset__radio-dot ${dataSourceMode === "existing" ? "ds-dataset__radio-dot--selected" : ""}`} />
              <div className="ds-dataset__radio-text">
                <Typography Component="span" fontSize="fs14" boldness="semibold">Use existing data source</Typography>
                <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-primary)">
                  Select and filter content from an added data source
                </Typography>
              </div>
            </div>
            <div
              className="ds-dataset__radio-option"
              onClick={() => setDataSourceMode("upload")}
            >
              <div className={`ds-dataset__radio-dot ${dataSourceMode === "upload" ? "ds-dataset__radio-dot--selected" : ""}`} />
              <div className="ds-dataset__radio-text">
                <Typography Component="span" fontSize="fs14" boldness="semibold">Upload from computer</Typography>
                <Typography Component="span" fontSize="fs14" boldness="regular" color="var(--text-primary)">
                  Upload files from your local machine
                </Typography>
              </div>
            </div>
          </div>

          {/* Data sources table */}
          {dataSourceMode === "existing" && (
            <>
              <div className="ds-dataset__table-header">
                <Typography Component="span" fontSize="fs16" boldness="semibold">
                  Data sources ({SAMPLE_DATASOURCES.length})
                </Typography>
              </div>
              <table className="ds-dataset__table">
                <thead>
                  <tr>
                    <th />
                    <th>Name</th>
                    <th>Type</th>
                    <th>Protocol</th>
                    <th>Working environment</th>
                    <th>Account</th>
                  </tr>
                </thead>
                <tbody>
                  {SAMPLE_DATASOURCES.map((ds, i) => (
                    <tr key={ds.name}>
                      <td>
                        <input
                          type="radio"
                          name="datasource"
                          checked={selectedDatasource === i}
                          onChange={() => setSelectedDatasource(i)}
                        />
                      </td>
                      <td><span className="ds-dataset__table-link">{ds.name}</span></td>
                      <td><span className="ds-dataset__badge">{ds.type}</span></td>
                      <td><span className="ds-dataset__badge">{ds.protocol}</span></td>
                      <td>{ds.workEnv}</td>
                      <td>{ds.account}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* -- Folder scope -- */}
              <div className="ds-dataset__subsection" style={{ marginTop: 16 }}>
                <Typography Component="h3" fontSize="fs16" boldness="semibold" className="ds-dataset__subsection-title">
                  Folder scope
                </Typography>
                <Typography Component="p" fontSize="fs14" boldness="regular" className="ds-dataset__subsection-subtitle">
                  Scope provides the structural boundaries for your dataset through specific folder selection.
                </Typography>

                <div className="ds-dataset__radio-option" onClick={() => setFolderScope("all")} style={{ width: "auto" }}>
                  <div className={`ds-dataset__radio-dot ${folderScope === "all" ? "ds-dataset__radio-dot--selected" : ""}`} />
                  <Typography Component="span" fontSize="fs14" boldness="regular">Use all folders</Typography>
                </div>
                <div className="ds-dataset__radio-option" onClick={() => setFolderScope("custom")} style={{ width: "auto" }}>
                  <div className={`ds-dataset__radio-dot ${folderScope === "custom" ? "ds-dataset__radio-dot--selected" : ""}`} />
                  <Typography Component="span" fontSize="fs14" boldness="regular">Use custom selection</Typography>
                </div>
              </div>

              {folderScope === "custom" && (
                <div className="ds-dataset__subsection">
                  <Typography Component="h4" fontSize="fs16" boldness="semibold" className="ds-dataset__subsection-title">
                    Custom folder selection
                  </Typography>
                  <Typography Component="p" fontSize="fs14" boldness="regular" className="ds-dataset__subsection-subtitle">
                    Select custom folder scope and apply filters
                  </Typography>

                  <table className="ds-dataset__inner-table">
                    <thead>
                      <tr><th>Folder paths</th><th style={{ width: 83 }} /></tr>
                    </thead>
                    <tbody>
                      {SAMPLE_FOLDERS.map((folder) => (
                        <tr key={folder}>
                          <td>{folder}</td>
                          <td style={{ textAlign: "center" }}>···</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <div>
                    <Button variant="outline" label="Add datasource scope" />
                  </div>
                </div>
              )}

              {/* -- File scope (Filters) -- */}
              <div className="ds-dataset__subsection" style={{ marginTop: 16 }}>
                <Typography Component="h3" fontSize="fs16" boldness="semibold" className="ds-dataset__subsection-title">
                  File scope
                </Typography>
                <Typography Component="p" fontSize="fs14" boldness="regular" className="ds-dataset__subsection-subtitle">
                  Filters provide a granular mechanism to define the exact scope and boundaries of your dataset.
                </Typography>

                <div className="ds-dataset__notice">
                  <span className="ds-dataset__notice-icon"><InfoCircleIcon /></span>
                  <Typography Component="p" fontSize="fs14" boldness="regular" className="ds-dataset__notice-text">
                    Placeholder message on unsupported file types.
                  </Typography>
                </div>

                <div className="ds-dataset__fields">
                  <div className="ds-dataset__field">
                    <SelectDropdownField
                      form={form}
                      name="fileTypes"
                      label="Types"
                      items={FILE_TYPE_ITEMS}
                      placeholder="Select file types"
                      size="fill"
                      options={{ isMultiSelect: true, isChipDisplay: true, isClearable: true }}
                    />
                  </div>
                  <div className="ds-dataset__field">
                    <SelectDropdownField
                      form={form}
                      name="lastModified"
                      label="Last modified"
                      items={LAST_MODIFIED_ITEMS}
                      placeholder="Any time"
                      size="fill"
                    />
                  </div>
                  <div className="ds-dataset__field">
                    <InputField
                      form={form}
                      name="sizeLimitMb"
                      label="Size limit, MB"
                      type="number"
                      placeholder="Enter max file size"
                    />
                  </div>
                  <div className="ds-dataset__field">
                    <InputField
                      form={form}
                      name="excludePatterns"
                      label="Exclude patterns"
                      isOptional
                      tooltip="Glob patterns to exclude files or folders"
                      placeholder="temp/, *.tmp, *draft*"
                    />
                  </div>
                </div>
              </div>
            </>
          )}

          {dataSourceMode === "upload" && (
            <div className="ds-dataset__subsection">
              <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                File upload area placeholder — drag & drop or browse.
              </Typography>
              <div>
                <Button variant="outline" label="Browse files" />
              </div>
            </div>
          )}
        </section>

        {/* ══════════════════════════════════════════════
            Section 3 — Synchronization schedule
            ══════════════════════════════════════════════ */}
        <hr className="ds-dataset__divider" />

        <section className="ds-dataset__section">
          <Typography Component="h2" fontSize="fs14" boldness="semibold" className="ds-dataset__section-title">
            Synchronization schedule
          </Typography>

          <Typography Component="p" fontSize="fs14" boldness="regular" className="ds-dataset__section-subtitle" style={{ maxWidth: 984 }}>
            A synchronization schedule provides a fixed schedule to keep your dataset up to date with its data source. Minimum frequency of 2 hours is required.
          </Typography>

          <CheckboxField
            form={form}
            name="syncEnabled"
            label="Enable dataset synchronization schedule"
          />

          <div className="ds-dataset__tabs">
            <button
              type="button"
              className={`ds-dataset__tab ${scheduleTab === "builder" ? "ds-dataset__tab--active" : ""}`}
              onClick={() => setScheduleTab("builder")}
            >
              Use schedule builder
            </button>
            <button
              type="button"
              className={`ds-dataset__tab ${scheduleTab === "cron" ? "ds-dataset__tab--active" : ""}`}
              onClick={() => setScheduleTab("cron")}
            >
              Use cron expression
            </button>
          </div>

          {scheduleTab === "builder" && (
            <>
              <div className="ds-dataset__section-header">
                <Typography Component="h3" fontSize="fs14" boldness="semibold" className="ds-dataset__subsection-title">
                  Schedule frequency
                </Typography>
                <Typography Component="p" fontSize="fs14" boldness="regular" className="ds-dataset__subsection-subtitle">
                  Select schedule frequency and configure time of the synchronization.
                </Typography>
              </div>

              <div className="ds-dataset__field" style={{ width: 616 }}>
                <RadioGroupField
                  form={form}
                  name="syncFrequency"
                  label=""
                  options={FREQUENCY_OPTIONS}
                />
              </div>

              <Typography Component="h3" fontSize="fs14" boldness="semibold" className="ds-dataset__subsection-title">
                Configure time
              </Typography>

              <div className="ds-dataset__field-row">
                <div className="ds-dataset__field">
                  <InputField
                    form={form}
                    name="syncHour"
                    label="Hour (UTC)"
                    type="number"
                    placeholder="0–23"
                  />
                </div>
                <div className="ds-dataset__field">
                  <InputField
                    form={form}
                    name="syncMinute"
                    label="Minute of the hour (UTC)"
                    type="number"
                    placeholder="0–59"
                  />
                </div>
              </div>
            </>
          )}

          {scheduleTab === "cron" && (
            <div className="ds-dataset__field" style={{ width: 616 }}>
              <InputField
                form={form}
                name="syncCronExpression"
                label="Cron expression"
                placeholder="0 10 * * *"
              />
            </div>
          )}
        </section>

        {/* ══════════════════════════════════════════════
            Actions
            ══════════════════════════════════════════════ */}
        <hr className="ds-dataset__divider" />

        <div style={{ display: "flex", gap: 12 }}>
          <Button variant="solid" label="Save" type="submit" />
          <Button
            variant="outline"
            label="Reset"
            type="button"
            onClick={() => {
              form.reset()
              setSubmittedData(null)
              setDataSourceMode("existing")
              setFolderScope("custom")
              setSelectedDatasource(0)
              setScheduleTab("builder")
            }}
          />
        </div>

        {submittedData !== null && (
          <div className="ds-dataset__output">
            <Typography Component="h3" fontSize="fs14" boldness="semibold">
              Saved Values
            </Typography>
            <pre className="ds-dataset__pre">
              {JSON.stringify({
                ...submittedData,
                dataSourceMode,
                selectedDatasource: SAMPLE_DATASOURCES[selectedDatasource]?.name,
                folderScope,
                scheduleTab,
              }, null, 2)}
            </pre>
          </div>
        )}
      </Form>
    </div>
  )
}
