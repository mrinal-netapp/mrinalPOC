# CSI Driver Installation Guide

This guide explains how to install the necessary CSI drivers for PVC-based volume management (Pattern B) in your Kubernetes cluster.

## Required CSI Drivers

For Pattern B to work, you need to install:
1. **NFS CSI Driver** - For NFS volume support
2. **CIFS/SMB CSI Driver** - For CIFS/SMB volume support

## Prerequisites

- Kubernetes cluster (v1.20+ recommended)
- `kubectl` configured to access your cluster
- Helm 3.x (recommended for easier installation)
- Cluster admin permissions

## Option 1: NFS CSI Driver Installation

### Using Helm (Recommended)

The official NFS CSI driver can be installed via Helm:

```bash
# Add the CSI driver Helm repository
helm repo add csi-driver-nfs https://raw.githubusercontent.com/kubernetes-csi/csi-driver-nfs/master/charts
helm repo update

# Install the NFS CSI driver
helm install csi-driver-nfs csi-driver-nfs/csi-driver-nfs \
  --namespace kube-system \
  --set kubeletDir=/var/lib/kubelet
```

### Using kubectl (Manual Installation)

```bash
# Clone the repository
git clone https://github.com/kubernetes-csi/csi-driver-nfs.git
cd csi-driver-nfs

# Deploy the driver
kubectl apply -f deploy/rbac-csi-nfs-controller.yaml
kubectl apply -f deploy/csi-nfs-driverinfo.yaml
kubectl apply -f deploy/csi-nfs-controller.yaml
kubectl apply -f deploy/csi-nfs-node.yaml
```

### Verify NFS CSI Driver Installation

```bash
# Check if the driver pods are running
kubectl get pods -n kube-system | grep csi-nfs

# Check if the driver is registered
kubectl get csidriver | grep nfs.csi.k8s.io
```

Expected output should show:
- `csi-nfs-controller-*` pods in Running state
- `csi-nfs-node-*` pods (one per node) in Running state
- `nfs.csi.k8s.io` CSIDriver resource

## Option 2: CIFS/SMB CSI Driver Installation

### Using Helm (Recommended)

```bash
# Add the CSI driver Helm repository
helm repo add csi-driver-smb https://raw.githubusercontent.com/kubernetes-csi/csi-driver-smb/master/charts
helm repo update

# Install the SMB CSI driver
helm install csi-driver-smb csi-driver-smb/csi-driver-smb \
  --namespace kube-system \
  --set kubeletDir=/var/lib/kubelet
```

### Using kubectl (Manual Installation)

```bash
# Clone the repository
git clone https://github.com/kubernetes-csi/csi-driver-smb.git
cd csi-driver-smb

# Deploy the driver
kubectl apply -f deploy/rbac-csi-smb-controller.yaml
kubectl apply -f deploy/csi-smb-driverinfo.yaml
kubectl apply -f deploy/csi-smb-controller.yaml
kubectl apply -f deploy/csi-smb-node.yaml
```

### Verify SMB CSI Driver Installation

```bash
# Check if the driver pods are running
kubectl get pods -n kube-system | grep csi-smb

# Check if the driver is registered
kubectl get csidriver | grep smb.csi.k8s.io
```

Expected output should show:
- `csi-smb-controller-*` pods in Running state
- `csi-smb-node-*` pods (one per node) in Running state
- `smb.csi.k8s.io` CSIDriver resource

## Alternative: NFS Subdir External Provisioner

If you prefer a simpler NFS solution that creates subdirectories per PVC, you can use `nfs-subdir-external-provisioner`:

```bash
# Add Helm repository
helm repo add nfs-subdir-external-provisioner https://kubernetes-sigs.github.io/nfs-subdir-external-provisioner/
helm repo update

# Install (replace NFS_SERVER and NFS_PATH with your values)
helm install nfs-subdir-external-provisioner nfs-subdir-external-provisioner/nfs-subdir-external-provisioner \
  --set nfs.server=<NFS_SERVER_IP> \
  --set nfs.path=/exports \
  --namespace kube-system
```

**Note**: This approach requires a single NFS server/export, which may not work if your buckets use different NFS endpoints.

## Configure StorageClasses

After installing the CSI drivers, update the StorageClass definitions to match your provisioner names:

### 1. Check Provisioner Names

```bash
# Check NFS CSI driver provisioner
kubectl get csidriver nfs.csi.k8s.io -o yaml | grep provisioner

# Check SMB CSI driver provisioner  
kubectl get csidriver smb.csi.k8s.io -o yaml | grep provisioner
```

### 2. Update StorageClasses

Edit `src/nemo/storage-manager/storageclasses.yaml` and ensure the `provisioner` field matches:

```yaml
# For NFS
provisioner: nfs.csi.k8s.io  # Should match your NFS CSI driver

# For CIFS/SMB
provisioner: smb.csi.k8s.io  # Should match your SMB CSI driver
```

### 3. Apply StorageClasses

```bash
kubectl apply -f src/nemo/storage-manager/storageclasses.yaml
```

### 4. Verify StorageClasses

```bash
kubectl get storageclass

# Should show:
# NAME            PROVISIONER       RECLAIMPOLICY   VOLUMEBINDINGMODE   ALLOWVOLUMEEXPANSION   AGE
# nfs-storage     nfs.csi.k8s.io    Delete          Immediate           true                   <age>
# cifs-storage    smb.csi.k8s.io    Delete          Immediate           true                   <age>
```

## Testing CSI Drivers

### Test NFS StorageClass

```bash
# Create a test PVC
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: test-nfs-pvc
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: nfs-storage
  resources:
    requests:
      storage: 1Gi
EOF

# Check PVC status
kubectl get pvc test-nfs-pvc

# Clean up
kubectl delete pvc test-nfs-pvc
```

### Test CIFS StorageClass

```bash
# Create a test PVC
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: test-cifs-pvc
spec:
  accessModes:
    - ReadWriteMany
  storageClassName: cifs-storage
  resources:
    requests:
      storage: 1Gi
EOF

# Check PVC status
kubectl get pvc test-cifs-pvc

# Clean up
kubectl delete pvc test-cifs-pvc
```

## Troubleshooting

### CSI Driver Pods Not Starting

```bash
# Check pod logs
kubectl logs -n kube-system -l app=csi-nfs-controller
kubectl logs -n kube-system -l app=csi-smb-controller

# Check node pods
kubectl logs -n kube-system -l app=csi-nfs-node --tail=50
kubectl logs -n kube-system -l app=csi-smb-node --tail=50
```

### PVC Stuck in Pending

```bash
# Check PVC events
kubectl describe pvc <pvc-name>

# Check for provisioner errors
kubectl get events --sort-by='.lastTimestamp' | grep <pvc-name>
```

### StorageClass Not Found

```bash
# Verify StorageClass exists
kubectl get storageclass

# Check if provisioner matches CSI driver
kubectl get storageclass nfs-storage -o yaml | grep provisioner
kubectl get csidriver | grep nfs
```

## Platform-Specific Notes

### GKE (Google Kubernetes Engine)

GKE has built-in support for NFS via Filestore. You may not need the NFS CSI driver if using Filestore.

### EKS (Amazon Elastic Kubernetes Service)

AWS EFS CSI driver is available. Consider using EFS instead of generic NFS CSI driver for better integration.

### AKS (Azure Kubernetes Service)

Azure Files CSI driver provides SMB support. Consider using Azure Files instead of generic SMB CSI driver.

### On-Premises Clusters

For on-premises deployments, the generic CSI drivers work well. Ensure:
- NFS servers are accessible from cluster nodes
- SMB shares are accessible from cluster nodes
- Network connectivity and firewall rules are configured

## Next Steps

After installing the CSI drivers:

1. **Verify Installation**: Run the verification commands above
2. **Update StorageClasses**: Ensure provisioner names match
3. **Test PVC Creation**: Create test PVCs to verify functionality
4. **Configure Storage Manager**: Ensure bucket configurations use the correct StorageClass names
5. **Monitor**: Watch for PVC creation/deletion events

## References

- [NFS CSI Driver](https://github.com/kubernetes-csi/csi-driver-nfs)
- [SMB CSI Driver](https://github.com/kubernetes-csi/csi-driver-smb)
- [Kubernetes CSI Documentation](https://kubernetes-csi.github.io/docs/)

