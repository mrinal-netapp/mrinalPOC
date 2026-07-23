import type {
  DatasetDetail,
  DatasetRefreshConfig,
  DatasetSpec,
  DatasetUpdateRequest,
  ScheduleType,
} from "@/api/dataset.types";
import type { DataSourceCategory } from "@/api/data-source.types";

import {
  MAX_FILE_SIZE_BYTES,
  type DatasetFormValues,
  type SizeFormUnit,
} from "./dataset-form.consts";

const BYTES_PER_KB = 1_000;
const BYTES_PER_MB = 1_000_000;
const BYTES_PER_GB = 1_000_000_000;

/**
 * Maps API `max_file_size_bytes` to form display: prefer GB if evenly divisible, else MB, else KB.
 * Value string is the amount in the chosen unit (not raw bytes on screen).
 */
export function maxFileSizeBytesToFormDisplay(
  maxFileSizeBytes: number | null | undefined,
): { value: string; size_unit: SizeFormUnit } {
  if (maxFileSizeBytes == null || maxFileSizeBytes === 0) {
    return { value: "", size_unit: "MB" };
  }
  if (!Number.isFinite(maxFileSizeBytes) || maxFileSizeBytes < 0) {
    return { value: "", size_unit: "MB" };
  }
  const bytes = Math.trunc(maxFileSizeBytes);
  if (bytes % BYTES_PER_GB === 0) {
    return { value: String(bytes / BYTES_PER_GB), size_unit: "GB" };
  }
  if (bytes % BYTES_PER_MB === 0) {
    return { value: String(bytes / BYTES_PER_MB), size_unit: "MB" };
  }
  const kb = bytes / BYTES_PER_KB;
  if (Number.isInteger(kb)) {
    return { value: String(kb), size_unit: "KB" };
  }
  // Byte counts are integers; in KB the fractional part is at most 3 digits.
  const value = String(Number(kb.toFixed(3)));
  return { value, size_unit: "KB" };
}

function parseTimeOfDay(tod: string | null): { hour: number; minute: number } {
  if (!tod) return { hour: 0, minute: 0 };
  const parts = tod.split(":");
  return {
    hour: Number(parts[0]) || 0,
    minute: Number(parts[1]) || 0,
  };
}

/** When API used `schedule_type: "cron"`, form builder radios use a non-cron type. */
export function toBuilderScheduleType(
  st: ScheduleType | undefined,
): "hourly" | "daily" | "weekly" | "monthly" {
  if (st === "hourly" || st === "daily" || st === "weekly" || st === "monthly") {
    return st;
  }
  return "daily";
}

/** Best-effort category from dataset origin kind before the linked source is fetched. */
function categoryFromOriginKind(
  originKind: DatasetDetail["data_source_origin_kind"],
): DataSourceCategory | null {
  if (originKind === "volume") return "Volume";
  return null;
}

export function buildDefaultValues(initialData?: DatasetDetail): DatasetFormValues {
  if (initialData) {
    const spec = initialData.spec ?? {};
    const rc = initialData.refresh_config;
    const tod = parseTimeOfDay(rc?.time_of_day ?? null);
    const isCronFromApi = rc?.schedule_type === "cron";
    const sizeForm = maxFileSizeBytesToFormDisplay(spec.max_file_size_bytes);

    return {
      input_type: initialData.input_type,
      kind: initialData.kind,
      name: initialData.name,
      description: initialData.description ?? "",
      labels: initialData.labels,
      data_source_id: initialData.data_source?.dsrc_id ?? "",
      // Volume origin → "Volume" immediately; connector origin resolved when source loads.
      data_source_category: categoryFromOriginKind(initialData.data_source_origin_kind),
      uploaded_files: [],
      spec: {
        folder_scope: spec.folder_scope ?? "all",
        paths: spec.paths?.length ? spec.paths : ["/"],
        file_types: (spec.file_types ?? []).join(", "),
        last_modified_filter: spec.last_modified_filter ?? "all",
        max_file_size_bytes: sizeForm.value,
        size_unit: sizeForm.size_unit,
        exclude_patterns: (spec.exclude_patterns ?? []).join(", "),
      },
      resource_selector: initialData.resource_selector ?? [],
      schema_query: initialData.sql_query ?? "",
      sync_enabled: rc?.auto_refresh_enabled ?? false,
      sync_schedule_mode: isCronFromApi ? "cron" : "builder",
      refresh_config: {
        schedule_type: toBuilderScheduleType(rc?.schedule_type),
        interval_minutes: rc?.interval_minutes ?? 1,
        time_of_day_hour: tod.hour,
        time_of_day_minute: tod.minute,
        day_of_week: rc?.day_of_week ?? [],
        day_of_month: rc?.day_of_month ?? 1,
        cron_expression: rc?.cron_expression ?? "",
        paused: rc?.paused ?? false,
      },
    };
  }

  return {
    input_type: "data-source",
    kind: "unstructured",
    name: "",
    description: "",
    labels: [],
    data_source_id: "",
    data_source_category: null,
    uploaded_files: [],
    spec: {
      folder_scope: "all",
      paths: ["/"],
      file_types: "",
      last_modified_filter: "all",
      max_file_size_bytes: "",
      size_unit: "MB",
      exclude_patterns: "",
    },
    resource_selector: [],
    schema_query: "",
    sync_enabled: false,
    sync_schedule_mode: "builder",
    refresh_config: {
      schedule_type: "daily",
      interval_minutes: 1,
      time_of_day_hour: 0,
      time_of_day_minute: 0,
      day_of_week: [],
      day_of_month: 1,
      cron_expression: "",
      paused: false,
    },
  };
}

export function buildSpecPayload(values: DatasetFormValues): DatasetSpec {
  const sizeMultiplier = values.spec.size_unit === "GB" ? BYTES_PER_GB : values.spec.size_unit === "KB" ? BYTES_PER_KB : BYTES_PER_MB;
  const raw = Number(values.spec.max_file_size_bytes);
  const sizeNum = Number.isFinite(raw) && raw > 0 ? raw : 0;
  const customPaths = values.spec.folder_scope === "custom"
    ? values.spec.paths.map((p) => String(p).trim()).filter((p) => p.length > 0)
    : [];
  return {
    folder_scope: values.spec.folder_scope,
    paths: values.spec.folder_scope === "custom" && customPaths.length > 0 ? customPaths : undefined,
    file_types: values.spec.file_types.trim()
      ? values.spec.file_types.split(",").map((p) => p.trim()).filter(Boolean)
      : undefined,
    last_modified_filter: values.spec.last_modified_filter !== "all" ? values.spec.last_modified_filter : undefined,
    max_file_size_bytes: sizeNum > 0 ? Math.min(sizeNum * sizeMultiplier, MAX_FILE_SIZE_BYTES) : undefined,
    exclude_patterns: values.spec.exclude_patterns.trim()
      ? values.spec.exclude_patterns.split(",").map((p) => p.trim()).filter(Boolean)
      : undefined,
  };
}

export function buildRefreshConfigPayload(values: DatasetFormValues): DatasetRefreshConfig | undefined {
  if (!values.sync_enabled) {
    return undefined;
  }

  const rc = values.refresh_config;
  const toInt = (v: unknown): number => {
    const n = Math.trunc(Number(v));
    return Number.isNaN(n) ? 0 : n;
  };
  const padTwo = (n: number): string => String(n).padStart(2, "0");
  const th = toInt(rc.time_of_day_hour);
  const tmin = toInt(rc.time_of_day_minute);
  const timeOfDay = `${padTwo(th)}:${padTwo(tmin)}`;

  if (values.sync_schedule_mode === "cron") {
    const expression = (rc.cron_expression ?? "").trim();
    return {
      auto_refresh_enabled: true,
      schedule_type: "cron",
      interval_minutes: undefined,
      time_of_day: null,
      day_of_week: null,
      day_of_month: null,
      timezone: null,
      cron_expression: expression || null,
      paused: rc.paused,
    };
  }

  const st = toBuilderScheduleType(rc.schedule_type);

  return {
    auto_refresh_enabled: true,
    schedule_type: st,
    interval_minutes: st === "hourly" ? toInt(rc.interval_minutes) : undefined,
    time_of_day: st !== "hourly" ? timeOfDay : null,
    day_of_week: st === "weekly" ? rc.day_of_week : null,
    day_of_month: st === "monthly" ? toInt(rc.day_of_month) : null,
    timezone: null,
    cron_expression: null,
    paused: rc.paused,
  };
}

/**
 * Compares current form values against the original dataset and returns
 * only the fields that actually changed. Prevents the backend from
 * triggering side-effects (e.g. Temporal workflow reschedule) for
 * unchanged fields like refresh_config.
 *
 * Both sides are compared by round-tripping through the same payload
 * builders so shape differences (e.g. `undefined` vs missing key,
 * `[]` vs `undefined`) don't produce false positives.

 * Builds an explicit "schedule disabled" refresh config. Used when the user
 * turns the schedule OFF in edit mode: `buildRefreshConfigPayload` returns
 * `undefined` for a disabled schedule, but the update path must send something
 * the backend can act on (auto_refresh_enabled=false) — otherwise the disable
 * is silently dropped and the old schedule persists.
 */
function buildDisabledRefreshConfig(values: DatasetFormValues): DatasetRefreshConfig {
  const rc = values.refresh_config;
  const toInt = (v: unknown): number => {
    const n = Math.trunc(Number(v));
    return Number.isNaN(n) ? 0 : n;
  };
  const padTwo = (n: number): string => String(n).padStart(2, "0");
  const th = toInt(rc.time_of_day_hour);
  const tmin = toInt(rc.time_of_day_minute);
  const timeOfDay = `${padTwo(th)}:${padTwo(tmin)}`;

  if (values.sync_schedule_mode === "cron") {
    const expression = (rc.cron_expression ?? "").trim();
    return {
      auto_refresh_enabled: false,
      schedule_type: "cron",
      interval_minutes: undefined,
      time_of_day: null,
      day_of_week: null,
      day_of_month: null,
      timezone: null,
      cron_expression: expression || null,
      paused: rc.paused,
    };
  }

  const st = toBuilderScheduleType(rc.schedule_type);
  return {
    auto_refresh_enabled: false,
    schedule_type: st,
    interval_minutes: st === "hourly" ? toInt(rc.interval_minutes) : undefined,
    time_of_day: st !== "hourly" ? timeOfDay : null,
    day_of_week: st === "weekly" ? rc.day_of_week : null,
    day_of_month: st === "monthly" ? toInt(rc.day_of_month) : null,
    timezone: null,
    cron_expression: null,
    paused: rc.paused,
  };
}

export function buildEditDelta(
  values: DatasetFormValues,
  initialData: DatasetDetail,
): DatasetUpdateRequest {
  const delta: DatasetUpdateRequest = {};

  // Round-trip initialData through form defaults → payload builders
  // so both sides share the exact same shape for comparison.
  const baselineFormValues = buildDefaultValues(initialData);

  // Compare with `|| undefined` so "" and undefined are treated as equal, but
  // send the raw string on change so clearing the description (→ "") is
  // persisted (the slice drops `undefined`, which would otherwise no-op).
  const newDescription = values.description || undefined;
  const oldDescription = baselineFormValues.description || undefined;
  if (newDescription !== oldDescription) {
    delta.description = values.description ?? "";
  }

  const newLabels = [...(values.labels as string[])].sort();
  const oldLabels = [...(baselineFormValues.labels as string[])].sort();
  if (JSON.stringify(newLabels) !== JSON.stringify(oldLabels)) {
    delta.labels = values.labels as string[];
  }

  const newSpec = buildSpecPayload(values);
  const oldSpec = buildSpecPayload(baselineFormValues);
  if (JSON.stringify(newSpec) !== JSON.stringify(oldSpec)) {
    delta.spec = newSpec;
  }

  const newSqlQuery = values.schema_query.trim();
  const oldSqlQuery = baselineFormValues.schema_query.trim();
  if (newSqlQuery !== oldSqlQuery) {
    delta.sql_query = newSqlQuery;
  }

  // Connector-resource selectors. Compared by JSON so reordering or content
  // changes are detected; sent (even when emptied) so cleared connector
  // selections overwrite stale backend values.
  const newResourceSelector = values.resource_selector ?? [];
  const oldResourceSelector = baselineFormValues.resource_selector ?? [];
  if (JSON.stringify(newResourceSelector) !== JSON.stringify(oldResourceSelector)) {
    delta.resource_selector = newResourceSelector;
  }

  if (values.input_type !== "upload" && initialData.input_type !== "upload") {
    const newRefreshConfig = buildRefreshConfigPayload(values);
    const oldRefreshConfig = buildRefreshConfigPayload(baselineFormValues);
    if (JSON.stringify(newRefreshConfig) !== JSON.stringify(oldRefreshConfig)) {
      // When the schedule was turned OFF, `newRefreshConfig` is undefined; send an
      // explicit disabled config so the backend actually clears the schedule.
      delta.refresh_config = newRefreshConfig ?? buildDisabledRefreshConfig(values);
    }
  }

  return delta;
}
