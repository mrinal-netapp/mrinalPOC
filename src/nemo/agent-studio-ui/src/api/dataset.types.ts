import type { BaseListParams, ScheduleConfig } from './api.types';

// -- Enums --

export type DatasetInputType = 'data-source' | 'upload';

/** Backend dataset kind — unstructured (files/docs) vs structured (tables/metrics/SQL). */
export type DatasetKind = 'structured' | 'unstructured';

/**
 * Moved here from data-source.types.ts — single source of truth.
 * data-source.types.ts re-imports this type.
 */
export type DatasetLifecycleStatus = 'in_progress' | 'ready' | 'errored' | 'deprecated';

export type DatasetStatus = 'Draft' | 'Healthy' | 'Importing' | 'Unhealthy' | 'Ready' | 'Failed';

export type SynchronizationStatus =
  | 'Completed'
  | 'Synchronizing'
  | 'Failed'
  | 'Pending'
  | 'Never';

export type SnapshotStatus = 'pending' | 'in-progress' | 'completed' | 'errored';

export type FolderScope = 'all' | 'custom';

export type LastModifiedFilter = 'all' | '7d' | '30d' | '90d' | '1y';

export type ScheduleType = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'cron';

/** Binary origin kind for routing `data_source_id` → `originVolume` vs `originConnector`. */
export type DataSourceOriginKind = 'volume' | 'connector';

// -- Sub-objects --

export interface DataSourceRef {
  dsrc_id: string;
  name: string;
}

export interface DatasetSpec {
  folder_scope?: FolderScope;
  paths?: string[];
  file_types?: string[];
  last_modified_filter?: LastModifiedFilter;
  max_file_size_bytes?: number | null;
  exclude_patterns?: string[];
}

/**
 * A single connector-resource selector entry. For connector-backed (non-volume)
 * data sources, scope is expressed as structured selectors rather than folder
 * path strings — e.g. `{ bucket, prefix }` (object store), `{ database, schema,
 * table }` (database), or `{ category }` (metrics). Each entry is the `resource`
 * payload of a node chosen in the connector explorer. Maps to backend
 * `resourceSelector` (Array<Record<string, any>>).
 */
export type ResourceSelectorEntry = Record<string, unknown>;

export interface DatasetRefreshConfig extends ScheduleConfig {
  auto_refresh_enabled: boolean;
  schedule_type: ScheduleType;
  timezone: string | null;
  paused: boolean;
}

export interface SynchronizationSummary {
  status: SynchronizationStatus;
  schedule: string | null;
  last_completed_synchronization: string | null;
  next_scheduled_synchronization: string | null;
}

export interface DatasetLatestSnapshot {
  id: string;
  version: number;
  date: string;
  total_files: number;
  /** Omitted by current list API; shown as n/a in KB picker until present. */
  total_folders?: number;
  files_added: number;
  files_removed: number;
}

// -- Response interfaces --

export interface DatasetListItem {
  dset_id: string;
  name: string;
  kind: DatasetKind;
  data_source: DataSourceRef | null;
  /**
   * Which origin field links this dataset to its data source
   * (`originVolume` vs `originConnector`). Null for manual-upload datasets.
   * Always populated by normalizeDatasetListItem; optional so fixtures needn't specify it.
   */
  data_source_origin_kind?: DataSourceOriginKind | null;
  input_type: DatasetInputType;
  /** Raw backend import lifecycle — use for preview gating; independent of display `status`. */
  lifecycle_status: DatasetLifecycleStatus;
  status: DatasetStatus;
  deprecated: boolean;
  files_count: number;
  synchronization_status: SynchronizationStatus;
  /** Populated when backend status is `errored` (maps from `errorMessage`). */
  error_message?: string | null;
  latest_snapshot: DatasetLatestSnapshot | null;
  labels: string[];
  created_at: string;
  updated_at: string;
  modified_by: string;
}

export interface DatasetDetail extends DatasetListItem {
  description: string | null;
  spec: DatasetSpec | null;
  /**
   * Connector-resource selectors for connector-backed sources (object store /
   * database / metrics). Null/absent for volume sources, which use `spec.paths`.
   * Always populated by the mapper; optional here so fixtures/partials needn't
   * specify it. Maps to backend `resourceSelector`.
   */
  resource_selector?: ResourceSelectorEntry[] | null;
  /** Schema-scope SQL query for structured datasets (backend `sqlQuery`). */
  sql_query?: string | null;
  refresh_config: DatasetRefreshConfig | null;
  synchronization_summary: SynchronizationSummary | null;
  /** Iceberg/catalog namespace — required for dataset preview via the Analytics Engine. */
  catalog_namespace?: string | null;
  /** Iceberg/catalog table name — required for dataset preview via the Analytics Engine. */
  catalog_table_name?: string | null;
  /** Present when status is errored — surfaced on the detail header. */
  error_message?: string | null;
}

export interface UsedKnowledgeBase {
  kb_id: string;
  name: string;
}

export interface DatasetSnapshot {
  id: string;
  version: number | null;
  status: SnapshotStatus;
  total_files: number | null;
  total_folders: number | null;
  files_synced: number | null;
  files_added: number | null;
  files_removed: number | null;
  used_knowledge_base: UsedKnowledgeBase | null;
  expired: boolean;
  is_current: boolean;
  created_at: string;
}

export interface DatasetSnapshotListResponse {
  dataset_id: string;
  snapshots: DatasetSnapshot[];
}

export interface DatasetKBListItem {
  kb_id: string;
  name: string;
  status: DatasetStatus;
  file_scope: number;
  synchronization_schedule: string | null;
  synchronization_status: SynchronizationStatus;
  labels: string[];
  created_at: string;
}

export interface DatasetKBListResponse {
  dataset_id: string;
  knowledge_bases: DatasetKBListItem[];
}

export interface DatasetAcquireResponse {
  workflowId: string;
  status: string;
  datasetId: string;
}

// -- Request interfaces --

export interface DatasetCreateRequest {
  name: string;
  input_type: DatasetInputType;
  kind: DatasetKind;
  data_source_id?: string;
  /**
   * Required when data_source_id is set so the slice can route to
   * `originVolume` (volume/NFS/SMB) vs `originConnector` (connector-backed).
   * BACKEND GAP: backend has no generic originDataSourceId field — must be
   * removed once the backend accepts a unified field.
   */
  data_source_origin_kind?: DataSourceOriginKind;
  description?: string;
  labels?: string[];
  spec: DatasetSpec;
  /** Connector-resource selectors (object store / database / metrics sources). */
  resource_selector?: ResourceSelectorEntry[];
  /** Schema-scope SQL query (structured datasets). Maps to backend `sqlQuery`. */
  sql_query?: string;
  refresh_config?: DatasetRefreshConfig;
}

/**
 * A file uploaded to the dataset's `data_files/` S3 prefix, registered on the
 * draft manifest via `updateDataset`. Mirrors the backend `UploadedFileInfo`.
 */
export interface UploadedFileInfo {
  /** S3 object key relative to the bucket (no `s3://` scheme). */
  key: string;
  /** Full `s3://bucket/key` URI. */
  url: string;
  size?: number;
  /** Original (directory-relative) name for display/dedup. */
  originalName?: string;
}

export type DatasetManifestStatus = 'draft' | 'committed' | 'deprecated';

/** A single file recorded on a dataset manifest. */
export interface DatasetManifestFile {
  id: string;
  /** Display name / relative path of the file. */
  file_name: string;
  /** Full `s3://bucket/key` URI (nullable on older records). */
  uri: string | null;
}

/**
 * A dataset manifest — a versioned batch of files. The committed manifest is the
 * "live" file set; a draft is a staged batch awaiting commit (which triggers import).
 */
export interface DatasetManifest {
  id: string;
  manifest_id: number;
  status: DatasetManifestStatus;
  files: DatasetManifestFile[];
}

export interface DatasetUpdateRequest {
  name?: string;
  description?: string;
  data_source_id?: string;
  /** See DatasetCreateRequest.data_source_origin_kind for context. */
  data_source_origin_kind?: DataSourceOriginKind;
  labels?: string[];
  spec?: DatasetSpec;
  /** Connector-resource selectors (object store / database / metrics sources). */
  resource_selector?: ResourceSelectorEntry[];
  /** Schema-scope SQL query (structured datasets). Maps to backend `sqlQuery`. */
  sql_query?: string;
  refresh_config?: DatasetRefreshConfig;
  deprecated?: boolean;
  synchronization_status?: SynchronizationStatus;
  /**
   * Manual-upload files to register on the dataset's draft manifest. The
   * backend creates/replaces the draft and auto-commits the first batch,
   * triggering the import workflow. Maps to backend `uploadedFiles`.
   */
  uploaded_files?: UploadedFileInfo[];
}

export interface DatasetSnapshotUpdateRequest {
  status?: SnapshotStatus;
  is_current?: boolean;
  deprecated?: boolean;
}

// Backend filter mechanism uses ?field=X&value=Y (one field at a time), not named filter params.
// These filter fields are defined for future use but are NOT sent to the backend today.
// The listDatasets query() strips them and only forwards limit, skip, and nameRegex —
// the only params the backend validator currently accepts.
// Passing these fields to useListDatasetsQuery() has no effect at runtime.
// Remove this comment and wire them up once the backend extends its query validator.
export type DatasetListParams = BaseListParams;
