import type { BaseListParams, BaseResource } from './api.types';

import type { DatasetStatus } from './dataset.types';

// -- Enums --

export type DataSourceProtocol = 'NFS' | 'SMB' | 'S3';

/**
 * High-level (5-value) data source category derived from the backend taxonomy
 * (`type` + `connector_config.connector_type`). Used to gate which dataset
 * scope options (folder / file / schema) apply to a given data source.
 */
export type DataSourceCategory =
  | 'Volume'
  | 'Object Store'
  | 'Database'
  | 'Storage System'
  | 'API';

export type DataSourceStatus =
  | 'Initializing'
  | 'Healthy'
  | 'Unhealthy'
  | 'Failed';

export type ScanStatus = 'Completed' | 'Unscanned' | 'Failed' | 'Scanning';

export type ActivityStatus =
  | 'Success'
  | 'Failed'
  | 'In Progress'
  | 'Warning';

export type ScanDepth =
  | 'none'
  | 'all_levels'
  | 'top_5_levels'
  | 'top_2_levels'
  | 'custom';

// -- Sub-objects --

export interface DataSourceConnectionBase {
  server: string;
  export_path: string | null;
  folder_boundary: string | null;
  auth_method: string;
  username: string;
  /** Storage region, sourced from volume_config.region. Null/undefined when not set. */
  region?: string | null;
  // -- Volume sources only: surfaced from volume_config.volume_info so the edit
  //    form can rehydrate the access-config dialog's Volume tab. Null for
  //    connector-backed sources. (volume_name is display-only and not persisted.)
  /** Provisioning mode of the volume ('static' = existing export, 'dynamic' = PVC). */
  provisioning_mode?: 'static' | 'dynamic' | null;
  /** Volume protocol identifier ('NFS' | 'SMB' | 'S3'). */
  volume_type?: string | null;
  /** Mount options applied to the volume. */
  mount_options?: string[] | null;
  /** Dynamic provisioning only — StorageClass name. */
  storage_class_name?: string | null;
  /** Dynamic provisioning only — requested PVC size. */
  storage_size?: string | null;
}

export type DataSourceConnectionResponse = DataSourceConnectionBase;

export interface DataSourceConnectionRequest extends DataSourceConnectionBase {
  password: string;
}

export interface ScanConfig {
  scan_depth: ScanDepth;
  custom_depth: number | null; // required when scan_depth is 'custom'
}

export interface FileTypeStat {
  file_type: string;
  count: number;
}

export interface ScanDetails {
  status: ScanStatus;
  scan_depth: ScanDepth;
  custom_depth: number | null;
  last_completed_at: string | null;
  status_message: string | null;
  total_files: number | null;
  total_folders: number | null;
  total_size_bytes: number | null;
  file_type_stats: FileTypeStat[] | null;
}

export interface AssociatedDataset {
  dset_id: string;
  name: string;
}

// -- Response interfaces --

export interface DataSourceListItem extends BaseResource {
  dsrc_id: string;
  source_type: DataSourceProtocol | null;
  /**
   * High-level category derived from the backend `type` +
   * `connector_config.connector_type`. Null/undefined when the taxonomy is
   * unavailable (scope gating then falls back to "no constraint").
   */
  category?: DataSourceCategory | null;
  /**
   * Connector provider id from backend `connector_config.provider`
   * (e.g. 's3', 'gcs', 'postgresql', 'gcp', 'ontap'). Null for volume sources.
   * Used to look up the explorer `dataAccessModel` (rootAction, selection mode,
   * selectable types, region support) for connector browsing.
   */
  provider?: string | null;
  /**
   * Connector scope from backend `connector_config.scope` ('account' |
   * 'resource'). Determines the explorer's root listing for account-scoped
   * providers. Null for volume sources.
   */
  connector_scope?: 'account' | 'resource' | null;
  /**
   * Connector type from backend `connector_config.connector_type`
   * ('cloud' | 'storage' | 'objectstore' | 'database' | 'api'). Null for volume
   * sources. Used by the edit form to rebuild the connector summary + dialog.
   */
  connector_type?: ConnectorType | null;
  /**
   * Full backend `connector_config` object (scope/provider/connector_type plus
   * the provider-specific catalog fields). Null for volume sources. The edit
   * form rehydrates the access-config dialog from this.
   */
  connector_config?: ConnectorConfig | null;
  /** Saved credential id referenced by the connector. Null for volume sources. */
  credential_id?: string | null;
  /**
   * Persisted Test Connection outcome for connector sources, sourced from the
   * backend `last_connection_test_status`. Null when the connector has never
   * been tested. Drives the Connection status in the list + edit form.
   */
  connection_test_status?: 'success' | 'failed' | null;
  status: DataSourceStatus;
  scan_status: ScanStatus;
  deprecated: boolean;
  associated_datasets: AssociatedDataset[];
  associated_datasets_count: number;
  last_validated_at: string | null;
  last_validation_error: string | null;
  scan: ScanDetails | null;
}

export interface DataSourceDetail extends DataSourceListItem {
  description: string | null;
  connection: DataSourceConnectionResponse;
  modified_by: string;
  scanned_data_count: number | null;
}

export interface DataSourceDatasetRef {
  dset_id: string;
  name: string;
  file_scope: number;
  synchronization_schedule: string | null;
  status: DatasetStatus;
  labels: string[];
  created_at: string;
}

export interface DataSourceDatasetsResponse {
  data_source_id: string;
  datasets: DataSourceDatasetRef[];
}

export interface DataSourceDeprecationResponse {
  dsrc_id: string;
  deprecated: boolean;
  message: string;
}

// -- Volume config (create request, backend shape) --

/**
 * Describes the storage volume for a data source of type 'volume'.
 * Matches the backend volume_config JSON object accepted by POST /datasources.
 *
 * volume_info.type     – protocol identifier ('nfs', 'smb', 's3')
 * volume_info.endpoint – connection target, ONTAP-style: "server:/export/path"
 * auth_info.type       – auth method stored by the backend ('none', 'basic', …)
 */
export interface VolumeInfo {
  type: string;
  provisioning_mode?: 'static' | 'dynamic';
  endpoint?: string;
  mount_options?: string[];
  /** Dynamic provisioning only. */
  storage_class_name?: string;
  storage_size?: string;
  /** PVC access modes for dynamic provisioning (e.g. ["ReadWriteMany"]). */
  access_modes?: string[];
}

export interface VolumeAuthInfo {
  type?: string;
  username?: string;
  /** Plaintext credential at create time; persisted encrypted by the backend. */
  password_encrypted?: string;
}

export interface VolumeConfig {
  region: string;
  protocol: string;
  volume_info: VolumeInfo;
  auth_info: VolumeAuthInfo;
}

// -- Connector config (create request, backend shape) --

export type ConnectorScope = 'account' | 'resource';

export type ConnectorType =
  | 'database'
  | 'objectstore'
  | 'cloud'
  | 'storage'
  | 'api';

/**
 * Backend connector_config object accepted by POST /datasources for type
 * 'connector'. `scope`, `provider` and `connector_type` are validated by the
 * backend; the remaining provider-specific fields (host, port, bucket,
 * cluster_url, base_url, …) are validated against provider-catalog.json.
 */
export interface ConnectorConfig {
  scope: ConnectorScope;
  provider: string;
  connector_type: ConnectorType;
  [key: string]: unknown;
}

/**
 * Flat frontend shape the access-config dialog assembles for connector data
 * sources. `config` holds only the provider-specific catalog fields; the
 * slice merges scope/provider/connector_type into the final connector_config.
 */
export interface ConnectorCreateInput {
  provider: string;
  scope: ConnectorScope;
  connector_type: ConnectorType;
  config: Record<string, unknown>;
  credential_id: string;
}

// -- Request interfaces --

/**
 * Flat frontend shape accepted by createDataSource in the slice.
 * The slice's queryFn translates this into the nested DataSourceCreateRequest
 * backend shape (volume_config nesting, endpoint formatting, etc.) before POSTing.
 */
export interface DataSourceFormCreateInput {
  name: string;
  source_type: DataSourceProtocol | null;
  description?: string;
  labels?: string[];
  connection: {
    server: string;
    export_path?: string;
    folder_boundary?: string;
    auth_method?: string;
    username?: string;
    password?: string;
    // Volume-only fields (set by the access-config dialog Volume tab). The slice
    // maps these into volume_config for both static ("Existing Volume") and
    // dynamic ("New Volume") provisioning.
    provisioning_mode?: 'static' | 'dynamic';
    /** User-supplied volume name; surfaced in the summary card (display only). */
    volume_name?: string;
    /** 'NFS' | 'SMB' — drives volume_info.type and volume_config.protocol. */
    volume_type?: string;
    region?: string;
    mount_options?: string[];
    storage_class_name?: string;
    storage_size?: string;
    /** Dynamic provisioning PVC access modes; defaults to ["ReadWriteMany"]. */
    access_modes?: string[];
    auth_type?: string;
    /** Free-form key/value tags persisted as the data source metadata. */
    metadata?: Record<string, string>;
  };
  /**
   * Present for connector-backed sources (Storage system, Object store,
   * Database, API). When set, the slice POSTs a `type: 'connector'` body and
   * ignores volume_config. Volume sources leave this undefined.
   */
  connector?: ConnectorCreateInput | null;
  scan_enabled?: boolean;
  scan_config?: {
    scan_depth: ScanDepth;
    custom_depth?: number | null;
  };
}

export interface DataSourceCreateRequest {
  /** Client-supplied identifier for volume sources (e.g. "vol-1a2b3c4d"). */
  id?: string;
  /** Owning project; mirrors the projectId in the request URL. */
  project_id?: string;
  name: string;
  /** 'volume' covers NFS / SMB / S3 mounts; 'connector' for API-based sources. */
  type: 'volume' | 'connector';
  description?: string;
  labels?: string[];
  /** Required when type is 'volume'. */
  volume_config?: VolumeConfig;
  /** Required when type is 'connector'. */
  connector_config?: ConnectorConfig;
  /** Required when type is 'connector' — references a saved credential. */
  credential_id?: string;
  /** Free-form key/value tags (volume sources). */
  metadata?: Record<string, string>;
  scan_config?: ScanConfig;
}

// -- Storage classes & deployments (volume dynamic provisioning helpers) --

/** Cluster StorageClass available for dynamically provisioned volumes. */
export interface StorageClass {
  name: string;
  provisioner: string;
}

export interface DataSourceUpdateRequest {
  name?: string;
  description?: string;
  labels?: string[];
  scan_config?: ScanConfig;
  /**
   * Connector catalog config (scope/provider/connector_type + provider-specific
   * fields). Sent on edit so connector data sources persist changes made in the
   * access-config dialog. The backend merges this into the stored connector_config.
   */
  connector_config?: ConnectorConfig;
  /** Saved credential referenced by the connector; sent alongside connector_config. */
  credential_id?: string;
}


// Today listDataSources query() only forwards limit, skip, and nameRegex to the backend;
// passing any of these fields below has zero runtime effect.
//
// Uncomment each field when:
//   1. A filter UI component for it exists in data-source-list.tsx, AND
//   2. The backend validator (listDataSourceQueryValidator) accepts it, AND
//   3. The listDataSources query() is updated to forward it.
//
// Note: 'type' requires a taxonomy decision first 
//   FE uses NFS/SMB/S3; backend uses volume|connector — agree on mapping before wiring.
export type DataSourceListParams = BaseListParams;
/*
  // type?: DataSourceProtocol;  // DS-2: taxonomy mismatch — decision needed before enabling
  // status?: DataSourceStatus;   // not in listDataSourceQueryValidator yet
  // scan_status?: ScanStatus;    // not in listDataSourceQueryValidator yet
  // deprecated?: boolean;        // not in listDataSourceQueryValidator yet
  // labels?: string[];           // not in listDataSourceQueryValidator yet
*/

// -- Activity (no BE endpoint yet — types are provisional) --

export interface DataSourceActivityItem {
  activity_id: string;
  created_at: string;
  status: ActivityStatus;
  event: string;
  details: string | null;
}

export interface DataSourceActivityResponse {
  data_source_id: string;
  activities: DataSourceActivityItem[];
}
