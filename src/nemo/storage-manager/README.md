# Storage Manager Service

The Storage Manager service is responsible for coordinating bucket routing, configuration synchronization, and volume mount management in the AgentStudio deployment.

## Features

- **Configuration Sync**: Periodically syncs bucket ownership and metadata from config-service
- **Routing Coordination**: Maintains bucket-to-deployment mappings
- **StorageClass-based Volume Management**: Creates and manages Kubernetes StorageClasses, Secrets, and PVCs per bucket
- **Metrics Collection**: Collects and aggregates metrics from API Gateway

## StorageClass-based Volume Management

The Storage Manager creates StorageClasses, Secrets, and PVCs per bucket for PVC-based volume management. This approach uses standard Kubernetes resources and CSI drivers, eliminating the need for privileged containers.

### Prerequisites

1. **Install CSI Drivers**: Before deploying Storage Manager, install NFS and/or CIFS/SMB CSI drivers:
   - NFS: https://github.com/kubernetes-csi/csi-driver-nfs
   - SMB: https://github.com/kubernetes-csi/csi-driver-smb

2. **RBAC Permissions**: Storage Manager needs permissions to create, read, update, and delete StorageClasses, Secrets, PVCs, and PVs (for static provisioning). Ensure the ServiceAccount has the following ClusterRole:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: storage-manager-storageclass-manager
rules:
- apiGroups: ["storage.k8s.io"]
  resources: ["storageclasses"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["persistentvolumeclaims"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["persistentvolumes"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get", "list", "watch", "patch"]
- apiGroups: ["agentstudio.io"]
  resources: ["volumemountsets"]
  verbs: ["get", "list", "watch", "create", "update", "patch"]
- apiGroups: ["agentstudio.io"]
  resources: ["volumemountsets/status"]
  verbs: ["get", "update", "patch"]
- apiGroups: [""]
  resources: ["events"]
  verbs: ["get", "list", "watch"]
```

**Note**: 
- `persistentvolumes` is a cluster-scoped resource, so a ClusterRole (not Role) is required.
- When using the VolumeMountSet controller, the same ServiceAccount needs `volumemountsets/status` and `events` for mount-failure detection and status updates.

### How It Works

1. **Config Sync**: Storage Manager periodically pulls bucket ownership from config-service
2. **Change Detection**: When bucket ownership changes are detected:
   - **New Buckets**: Creates a StorageClass and Secret (if auth needed) per bucket
   - **Updated Buckets**: Updates the existing StorageClass and Secret
   - **Removed Buckets**: Deletes the StorageClass and Secret
3. **PVC Management**: Storage Manager creates and manages PVCs directly, which are mounted by Kubernetes when pods restart
4. **API Requests**: All instances can handle API requests (stateless), providing high availability

### VolumeMountSet CR and controller (optional)

When **USE_VOLUME_MOUNT_SET_CR** is set, storage-manager writes desired PVC mounts to a **VolumeMountSet** custom resource (CR) instead of patching the deployment directly. A separate **VolumeMountSet controller** watches the CR, patches the target Deployment’s volumes/volumeMounts (managed PVCs only), detects mount failures via Pod Events, and updates the CR status (evicted PVCs, per-PVC conditions). Health is then read from the CR status.

- **CRD**: Install `volumemountsets.agentstudio.io` (see `deployments/crds/volumemountsets.agentstudio.io.yaml`) before storage-manager and the controller. The CR has a **status subresource**; only the controller should patch status.
- **CR name**: Set via `VOLUME_MOUNT_SET_NAME` (default: `s3gateway`). The target Deployment name can be set with `TARGET_DEPLOYMENT_NAME` (defaults to the CR name).
- **Helm**: In the s3gateway chart, set `useVolumeMountSetCR: true` so the chart does **not** inject versitygw PVC volumes (the controller owns them). Default-bucket, pvcs-mount-base, and metadata-volume are still rendered by the chart.
- **Controller**: Run the controller in the same process, same pod, or as a separate deployment. Standalone: `npm run start:controller` (build first). Env: `MOUNT_FAILURE_REMOVAL_MINUTES` (default 5), `MOUNT_FAILURE_RETRY_INTERVAL_MINUTES` (default 30).

### Environment Variables

- `K8S_NAMESPACE`: Kubernetes namespace for StorageClasses and PVCs (defaults to current namespace or 'default')
- `KUBECONFIG_PATH`: Path to kubeconfig file (optional, uses in-cluster config if not set)
- `DEPLOYMENT_ID`: Deployment identifier (required)
- `REGION`: Deployment region (required)
- `CONFIG_SERVICE_URL`: URL of config-service
- `CONFIG_SYNC_INTERVAL`: Config sync interval (e.g., '30s' or milliseconds)
- `LOG_LEVEL`: Logging level (default: 'info')
- `USE_VOLUME_MOUNT_SET_CR`: When set, storage-manager updates the VolumeMountSet CR spec (desiredPvcNames) and reads health from CR status instead of patching the deployment or listing Pods/Events.
- `VOLUME_MOUNT_SET_NAME`: Name of the VolumeMountSet CR (default: `s3gateway`).
- `TARGET_DEPLOYMENT_NAME`: Target Deployment name for the VolumeMountSet (default: same as `VOLUME_MOUNT_SET_NAME`).

### API Endpoints

- `GET /api/v1/routing/info`: Get routing information for a bucket
- `GET /api/v1/health`: Health check with details
- `POST /api/v1/metrics`: Submit metrics
- `GET /health`: Simple health check
- `GET /ready`: Readiness check
- `GET /swagger`: Swagger UI documentation

## Development

### Build

```bash
npm install
npm run build
```

### Run Locally

```bash
npm run dev
```

### Testing StorageClass Operations

When running locally, you can test StorageClass operations by:

1. Setting `KUBECONFIG_PATH` to point to your kubeconfig file
2. Ensuring CSI drivers are installed in your cluster
3. The service will automatically create/update/delete StorageClasses based on bucket ownership changes

### Scaling Considerations

- **API Requests**: Scale horizontally - all instances can handle requests
- **Background Tasks**: All instances perform background tasks (config sync, health reporting, Kubernetes resource management)
- **State**: Each instance maintains its own `bucketRegistry`

## Troubleshooting

### StorageClass Operations Failing

If StorageClass creation fails, check:
1. ServiceAccount permissions (ClusterRole and ClusterRoleBinding for StorageClasses and Secrets)
2. Network connectivity to Kubernetes API server
3. CSI drivers are installed and StorageClasses can be created
4. The namespace is correct (check `K8S_NAMESPACE` environment variable)


