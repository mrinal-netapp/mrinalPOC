apiVersion: trident.netapp.io/v1
kind: TridentBackendConfig
metadata:
  name: ${BACKEND_NAME}
  namespace: ${TRIDENT_NAMESPACE}
spec:
  version: 1
  backendName: ${BACKEND_NAME}
  storageDriverName: google-cloud-netapp-volumes-san
  projectNumber: "${PROJECT_NUMBER}"
  location: "${GCNV_LOCATION}"
${STORAGE_POOLS_BLOCK}
