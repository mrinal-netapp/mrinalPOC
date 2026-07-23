# Design: Support for Dynamic PVC Provisioning

## Overview

This document describes the enhancement to support buckets backed by newly provisioned volumes via PVC, in addition to the existing support for buckets backed by existing NFS/SMB volumes.

## Current Architecture

### Current State (Static Provisioning)

The system currently supports buckets backed by **existing** NFS/SMB volumes using static provisioning:

1. **StorageClass Creation**: Creates a StorageClass per bucket with `provisioner: kubernetes.io/no-provisioner`
2. **PVC Creation**: Creates a PVC referencing the StorageClass
3. **PV Creation**: When PVC is pending, creates a PV on-demand pointing to the existing volume endpoint
4. **Binding**: Binds the PVC to the manually created PV
5. **Deployment Update**: Updates the deployment to mount the PVC

**Key Characteristics:**
- StorageClass uses `kubernetes.io/no-provisioner` (static provisioning)
- PVs are created manually by Storage Manager pointing to existing volumes
- Volume endpoints (NFS server:/share or SMB //server/share) are specified in bucket configuration
- Supports NFS and SMB/CIFS protocols

### Current Flow

```
Bucket Assignment → StorageClass (no-provisioner) → PVC → PV (on-demand, points to existing volume) → Deployment Mount
```

## Architecture

### Static + Dynamic Provisioning

The system supports **both** static and dynamic provisioning:

1. **Static Provisioning** (existing behavior):
   - Buckets backed by existing NFS/SMB volumes
   - StorageClass with `kubernetes.io/no-provisioner`
   - PVs created manually pointing to existing volumes

2. **Dynamic Provisioning** (new):
   - Buckets backed by newly provisioned volumes
   - Uses existing StorageClasses with dynamic provisioners (CSI drivers)
   - PVCs automatically trigger volume provisioning
   - No manual PV creation needed

### Supported Dynamic Provisioners

The system will support any Kubernetes StorageClass with a dynamic provisioner, including:

- **Cloud Provider CSI Drivers**:
  - AWS EBS: `ebs.csi.aws.com`
  - GCP Persistent Disk: `pd.csi.storage.gke.io`
  - Azure Disk: `disk.csi.azure.com`
  - OpenStack Cinder: `cinder.csi.openstack.org`

- **Network Storage CSI Drivers**:
  - NFS CSI: `nfs.csi.k8s.io` (for dynamic NFS provisioning)
  - SMB CSI: `smb.csi.k8s.io` (for dynamic SMB provisioning)
  - CephFS: `cephfs.csi.ceph.com`
  - GlusterFS: `gluster.org/glusterfs`

- **Other Storage Solutions**:
  - Longhorn: `driver.longhorn.io`
  - Rook: `rook-ceph.rbd.csi.ceph.com`
  - Portworx: `pxd.portworx.com`

## Design Decisions

### 1. Provisioning Mode Detection

**Option A: Explicit Field** (Recommended)
- Add `provisioning_mode: 'static' | 'dynamic'` to `BucketStorageClassSpec`
- Add `storage_class_name?: string` for dynamic provisioning (references existing StorageClass)
- Clear and explicit, easy to validate

**Option B: Implicit Detection**
- Detect based on presence of `storage_class_name` field
- If `storage_class_name` is provided, use dynamic provisioning
- If not, use static provisioning (existing behavior)
- Less explicit but backward compatible

**Decision: Option A** - More explicit and allows for future expansion

### 2. StorageClass Handling

**For Static Provisioning:**
- Create StorageClass per bucket (existing behavior)
- StorageClass name: `sc-{namespace-id}-{bucket-name}`
- Provisioner: `kubernetes.io/no-provisioner`

**For Dynamic Provisioning:**
- Use existing StorageClass (no creation needed)
- StorageClass name: Provided in bucket configuration
- Provisioner: Determined by the existing StorageClass (CSI driver)

### 3. PVC Creation

**For Static Provisioning:**
- Create PVC referencing the per-bucket StorageClass
- When PVC is pending, create PV on-demand
- Bind PVC to PV

**For Dynamic Provisioning:**
- Create PVC referencing the existing StorageClass
- Let Kubernetes provisioner create PV automatically
- No manual PV creation needed

### 4. Volume Endpoint Handling

**For Static Provisioning:**
- `volume_info.endpoint` contains the existing volume endpoint (e.g., `nfs-server:/share`)
- Used to create PV pointing to existing volume

**For Dynamic Provisioning:**
- `volume_info.endpoint` may be empty or contain metadata
- Volume endpoint is determined by the StorageClass provisioner
- May need additional parameters in `volume_info` for provisioner-specific config

### 5. Secret Management

**For Static Provisioning:**
- Secrets created for SMB authentication (existing behavior)

**For Dynamic Provisioning:**
- Secrets may be required by the StorageClass provisioner
- Secrets should be referenced in StorageClass parameters (already configured)
- May need to create additional secrets if StorageClass requires them

## Data Model Changes

### BucketStorageClassSpec Enhancement

```typescript
export interface BucketStorageClassSpec {
  namespace_id: string;
  bucket_name: string;
  
  // NEW: Provisioning mode
  provisioning_mode: 'static' | 'dynamic';
  
  // NEW: For dynamic provisioning, reference existing StorageClass
  // If not provided and provisioning_mode is 'dynamic', use default StorageClass
  storage_class_name?: string;
  
  volume_info: {
    type: string; // 'nfs', 'cifs', 'smb', or provisioner-specific type
    endpoint?: string; // Required for static, optional for dynamic
    mount_options?: string[];
    // NEW: Additional parameters for dynamic provisioning
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
  
  // NEW: Storage size for dynamic provisioning
  storage_size?: string; // e.g., '10Gi', '100Gi'
}
```

### Bucket Entity Enhancement (Config Service)

The bucket entity in config service may need to support the new fields:

```typescript
// In config-service bucket entity
volume_info: {
  type: string;
  endpoint?: string; // Optional for dynamic provisioning
  mount_options?: string[];
  provisioning_mode?: 'static' | 'dynamic'; // NEW
  storage_class_name?: string; // NEW
  storage_size?: string; // NEW
  parameters?: Record<string, string>; // NEW
};
```

## API Changes

### CreateBucketRequest

```typescript
{
  name: string
  region: string
  volume_info: {
    type: string
    endpoint?: string // Required for static
    provisioning_mode?: 'static' | 'dynamic'
    storage_class_name?: string // Required for dynamic
    storage_size?: string // Required for dynamic
    parameters?: Record<string, string>
    mount_options?: string[]
  }
  auth_info: AuthInfo
  protocol: string
  metadata?: Record<string, any>
}
```

### UpdateBucketRequest

```typescript
{
  region?: string
  volume_info?: {
    type?: string
    endpoint?: string
    provisioning_mode?: 'static' | 'dynamic'
    storage_class_name?: string
    storage_size?: string
    parameters?: Record<string, string>
    mount_options?: string[]
  }
  auth_info?: Partial<AuthInfo>
  protocol?: string
  metadata?: Record<string, any>
}
```

### Validation Rules

**Static Provisioning:**
- `volume_info.endpoint` required
- `volume_info.type` required

**Dynamic Provisioning:**
- `volume_info.storage_class_name` required
- `volume_info.storage_size` required (format: `^\d+[KMGTPE]i?$`)
- `volume_info.endpoint` optional

## Implementation Flow

### Static Provisioning Flow (Existing)

```
1. Bucket assigned to deployment
2. Storage Manager creates StorageClass (no-provisioner)
3. Storage Manager creates Secret (if auth needed)
4. Storage Manager creates PVC
5. If PVC pending, Storage Manager creates PV (points to existing volume)
6. PVC binds to PV
7. Deployment updated to mount PVC
```

### Dynamic Provisioning Flow (New)

```
1. Bucket assigned to deployment
2. Storage Manager validates StorageClass exists (if specified)
3. Storage Manager creates Secret (if needed by StorageClass)
4. Storage Manager creates PVC (references existing StorageClass)
5. Kubernetes provisioner automatically creates PV
6. PVC binds to PV (automatic)
7. Deployment updated to mount PVC
```

## Component Changes

### 1. StorageClassBuilder

**Changes:**
- Support both static and dynamic provisioning modes
- For static: Create StorageClass with `kubernetes.io/no-provisioner` (existing)
- For dynamic: Skip StorageClass creation, use existing StorageClass

**New Methods:**
- `shouldCreateStorageClass(spec: BucketStorageClassSpec): boolean`
- `validateStorageClassExists(storageClassName: string): Promise<void>`

### 2. StorageClassResourceManager

**Changes:**
- Add method to validate existing StorageClass exists
- Skip StorageClass creation for dynamic provisioning mode

**New Methods:**
- `validateStorageClass(storageClassName: string): Promise<k8s.V1StorageClass>`

### 3. PVCManager

**Changes:**
- Detect provisioning mode from StorageClass provisioner
- Skip PV creation callback for dynamic provisioning
- For dynamic: Let Kubernetes handle PV provisioning automatically

**Modified Methods:**
- `createOrUpdatePVC()`: Check if StorageClass uses dynamic provisioning, skip PV creation callback if so

### 4. StorageClassManager

**Changes:**
- Orchestrate both static and dynamic provisioning flows
- Route to appropriate handlers based on provisioning mode

**Modified Methods:**
- `createOrUpdateStorageClass()`: Handle both modes
- `createOrUpdatePVC()`: Skip PV creation for dynamic provisioning

### 5. Server (Storage Manager)

**Changes:**
- Pass provisioning mode information through sync flow
- Handle both modes in `syncStorageClasses()`

**Modified Methods:**
- `syncStorageClasses()`: Handle both provisioning modes

## Frontend Changes

### UI Components

1. **Provisioning Mode Toggle**: Radio buttons to choose between Existing Volume and New Volume
2. **Conditional Forms**: Show/hide fields based on provisioning mode
3. **StorageClass Selection**: Dropdown to select StorageClass for dynamic provisioning
4. **Storage Size Input**: Input field for volume size (e.g., "10Gi", "100Gi")
5. **Advanced Parameters**: Optional accordion for provisioner-specific parameters

### UI Flow

#### Creating a Bucket

1. User opens Create Bucket modal
2. User selects provisioning mode:
   - **Existing Volume**: Shows Volume Endpoint field (current behavior)
   - **New Volume**: Shows StorageClass dropdown and Storage Size input
3. User fills in required fields
4. User submits form
5. Backend validates and creates bucket
6. Storage Manager creates PVC (and PV if static, or lets Kubernetes provision if dynamic)

#### Editing a Bucket

1. User opens Edit Bucket modal
2. Form pre-populates with current bucket data
3. Provisioning mode reflects current bucket configuration
4. User can change provisioning mode (with validation)
5. User updates fields and submits

### Files Changed (Frontend)

- `types/bucket.ts` - Add provisioning mode fields
- `BucketForm.tsx` - Add toggle and conditional fields
- `bucketForm.ts` - Update form conversion utilities
- `api.ts` - Add StorageClass API and update types

## Configuration

### Environment Variables

No new environment variables required. The provisioning mode is determined from bucket configuration.

### StorageClass Configuration

For dynamic provisioning, administrators must:

1. **Create StorageClasses** with appropriate provisioners:
   ```yaml
   apiVersion: storage.k8s.io/v1
   kind: StorageClass
   metadata:
     name: aws-ebs-gp3
   provisioner: ebs.csi.aws.com
   parameters:
     type: gp3
     fsType: ext4
   volumeBindingMode: WaitForFirstConsumer
   allowVolumeExpansion: true
   ```

2. **Configure bucket** to reference the StorageClass:
   ```json
   {
     "provisioning_mode": "dynamic",
     "storage_class_name": "aws-ebs-gp3",
     "volume_info": {
       "type": "ebs",
       "storage_size": "100Gi"
     }
   }
   ```

## Backward Compatibility

### Existing Buckets

- Existing buckets without `provisioning_mode` field default to `'static'`
- Existing behavior is preserved
- No migration required

### API Compatibility

- Bucket creation API remains backward compatible
- New fields are optional
- Default behavior matches current implementation

## Error Handling

### Dynamic Provisioning Errors

1. **StorageClass Not Found**:
   - Error: StorageClass specified in `storage_class_name` does not exist
   - Handling: Log error, skip bucket, continue with other buckets

2. **Provisioner Failure**:
   - Error: CSI driver fails to provision volume
   - Handling: PVC remains in Pending state, retry on next sync cycle

3. **Insufficient Resources**:
   - Error: Cloud provider has insufficient quota/resources
   - Handling: PVC remains in Pending state, log warning

### Static Provisioning Errors

- Existing error handling remains unchanged

## Testing Strategy

### Unit Tests

1. **StorageClassBuilder**:
   - Test static provisioning mode (existing tests)
   - Test dynamic provisioning mode (skip creation)
   - Test validation of existing StorageClass

2. **PVCManager**:
   - Test PVC creation for static provisioning
   - Test PVC creation for dynamic provisioning (no PV callback)
   - Test detection of provisioning mode

3. **StorageClassManager**:
   - Test orchestration of static provisioning flow
   - Test orchestration of dynamic provisioning flow

### Integration Tests

1. **End-to-End Static Provisioning**:
   - Create bucket with static provisioning
   - Verify StorageClass, PVC, PV creation
   - Verify deployment mount

2. **End-to-End Dynamic Provisioning**:
   - Create bucket with dynamic provisioning
   - Verify PVC creation (no StorageClass creation)
   - Verify automatic PV provisioning
   - Verify deployment mount

3. **Mixed Mode**:
   - Create buckets with both static and dynamic provisioning
   - Verify both work correctly in same deployment

## Migration Path

### Phase 1: Implementation
- Add `provisioning_mode` field to types
- Implement dynamic provisioning support
- Maintain backward compatibility

### Phase 2: Testing
- Unit tests for new functionality
- Integration tests with real StorageClasses
- Performance testing

### Phase 3: Documentation
- Update API documentation
- Update deployment guides
- Add examples for common StorageClasses

### Phase 4: Rollout
- Deploy to staging environment
- Monitor for issues
- Gradual rollout to production

## Security Considerations

### Dynamic Provisioning

1. **StorageClass Access Control**:
   - Ensure StorageClasses are properly secured
   - Validate StorageClass exists before use
   - Prevent use of unauthorized StorageClasses

2. **Resource Quotas**:
   - Monitor PVC creation to prevent resource exhaustion
   - Consider implementing quotas per namespace

3. **Secret Management**:
   - Ensure secrets for StorageClasses are properly secured
   - Validate secret references in StorageClass parameters

## Performance Considerations

### Dynamic Provisioning

1. **Provisioning Latency**:
   - Dynamic provisioning may take longer than static
   - Consider async provisioning with status polling

2. **Resource Usage**:
   - Monitor PV creation rate
   - Consider rate limiting for cloud provider APIs

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| StorageClass not found | Validate before use, clear error messages |
| Provisioning failures | Retry logic, status monitoring |
| Resource exhaustion | Monitor PVC creation, consider quotas |
| Breaking changes | Backward compatible design, default to static |

## Future Enhancements

1. **StorageClass Discovery**:
   - Automatically discover available StorageClasses
   - Provide recommendations based on volume type

2. **Volume Expansion**:
   - Support volume expansion for dynamically provisioned volumes
   - Handle expansion requests gracefully

3. **Volume Snapshots**:
   - Support volume snapshots for dynamically provisioned volumes
   - Integrate with backup solutions

4. **Multi-Cloud Support**:
   - Support multiple cloud providers
   - Automatic StorageClass selection based on deployment region

## References

- [Kubernetes Storage Classes](https://kubernetes.io/docs/concepts/storage/storage-classes/)
- [CSI Drivers](https://kubernetes-csi.github.io/docs/)
- [Dynamic Volume Provisioning](https://kubernetes.io/docs/concepts/storage/dynamic-provisioning/)
- [Static Volume Provisioning](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#static)

