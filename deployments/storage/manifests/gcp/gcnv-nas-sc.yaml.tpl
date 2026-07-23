apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ${STORAGE_CLASS_NAME}
provisioner: csi.trident.netapp.io
parameters:
  backendType: "google-cloud-netapp-volumes"
allowVolumeExpansion: true
# WaitForFirstConsumer for the same reason as the SAN StorageClass template
# (see gcnv-san-sc.yaml.tpl): avoids a permanent provisioning deadlock if the
# node pool needed to service the volume has scaled to zero when the PVC is
# created, by deferring the topology decision until a consumer pod exists.
volumeBindingMode: WaitForFirstConsumer
