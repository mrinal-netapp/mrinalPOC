apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ${STORAGE_CLASS_NAME}
  annotations:
    storageclass.kubernetes.io/is-default-class: "${MARK_AS_DEFAULT}"
provisioner: csi.trident.netapp.io
parameters:
  backendType: "ontap-nas"
reclaimPolicy: Retain
volumeBindingMode: Immediate
allowVolumeExpansion: true
mountOptions:
  - nfsvers=4.0
  - nolock
  - soft
  - timeo=50
  - retrans=3
