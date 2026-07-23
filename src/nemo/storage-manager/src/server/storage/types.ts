/**
 * Shared types for storage management
 */

export interface BucketStorageClassSpec {
  project_id: string;
  bucket_name: string;
  
  // NEW: Provisioning mode ('static' for existing volumes, 'dynamic' for new volumes)
  provisioning_mode?: 'static' | 'dynamic'; // Default: 'static' for backward compatibility
  
  // NEW: For dynamic provisioning, reference existing StorageClass
  // If not provided and provisioning_mode is 'dynamic', validation error
  storage_class_name?: string;
  
  volume_info: {
    type: string; // 'nfs', 'cifs', 'smb', or provisioner-specific type
    endpoint?: string; // Required for static, optional for dynamic
    mount_options?: string[];
    // NEW: Additional parameters for dynamic provisioning (e.g., volume type, IOPS)
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
  
  // NEW: Storage size for dynamic provisioning (defaults to DEFAULT_STORAGE_SIZE env var)
  storage_size?: string; // e.g., '10Gi', '100Gi'
  
  // NEW: Access modes for PVC (defaults to best mode based on StorageClass provisioner)
  // If not specified, system will automatically select the best mode (prefers ReadWriteMany)
  access_modes?: string[]; // e.g., ['ReadWriteMany'], ['ReadWriteOnce']
}

