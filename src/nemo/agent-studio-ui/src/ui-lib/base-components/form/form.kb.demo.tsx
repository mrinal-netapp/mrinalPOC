import { useState } from "react"
import type { ReactElement } from "react"
import { useForm } from "@tanstack/react-form"

import { Button } from "@/ui-lib/base-components/button/button"
import { Typography } from "@/ui-lib/base-components/typography/typography"
import { Form } from "./form"
import { InputField } from "./form-field.input"
import { SelectDropdownField } from "./form-field.select-dropdown"
import { ToggleField } from "./form-field.toggle"
import { asFormApi } from "./form.utils.demo"
import "./form.kb.demo.scss"

// -- Data

const LABEL_ITEMS = [
  { key: "staging", value: "staging", label: "Staging" },
  { key: "nfs", value: "nfs", label: "NFS" },
  { key: "production", value: "production", label: "Production" },
  { key: "development", value: "development", label: "Development" },
]

const EMBEDDING_MODEL_ITEMS = [
  { key: "openai-small", value: "openai-small", label: "OpenAI text-embedding-3-small" },
  { key: "openai-large", value: "openai-large", label: "OpenAI text-embedding-3-large" },
  { key: "cohere", value: "cohere", label: "Cohere embed-english-v3.0" },
]

const CHUNKING_STRATEGY_ITEMS = [
  { key: "token", value: "token", label: "Chunk by token" },
  { key: "sentence", value: "sentence", label: "Chunk by sentence" },
  { key: "paragraph", value: "paragraph", label: "Chunk by paragraph" },
]

const INDEX_TYPE_ITEMS = [
  { key: "hybrid", value: "hybrid", label: "Hybrid search (Recommended)" },
  { key: "vector", value: "vector", label: "Vector only" },
  { key: "keyword", value: "keyword", label: "Keyword only" },
]

const VECTOR_QUANTIZATION_ITEMS = [
  { key: "none", value: "none", label: "None" },
  { key: "sq8", value: "sq8", label: "Scalar (SQ8)" },
  { key: "pq", value: "pq", label: "Product quantization (PQ)" },
]

const VECTOR_INDEX_ITEMS = [
  { key: "hnsw", value: "hnsw", label: "Hierarchical Navigable Small World (Recommended)" },
  { key: "flat", value: "flat", label: "Flat (brute-force)" },
  { key: "ivf", value: "ivf", label: "IVF" },
]

const SAMPLE_DATASETS = [
  { name: "prod-documents", status: "Active", type: "NFS", dataSource: "prod-storage-nfs", modified: "2 hours ago", labels: ["staging", "nfs"] },
  { name: "contracts-2024", status: "Syncing", type: "S3", dataSource: "dev-s3-bucket", modified: "1 day ago", labels: ["production"] },
  { name: "support-tickets", status: "Active", type: "CIFS", dataSource: "staging-cifs-share", modified: "3 days ago", labels: ["development"] },
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

function WarningTriangleIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 1.5L14.5 13.5H1.5L8 1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M8 6.5v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="8" cy="11.5" r="0.6" fill="currentColor" />
    </svg>
  )
}

function PlusIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function ChevronDownIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IndexSizeIcon(): ReactElement {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 8h10M7 12h10M7 16h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function BuildTimeIcon(): ReactElement {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 7v5l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// -- Default values

const DEFAULT_VALUES = {
  name: "",
  description: "",
  labels: ["staging", "nfs"] as (string | number)[],
  reuseForPipeline: true,
  embeddingModel: "openai-small",
  chunkingStrategy: "token",
  cronExpression: "0 * * * *",
  dataChangeThreshold: false,
  indexType: "hybrid",
  vectorQuantization: "none",
  vectorIndexConfig: "hnsw",
}

// -- Component

type FormMode = "normal" | "readonly" | "disabled"

export default function KbFormDemo(): ReactElement {
  const [formMode, setFormMode] = useState<FormMode>("normal")
  const [submittedData, setSubmittedData] = useState<typeof DEFAULT_VALUES | null>(null)
  const [selectedDataset, setSelectedDataset] = useState(0)
  const [syncMode, setSyncMode] = useState<"manual" | "after-dataset" | "schedule">("schedule")
  const [scheduleTab, setScheduleTab] = useState<"builder" | "cron">("cron")
  const [processingMode, setProcessingMode] = useState<"standard" | "visual">("standard")
  const [chunkSize, setChunkSize] = useState(850)
  const [overlapTokens, setOverlapTokens] = useState(40)

  const form = asFormApi(useForm({
    defaultValues: DEFAULT_VALUES,
    onSubmit: async ({ value }) => {
      setSubmittedData(value)
    },
  }))

  const overlapPercent = chunkSize > 0 ? Math.round((overlapTokens / chunkSize) * 100) : 0

  return (
    <div className="kb-form">
      <div className="kb-form__mode-toggle">
        <Button variant={formMode === "normal" ? "solid" : "outline"} label="Normal" onClick={() => setFormMode("normal")} />
        <Button variant={formMode === "readonly" ? "solid" : "outline"} label="Read Only" onClick={() => setFormMode("readonly")} />
        <Button variant={formMode === "disabled" ? "solid" : "outline"} label="Disabled" onClick={() => setFormMode("disabled")} />
      </div>

      <Form form={form} isReadOnly={formMode === "readonly"} isDisabled={formMode === "disabled"}>

        {/* ══════════════════════════════════════════════
            Section 1 — Details
            ══════════════════════════════════════════════ */}
        <section className="kb-form__section">
          <div className="kb-form__section-header">
            <Typography Component="h2" fontSize="fs14" boldness="semibold" className="kb-form__section-title">
              Details
            </Typography>
            <Typography Component="p" fontSize="fs14" boldness="regular" className="kb-form__section-subtitle">
              Provide the identifying information for this Knowledge Base.
            </Typography>
          </div>

          <div className="kb-form__fields">
            <div className="kb-form__field">
              <InputField
                form={form}
                name="name"
                label="Name"
                placeholder="Enter knowledge base name"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                validators={{ onBlur: ({ value }: { value: string }) => required(value) } as any}
              />
            </div>
            <div className="kb-form__field">
              <InputField
                form={form}
                name="description"
                label="Description"
                isOptional
                placeholder="Enter description"
              />
            </div>
            <div className="kb-form__field">
              <SelectDropdownField
                form={form}
                name="labels"
                label="Labels"
                isOptional
                tooltip="Assign labels to categorize this Knowledge Base"
                items={LABEL_ITEMS}
                placeholder="Select labels"
                size="fill"
                options={{ isMultiSelect: true, isChipDisplay: true, isClearable: true }}
              />
            </div>
            <ToggleField
              form={form}
              name="reuseForPipeline"
              label="Use same details for an execution of a pipeline"
            />
          </div>
        </section>

        {/* ══════════════════════════════════════════════
            Section 2 — Dataset configuration
            ══════════════════════════════════════════════ */}
        <hr className="kb-form__divider" />

        <section className="kb-form__section">
          <div className="kb-form__section-header">
            <Typography Component="h2" fontSize="fs14" boldness="semibold" className="kb-form__section-title">
              Dataset configuration
            </Typography>
            <Typography Component="p" fontSize="fs14" boldness="regular" className="kb-form__section-subtitle">
              Select an existing dataset to power the knowledge base.
            </Typography>
          </div>

          {/* Dataset table */}
          <div className="kb-form__table-header">
            <Typography Component="span" fontSize="fs16" boldness="semibold">
              Datasets ({SAMPLE_DATASETS.length})
            </Typography>
          </div>
          <table className="kb-form__table">
            <thead>
              <tr>
                <th />
                <th>Name</th>
                <th>Status</th>
                <th>Type</th>
                <th>Data source</th>
                <th>Modified</th>
                <th>Labels</th>
              </tr>
            </thead>
            <tbody>
              {SAMPLE_DATASETS.map((ds, i) => (
                <tr key={ds.name}>
                  <td>
                    <input
                      type="radio"
                      name="dataset"
                      checked={selectedDataset === i}
                      onChange={() => setSelectedDataset(i)}
                    />
                  </td>
                  <td><span className="kb-form__table-link">{ds.name}</span></td>
                  <td><span className="kb-form__badge">{ds.status}</span></td>
                  <td>{ds.type}</td>
                  <td>{ds.dataSource}</td>
                  <td>{ds.modified}</td>
                  <td>
                    {ds.labels.map((lbl) => (
                      <span key={lbl} className="kb-form__badge" style={{ marginRight: 4 }}>{lbl}</span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Synchronization settings */}
          <div className="kb-form__section-header">
            <Typography Component="h2" fontSize="fs14" boldness="semibold" className="kb-form__section-title">
              Synchronization settings
            </Typography>
            <Typography Component="p" fontSize="fs14" boldness="regular" className="kb-form__section-subtitle">
              Select how the Knowledge Base stays up to date.
            </Typography>
          </div>

          <div className="kb-form__fields">
            <div className="kb-form__radio-option" onClick={() => setSyncMode("manual")}>
              <div className={`kb-form__radio-dot ${syncMode === "manual" ? "kb-form__radio-dot--selected" : ""}`} />
              <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
                <Typography Component="span" fontSize="fs14" boldness="semibold">Synchronize manually</Typography>
                <Typography Component="span" fontSize="fs14" boldness="regular">Updates must be applied manually.</Typography>
              </div>
            </div>
            <div className="kb-form__radio-option" onClick={() => setSyncMode("after-dataset")}>
              <div className={`kb-form__radio-dot ${syncMode === "after-dataset" ? "kb-form__radio-dot--selected" : ""}`} />
              <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
                <Typography Component="span" fontSize="fs14" boldness="semibold">Synchronize after dataset updates</Typography>
                <Typography Component="span" fontSize="fs14" boldness="regular">Starts automatically after each dataset synchronization completes.</Typography>
              </div>
            </div>
            <div className="kb-form__radio-option" onClick={() => setSyncMode("schedule")}>
              <div className={`kb-form__radio-dot ${syncMode === "schedule" ? "kb-form__radio-dot--selected" : ""}`} />
              <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
                <Typography Component="span" fontSize="fs14" boldness="semibold">Sync on Knowledge Base schedule</Typography>
                <Typography Component="span" fontSize="fs14" boldness="regular">Updates based on the Knowledge Base schedule, independent of dataset updates.</Typography>
              </div>
            </div>
          </div>

          {/* Schedule tabs */}
          {syncMode === "schedule" && (
            <>
              <div className="kb-form__tabs">
                <button
                  type="button"
                  className={`kb-form__tab ${scheduleTab === "builder" ? "kb-form__tab--active" : ""}`}
                  onClick={() => setScheduleTab("builder")}
                >
                  Use schedule builder
                </button>
                <button
                  type="button"
                  className={`kb-form__tab ${scheduleTab === "cron" ? "kb-form__tab--active" : ""}`}
                  onClick={() => setScheduleTab("cron")}
                >
                  Use cron expression
                </button>
              </div>

              {scheduleTab === "cron" && (
                <div className="kb-form__field">
                  <InputField
                    form={form}
                    name="cronExpression"
                    label="Cron expression"
                    tooltip="Standard cron format: minute hour day month weekday"
                    placeholder="0 * * * *"
                  />
                </div>
              )}

              {scheduleTab === "builder" && (
                <Typography Component="p" fontSize="fs14" boldness="regular" color="var(--text-secondary)">
                  Schedule builder placeholder — configure frequency and time.
                </Typography>
              )}
            </>
          )}

          {/* Data change threshold */}
          <div className="kb-form__section-header">
            <Typography Component="h2" fontSize="fs14" boldness="semibold" className="kb-form__section-title">
              Data change threshold
            </Typography>
            <Typography Component="p" fontSize="fs14" boldness="regular" className="kb-form__section-subtitle">
              Select to synchronize based on a specified minimum file change threshold.
            </Typography>
          </div>

          <ToggleField
            form={form}
            name="dataChangeThreshold"
            label="Data change threshold"
          />

          <div className="kb-form__notice">
            <span className="kb-form__notice-icon kb-form__notice-icon--warning"><WarningTriangleIcon /></span>
            <Typography Component="p" fontSize="fs14" boldness="regular" className="kb-form__notice-text">
              If disabled, a new version is created for each file change.
            </Typography>
          </div>
        </section>

        {/* ══════════════════════════════════════════════
            Section 3 — Processing configuration
            ══════════════════════════════════════════════ */}
        <hr className="kb-form__divider" />

        <section className="kb-form__section">
          <div className="kb-form__section-header">
            <Typography Component="h2" fontSize="fs14" boldness="semibold" className="kb-form__section-title">
              Processing configuration
            </Typography>
            <Typography Component="p" fontSize="fs14" boldness="regular" className="kb-form__section-subtitle">
              Select how documents are parsed before chunking and indexing.
            </Typography>
          </div>

          <div className="kb-form__fields">
            <div className="kb-form__radio-option" onClick={() => setProcessingMode("standard")}>
              <div className={`kb-form__radio-dot ${processingMode === "standard" ? "kb-form__radio-dot--selected" : ""}`} />
              <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
                <Typography Component="span" fontSize="fs14" boldness="semibold">Standard</Typography>
                <Typography Component="span" fontSize="fs14" boldness="regular">
                  High-speed text extraction for documents. Optimized for performance and plain-text accuracy.
                </Typography>
              </div>
            </div>
            <div className="kb-form__radio-option" onClick={() => setProcessingMode("visual")}>
              <div className={`kb-form__radio-dot ${processingMode === "visual" ? "kb-form__radio-dot--selected" : ""}`} />
              <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
                <Typography Component="span" fontSize="fs14" boldness="semibold">Visual</Typography>
                <Typography Component="span" fontSize="fs14" boldness="regular">
                  OCR and VLM recognition for complex layouts. Captures tables, charts, and images.
                </Typography>
              </div>
            </div>
          </div>

          {/* Expandable config links */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <button type="button" className="kb-form__expand-link">
              <PlusIcon /> File size limitation <ChevronDownIcon />
            </button>
            <button type="button" className="kb-form__expand-link">
              <PlusIcon /> Error handling <ChevronDownIcon />
            </button>
            <button type="button" className="kb-form__expand-link">
              <PlusIcon /> Duplicate file handling <ChevronDownIcon />
            </button>
          </div>
        </section>

        {/* ══════════════════════════════════════════════
            Section 4 — Embedding and chunking configuration
            ══════════════════════════════════════════════ */}
        <hr className="kb-form__divider" />

        <section className="kb-form__section">
          <div className="kb-form__section-header">
            <Typography Component="h2" fontSize="fs14" boldness="semibold" className="kb-form__section-title">
              Embedding and chunking configuration
            </Typography>
            <Typography Component="p" fontSize="fs14" boldness="regular" className="kb-form__section-subtitle">
              Select how documents are split, normalized, and filtered before indexing.
            </Typography>
          </div>

          <div className="kb-form__field">
            <SelectDropdownField
              form={form}
              name="embeddingModel"
              label="Embedding model"
              tooltip="Select the embedding model for vector generation"
              items={EMBEDDING_MODEL_ITEMS}
              placeholder="Select model"
              size="fill"
            />
          </div>

          {/* Chunking configuration sub-header */}
          <div className="kb-form__section-header">
            <Typography Component="h2" fontSize="fs14" boldness="semibold" className="kb-form__section-title">
              Chunking configuration
            </Typography>
            <Typography Component="p" fontSize="fs14" boldness="regular" className="kb-form__section-subtitle">
              Select how documents are split, normalized, and filtered before indexing.
            </Typography>
          </div>

          <div className="kb-form__field">
            <SelectDropdownField
              form={form}
              name="chunkingStrategy"
              label="Chunking strategy"
              tooltip="Determines how text is segmented into chunks"
              items={CHUNKING_STRATEGY_ITEMS}
              placeholder="Select strategy"
              size="fill"
            />
          </div>

          <div className="kb-form__notice">
            <span className="kb-form__notice-icon"><InfoCircleIcon /></span>
            <Typography Component="p" fontSize="fs14" boldness="regular" className="kb-form__notice-text">
              Default dimensions 1536; Supported dimensions: 512, 1536; Matryoshka embeddings supported (variable dimensions).
            </Typography>
          </div>

          {/* Chunk size slider */}
          <div className="kb-form__slider-block">
            <Typography Component="h3" fontSize="fs16" boldness="semibold" className="kb-form__subsection-title">
              Chunk size, tokens
            </Typography>
            <div className="kb-form__slider-row">
              <input
                type="range"
                className="kb-form__slider-track"
                min={100}
                max={2000}
                value={chunkSize}
                onChange={(e) => setChunkSize(Number(e.target.value))}
              />
            </div>
            <div className="kb-form__slider-labels">
              <span>100</span>
              <span className="kb-form__slider-value">{chunkSize}</span>
              <span>2000</span>
            </div>
          </div>

          {/* Overlap slider */}
          <div className="kb-form__slider-block">
            <Typography Component="h3" fontSize="fs16" boldness="semibold" className="kb-form__subsection-title">
              Overlap, tokens
            </Typography>
            <div className="kb-form__slider-row">
              <input
                type="range"
                className="kb-form__slider-track"
                min={0}
                max={420}
                value={overlapTokens}
                onChange={(e) => setOverlapTokens(Number(e.target.value))}
              />
            </div>
            <div className="kb-form__slider-labels">
              <span>0</span>
              <span className="kb-form__slider-value">{overlapTokens}</span>
              <span>420</span>
            </div>
            <Typography Component="p" fontSize="fs14" boldness="regular">
              Overlap: {overlapPercent}%
            </Typography>
          </div>
        </section>

        {/* ══════════════════════════════════════════════
            Section 5 — Indexing configuration
            ══════════════════════════════════════════════ */}
        <hr className="kb-form__divider" />

        <section className="kb-form__section">
          <div className="kb-form__section-header">
            <Typography Component="h2" fontSize="fs14" boldness="semibold" className="kb-form__section-title">
              Indexing configuration
            </Typography>
            <Typography Component="p" fontSize="fs14" boldness="regular" className="kb-form__section-subtitle">
              Select the embedding stack and storage strategy for this corpus.
            </Typography>
          </div>

          <div className="kb-form__field">
            <SelectDropdownField
              form={form}
              name="indexType"
              label="Index type"
              tooltip="Choose the search strategy for the index"
              items={INDEX_TYPE_ITEMS}
              placeholder="Select index type"
              size="fill"
            />
          </div>

          <div className="kb-form__field">
            <SelectDropdownField
              form={form}
              name="vectorQuantization"
              label="Vector quantization"
              tooltip="Quantization reduces storage costs and speeds up searches"
              items={VECTOR_QUANTIZATION_ITEMS}
              placeholder="Select quantization"
              size="fill"
            />
          </div>

          <div className="kb-form__notice">
            <span className="kb-form__notice-icon"><InfoCircleIcon /></span>
            <Typography Component="p" fontSize="fs14" boldness="regular" className="kb-form__notice-text">
              Quantization reduces storage costs and speeds up searches. For production workloads with millions of vectors, scalar quantization (SQ8) is an efficient balance of accuracy and speed.
            </Typography>
          </div>

          <div className="kb-form__stats-row">
            <div className="kb-form__stat" style={{ width: 174 }}>
              <span className="kb-form__stat-value">12.00 KB</span>
              <span className="kb-form__stat-label">Estimate, per vector</span>
            </div>
            <div className="kb-form__stat" style={{ width: 231 }}>
              <span className="kb-form__stat-value">11718.75 GB</span>
              <span className="kb-form__stat-label">Storage estimate, per 1M vectors</span>
            </div>
          </div>

          <div className="kb-form__field">
            <SelectDropdownField
              form={form}
              name="vectorIndexConfig"
              label="Vector index configuration"
              tooltip="Determines how vectors are stored and searched"
              items={VECTOR_INDEX_ITEMS}
              placeholder="Select configuration"
              size="fill"
            />
          </div>
        </section>

        {/* ══════════════════════════════════════════════
            Estimated build summary
            ══════════════════════════════════════════════ */}
        <hr className="kb-form__divider" />

        <section className="kb-form__section">
          <Typography Component="h2" fontSize="fs16" boldness="semibold" className="kb-form__section-title">
            Estimated build summary
          </Typography>

          <div className="kb-form__summary-cards">
            <div className="kb-form__summary-card">
              <div className="kb-form__summary-icon"><IndexSizeIcon /></div>
              <div className="kb-form__summary-text">
                <div className="kb-form__summary-number">2.4<span>GB</span></div>
                <div className="kb-form__summary-label">Index size</div>
              </div>
            </div>
            <div className="kb-form__summary-card">
              <div className="kb-form__summary-icon"><BuildTimeIcon /></div>
              <div className="kb-form__summary-text">
                <div className="kb-form__summary-number">25-35<span>minutes</span></div>
                <div className="kb-form__summary-label">Build time</div>
              </div>
            </div>
          </div>

          <div className="kb-form__notice">
            <span className="kb-form__notice-icon"><InfoCircleIcon /></span>
            <Typography Component="p" fontSize="fs14" boldness="regular" className="kb-form__notice-text">
              The build process will scan files, extract content, generate embeddings, and create the vector index. You can monitor progress and view logs during the build.
            </Typography>
          </div>
        </section>

        {/* ══════════════════════════════════════════════
            Actions
            ══════════════════════════════════════════════ */}
        <hr className="kb-form__divider" />

        <div style={{ display: "flex", gap: 12 }}>
          <Button variant="solid" label="Save" type="submit" />
          <Button
            variant="outline"
            label="Reset"
            type="button"
            onClick={() => {
              form.reset()
              setSubmittedData(null)
              setSelectedDataset(0)
              setSyncMode("schedule")
              setScheduleTab("cron")
              setProcessingMode("standard")
              setChunkSize(850)
              setOverlapTokens(40)
            }}
          />
        </div>

        {submittedData !== null && (
          <div className="kb-form__output">
            <Typography Component="h3" fontSize="fs14" boldness="semibold">
              Saved Values
            </Typography>
            <pre className="kb-form__pre">
              {JSON.stringify({
                ...submittedData,
                selectedDataset: SAMPLE_DATASETS[selectedDataset]?.name,
                syncMode,
                scheduleTab,
                processingMode,
                chunkSize,
                overlapTokens,
                overlapPercent: `${overlapPercent}%`,
              }, null, 2)}
            </pre>
          </div>
        )}
      </Form>
    </div>
  )
}
