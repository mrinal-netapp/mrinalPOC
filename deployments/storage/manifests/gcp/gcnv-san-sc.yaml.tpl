apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ${STORAGE_CLASS_NAME}
provisioner: csi.trident.netapp.io
parameters:
  backendType: "google-cloud-netapp-volumes-san"
  fsType: "${SAN_FSTYPE}"
allowVolumeExpansion: true
# WaitForFirstConsumer: Trident's GCNV SAN driver needs a node that already
# publishes its topology segment (i.e. one running on the SAN-tainted node
# pool) before it can pick a LUN location. With Immediate binding, Trident
# has to decide topology before any pod/node is known, which fails outright
# ("no available topology found") if that node pool has scaled to zero — and
# the cluster autoscaler won't scale it back up to fix an already-unbound
# Immediate PVC, causing a permanent deadlock. WaitForFirstConsumer defers
# binding until a pod is scheduled, which the autoscaler treats as a normal
# scale-up trigger.
volumeBindingMode: WaitForFirstConsumer
