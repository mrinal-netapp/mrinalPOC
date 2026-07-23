/**
 * dataset.mapper.ts
 *
 * Translates raw backend responses (config-service) into the typed frontend
 * shapes defined in dataset.types.ts.
 *
 * Backend model                                → Frontend model
 * ────────────────────────────────────────────────────────────────
 * id (or dset_id fallback)                     → dset_id
 * type ('acquired'|'manual')                   → input_type ('data-source'|'upload')
 * status ('in_progress'|'ready'|'errored')     → status ('Importing'|'Ready'|'Failed'|...)
 * originVolume / originConnector               → data_source { dsrc_id, name }
 * data_source_type / origin fields             → data_source_origin_kind
 * createdAt / created_at                       → created_at  (handles both casings)
 * synchronization_status (pre-computed)        → synchronization_status (present on both list and detail; fallback: derived from status)
 * latest_snapshot / latestSnapshot             → latest_snapshot (present on both list and detail; null when no snapshot yet)
 * synchronization_summary                      → synchronization_summary (detail only)
 *
 * Iceberg snapshot (GET /datasets/:id/snapshots):
 * snapshotId (number)                          → id (string)
 * position in oldest→newest sort              → version (1-based)
 * timestampMs                                  → created_at (ISO string)
 * snapshotId === currentSnapshotId            → is_current
 * summary['total-data-files']                 → total_files
 * summary['added-data-files']                 → files_added
 * summary['deleted-data-files']               → files_removed
 *
 *
 * Knowledge-base reverse-lookup (GET /datasets/:id/knowledge-bases):
 * id                                           → kb_id
 * status (in_progress→Importing, ready→Ready…)  → status (DatasetStatus)
 * stats.fileCount                              → file_scope
 * scheduleConfig.cronExpression               → synchronization_schedule
 * status-derived                               → synchronization_status
 * labels                                       → labels
 *
 * Schedule config write (POST /datasets, PUT /datasets/:id):
 * DatasetRefreshConfig (frontend)              → { cronExpression, timezone, enabled } (backend)
 *   auto_refresh_enabled + !paused            → enabled
 *   cron_expression (if provided)             → cronExpression (direct)
 *   schedule_type + interval fields           → cronExpression (derived)
 *   timezone                                  → timezone (fallback 'UTC')
 *
 * Schedule config read (GET /datasets, GET /datasets/:id):
 * { cronExpression, timezone, enabled } (backend) → DatasetRefreshConfig (frontend)
 *   cronExpression                            → cron_expression; schedule_type: 'cron'
 *   timezone                                  → timezone
 *   enabled                                   → auto_refresh_enabled; paused: !enabled
 *
 * Fields with no backend equivalent are filled with safe defaults.
 */

import type {
  DatasetDetail,
  DatasetInputType,
  DatasetKBListItem,
  DatasetLifecycleStatus,
  DatasetListItem,
  DatasetManifest,
  DatasetRefreshConfig,
  DatasetSnapshot,
  DatasetSpec,
  DatasetStatus,
  DataSourceOriginKind,
  DatasetKind,
  LastModifiedFilter,
  ResourceSelectorEntry,
  SynchronizationStatus,
  SynchronizationSummary,
} from './dataset.types';

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord {
  return value !== null && typeof value === 'object' ? (value as RawRecord) : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveInputType(raw: unknown): DatasetInputType {
  const source = asRecord(raw);
  if (source.type === 'manual') return 'upload';
  // 'acquired' or anything with a data source reference → data-source
  return 'data-source';
}

function resolveLifecycleStatus(raw: unknown): DatasetLifecycleStatus {
  const s = String(asRecord(raw).status ?? '').toLowerCase();
  if (s === 'ready' || s === 'errored' || s === 'deprecated' || s === 'in_progress') {
    return s;
  }
  return 'in_progress';
}

function resolveStatus(raw: unknown): DatasetStatus {
  const s = String(asRecord(raw).status ?? '').toLowerCase();
  if (s === 'ready') return 'Ready';
  if (s === 'errored') return 'Failed';
  if (s === 'in_progress') return 'Importing';
  if (s === 'deprecated') return 'Unhealthy';
  return 'Draft';
}

function resolveSyncStatus(raw: unknown): SynchronizationStatus {
  const source = asRecord(raw);
  // Manual (upload) datasets have no external source to sync from — sync is
  // disabled for them in the UI, so their processing status should never be
  // reported as a synchronization outcome (e.g. "Completed") once ready.
  // While import is running or has failed, surface that here so the detail
  // header does not show a misleading "Never" beside a green Ready status.
  // Check type before any pre-computed synchronization_status so stale/partial
  // responses cannot surface "Completed" for manual uploads.
  if (source.type === 'manual') {
    const s = String(source.status ?? '').toLowerCase();
    if (s === 'in_progress') return 'Synchronizing';
    if (s === 'errored') return 'Failed';
    return 'Never';
  }
  // Prefer the pre-computed field from enrichDatasetsForResponse.
  // Fall back to deriving from the raw status enum for older/partial responses.
  if (source.synchronization_status) return source.synchronization_status as SynchronizationStatus;
  const s = String(source.status ?? '').toLowerCase();
  if (s === 'in_progress') return 'Synchronizing';
  if (s === 'ready') return 'Completed';
  if (s === 'errored') return 'Failed';
  return 'Never';
}

function sanitizeSynchronizationSummary(
  summary: SynchronizationSummary | null,
  syncStatus: SynchronizationStatus,
): SynchronizationSummary | null {
  if (!summary || syncStatus !== 'Never') return summary;
  // Stale backend responses may still carry import timestamps in sync fields
  // even when sync status is "Never" (e.g. manual uploads). Strip them so the
  // UI never shows a "last completed synchronization" that contradicts status.
  return {
    ...summary,
    status: 'Never',
    schedule: null,
    last_completed_synchronization: null,
    next_scheduled_synchronization: null,
  };
}

function resolveDataSourceOriginKind(raw: RawRecord): DataSourceOriginKind | null {
  const explicit = asNullableString(raw.data_source_type);
  if (explicit === 'volume' || explicit === 'connector') {
    return explicit;
  }
  if (raw.originConnector) return 'connector';
  if (raw.originVolume) return 'volume';
  return null;
}

// ---------------------------------------------------------------------------
// Public mappers
// ---------------------------------------------------------------------------

/**
 * Converts the frontend DatasetRefreshConfig → the backend rich `refreshConfig`
 * (JSONB) shape. Persisting this lets the backend derive `scheduleConfig` itself
 * (via applyRefreshConfig) AND round-trip the full schedule on edit, instead of
 * collapsing everything to a cron string.
 *
 * Only the fields relevant to the selected schedule_type are emitted, and `null`
 * values are omitted entirely — the backend validator (assertRefreshConfigShape)
 * rejects `timezone: null` and ignores fields that don't apply to the type.
 */
export function toBackendRefreshConfig(cfg: DatasetRefreshConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {
    auto_refresh_enabled: !!cfg.auto_refresh_enabled,
    paused: !!cfg.paused,
    schedule_type: cfg.schedule_type,
  };
  if (cfg.timezone) out.timezone = cfg.timezone;

  switch (cfg.schedule_type) {
    case 'hourly':
      if (cfg.interval_minutes != null) out.interval_minutes = cfg.interval_minutes;
      break;
    case 'daily':
      if (cfg.time_of_day) out.time_of_day = cfg.time_of_day;
      break;
    case 'weekly':
      if (cfg.time_of_day) out.time_of_day = cfg.time_of_day;
      if (cfg.day_of_week?.length) out.day_of_week = cfg.day_of_week;
      break;
    case 'monthly':
      if (cfg.time_of_day) out.time_of_day = cfg.time_of_day;
      if (cfg.day_of_month != null) out.day_of_month = cfg.day_of_month;
      break;
    case 'cron':
      if (cfg.cron_expression) out.cron_expression = cfg.cron_expression;
      break;
  }
  return out;
}

/**
 * Converts the backend scheduleConfig shape `{ cronExpression, timezone, enabled }`
 * back to `DatasetRefreshConfig` for form pre-fill.
 *
 * Information loss is unavoidable: a cron string cannot be reliably decomposed
 * into schedule_type + interval fields, so we always set schedule_type='cron'
 * and populate cron_expression. If the backend later returns a richer
 * `refresh_config` object, the caller should prefer that (see normalizeDataset).
 */
export function fromBackendScheduleConfig(raw: unknown): DatasetRefreshConfig | null {
  const source = asRecord(raw);
  const cronExpression = asNullableString(source.cronExpression) ?? asNullableString(source.cron_expression);
  if (!cronExpression) return null;
  return {
    auto_refresh_enabled: (source.enabled as boolean | undefined) ?? true,
    paused: !((source.enabled as boolean | undefined) ?? true),
    schedule_type: 'cron',
    timezone: (source.timezone as string | null | undefined) ?? null,
    cron_expression: cronExpression,
    interval_minutes: null,
    time_of_day: null,
    day_of_week: null,
    day_of_month: null,
  };
}

function resolveKind(raw: RawRecord): DatasetKind {
  const kind = asString(raw.kind);
  return kind === 'structured' ? 'structured' : 'unstructured';
}

/**
 * Maps a single raw backend Dataset object → typed DatasetListItem.
 */
export function normalizeDatasetListItem(rawInput: unknown): DatasetListItem {
  const raw = asRecord(rawInput);
  // Backend sends originVolume (for volume/NFS/SMB data sources) or
  // originConnector (for connector data sources) — not dataSourceId.
  const dataSourceId: string | null =
    asNullableString(raw.dataSourceId) ??
    asNullableString(raw.data_source_id) ??
    asNullableString(raw.originVolume) ??
    asNullableString(raw.originConnector) ??
    null;

  return {
    // BaseResource equivalent fields
    name: asString(raw.name),
    labels: Array.isArray(raw.labels) ? (raw.labels as string[]) : [],
    created_at: asString(raw.createdAt, asString(raw.created_at)),
    updated_at: asString(raw.updatedAt, asString(raw.updated_at)),

    // DatasetListItem
    // Prefer raw.id (canonical backend field). Fall back to raw.dset_id so the
    // mapper is safe when called on already-normalised data (mocks, fixtures,
    // transitional endpoints that pre-map the identifier).
    dset_id: asString(raw.id, asString(raw.dset_id)),
    kind: resolveKind(raw),
    data_source: dataSourceId
      ? { dsrc_id: dataSourceId, name: asString(raw.dataSourceName, asString(raw.data_source_name)) }
      : null,
    data_source_origin_kind: resolveDataSourceOriginKind(raw),
    input_type: resolveInputType(raw),
    lifecycle_status: resolveLifecycleStatus(raw),
    status: resolveStatus(raw),
    deprecated: asBoolean(raw.deprecated),
    // Primary: stats.sourceFileCount (persisted at import completion).
    // Fallback: latest_snapshot.total_files / latestSnapshot.totalFiles for rows
    // where stats capture failed or hasn't run yet.
    files_count: asNumber(asRecord(raw.stats).sourceFileCount,
      asNumber(asRecord(raw.latest_snapshot).total_files, asNumber(asRecord(raw.latestSnapshot).totalFiles))),
    synchronization_status: resolveSyncStatus(raw),
    error_message: asNullableString(raw.errorMessage) ?? asNullableString(raw.error_message),
    // Backend enriches both list and detail with latest_snapshot. Handles both casings.
    latest_snapshot: (raw.latest_snapshot ?? raw.latestSnapshot ?? null) as DatasetListItem['latest_snapshot'],
    modified_by: asString(raw.modifiedBy, asString(raw.modified_by)),
  };
}

/**
 * Maps a single raw Iceberg snapshot object from GET /datasets/:id/snapshots
 * → typed DatasetSnapshot.
 *
 * @param raw   - One entry from the backend `snapshots` array.
 * @param idx   - 0-based position after oldest→newest sort; used to derive `version`.
 * @param currentSnapshotId - The `currentSnapshotId` from the same response envelope.
 */
export function normalizeSnapshot(
  rawInput: unknown,
  idx: number,
  currentSnapshotId: number | null,
): DatasetSnapshot {
  const raw = asRecord(rawInput);
  const summary = asRecord(raw.summary);
  return {
    id: String(raw.snapshotId),
    version: idx + 1,
    status: 'completed',
    total_files: summary['total-data-files'] != null ? Number(summary['total-data-files']) : null,
    total_folders: null,
    files_synced: null,
    files_added: summary['added-data-files'] != null ? Number(summary['added-data-files']) : null,
    files_removed: summary['deleted-data-files'] != null ? Number(summary['deleted-data-files']) : null,
    used_knowledge_base: null,
    expired: false,
    is_current: currentSnapshotId != null && raw.snapshotId === currentSnapshotId,
    created_at: new Date(
      typeof raw.timestampMs === 'number' || typeof raw.timestampMs === 'string'
        ? raw.timestampMs
        : 0,
    ).toISOString(),
  };
}

/**
 * Maps a single raw KnowledgeBase entity from GET /datasets/:id/knowledge-bases
 * → typed DatasetKBListItem.
 *
 * The backend route already maps field names (id→kb_id, etc.) when it ships,
 * but this normalizer tolerates both the raw entity shape (`id`, camelCase
 * timestamps) and the pre-mapped shape (`kb_id`, snake_case) so it is safe
 * against partial rollouts and mock data.
 */
export function normalizeKBListItem(rawInput: unknown): DatasetKBListItem {
  const raw = asRecord(rawInput);
  const kbStatusToDatasetStatus: Record<string, DatasetStatus> = {
    in_progress: 'Healthy',
    ready: 'Ready',
    errored: 'Failed',
    deprecated: 'Unhealthy',
  };
  const kbStatusToSyncStatus: Record<string, SynchronizationStatus> = {
    in_progress: 'Synchronizing',
    ready: 'Completed',
    errored: 'Failed',
  };
  const rawStatus = String(raw.status ?? '').toLowerCase();

  return {
    kb_id: asString(raw.kb_id, asString(raw.id)),
    name: asString(raw.name),
    status: kbStatusToDatasetStatus[rawStatus] ?? 'Draft',
    file_scope: asNumber(raw.file_scope, asNumber(asRecord(raw.stats).fileCount)),
    synchronization_schedule:
      asNullableString(raw.synchronization_schedule) ??
      asNullableString(asRecord(raw.scheduleConfig).cronExpression) ??
      null,
    synchronization_status:
      (asNullableString(raw.synchronization_status) as SynchronizationStatus | null) ??
      kbStatusToSyncStatus[rawStatus] ??
      'Never',
    labels: Array.isArray(raw.labels) ? (raw.labels as string[]) : [],
    created_at: asString(
      raw.created_at,
      raw.createdAt instanceof Date ? raw.createdAt.toISOString() : asString(raw.createdAt),
    ),
  };
}

/**
 * Maps a single raw backend Dataset object → typed DatasetDetail.
 *
 * DatasetDetail extends DatasetListItem, so this is a superset of
 * normalizeDatasetListItem and is safe to use for both list and detail responses.
 */
export function normalizeDataset(rawInput: unknown): DatasetDetail {
  const raw = asRecord(rawInput);
  const listItem = normalizeDatasetListItem(raw);
  return {
    ...listItem,

    // DatasetDetail extras
    description: asNullableString(raw.description),

    // Schema-scope query for structured datasets (BE: sqlQuery).
    sql_query: asNullableString(raw.sqlQuery) ?? asNullableString(raw.sql_query),
    spec: (raw.filterSpec ?? raw.spec ?? null) as DatasetDetail['spec'],
    // Connector-resource selectors (object store / database / metrics). Volume
    // sources leave this null and use spec.paths instead.
    resource_selector: Array.isArray(raw.resourceSelector)
      ? (raw.resourceSelector as DatasetDetail['resource_selector'])
      : Array.isArray(raw.resource_selector)
        ? (raw.resource_selector as DatasetDetail['resource_selector'])
        : null,
    // Prefer the richer frontend-shaped refresh_config when the backend returns it.
    // Fall back to converting the abbreviated scheduleConfig shape (cronExpression, timezone, enabled).
    refresh_config:
      (raw.refresh_config as DatasetDetail['refresh_config'] | undefined) ??
      (raw.refreshConfig as DatasetDetail['refresh_config'] | undefined) ??
      fromBackendScheduleConfig(raw.scheduleConfig ?? raw.schedule_config) ??
      null,
    // Backend enriches detail responses with synchronization_summary.
    synchronization_summary: sanitizeSynchronizationSummary(
      (raw.synchronization_summary ?? null) as DatasetDetail['synchronization_summary'],
      listItem.synchronization_status,
    ),
    error_message:
      asNullableString(raw.errorMessage) ?? asNullableString(raw.error_message),
    // Iceberg catalog coordinates — backend uses camelCase (namespace, catalogTableName / catalogTableRef).
    catalog_namespace: asNullableString(raw.namespace) ?? asNullableString(raw.catalog_namespace),
    catalog_table_name:
      asNullableString(raw.catalogTableName) ??
      asNullableString(raw.catalog_table_name) ??
      asNullableString(raw.catalogTableRef),
  };
}

/**
 * Converts a relative "last modified" window (7d/30d/90d/1y) into an absolute
 * ISO-8601 timestamp the acquisition workflow understands (`modifiedAfter`).
 *
 * The backend only supports a fixed timestamp, so the window is anchored at
 * save time. For recurring refreshes this is a point-in-time approximation
 * rather than a sliding window (a true sliding window would need backend work).
 */
function lastModifiedWindowToIso(
  filter: LastModifiedFilter | undefined,
  now: Date,
): string | undefined {
  if (!filter || filter === 'all') return undefined;
  const daysByWindow: Record<Exclude<LastModifiedFilter, 'all'>, number> = {
    '7d': 7,
    '30d': 30,
    '90d': 90,
    '1y': 365,
  };
  const days = daysByWindow[filter];
  if (!days) return undefined;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Glob metacharacters and common unicode asterisk lookalikes from pasted text. */
const GLOB_METACHAR_RE = /[*?[\]\\/]/;
const UNICODE_ASTERISK_RE = /[\uFF0A\u2217\u066D]/g;

/**
 * Converts a single file-type form entry into a glob for `fileIncludePattern`.
 * Bare extensions (`csv`, `.pdf`) become `*.csv`, `*.pdf`. Values that already
 * look like globs (`*.csv`, `temp/*.parquet`) are passed through unchanged.
 */
export function fileTypeEntryToIncludeGlob(entry: string): string {
  const trimmed = entry.trim().replace(UNICODE_ASTERISK_RE, '*');
  if (!trimmed) return '';
  if (GLOB_METACHAR_RE.test(trimmed)) {
    return trimmed;
  }
  return `*${trimmed.startsWith('.') ? trimmed : `.${trimmed}`}`;
}

/**
 * Translates the form-shaped DatasetSpec into the backend `acquisitionConfig`
 * that the acquisition workflow actually reads:
 *   file_types          → fileIncludePattern ("*.pdf,*.docx" or "*.csv")
 *   exclude_patterns    → fileExcludePattern ("temp/*,*.tmp")
 *   max_file_size_bytes → maxFileSize (positive integer bytes)
 *   last_modified_filter→ modifiedAfter (absolute ISO-8601)
 *
 * `explicitClears` (used on update) emits empty strings for the include/exclude
 * patterns when they're unset so the backend overwrites previously-set values.
 * (maxFileSize/modifiedAfter can't be cleared this way — the validator rejects
 * non-positive sizes and invalid dates — so they're omit-only.)
 *
 * Returns undefined when there is nothing to send.
 */
export function toBackendAcquisitionConfig(
  spec: DatasetSpec | null | undefined,
  options?: { explicitClears?: boolean; now?: Date },
): Record<string, unknown> | undefined {
  if (!spec) return undefined;
  const explicitClears = options?.explicitClears ?? false;
  const now = options?.now ?? new Date();
  const cfg: Record<string, unknown> = {};

  const fileTypes = spec.file_types ?? [];
  if (fileTypes.length > 0) {
    cfg.fileIncludePattern = fileTypes.map(fileTypeEntryToIncludeGlob).join(',');
  } else if (explicitClears) {
    cfg.fileIncludePattern = '';
  }

  const excludes = spec.exclude_patterns ?? [];
  if (excludes.length > 0) {
    cfg.fileExcludePattern = excludes.join(',');
  } else if (explicitClears) {
    cfg.fileExcludePattern = '';
  }

  if (typeof spec.max_file_size_bytes === 'number' && spec.max_file_size_bytes > 0) {
    cfg.maxFileSize = Math.trunc(spec.max_file_size_bytes);
  }

  const modifiedAfter = lastModifiedWindowToIso(spec.last_modified_filter, now);
  if (modifiedAfter) {
    cfg.modifiedAfter = modifiedAfter;
  }

  return Object.keys(cfg).length > 0 ? cfg : undefined;
}

/**
 * Derives the single `sourcePath` the acquisition workflow honours from the
 * form's folder scope. Returns undefined for "all folders" or when no concrete
 * path is selected.
 *
 * NOTE: the workflow honours a single sourcePath for volume sources (object
 * stores can use multi-prefix `resourceSelector`, but that needs the source
 * bucket which isn't available here). When multiple custom folders are selected,
 * only the first is sent — true multi-path on volumes needs backend support.
 */
export function deriveSourcePath(spec: DatasetSpec | null | undefined): string | undefined {
  if (!spec || spec.folder_scope !== 'custom') return undefined;
  const first = (spec.paths ?? []).map((p) => String(p).trim()).filter(Boolean)[0];
  return first || undefined;
}

/**
 * Builds the backend `filterSpec` for a dataset: keeps the form-shaped keys
 * (so the edit form can round-trip the UI selection) and augments them with the
 * `sourcePath` the workflow reads. Returns undefined when no spec is provided.
 */
export function toBackendFilterSpec(
  spec: DatasetSpec | null | undefined,
): Record<string, unknown> | undefined {
  if (!spec) return undefined;
  const sourcePath = deriveSourcePath(spec);
  return { ...spec, ...(sourcePath ? { sourcePath } : {}) };
}

/**
 * Derives backend `sourceDatabase` / `sourceSchema` from a database table
 * resource-selector entry. The acquisition workflow overlays these onto the
 * connector config when the connector has no default database (resource scope).
 *
 * When `explicitClears` is true (update path), always emits both fields: set from
 * the first table entry when present, otherwise `null` so stale DB values are
 * overwritten when scope is cleared or no longer includes a table.
 */
export function toBackendDatabaseSourceFields(
  resourceSelector: ResourceSelectorEntry[] | undefined,
  options?: { explicitClears?: boolean },
): { sourceDatabase?: string | null; sourceSchema?: string | null } {
  const explicitClears = options?.explicitClears ?? false;

  for (const entry of resourceSelector ?? []) {
    const raw = entry as Record<string, unknown>;
    const schema = raw.schema;
    const table = raw.table;
    if (typeof schema !== 'string' || !schema || typeof table !== 'string' || !table) {
      continue;
    }
    const database = typeof raw.database === 'string' && raw.database ? raw.database : undefined;
    if (explicitClears) {
      return {
        sourceDatabase: database ?? null,
        sourceSchema: schema,
      };
    }
    return {
      ...(database ? { sourceDatabase: database } : {}),
      sourceSchema: schema,
    };
  }

  if (explicitClears) {
    return { sourceDatabase: null, sourceSchema: null };
  }
  return {};
}

/**
 * Maps a single raw backend DataSetManifest (with its `files` relation) → typed
 * DatasetManifest. The backend uses camelCase (manifestId, fileName); files may
 * be absent when the relation wasn't loaded.
 */
export function normalizeManifest(rawInput: unknown): DatasetManifest {
  const raw = asRecord(rawInput);
  const rawFiles: unknown[] = Array.isArray(raw.files) ? raw.files : [];
  const manifestStatus = asString(raw.status);
  return {
    id: asString(raw.id),
    manifest_id: Number(raw.manifestId ?? raw.manifest_id ?? 0),
    status: manifestStatus === 'committed' || manifestStatus === 'deprecated' ? manifestStatus : 'draft',
    files: rawFiles.map((file) => {
      const entry = asRecord(file);
      return {
        id: asString(entry.id),
        file_name: asString(entry.fileName, asString(entry.file_name)),
        uri: asNullableString(entry.uri),
      };
    }),
  };
}
