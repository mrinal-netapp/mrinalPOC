# StorageClass Registration Guide for Dynamic Volumes

This guide explains how to register StorageClasses for dynamic volume provisioning and provides options for local storage solutions.

## Overview

A **StorageClass** in Kubernetes defines a class of storage with specific characteristics (provisioner, parameters, reclaim policy, etc.). When a PVC references a StorageClass, Kubernetes automatically provisions a PersistentVolume using the specified provisioner.

## How to Register a StorageClass

### 1. Basic StorageClass Structure

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: <storage-class-name>
provisioner: <provisioner-name>
parameters:
  # Provisioner-specific parameters
allowVolumeExpansion: true  # Optional: allows volume expansion
volumeBindingMode: Immediate  # or WaitForFirstConsumer
reclaimPolicy: Delete  # or Retain
```

### 2. Apply the StorageClass

```bash
kubectl apply -f storageclass.yaml
```

### 3. Verify the StorageClass

```bash
# List all StorageClasses
kubectl get storageclass

# Get details of a specific StorageClass
kubectl get storageclass <name> -o yaml

# Describe a StorageClass
kubectl describe storageclass <name>
```

## Local Storage Options

### Option 1: Local Path Provisioner (Simplest)

**Best for**: Development, testing, single-node clusters

The Local Path Provisioner uses the host's local filesystem to create volumes.

#### Installation

```bash
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.24/deploy/local-path-storage.yaml
```

#### StorageClass Example

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-path
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: rancher.io/local-path
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
```

**Features**:
- ✅ Simple setup
- ✅ No additional dependencies
- ✅ Works on any Kubernetes cluster
- ❌ Data tied to specific node
- ❌ No replication
- ❌ Not suitable for production workloads requiring HA

### Option 2: OpenEBS LocalPV

**Best for**: Production workloads needing local storage with better management

OpenEBS LocalPV provides local persistent volumes with better lifecycle management.

#### Installation

```bash
# Install OpenEBS operator
kubectl apply -f https://openebs.github.io/charts/openebs-operator.yaml

# Or using Helm
helm repo add openebs https://openebs.github.io/charts
helm repo update
helm install openebs openebs/openebs --namespace openebs --create-namespace
```

#### StorageClass Example (Hostpath)

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: openebs-hostpath
provisioner: openebs.io/local
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
parameters:
  storageType: hostpath
  basePath: "/var/openebs/local"
```

#### StorageClass Example (Device)

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: openebs-device
provisioner: openebs.io/local
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
parameters:
  storageType: device
  fstype: "ext4"
```

**Features**:
- ✅ Better lifecycle management
- ✅ Supports both hostpath and raw devices
- ✅ Production-ready
- ✅ Can use LVM for better performance
- ❌ More complex setup
- ❌ Still node-local (no replication)

### Option 3: TopoLVM (LVM-based)

**Best for**: Production workloads needing LVM-based local storage

TopoLVM uses LVM (Logical Volume Manager) for dynamic provisioning of local storage.

#### Prerequisites

- Nodes must have LVM installed
- Volume group (VG) must exist on each node

#### Installation

```bash
# Clone the repository
git clone https://github.com/topolvm/topolvm.git
cd topolvm

# Install using Helm
helm repo add topolvm https://topolvm.github.io/topolvm
helm repo update
helm install topolvm topolvm/topolvm --namespace topolvm-system --create-namespace
```

#### StorageClass Example

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: topolvm-provisioner
provisioner: topolvm.cybozu.com
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
parameters:
  "topolvm.cybozu.com/device-class": "ssd"  # Must match device-class in TopoLVM config
```

**Features**:
- ✅ LVM-based (better performance)
- ✅ Dynamic provisioning
- ✅ Volume expansion support
- ✅ Raw block volumes
- ✅ Filesystem metrics
- ❌ Requires LVM setup on nodes
- ❌ More complex configuration

### Option 4: Local Static Provisioning with CSI

**Best for**: When you need to manually manage local volumes

This approach uses the local volume static provisioner to discover and create PVs from local disks.

#### Installation

```bash
# Clone the local volume provisioner
git clone https://github.com/kubernetes-sigs/sig-storage-local-static-provisioner.git
cd sig-storage-local-static-provisioner

# Configure and deploy
# Edit deployment/kubernetes/example/default_example_storageclass.yaml
kubectl apply -f deployment/kubernetes/example/
```

#### StorageClass Example

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-storage
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
```

**Note**: This uses `no-provisioner`, meaning PVs must be created manually (by an admin or by Storage Manager). There is no provisioner pod that dynamically creates volumes.

## Cloud Provider StorageClasses

### AWS EBS

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ebs-gp3
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "3000"
  throughput: "125"
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

### Azure Disk

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: azure-disk-premium
provisioner: disk.csi.azure.com
parameters:
  skuName: Premium_LRS
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

### GCP Persistent Disk

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gce-pd-ssd
provisioner: pd.csi.storage.gke.io
parameters:
  type: pd-ssd
  replication-type: regional-pd
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
```

## Using StorageClasses in Your Application

### 1. Create a PVC referencing the StorageClass

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-pvc
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: local-path  # Reference your StorageClass
  resources:
    requests:
      storage: 10Gi
```

### 2. Use the PVC in a Pod

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-pod
spec:
  containers:
  - name: app
    image: nginx
    volumeMounts:
    - name: data
      mountPath: /data
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: my-pvc
```

## StorageClass Parameters Explained

### `provisioner`
- **Required**: The name of the volume plugin/CSI driver
- Examples: `rancher.io/local-path`, `openebs.io/local`, `ebs.csi.aws.com`

### `volumeBindingMode`
- **`Immediate`**: Volume is bound immediately when PVC is created
- **`WaitForFirstConsumer`**: Volume is bound when a pod using the PVC is scheduled (recommended for local storage)

### `reclaimPolicy`
- **`Delete`**: Volume is deleted when PVC is deleted
- **`Retain`**: Volume is retained after PVC deletion (manual cleanup required)

### `allowVolumeExpansion`
- **`true`**: Allows PVC expansion
- **`false`**: Volume size cannot be changed after creation

## Recommendations for Local Storage

### Development/Testing
- **Use**: Local Path Provisioner
- **Reason**: Simplest setup, good enough for testing

### Production (Single Node)
- **Use**: OpenEBS LocalPV or TopoLVM
- **Reason**: Better lifecycle management, production-ready

### Production (Multi-Node, High Performance)
- **Use**: TopoLVM with LVM
- **Reason**: Best performance, supports volume expansion

### Production (Multi-Node, High Availability)
- **Avoid**: Local storage (data tied to nodes)
- **Use**: Network-attached storage (NFS, Ceph, GlusterFS) or cloud storage

## Integration with AgentStudio

When creating a bucket with dynamic provisioning in AgentStudio:

1. **Ensure StorageClass exists** in your cluster:
   ```bash
   kubectl get storageclass
   ```

2. **Create bucket via UI/API** with:
   - `provisioning_mode: "dynamic"`
   - `storage_class_name: "<your-storageclass-name>"`
   - `storage_size: "10Gi"` (or desired size)

3. **Storage Manager will**:
   - Validate the StorageClass exists
   - Create a PVC referencing the StorageClass
   - Kubernetes will automatically provision a PV
   - Mount the PVC to your deployment

## Troubleshooting

### Check StorageClass Status
```bash
kubectl get storageclass
kubectl describe storageclass <name>
```

### Check PVC Status
```bash
kubectl get pvc
kubectl describe pvc <pvc-name>
```

### Check PV Status
```bash
kubectl get pv
kubectl describe pv <pv-name>
```

### Check Provisioner Logs
```bash
# For local-path-provisioner
kubectl logs -n local-path-storage -l app=local-path-provisioner

# For OpenEBS
kubectl logs -n openebs -l app=openebs-localpv-provisioner
```

### Common Issues

1. **PVC stuck in Pending**
   - Check if StorageClass exists
   - Check provisioner pod logs
   - Verify node has available storage

2. **Volume not binding**
   - Ensure `volumeBindingMode` is appropriate
   - For local storage, use `WaitForFirstConsumer`
   - Check node selectors/affinity

3. **Volume expansion fails**
   - Ensure `allowVolumeExpansion: true` in StorageClass
   - Check if provisioner supports expansion

## References

- [Kubernetes Storage Classes](https://kubernetes.io/docs/concepts/storage/storage-classes/)
- [Local Path Provisioner](https://github.com/rancher/local-path-provisioner)
- [OpenEBS LocalPV](https://openebs.io/docs/user-guides/localpv-hostpath)
- [TopoLVM](https://github.com/topolvm/topolvm)
- [CSI Drivers](https://kubernetes-csi.github.io/docs/drivers.html)







