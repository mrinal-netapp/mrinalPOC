import type {
  DatasetInputType,
  DatasetKind,
  FolderScope,
  LastModifiedFilter,
  ResourceSelectorEntry,
  ScheduleType,
} from "@/api/dataset.types";
import type { DataSourceCategory, DataSourceProtocol } from "@/api/data-source.types";

// -- Types --

export type SizeFormUnit = "KB" | "MB" | "GB";

/** Which dataset scope options are available for a given data source category. */
export interface ScopeAvailability {
  folder: boolean;
  file: boolean;
  schema: boolean;
}

/**
 * Maps a data source category → the dataset scope options it allows.
 *   Volume / Object Store → folder + file scope
 *   Database              → schema scope
 *   Storage System / API  → nothing
 * A null/unknown category (no data source selected yet, or category not provided)
 * imposes no constraint so the form stays usable.
 */
/** Shown when file scope is disabled because the dataset kind is not unstructured. */
export const FILE_SCOPE_UNSUPPORTED_KIND_MESSAGE =
  "File scope is only available for unstructured datasets.";

/** File scope filters apply to unstructured datasets only (e.g. *.pdf, *.docx). */
export function isFileScopeAvailableForKind(
  kind: DatasetKind | "",
  scope: ScopeAvailability,
): boolean {
  return scope.file && kind === "unstructured";
}

/** Shown when folder scope is disabled because the data source isn't NFS. */
export const FOLDER_SCOPE_UNSUPPORTED_SOURCE_MESSAGE =
  "Folder scope is only available for NFS data sources.";

/**
 * Folder scope is only meaningful for NFS-protocol volumes — SMB/S3 volumes,
 * object stores, and connector-backed sources (database/API/storage system)
 * don't support it even though their category may otherwise allow it.
 * A null/undefined sourceType (no data source selected yet, or its detail is
 * still loading) imposes no additional constraint beyond the category check,
 * mirroring `getScopeAvailability`'s own null-category handling.
 */
export function isFolderScopeAvailableForSource(
  scope: ScopeAvailability,
  sourceType: DataSourceProtocol | null | undefined,
): boolean {
  if (!scope.folder) {
    return false;
  }
  return sourceType == null || sourceType === "NFS";
}

const UNSTRUCTURED_COMPATIBLE_CATEGORIES = new Set<DataSourceCategory>([
  "Volume",
  "Object Store",
]);

const STRUCTURED_COMPATIBLE_CATEGORIES = new Set<DataSourceCategory>([
  "Database",
  "Storage System",
]);

/**
 * Whether a data source can be used with the selected dataset kind.
 * A null/undefined category means the taxonomy is unavailable (e.g. legacy
 * or just-created sources); treat as compatible so those sources stay visible
 * rather than being silently hidden from the picker.
 */
export function isDataSourceCompatibleWithDatasetKind(
  category: DataSourceCategory | null | undefined,
  kind: DatasetKind | "",
): boolean {
  if (!category) {
    return true;
  }
  if (kind === "structured") {
    return STRUCTURED_COMPATIBLE_CATEGORIES.has(category);
  }
  return UNSTRUCTURED_COMPATIBLE_CATEGORIES.has(category);
}

export function getScopeAvailability(
  category: DataSourceCategory | null | undefined,
): ScopeAvailability {
  switch (category) {
    case "Volume":
    case "Object Store":
      return { folder: true, file: true, schema: false };
    case "Database":
      return { folder: false, file: false, schema: true };
    case "Storage System":
    case "API":
      return { folder: false, file: false, schema: false };
    default:
      return { folder: true, file: true, schema: true };
  }
}

/**
 * Collapses the 5-value category to the binary origin kind the dataset
 * create/update API needs (`originVolume` vs `originConnector`):
 *   Volume → 'volume'; everything else → 'connector'.
 * Returns undefined for an unknown/null category so the caller can omit the
 * field (the slice then defaults to the volume origin, preserving prior behavior).
 */
export function toDataSourceOriginKind(
  category: DataSourceCategory | null | undefined,
): "volume" | "connector" | undefined {
  if (category == null) {
    return undefined;
  }
  return category === "Volume" ? "volume" : "connector";
}

// -- Constants --

export const DEFAULT_LABEL_ITEMS = [
  { key: "staging", value: "staging", label: "Staging" },
  { key: "production", value: "production", label: "Production" },
  { key: "development", value: "development", label: "Development" },
  { key: "backup", value: "backup", label: "Backup" },
  { key: "nfs", value: "nfs", label: "NFS" },
  { key: "smb", value: "smb", label: "SMB" },
  { key: "s3", value: "s3", label: "S3" },
];

export const DESCRIPTION_MAX_LENGTH = 500;

export const MAX_FILE_SIZE_BYTES = 100 * 1_000_000_000; // 100 GB

export const INPUT_TYPE_OPTIONS: { value: DatasetInputType; title: string; description: string; isDisabled?: boolean }[] = [
  { value: "data-source", title: "Use existing data source", description: "Select and filter content from an added data source" },
  { value: "upload", title: "Upload from computer", description: "Upload files from your local machine" },
];

export const DATASET_KIND_OPTIONS: { value: DatasetKind; title: string; description: string }[] = [
  { value: "unstructured", title: "Unstructured", description: "Documents, files, text, and images" },
  { value: "structured", title: "Structured", description: "Database tables, metrics, and SQL-defined data" },
];

export const FOLDER_SCOPE_OPTIONS: { value: FolderScope; label: string }[] = [
  { value: "all", label: "Use all folders" },
  { value: "custom", label: "Use custom selection" },
];

export const LAST_MODIFIED_OPTIONS: { value: LastModifiedFilter; label: string }[] = [
  { value: "all", label: "Any time" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "1y", label: "Last year" },
];

export const SCHEDULE_TYPE_OPTIONS: { value: ScheduleType; label: string }[] = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

export const FILE_TYPE_OPTIONS = [
  { key: ".pdf", value: ".pdf", label: ".pdf" },
  { key: ".docx", value: ".docx", label: ".docx" },
  { key: ".txt", value: ".txt", label: ".txt" },
  { key: ".xlsx", value: ".xlsx", label: ".xlsx" },
];

export const SIZE_UNIT_OPTIONS = [
  { key: "KB", value: "KB", label: "KB" },
  { key: "MB", value: "MB", label: "MB" },
  { key: "GB", value: "GB", label: "GB" },
];

// -- Form value shape --

export type SyncScheduleMode = "builder" | "cron";

export interface DatasetFormValues {
  input_type: DatasetInputType;
  /** Defaults to unstructured in create mode; empty only transiently before hydration. */
  kind: DatasetKind | "";
  name: string;
  description: string;
  labels: (string | number)[];

  // Data source mode
  data_source_id: string;
  /** Category of the selected data source; gates which scope options are available. UI-only. */
  data_source_category: DataSourceCategory | null;

  // Upload mode
  uploaded_files: File[];

  // Spec
  spec: {
    folder_scope: FolderScope;
    paths: string[];
    file_types: string;
    last_modified_filter: LastModifiedFilter;
    max_file_size_bytes: string;
    size_unit: SizeFormUnit;
    exclude_patterns: string;
  };

  /**
   * Connector-resource selectors for connector-backed sources (object store /
   * database / metrics). Each entry is the chosen explorer node's `resource`
   * payload. Empty for volume sources, which use `spec.paths`. Persisted as
   * backend `resourceSelector`.
   */
  resource_selector: ResourceSelectorEntry[];

  /** Schema-scope SQL query (structured datasets). Persisted as backend `sqlQuery`. */
  schema_query: string;

  // Sync schedule
  sync_enabled: boolean;
  /** Builder vs cron tab; drives payload and submit validation. */
  sync_schedule_mode: SyncScheduleMode;
  refresh_config: {
    schedule_type: ScheduleType;
    interval_minutes: number;
    time_of_day_hour: number;
    time_of_day_minute: number;
    day_of_week: number[];
    day_of_month: number;
    cron_expression: string;
    paused: boolean;
  };
}
