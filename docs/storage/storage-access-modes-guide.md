# Storage Access Modes Guide

## Overview

This guide explains how AgentStudio handles access modes for PersistentVolumeClaims (PVCs) and how to prevent issues when using StorageClasses that don't support ReadWriteMany.

## Problem

When creating PVCs for dynamic volumes, the system previously hardcoded `ReadWriteMany` access mode. However, many StorageClasses (like `local-path`, `ebs.csi.aws.com`, etc.) only support `ReadWriteOnce` or `ReadWriteOncePod`. This causes PVC creation to fail with errors like:

```
failed to provision volume with StorageClass "standard": 
NodePath only supports ReadWriteOnce and ReadWriteOncePod (1.22+) access modes
```

## Solution

The system now automatically selects the appropriate access mode based on the StorageClass provisioner's capabilities:

1. **Automatic Selection**: If access modes are not specified, the system automatically selects the best mode:
   - Prefers `ReadWriteMany` for shared access across pods (ideal for Ray deployments)
   - Falls back to `ReadWriteOnce` if `ReadWriteMany` is not supported
   - Validates requested modes against StorageClass capabilities

2. **Explicit Configuration**: You can explicitly specify access modes in the bucket configuration

3. **Validation**: The system validates access modes before creating PVCs, providing clear error messages

## Supported Access Modes by Provisioner

The system includes a mapping of common StorageClass provisioners to their supported access modes:

### ReadWriteMany Support
- `nfs.csi.k8s.io` - NFS CSI driver
- `smb.csi.k8s.io` - SMB/CIFS CSI driver
- `cephfs.csi.ceph.com` - CephFS
- `gluster.org/glusterfs` - GlusterFS
- `kubernetes.io/portworx-volume` - Portworx
- `kubernetes.io/no-provisioner` - Static provisioning

### ReadWriteOnce Only
- `rancher.io/local-path` - Local Path Provisioner
- `openebs.io/local` - OpenEBS Local
- `ebs.csi.aws.com` - AWS EBS
- `pd.csi.storage.gke.io` - GCE Persistent Disk
- `disk.csi.azure.com` - Azure Disk
- `topolvm.cybozu.com` - TopoLVM

## Configuration

### Option 1: Automatic Selection (Recommended)

Don't specify `access_modes` - the system will automatically select the best mode:

```json
{
  "name": "my-bucket",
  "region": "us-east-1",
  "volume_info": {
    "type": "dynamic",
    "provisioning_mode": "dynamic",
    "storage_class_name": "local-path",
    "storage_size": "10Gi"
  },
  "auth_info": {
    "type": "none"
  },
  "protocol": "s3"
}
```

The system will automatically use `ReadWriteOnce` for `local-path` StorageClass.

### Option 2: Explicit Configuration

Specify access modes explicitly in the bucket configuration:

```json
{
  "name": "my-bucket",
  "region": "us-east-1",
  "volume_info": {
    "type": "dynamic",
    "provisioning_mode": "dynamic",
    "storage_class_name": "nfs-storage",
    "storage_size": "10Gi",
    "access_modes": ["ReadWriteMany"]
  },
  "auth_info": {
    "type": "none"
  },
  "protocol": "s3"
}
```

**Note**: If you specify access modes that are not supported by the StorageClass, the system will reject the request with a clear error message.

## API Usage

### Create Bucket with Automatic Access Mode Selection

```bash
curl -X POST http://localhost:8080/api/v1/namespaces/my-namespace/buckets \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-bucket",
    "region": "us-east-1",
    "volume_info": {
      "type": "dynamic",
      "provisioning_mode": "dynamic",
      "storage_class_name": "local-path",
      "storage_size": "10Gi"
    },
    "auth_info": {
      "type": "none"
    },
    "protocol": "s3"
  }'
```

### Create Bucket with Explicit Access Modes

```bash
curl -X POST http://localhost:8080/api/v1/namespaces/my-namespace/buckets \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-bucket",
    "region": "us-east-1",
    "volume_info": {
      "type": "dynamic",
      "provisioning_mode": "dynamic",
      "storage_class_name": "nfs-storage",
      "storage_size": "10Gi",
      "access_modes": ["ReadWriteMany"]
    },
    "auth_info": {
      "type": "none"
    },
    "protocol": "s3"
  }'
```

## Error Handling

### Invalid Access Mode

If you specify an access mode that is not supported by the StorageClass:

```
StorageClass 'local-path' (provisioner: rancher.io/local-path) 
does not support requested access modes: ReadWriteMany. 
Supported access modes: ReadWriteOnce, ReadWriteOncePod. 
Consider using a different StorageClass or adjusting access modes.
```

**Solution**: Either:
1. Remove `access_modes` to let the system auto-select
2. Use a supported access mode (e.g., `ReadWriteOnce`)
3. Use a different StorageClass that supports your desired access mode

## Best Practices

1. **For Ray Deployments**: Use StorageClasses that support `ReadWriteMany` (NFS, SMB, CephFS) for shared access across pods
2. **For Single-Pod Use**: `ReadWriteOnce` is sufficient and works with most StorageClasses
3. **Let System Decide**: Unless you have specific requirements, let the system automatically select access modes
4. **Check StorageClass Capabilities**: Before specifying access modes, verify what your StorageClass supports

## StorageClass Examples

### Local Path (ReadWriteOnce Only)

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-path
provisioner: rancher.io/local-path
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
```

**Supported Access Modes**: `ReadWriteOnce`, `ReadWriteOncePod`

### NFS Storage (ReadWriteMany Support)

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nfs-storage
provisioner: nfs.csi.k8s.io
volumeBindingMode: Immediate
reclaimPolicy: Retain
```

**Supported Access Modes**: `ReadWriteMany`, `ReadWriteOnce`, `ReadOnlyMany`

## Implementation Details

The access mode resolution is handled by `AccessModeResolver` utility class:

- **Location**: `src/nemo/storage-manager/src/server/storage/utils/AccessModeResolver.ts`
- **PVC Builder**: Uses `AccessModeResolver` to determine access modes
- **Validation**: `PVCManager` validates access modes before creating PVCs

## Troubleshooting

### Check StorageClass Provisioner

```bash
kubectl get storageclass <storage-class-name> -o jsonpath='{.provisioner}'
```

### Check Supported Access Modes

The system logs the supported and selected access modes:

```
[PVCManager] Creating PVC for StorageClass: local-path 
(provisioner: rancher.io/local-path, 
supported modes: ReadWriteOnce, ReadWriteOncePod, 
using modes: ReadWriteOnce)
```

### Verify PVC Access Mode

```bash
kubectl get pvc <pvc-name> -o jsonpath='{.spec.accessModes}'
```

## Related Documentation

- [Storage Class Guide](./storage-class-guide.md)
- [PVC Dynamic Provisioning Design](./pvc-dynamic-provisioning-design.md)

