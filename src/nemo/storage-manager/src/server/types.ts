/**
 * Types and interfaces for storage-manager server
 */

// BucketConfig represents a bucket configuration from config-service
export interface BucketConfig {
  project_id: string;
  bucket_name: string;
  region: string;
  volume_info: {
    type: string;
    endpoint?: string; // Optional for dynamic provisioning
    mount_options?: string[];
    provisioning_mode?: 'static' | 'dynamic';
    storage_class_name?: string;
    storage_size?: string;
    parameters?: Record<string, string>;
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
  /** Where storage is provisioned: 'helm' (skip PVC) or 'storage-manager' (default). */
  provisioning_source?: 'helm' | 'storage-manager';
  /** When true, skip PVC creation for this bucket. */
  skip_pvc_create?: boolean;
}

// DeploymentConfigResponse represents the configuration response from config-service
export interface DeploymentConfigResponse {
  deployment_id: string;
  buckets: BucketConfig[];
  config_version: number;
}

// BucketRoutingResponse represents routing info from config-service
export interface BucketRoutingResponse {
  bucket_name: string;
  project_id: string;
  deployments: Array<{
    deployment_id: string;
    role: 'primary' | 'secondary';
    priority: number;
    endpoint: string;
    health_status: 'healthy' | 'unhealthy' | 'unknown';
    load_balance_weight: number;
    last_health_check: string;
  }>;
  routing_strategy: string;
  updated_at: string;
}

// Cached routing info for non-local buckets
export interface CachedRoutingInfo {
  project_id: string;
  routing_info: BucketRoutingResponse;
  last_updated: number;
}

// Comprehensive routing registry entry for all buckets in relevant projects
export interface ProjectRoutingEntry {
  project_id: string;
  bucket_name: string;
  routing_info: BucketRoutingResponse;
  last_updated: number;
}

// Bucket list response from config-service
export interface BucketListResponse {
  buckets: Array<{ name: string }>;
}

