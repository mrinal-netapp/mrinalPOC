# RBAC Permissions Verification for Static PV Provisioning

## Overview

This document verifies that all necessary RBAC permissions are configured for Storage Manager to perform static PV provisioning operations.

## Required Permissions Summary

### Cluster-Scoped Resources (Require ClusterRole)

| Resource | API Group | Verbs | Operations |
|----------|-----------|-------|------------|
| `persistentvolumes` | `""` (core) | `get`, `list`, `watch`, `create`, `update`, `patch`, `delete` | Create PVs on-demand, list available PVs, delete unused PVs |
| `storageclasses` | `storage.k8s.io` | `get`, `list`, `watch`, `create`, `update`, `patch`, `delete` | Create/update/delete StorageClasses |

### Namespace-Scoped Resources (Can use ClusterRole for cross-namespace access)

| Resource | API Group | Verbs | Operations |
|----------|-----------|-------|------------|
| `persistentvolumeclaims` | `""` (core) | `get`, `list`, `watch`, `create`, `update`, `patch`, `delete` | Create/update/delete PVCs |
| `secrets` | `""` (core) | `get`, `list`, `watch`, `create`, `update`, `patch`, `delete` | Create/update/delete Secrets for auth |
| `deployments` | `apps` | `get`, `list`, `watch`, `patch` | Update deployment to mount PVCs |

## Code Operations Mapping

### PersistentVolume Operations

```typescript
// Create PV (ensurePVPool)
await this.coreApi.createPersistentVolume(pv);
// Required: create persistentvolumes

// List PVs (listPVsForStorageClass)
await this.coreApi.listPersistentVolume(..., labelSelector);
// Required: list persistentvolumes

// Read PV (ensurePVPool, findAvailablePV)
await this.coreApi.readPersistentVolume(pvName);
// Required: get persistentvolumes

// Delete PV (deleteStorageClass)
await this.coreApi.deletePersistentVolume(pvName);
// Required: delete persistentvolumes
```

### StorageClass Operations

```typescript
// Create StorageClass
await this.storageApi.createStorageClass(storageClass);
// Required: create storageclasses

// Read StorageClass
await this.storageApi.readStorageClass(scName);
// Required: get storageclasses

// Update StorageClass
await this.storageApi.replaceStorageClass(scName, storageClass);
// Required: update storageclasses

// List StorageClasses
await this.storageApi.listStorageClass(..., labelSelector);
// Required: list storageclasses

// Delete StorageClass
await this.storageApi.deleteStorageClass(scName);
// Required: delete storageclasses
```

### PersistentVolumeClaim Operations

```typescript
// Create PVC
await this.coreApi.createNamespacedPersistentVolumeClaim(namespace, pvc);
// Required: create persistentvolumeclaims

// Read PVC
await this.coreApi.readNamespacedPersistentVolumeClaim(pvcName, namespace);
// Required: get persistentvolumeclaims

// Update PVC
await this.coreApi.replaceNamespacedPersistentVolumeClaim(pvcName, namespace, pvc);
// Required: update persistentvolumeclaims

// Delete PVC
await this.coreApi.deleteNamespacedPersistentVolumeClaim(pvcName, namespace);
// Required: delete persistentvolumeclaims
```

### Secret Operations

```typescript
// Create Secret
await this.coreApi.createNamespacedSecret(namespace, secret);
// Required: create secrets

// Read Secret
await this.coreApi.readNamespacedSecret(secretName, namespace);
// Required: get secrets

// Update Secret
await this.coreApi.replaceNamespacedSecret(secretName, namespace, secret);
// Required: update secrets

// Delete Secret
await this.coreApi.deleteNamespacedSecret(secretName, namespace);
// Required: delete secrets
```

### Deployment Operations

```typescript
// List Deployments
await this.appsApi.listNamespacedDeployment(namespace, ..., labelSelector);
// Required: list deployments

// Read Deployment
await this.appsApi.readNamespacedDeployment(name, namespace);
// Required: get deployments

// Patch Deployment
await this.appsApi.patchNamespacedDeployment(name, namespace, patchBody, ...);
// Required: patch deployments
```

## Current RBAC Configuration

The RBAC configuration in `deployments/helm/workers/charts/storage-manager/templates/rbac-pvc.yaml` includes:

✅ **StorageClasses**: All required verbs  
✅ **Secrets**: All required verbs  
✅ **PVCs**: All required verbs  
✅ **PVs**: All required verbs (for static provisioning)  
✅ **Deployments**: Required verbs (get, list, watch, patch, update)  
✅ **Pods**: Required verbs (get, list, watch) — for checking active mounts  
✅ **Events**: Required verbs (create, patch) — for recording status events  
✅ **VolumeMountSets** (agentstudio.io): CRD management verbs

## Verification Commands

### Check Current Permissions

```bash
# Check ClusterRole exists
kubectl get clusterrole storage-manager-storageclass-manager -o yaml

# Check ClusterRoleBinding exists
kubectl get clusterrolebinding storage-manager-storageclass-manager -o yaml

# Verify ServiceAccount (use your deployment namespace)
kubectl get serviceaccount storage-manager -n <namespace> -o yaml

# Test permissions as the service account
kubectl auth can-i list persistentvolumes --as=system:serviceaccount:<namespace>:storage-manager
kubectl auth can-i create persistentvolumes --as=system:serviceaccount:<namespace>:storage-manager
kubectl auth can-i get persistentvolumes --as=system:serviceaccount:<namespace>:storage-manager
kubectl auth can-i delete persistentvolumes --as=system:serviceaccount:<namespace>:storage-manager

# Test StorageClass permissions
kubectl auth can-i create storageclasses --as=system:serviceaccount:<namespace>:storage-manager
kubectl auth can-i delete storageclasses --as=system:serviceaccount:<namespace>:storage-manager

# Test PVC permissions
kubectl auth can-i create persistentvolumeclaims --as=system:serviceaccount:<namespace>:storage-manager -n <namespace>
kubectl auth can-i delete persistentvolumeclaims --as=system:serviceaccount:<namespace>:storage-manager -n <namespace>

# Test Deployment permissions
kubectl auth can-i patch deployments --as=system:serviceaccount:<namespace>:storage-manager -n <namespace>
kubectl auth can-i update deployments --as=system:serviceaccount:<namespace>:storage-manager -n <namespace>
```

### Apply Updated RBAC

After updating the RBAC file, apply it:

```bash
# Apply updated RBAC
kubectl apply -f deployments/helm/workers/charts/storage-manager/templates/rbac-pvc.yaml

# Or via Helm upgrade
make helm-workers-upgrade-aks
```

## Common Permission Errors

### Error: "cannot list resource persistentvolumes"

**Cause**: Missing `persistentvolumes` resource in ClusterRole rules

**Solution**: Add the following rule to ClusterRole:
```yaml
- apiGroups: [""]
  resources: ["persistentvolumes"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
```

### Error: "persistentvolumes is forbidden"

**Cause**: ServiceAccount not bound to ClusterRole, or using Role instead of ClusterRole

**Solution**: 
1. Ensure ClusterRoleBinding exists and references the correct ServiceAccount
2. Verify using ClusterRole (not Role) - PVs are cluster-scoped

### Error: "cannot create resource persistentvolumes"

**Cause**: Missing `create` verb for `persistentvolumes`

**Solution**: Ensure `create` is included in verbs list

## Security Considerations

1. **Least Privilege**: The permissions granted are minimal and scoped to only what's needed
2. **Cluster-Scoped Access**: PVs are cluster-scoped, so ClusterRole is required
3. **Namespace Isolation**: Secrets and PVCs are namespace-scoped but ClusterRole allows cross-namespace access (if needed)
4. **Deployment Updates**: `patch` and `update` verbs are granted for deployments (not `delete`). The `update` verb is required because `replaceNamespacedDeployment` is used to avoid Content-Type header issues with patch operations.

## Related Files

- RBAC Template: `deployments/helm/workers/charts/storage-manager/templates/rbac-pvc.yaml`
- Design Document: `docs/storage/static-pv-provisioning-design.md`
- Storage Manager README: `src/nemo/storage-manager/README.md`

