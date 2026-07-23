/** Project init lifecycle status (persisted on `projects.init_status`). */
export enum ProjectInitStatus {
  Provisioning = 'provisioning',
  Ready = 'ready',
  Failed = 'failed',
}

export const PROJECT_INIT_STATUS_VALUES = Object.values(ProjectInitStatus) as ProjectInitStatus[];

// Project represents a project
export interface Project {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, any>;
  home_dir: string;
  // Initialization lifecycle: 'provisioning' right after create, then 'ready'
  // or 'failed' once the async ProjectInitWorkflow completes.
  init_status?: ProjectInitStatus;
  init_error?: string | null;
}

// CreateProjectRequest represents a request to create a project
export interface CreateProjectRequest {
  name: string;
  metadata?: Record<string, any>;
}

// UpdateProjectRequest represents a request to update a project
export interface UpdateProjectRequest {
  name?: string;
  metadata?: Record<string, any>;
}

// Bucket represents a bucket (volume)
export interface Bucket {
  project_id: string;
  name: string;
  region: string;
  volume_info: {
    type: string;
    endpoint?: string; // Optional for dynamic provisioning
    mount_options?: string[];
    // NEW fields
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
  deployment_config?: Record<string, any>;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, any>;
}

// CreateBucketRequest represents a request to create a bucket
export interface CreateBucketRequest {
  name: string;
  region: string;
  volume_info: {
    type: string;
    endpoint?: string; // Optional for dynamic provisioning
    mount_options?: string[];
    // NEW fields
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
  deployment_config?: Record<string, any>;
  metadata?: Record<string, any>;
}

// UpdateBucketRequest represents a request to update a bucket
export interface UpdateBucketRequest {
  region?: string;
  volume_info?: {
    type?: string;
    endpoint?: string;
    mount_options?: string[];
    // NEW fields
    provisioning_mode?: 'static' | 'dynamic';
    storage_class_name?: string;
    storage_size?: string;
    parameters?: Record<string, string>;
  };
  auth_info?: {
    type?: string;
    username?: string;
    password_encrypted?: string;
    [key: string]: any;
  };
  protocol?: string;
  deployment_config?: Record<string, any>;
  metadata?: Record<string, any>;
}

// ErrorResponse represents an error response
export interface ErrorResponse {
  error: string;
  code?: string;
}

