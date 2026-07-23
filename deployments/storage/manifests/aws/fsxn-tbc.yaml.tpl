apiVersion: trident.netapp.io/v1
kind: TridentBackendConfig
metadata:
  name: ${BACKEND_NAME}
  namespace: ${TRIDENT_NAMESPACE}
spec:
  version: 1
  backendName: ${BACKEND_NAME}
  storageDriverName: ontap-nas
  svm: ${ONTAP_SVM}
  aws:
    fsxFilesystemID: ${FSX_FILESYSTEM_ID}
  credentials:
    name: "${FSXN_CREDENTIALS_ARN}"
    type: awsarn
