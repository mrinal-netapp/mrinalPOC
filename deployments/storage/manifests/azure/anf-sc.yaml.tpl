apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ${STORAGE_CLASS_NAME}
  annotations:
    storageclass.kubernetes.io/is-default-class: "${MARK_AS_DEFAULT}"
provisioner: csi.trident.netapp.io
parameters:
  backendType: azure-netapp-files
  fsType: nfs
allowVolumeExpansion: true
reclaimPolicy: Delete
volumeBindingMode: Immediate
