export type DataSourceType = 'volume' | 'connector';
// The legacy `metrics` connector type was merged into the primary connectors
// (ONTAP, GCP). Metric acquisition is now driven by metric_category resourceSelector
// entries on those primary connectors instead of a dedicated connector type.
export type ConnectorSubType = 'objectstore' | 'database' | 'cloud' | 'storage' | 'api';
export type ConnectorScope = 'account' | 'resource';
export type ProtocolType = 'NFS' | 'SMB';

export interface VolumeConfig {
  region: string;
  volume_info: {
    type: string;
    endpoint?: string;
    mount_options?: string[];
    provisioning_mode?: 'static' | 'dynamic';
    storage_class_name?: string;
    storage_size?: string;
    parameters?: Record<string, string>;
    access_modes?: string[];
  };
  auth_info: {
    type: string;
    username?: string;
    password_encrypted?: string;
    [key: string]: any;
  };
  protocol: string;
  deployment_config?: Record<string, any>;
}

export interface ConnectorConfig {
  connector_type: ConnectorSubType;
  scope: ConnectorScope;
  provider: string;
  database_type?: 'postgresql' | 'mysql';
  host?: string;
  port?: number;
  database?: string;
  schema?: string;
  ssl_mode?: string;
  endpoint?: string;
  bucket?: string;
  prefix?: string;
  region?: string;
  project_id?: string;
  default_region?: string;
  cluster_url?: string;
  verify_tls?: boolean;
  default_svm?: string;
  base_url?: string;
  include_query_results?: boolean;
  include_dashboards?: boolean;
  include_data_sources?: boolean;
  max_result_rows?: number;
}

export interface DataSourceMountHealth {
  status: 'healthy' | 'unhealthy' | 'unknown';
  last_checked_at?: string;
  blocking?: string[];
  warnings?: string[];
  probed_lif?: string;
  repair_pending_pod_restart?: boolean;
  [key: string]: unknown;
}

export type ScanDepth = 'none' | 'all_levels' | 'top_5_levels' | 'top_2_levels' | 'custom';

export interface ScanConfig {
  scan_depth: ScanDepth;
  /** Required when scan_depth === 'custom'. Range 1..100. */
  custom_depth?: number | null;
}

export type ScanState = 'pending' | 'scanning' | 'completed' | 'failed' | 'skipped';

export interface ScanStatus {
  state: ScanState;
  started_at?: string;
  completed_at?: string;
  workflow_id?: string;
  last_error?: string;
}

export interface FileTypeStat {
  file_type: string;
  count: number;
}

export interface ScanResult {
  completed_at: string;
  error_message?: string;
  total_files: number;
  total_folders: number;
  total_size_bytes: number;
  file_type_stats: FileTypeStat[];
}

/** Lightweight dataset reference embedded in a data source response. */
export interface AssociatedDatasetRef {
  dset_id: string;
  name: string;
}

export interface DataSourceModel {
  id: string;
  project_id: string;
  name: string;
  type: DataSourceType;
  description?: string;
  volume_config?: VolumeConfig;
  connector_config?: ConnectorConfig;
  credential_id?: string;
  metadata: Record<string, any>;
  labels?: string[];
  /** Soft-retire flag — drives the "Deprecated" treatment in the UI. */
  deprecated: boolean;
  mount_health?: DataSourceMountHealth;
  scan_config?: ScanConfig;
  scan_status?: ScanStatus;
  scan_result?: ScanResult;
  /** Total files reported by the most recent successful scan (volumes only). */
  scanned_data_count?: number | null;
  /** Subject of the user who last created/updated this data source. */
  modified_by?: string;
  /** Datasets that read from this data source (capped). Populated by list/detail routes. */
  associated_datasets?: AssociatedDatasetRef[];
  /** Total number of datasets associated with this data source. */
  associated_datasets_count?: number;
  last_connection_test_at?: string;
  last_connection_test_status?: 'success' | 'failed';
  last_connection_test_message?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateDataSourceRequest {
  name: string;
  type: DataSourceType;
  description?: string;
  volume_config?: VolumeConfig;
  connector_config?: ConnectorConfig;
  credential_id?: string;
  metadata?: Record<string, any>;
  /** Null is accepted by the API validator and treated as "not provided". */
  labels?: string[] | null;
  scan_config?: ScanConfig;
}

export interface UpdateDataSourceRequest {
  name?: string;
  description?: string;
  volume_config?: Partial<VolumeConfig>;
  connector_config?: Partial<ConnectorConfig>;
  credential_id?: string;
  metadata?: Record<string, any>;
  /** Null is accepted by the API validator and treated as "not provided". */
  labels?: string[] | null;
  deprecated?: boolean;
  mount_health?: DataSourceMountHealth;
  scan_config?: ScanConfig;
}

/** Payload accepted by the internal workflow-engine callback. */
export interface ScanCallbackRequest {
  scan_status: ScanStatus;
  scan_result?: ScanResult;
}

export interface ErrorResponse {
  error: string;
  code?: string;
}
