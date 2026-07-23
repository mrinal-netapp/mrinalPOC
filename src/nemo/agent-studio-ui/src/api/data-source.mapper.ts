/**
 * data-source.mapper.ts
 *
 * Translates raw backend responses (config-service) into the typed frontend
 * shapes defined in data-source.types.ts.
 *
 * Backend model                        → Frontend model
 * ──────────────────────────────────────────────────────
 * id (or dsrc_id fallback)             → dsrc_id
 * type ('volume'|'connector')          → source_type ('NFS'|'SMB'|'S3'|null)
 * mount_health.status                  → status ('Healthy'|'Unhealthy'|'Initializing')
 * scan_status.state                    → scan_status ('Completed'|'Scanning'|'Failed'|'Unscanned')
 * scan_config + scan_status + scan_result → scan (ScanDetails | null)
 * volume_config.volume_info            → connection { server, export_path, ... }
 * created_at / createdAt               → created_at  (handles both casings)
 *
 * Fields with no backend equivalent are filled with safe defaults so that
 * downstream components never receive undefined where they expect a value.
 */

import { connectorTypeToDataSourceCategory } from './data-source-category.utils';
import type {
  ConnectorConfig,
  ConnectorType,
  DataSourceCategory,
  DataSourceDetail,
  DataSourceProtocol,
  DataSourceStatus,
  ScanDetails,
  ScanStatus,
} from './data-source.types';

const CONNECTOR_TYPES: readonly ConnectorType[] = [
  'database',
  'objectstore',
  'cloud',
  'storage',
  'api',
];
import type { DatasetStatus } from './dataset.types';

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

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Maps backend DataSet status enum → frontend DatasetStatus.
 * Used when a data source response embeds dataset references
 * (e.g. GET /datasources/:id/datasets).
 */
export function resolveDatasetStatus(raw: string | undefined): DatasetStatus {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'ready') return 'Ready';
  if (s === 'errored') return 'Failed';
  if (s === 'in_progress') return 'Importing';
  if (s === 'deprecated') return 'Unhealthy';
  return 'Draft';
}

function resolveSourceType(rawInput: unknown): DataSourceProtocol | null {
  const raw = asRecord(rawInput);
  const volumeInfo = asRecord(asRecord(raw.volume_config).volume_info);
  const connectorConfig = asRecord(raw.connector_config);

  if (raw.type === 'volume') {
    // Exact protocol only: map volume_config.volume_info.type to the protocol it
    // actually declares. An unrecognised/missing type stays null rather than
    // guessing NFS — `category` and `provider` carry the real identity.
    const vt = String(volumeInfo.type ?? '').toLowerCase();
    if (vt === 'nfs') return 'NFS';
    if (vt === 'smb') return 'SMB';
    if (vt === 's3') return 'S3';
    return null;
  }

  if (raw.type === 'connector') {
    // Exact protocol only: a connector maps to a DataSourceProtocol solely when
    // its provider truly speaks that protocol. AWS S3 and S3-compatible stores
    // both use provider 's3'. Everything else (GCS, ONTAP, databases, APIs,
    // cloud accounts) has no NFS/SMB/S3 analogue and stays null — `category` and
    // `provider` carry their real identity.
    const provider = String(connectorConfig.provider ?? '').toLowerCase();
    if (provider === 's3') return 'S3';
    if (provider === 'smb') return 'SMB';
    return null;
  }

  return null;
}

/**
 * Derives the high-level 5-value category from the backend taxonomy:
 *   type ('volume' | 'connector') + connector_config.connector_type
 * Returns null when the taxonomy is missing so scope gating falls back to
 * "no constraint".
 */
function resolveDataSourceCategory(rawInput: unknown): DataSourceCategory | null {
  const raw = asRecord(rawInput);
  if (raw.type === 'volume') return 'Volume';
  if (raw.type === 'connector') {
    return connectorTypeToDataSourceCategory(
      asString(asRecord(raw.connector_config).connector_type),
    );
  }
  return null;
}

function resolveStatus(rawInput: unknown): DataSourceStatus {
  const raw = asRecord(rawInput);

  // Connector sources have no mount_health; their health is the last connection
  // test outcome. Until tested, there is nothing to report → Initializing.
  if (raw.type === 'connector') {
    const test = String(raw.last_connection_test_status ?? '').toLowerCase();
    if (test === 'success') return 'Healthy';
    if (test === 'failed') return 'Unhealthy';
    return 'Initializing';
  }

  const mountHealth = asRecord(raw.mount_health);
  const s = String(mountHealth.status ?? '').toLowerCase();
  if (s === 'healthy') return 'Healthy';
  if (s === 'unhealthy') return 'Unhealthy';
  return 'Initializing';
}

/**
 * Maps backend scan_status.state → frontend ScanStatus string enum.
 * Backend states: pending | scanning | completed | failed | skipped
 * Frontend states: Completed | Scanning | Failed | Unscanned
 */
function resolveScanStatus(rawScanStatus: unknown): ScanStatus {
  const state = String(asRecord(rawScanStatus).state ?? '').toLowerCase();
  if (state === 'completed') return 'Completed';
  if (state === 'scanning' || state === 'pending') return 'Scanning';
  if (state === 'failed') return 'Failed';
  // 'skipped', undefined, or unknown → treat as not yet scanned
  return 'Unscanned';
}

/**
 * This comment is derived from the backend implementation
 * Builds a ScanDetails object from the backend scan_config, scan_status,
 * and scan_result fields. Returns null for connector data sources (scan
 * does not apply) and for volumes that have never been configured for scanning.
 */
function resolveScanDetails(rawInput: unknown): ScanDetails | null {
  const raw = asRecord(rawInput);
  // Scan only applies to volume data sources
  if (raw.type === 'connector') return null;

  const scanConfig = asRecord(raw.scan_config);
  const scanStatus = asRecord(raw.scan_status);
  const scanResult = asRecord(raw.scan_result);

  // Return null if the volume has never had a scan configured or triggered
  if (Object.keys(scanConfig).length === 0 && Object.keys(scanStatus).length === 0) return null;

  return {
    status: resolveScanStatus(scanStatus),
    scan_depth: (asString(scanConfig.scan_depth, 'none') as ScanDetails['scan_depth']),
    custom_depth: typeof scanConfig.custom_depth === 'number' ? scanConfig.custom_depth : null,
    last_completed_at: asNullableString(scanResult.completed_at),
    // Prefer error from scan_result; fall back to last_error on scan_status
    status_message: asNullableString(scanResult.error_message) ?? asNullableString(scanStatus.last_error),
    total_files: typeof scanResult.total_files === 'number' ? scanResult.total_files : null,
    total_folders: typeof scanResult.total_folders === 'number' ? scanResult.total_folders : null,
    total_size_bytes: typeof scanResult.total_size_bytes === 'number' ? scanResult.total_size_bytes : null,
    file_type_stats: Array.isArray(scanResult.file_type_stats) ? (scanResult.file_type_stats as ScanDetails['file_type_stats']) : null,
  };
}

/**
 * Splits an ONTAP-style endpoint string ("host:/export/path") into its
 * server and export_path parts.
 */
function splitEndpoint(endpoint: string): { server: string; exportPath: string | null } {
  const colonIdx = endpoint.indexOf(':');
  if (colonIdx === -1) return { server: endpoint, exportPath: null };
  return {
    server: endpoint.slice(0, colonIdx),
    exportPath: endpoint.slice(colonIdx + 1) || null,
  };
}

// ---------------------------------------------------------------------------
// Public mapper
// ---------------------------------------------------------------------------

/**
 * Maps a single raw backend DataSource object → typed DataSourceDetail.
 *
 * Safe to call on both list items and detail responses — DataSourceDetail
 * extends DataSourceListItem, so the result satisfies both types.
 */
export function normalizeDataSource(rawInput: unknown): DataSourceDetail {
  const raw = asRecord(rawInput);
  const mountHealth = asRecord(raw.mount_health);
  const volumeInfo = asRecord(asRecord(raw.volume_config).volume_info);

  const endpoint = typeof volumeInfo.endpoint === 'string' ? volumeInfo.endpoint : '';
  const { server, exportPath } = splitEndpoint(endpoint);

  return {
    // BaseResource
    name: asString(raw.name),
    labels: Array.isArray(raw.labels) ? (raw.labels as string[]) : [],
    created_at: asString(raw.createdAt, asString(raw.created_at)),
    updated_at: asString(raw.updatedAt, asString(raw.updated_at)),

    // DataSourceListItem
    // Prefer raw.id (canonical backend field). Fall back to raw.dsrc_id so the
    // mapper is safe when called on already-normalised data (mocks, fixtures,
    // transitional endpoints that pre-map the identifier).
    dsrc_id: asString(raw.id, asString(raw.dsrc_id)),
    source_type: resolveSourceType(raw),
    category: resolveDataSourceCategory(raw),
    // Surface the connector provider + scope so the dataset scope UI can pick
    // the explorer dataAccessModel. Null for volume sources.
    provider: (() => {
      const p = asString(asRecord(raw.connector_config).provider).toLowerCase();
      return p || null;
    })(),
    connector_scope: (() => {
      const s = asString(asRecord(raw.connector_config).scope).toLowerCase();
      return s === 'account' || s === 'resource' ? s : null;
    })(),
    // Surface the connector_type, full connector_config and credential_id so the
    // edit form can rehydrate the access-config dialog + summary card. Null for
    // volume sources (which carry no connector_config).
    connector_type: (() => {
      const t = asString(asRecord(raw.connector_config).connector_type).toLowerCase();
      return CONNECTOR_TYPES.includes(t as ConnectorType) ? (t as ConnectorType) : null;
    })(),
    connector_config: (() => {
      const cc = raw.connector_config;
      return cc !== null && typeof cc === 'object' ? (cc as ConnectorConfig) : null;
    })(),
    credential_id: asNullableString(raw.credential_id),
    // Persisted Test Connection outcome (connector sources). The per-session form
    // test is not stored; this is the backend's last recorded result.
    connection_test_status: (() => {
      const s = asString(raw.last_connection_test_status).toLowerCase();
      return s === 'success' || s === 'failed' ? s : null;
    })(),
    status: resolveStatus(raw),
    // scan_status derived from raw.scan_status.state (backend object → FE string enum)
    scan_status: resolveScanStatus(raw.scan_status),
    deprecated: asBoolean(raw.deprecated),
    associated_datasets: Array.isArray(raw.associated_datasets) ? (raw.associated_datasets as DataSourceDetail['associated_datasets']) : [],
    associated_datasets_count: asNumber(raw.associated_datasets_count),
    last_validated_at: asNullableString(mountHealth.last_checked_at),
    last_validation_error: (mountHealth.blocking as string[] | undefined)?.[0] ?? null,
    // scan built from raw.scan_config + raw.scan_status + raw.scan_result
    scan: resolveScanDetails(raw),

    // DataSourceDetail
    description: asNullableString(raw.description),
    connection: {
      server,
      export_path: exportPath,
      folder_boundary: Array.isArray(volumeInfo.folder_boundary)
      ? (volumeInfo.folder_boundary[0] ?? null)
      : null,
      // auth details live in volume_config.auth_info, not at the top level
      auth_method: asString(asRecord(asRecord(raw.volume_config).auth_info).type),
      username: asString(asRecord(asRecord(raw.volume_config).auth_info).username),
      // region lives at the top level of volume_config
      region: asNullableString(asRecord(raw.volume_config).region),
      // Volume-only fields surfaced for edit-form rehydration (null for connectors).
      provisioning_mode: volumeInfo.provisioning_mode === 'dynamic'
        ? 'dynamic'
        : raw.type === 'volume' ? 'static' : null,
      volume_type: ((): string | null => {
        const t = asString(volumeInfo.type).toUpperCase();
        return t || null;
      })(),
      mount_options: Array.isArray(volumeInfo.mount_options)
        ? (volumeInfo.mount_options as string[])
        : null,
      storage_class_name: asNullableString(volumeInfo.storage_class_name),
      storage_size: asNullableString(volumeInfo.storage_size),
    },
    modified_by: asString(raw.modifiedBy, asString(raw.modified_by)),
    scanned_data_count: null,
  };
}
