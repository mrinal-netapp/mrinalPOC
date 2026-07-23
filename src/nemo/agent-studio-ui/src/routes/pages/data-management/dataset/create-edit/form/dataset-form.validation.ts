import type { GlobalFormValidationError } from "@tanstack/form-core"
import type { AnyFieldApi } from "@tanstack/react-form"

import type { DatasetInputType, ResourceSelectorEntry } from "@/api/dataset.types"
import { validateCronExpression } from "@/ui-lib/base-components/cron-expression-input/cron-expression-input.util"
import type { DatasetFormValues } from "./dataset-form.consts"
import { parseDatabaseTableResource } from "./database-scope.utils"

/**
 * Dataset form validation: TanStack Form global `onSubmit` rules plus helpers for
 * the hidden `data_source_id` field. Split into (1) per-field validators and (2) submit-time
 * collectors for spec paths and sync schedule, so the main form and the sync settings dialog
 * can reuse the same schedule logic without duplicating it.
 */

const DATA_SOURCE_ID_MISSING = "Data source id is missing"

/** Coerce a form value to a number and enforce an inclusive [min, max] range. */
function parseNum(
  v: unknown,
  min: number,
  max: number,
  label: string,
): { ok: true; n: number } | { ok: false; message: string } {
  if (v === undefined || v === null) {
    return { ok: false, message: `${label} is required.` }
  }
  let raw: unknown = v
  if (typeof v === "string") {
    const s = v.trim()
    if (s === "" || s === "-") {
      return { ok: false, message: `${label} is required.` }
    }
    raw = s
  }
  const n = Number(raw)
  if (Number.isNaN(n)) {
    return { ok: false, message: `${label} must be a number.` }
  }
  if (n < min || n > max) {
    return { ok: false, message: `${label} must be between ${min} and ${max}.` }
  }
  return { ok: true, n }
}

/** Satisfies TanStack’s `fields` shape; keys are dot-paths under `DatasetFormValues`. */
function toFieldErrorMap(
  src: Record<string, string | undefined>,
): GlobalFormValidationError<DatasetFormValues>["fields"] {
  return src as GlobalFormValidationError<DatasetFormValues>["fields"]
}

/**
 * `data_source_id` (table row selection) when the user is in data-source mode, not “upload file”.
 * Used by the registered `form.Field` for that hidden field, not only by the root `onSubmit`.
 */
function getDataSourceIdFieldError(value: unknown, inputType: DatasetInputType): string | undefined {
  if (inputType !== "data-source") {
    return undefined
  }
  if (String(value ?? "").trim() !== "") {
    return undefined
  }
  return DATA_SOURCE_ID_MISSING
}

/**
 * Hidden `data_source_id` field: re-run when the data source table updates the id.
 * - onChange: show an error only after the user has tried to submit at least once, so we do
 *   not flash “missing” before they can pick a row.
 * - onSubmit: always validate, so a submit without a row fails.
 */
const dataSourceIdFieldValidators: {
  onChange: (o: { value: string; fieldApi: AnyFieldApi }) => string | undefined
  onSubmit: (o: { value: string; fieldApi: AnyFieldApi }) => string | undefined
} = {
  onChange: ({ value, fieldApi }) => {
    if (String(value ?? "").trim() !== "") {
      return undefined
    }
    const inputType = (fieldApi.form.state.values as DatasetFormValues).input_type
    const err = getDataSourceIdFieldError(value, inputType)
    if (err == null) {
      return undefined
    }
    return fieldApi.form.state.submissionAttempts > 0 ? err : undefined
  },
  onSubmit: ({ value, fieldApi }) =>
    getDataSourceIdFieldError(
      value,
      (fieldApi.form.state.values as DatasetFormValues).input_type,
    ) ?? undefined,
}

/** Mirrors config-service `isMetricCategorySelectorEntry` / `resourceSelectorHasMetricCategory`. */
function isMetricCategorySelectorEntry(entry: ResourceSelectorEntry): boolean {
  return typeof entry.category === "string"
}

function resourceSelectorHasMetricCategory(
  selector: ResourceSelectorEntry[] | undefined,
): boolean {
  return (selector ?? []).some(isMetricCategorySelectorEntry)
}

/**
 * Structured datasets require a schema-scope SQL query unless the resource
 * selector contains at least one metric-category entry (backend skips
 * sqlQuery whenever any entry has a category field, not only when the
 * selector is exclusively metric-category entries).
 * Mirrors createDataSetValidator in config-service/validators/dataSetValidator.ts.
 */
function structuredSchemaQueryRequired(value: DatasetFormValues): boolean {
  return (
    value.kind === "structured"
    && !resourceSelectorHasMetricCategory(value.resource_selector)
  )
}

const SCHEMA_QUERY_REQUIRED = "A schema-scope SQL query is required for structured datasets."
const RESOURCE_SELECTOR_REQUIRED =
  "Select at least one table or view in Data source scope."
const SINGLE_SCOPE_ENTRY =
  "Only one scope entry is allowed. The latest selection replaces the previous one."

const DATASET_NAME_START_ERROR =
  "Name must start with a letter (a-z) or underscore (_)."
const DATASET_NAME_CHARSET_ERROR =
  "Name can only contain lowercase letters (a-z), numbers (0-9), underscores (_), and hyphens (-)."

function getDatasetNameFieldError(name: unknown): string | undefined {
  const trimmed = String(name ?? "").trim()
  if (!trimmed) {
    return "Name is required"
  }
  if (trimmed.length < 3) {
    return "Name must be at least 3 characters"
  }
  if (!/^[a-z_]/.test(trimmed)) {
    return DATASET_NAME_START_ERROR
  }
  if (!/^[a-z0-9_-]+$/.test(trimmed)) {
    return DATASET_NAME_CHARSET_ERROR
  }
  return undefined
}

/** Structured database datasets: category on the form, or table-shaped scope entries. */
function isDatabaseStructuredDataset(value: DatasetFormValues): boolean {
  if (value.input_type !== "data-source" || value.kind !== "structured") {
    return false
  }
  if (value.data_source_category === "Database") {
    return true
  }
  return (value.resource_selector ?? []).some((entry) => parseDatabaseTableResource(entry) !== null)
}

/**
 * Lightweight schema-scope SQL validation. This is a format/shape check (not a
 * full SQL parser): it catches the common "wrong format" mistakes inline so the
 * field behaves like a normal validated input. An empty query is valid only when
 * schema scope is optional (unstructured kind, or structured + metric categories).
 */
const SQL_FORBIDDEN_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|MERGE|GRANT|REVOKE|REPLACE)\b/i

/** Strips leading line and block SQL comments before validation. */
function stripLeadingSqlComments(raw: string): string {
  let q = raw.trim()
  for (;;) {
    if (q.startsWith("--")) {
      const newline = q.indexOf("\n")
      q = (newline === -1 ? "" : q.slice(newline + 1)).trimStart()
      continue
    }
    if (q.startsWith("/*")) {
      const end = q.indexOf("*/")
      q = (end === -1 ? "" : q.slice(end + 2)).trimStart()
      continue
    }
    return q
  }
}

function validateSqlQuery(raw: unknown): string | undefined {
  const q = String(raw ?? "").trim()
  if (q === "") {
    return undefined
  }
  const executable = stripLeadingSqlComments(q)
  if (executable === "") {
    return "Query must start with SELECT (or WITH)."
  }
  if (!/^(select|with)\b/i.test(executable)) {
    return "Query must start with SELECT (or WITH)."
  }
  // Scan for forbidden keywords only outside string literals so a read-only
  // query that merely mentions one inside a quoted string (e.g.
  // `SELECT 'drop' AS note`) isn't flagged. `''` escapes are handled.
  // Use `executable` (leading comments stripped) so auto-fill headers like
  // `-- Database: …` or `-- DROP` don't false-positive downstream checks.
  const qWithoutStrings = executable.replace(/'(?:[^']|'')*'/g, "")
  if (SQL_FORBIDDEN_KEYWORDS.test(qWithoutStrings)) {
    return "Only read-only SELECT queries are allowed."
  }
  // Balanced parentheses.
  let depth = 0
  for (const ch of executable) {
    if (ch === "(") {
      depth += 1
    } else if (ch === ")") {
      depth -= 1
      if (depth < 0) {
        return "Unbalanced parentheses in query."
      }
    }
  }
  if (depth !== 0) {
    return "Unbalanced parentheses in query."
  }
  // Balanced single quotes (string literals).
  if (((executable.match(/'/g) ?? []).length) % 2 !== 0) {
    return "Unterminated string literal — check your quotes."
  }
  // A single statement only (ignore a single trailing semicolon). Use the
  // string-literal-stripped text so a semicolon inside a quoted string
  // (e.g. `SELECT ';' AS sep`) isn't mistaken for a statement separator.
  if (qWithoutStrings.replace(/;\s*$/, "").includes(";")) {
    return "Only a single SELECT statement is allowed."
  }
  return undefined
}

/**
 * Field-level validators for the schema-scope SQL textarea. Mirrors the
 * onBlur + onSubmit pattern used by the schedule numeric inputs so the textarea
 * surfaces inline errors on blur and blocks submission when invalid.
 */
const schemaQueryFieldValidators: {
  onBlur: (o: { value: unknown; fieldApi: AnyFieldApi }) => string | undefined
  onSubmit: (o: { value: unknown; fieldApi: AnyFieldApi }) => string | undefined
} = {
  onBlur: ({ value }) => validateSqlQuery(value),
  onSubmit: ({ value, fieldApi }) => {
    const formValues = fieldApi.form.state.values as DatasetFormValues
    if (structuredSchemaQueryRequired(formValues) && String(value ?? "").trim() === "") {
      return SCHEMA_QUERY_REQUIRED
    }
    return validateSqlQuery(value)
  },
}

/** When folder scope is “custom”, require at least one non-empty path. Data source presence is covered by `dataSourceIdFieldValidators`. */
function collectSpecPathErrors(value: DatasetFormValues): Record<string, string> {
  const out: Record<string, string> = {}

  if (value.input_type === "data-source" && value.spec.folder_scope === "custom") {
    const pathList = (value.spec.paths ?? []).map((p) => String(p).trim()).filter((p) => p.length > 0)
    if (pathList.length < 1) {
      out["spec.paths"] = "Add at least one folder path"
    } else if (pathList.length > 1) {
      out["spec.paths"] = SINGLE_SCOPE_ENTRY
    }
  }

  return out
}

/** Schema-scope SQL: required for structured (non-metric) datasets; format-checked when present. */
function collectSchemaQueryErrors(value: DatasetFormValues): Record<string, string> {
  const out: Record<string, string> = {}
  const trimmed = String(value.schema_query ?? "").trim()

  if (structuredSchemaQueryRequired(value) && trimmed === "") {
    out["schema_query"] = SCHEMA_QUERY_REQUIRED
    return out
  }

  const msg = validateSqlQuery(value.schema_query)
  if (msg) {
    out["schema_query"] = msg
  }
  return out
}

/** Name is required on create; edit mode keeps the existing name read-only. */
function collectNameErrors(value: DatasetFormValues, isEdit = false): Record<string, string> {
  if (isEdit) {
    return {}
  }
  const msg = getDatasetNameFieldError(value.name)
  return msg ? { name: msg } : {}
}

/** Database-backed structured datasets require at least one scope entry. */
function collectResourceSelectorErrors(value: DatasetFormValues): Record<string, string> {
  const out: Record<string, string> = {}

  if (
    isDatabaseStructuredDataset(value)
    && !(value.resource_selector?.length)
  ) {
    out.resource_selector = RESOURCE_SELECTOR_REQUIRED
  }

  const databaseTableCount = (value.resource_selector ?? []).filter(
    (entry) => parseDatabaseTableResource(entry) !== null,
  ).length
  if (isDatabaseStructuredDataset(value) && databaseTableCount > 1) {
    out.resource_selector = SINGLE_SCOPE_ENTRY
  }

  return out
}

/**
 * When `sync_enabled` is true, validate the builder fields for the current `schedule_type`,
 * or the cron string when the user is on the cron tab.
 *
 * Note: the cron `CronExpressionField` can surface its own message on blur; this submit-time
 * check is still required so the API never receives an invalid expression if the user skipped blur.
 */
function collectSyncScheduleErrors(value: DatasetFormValues): Record<string, string> {
  const out: Record<string, string> = {}

  if (value.input_type === "upload" || !value.sync_enabled) {
    return out
  }

  const refreshConfig = value.refresh_config

  /* v8 ignore else -- @preserve */ // sync_schedule_mode is "builder" | "cron"; the else branch is unreachable
  if (value.sync_schedule_mode === "builder") {
    const scheduleType = refreshConfig.schedule_type

    switch (scheduleType) {
      case "hourly": {
        const interval = parseNum(
          refreshConfig.interval_minutes,
          1,
          1440,
          "Interval (minutes)",
        )
        if (!interval.ok) {
          out["refresh_config.interval_minutes"] = interval.message
        }
        break
      }
      case "daily":
      case "weekly":
      case "monthly": {
        const hour = parseNum(refreshConfig.time_of_day_hour, 0, 23, "Hour (UTC)")
        if (!hour.ok) {
          out["refresh_config.time_of_day_hour"] = hour.message
        }
        const minute = parseNum(
          refreshConfig.time_of_day_minute,
          0,
          59,
          "Minute of the hour (UTC)",
        )
        if (!minute.ok) {
          out["refresh_config.time_of_day_minute"] = minute.message
        }
        if (scheduleType === "weekly" && (refreshConfig.day_of_week?.length ?? 0) < 1) {
          out["refresh_config.day_of_week"] = "Select at least one day"
        }
        if (scheduleType === "monthly") {
          const day = parseNum(refreshConfig.day_of_month, 1, 31, "Day of month")
          if (!day.ok) {
            out["refresh_config.day_of_month"] = day.message
          }
        }
        break
      }
      case "cron":
        break
      default: {
        const _exhaustive: never = scheduleType
        out["refresh_config.schedule_type"] = `Unsupported schedule type: ${_exhaustive}`
        break
      }
    }
  } else if (value.sync_schedule_mode === "cron") {
    const cronMsg = validateCronExpression(String(refreshConfig.cron_expression ?? ""))
    if (cronMsg) {
      out["refresh_config.cron_expression"] = cronMsg
    }
  }

  return out
}

/** Merges two error maps. `b` overwrites `a` on the same key. */
function mergeFieldErrors(
  a: Record<string, string>,
  b: Record<string, string>,
): GlobalFormValidationError<DatasetFormValues> | undefined {
  const fields = { ...a, ...b }
  if (Object.keys(fields).length === 0) {
    return undefined
  }
  return { fields: toFieldErrorMap(fields) }
}

const METRIC_CATEGORY_REQUIRES_STRUCTURED =
  'Datasets that select metric categories must have kind="structured"';

/** Kind must be explicitly chosen; metric-category selectors require structured. */
function collectKindErrors(value: DatasetFormValues): Record<string, string> {
  if (value.kind !== "structured" && value.kind !== "unstructured") {
    return { kind: "Dataset kind is required." }
  }
  if (
    resourceSelectorHasMetricCategory(value.resource_selector)
    && value.kind !== "structured"
  ) {
    return { kind: METRIC_CATEGORY_REQUIRES_STRUCTURED }
  }
  return {}
}

/**
 * Create/edit dataset form submit: spec paths (when applicable), kind, and sync schedule.
 * Does not duplicate `data_source_id` checks; those are on the `data_source_id` `Field` validators.
 */
function validateDatasetFormOnSubmit({
  value,
  isEdit = false,
}: {
  value: DatasetFormValues
  isEdit?: boolean
}):
  | GlobalFormValidationError<DatasetFormValues>
  | undefined {
  return mergeFieldErrors(
    {
      ...collectNameErrors(value, isEdit),
      ...collectSpecPathErrors(value),
      ...collectResourceSelectorErrors(value),
      ...collectSchemaQueryErrors(value),
      ...collectKindErrors(value),
    },
    collectSyncScheduleErrors(value),
  )
}

/**
 * Sync settings dialog submit: only `collectSyncScheduleErrors` (no data source or folder path rules).
 */
function validateSyncSettingsDialogOnSubmit({ value }: { value: DatasetFormValues }):
  | GlobalFormValidationError<DatasetFormValues>
  | undefined {
  const fields = collectSyncScheduleErrors(value)
  if (Object.keys(fields).length === 0) {
    return undefined
  }
  return { fields: toFieldErrorMap(fields) }
}

export {
  validateDatasetFormOnSubmit,
  validateSyncSettingsDialogOnSubmit,
  getDataSourceIdFieldError,
  getDatasetNameFieldError,
  dataSourceIdFieldValidators,
  validateSqlQuery,
  schemaQueryFieldValidators,
  parseNum,
  DATA_SOURCE_ID_MISSING,
}
