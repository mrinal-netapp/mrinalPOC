// Deployment represents a deployment
export interface Deployment {
  id: string;
  region: string;
  endpoint: string; // HTTPS endpoint (default, used for most operations)
  http_endpoint?: string; // HTTP endpoint (used for internal operations like Lakekeeper)
  capacity?: {
    max_buckets?: number;
    max_storage_tb?: number;
  };
  capabilities?: string[];
  storage_classes?: string[];
  registered_at: string;
  last_health_check?: string;
  status?: 'healthy' | 'unhealthy' | 'unknown';
}

// CreateDeploymentRequest represents a request to register a deployment
export interface CreateDeploymentRequest {
  id: string;
  region: string;
  endpoint: string; // HTTPS endpoint (default, used for most operations)
  http_endpoint?: string; // HTTP endpoint (used for internal operations like Lakekeeper)
  capacity?: {
    max_buckets?: number;
    max_storage_tb?: number;
  };
  capabilities?: string[];
  storage_classes?: string[];
}

// UpdateDeploymentRequest represents a request to update a deployment
export interface UpdateDeploymentRequest {
  region?: string;
  endpoint?: string; // HTTPS endpoint (default, used for most operations)
  http_endpoint?: string; // HTTP endpoint (used for internal operations like Lakekeeper)
  capacity?: {
    max_buckets?: number;
    max_storage_tb?: number;
  };
  capabilities?: string[];
  storage_classes?: string[];
}

// DeploymentAssignment represents a bucket assignment to a deployment
export interface DeploymentAssignment {
  bucket_name: string;
  project_id: string;
  deployment_id: string;
  role: 'primary' | 'secondary';
  priority: number;
  assigned_at: string;
  assignment_reason?: string;
  status: 'active' | 'inactive';
  load_balance_weight?: number;
}

// BucketConfig represents bucket configuration for a deployment
export interface BucketConfig {
  project_id: string;
  bucket_name: string;
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
  role: 'primary' | 'secondary';
  other_deployments?: Array<{
    deployment_id: string;
    role: 'primary' | 'secondary';
  }>;
  /**
   * Where the bucket's storage is provisioned from.
   * - 'helm': provisioned at install time (e.g. default bucket) — storage-manager should NOT create PVC
   * - 'storage-manager': provisioned by storage-manager (default)
   */
  provisioning_source?: 'helm' | 'storage-manager';
  /** When true, storage-manager skips PVC creation for this bucket. */
  skip_pvc_create?: boolean;
}

// DeploymentConfigResponse represents the configuration for a deployment
export interface DeploymentConfigResponse {
  deployment_id: string;
  buckets: BucketConfig[];
  config_version: number;
}

// RoutingDeploymentInfo represents deployment info for routing
export interface RoutingDeploymentInfo {
  deployment_id: string;
  role: 'primary' | 'secondary';
  priority: number;
  endpoint: string; // HTTPS endpoint
  http_endpoint?: string; // HTTP endpoint (for internal operations)
  health_status: 'healthy' | 'unhealthy' | 'unknown';
  load_balance_weight: number;
  last_health_check: string;
}

// BucketRoutingResponse represents routing information for a bucket
export interface BucketRoutingResponse {
  bucket_name: string;
  project_id: string;
  deployments: RoutingDeploymentInfo[];
  routing_strategy: 'load_balance' | 'failover' | 'geographic';
  updated_at: string;
}

// Metrics represents metrics data from a deployment
export interface Metrics {
  deployment_id: string;
  timestamp: string;
  metrics?: {
    request_latency_p50_ms?: number;
    request_latency_p95_ms?: number;
    request_latency_p99_ms?: number;
    requests_per_second?: number;
    error_rate?: number;
    cpu_usage_percent?: number;
    memory_usage_percent?: number;
    disk_io_utilization?: number;
  };
  bucket_metrics?: Record<string, {
    requests?: number;
    errors?: number;
    storage_bytes?: number;
  }>;
}

// HealthReport represents health status from a deployment
export interface HealthReport {
  deployment_id: string;
  timestamp: string;
  healthy: boolean;
  status_message?: string;
  volume_mount_status?: Record<string, {
    mounted: boolean;
    status: string;
  }>;
  bucket_health?: BucketHealth[]; // Per-bucket health information
}

// BucketHealth represents health status for a specific bucket on a deployment
export interface BucketHealth {
  project_id: string;
  bucket_name: string;
  deployment_id: string;
  timestamp: string;
  healthy: boolean;
  status_message?: string;
  volume_mount_status?: {
    mounted: boolean;
    status: string;
  };
}

// ErrorResponse represents an error response
export interface ErrorResponse {
  error: string;
  code?: string;
}

