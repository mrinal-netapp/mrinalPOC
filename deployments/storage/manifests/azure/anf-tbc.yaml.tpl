apiVersion: trident.netapp.io/v1
kind: TridentBackendConfig
metadata:
  name: ${BACKEND_NAME}
  namespace: ${TRIDENT_NAMESPACE}
spec:
  version: 1
  storageDriverName: azure-netapp-files
  subscriptionID: "${SUBSCRIPTION_ID}"
  tenantID: "${TENANT_ID}"
  location: "${LOCATION}"
  useManagedIdentity: true
  managedIdentityClientID: "${KUBELET_CLIENT_ID}"
  resourceGroups: ["${RESOURCE_GROUP}"]
  netappAccounts: ["${ANF_ACCOUNT}"]
  capacityPools: ["${ANF_POOL}"]
  virtualNetwork: "${VNET_NAME}"
  subnet: "${ANF_SUBNET}"
  serviceLevel: ${ANF_SERVICE_LEVEL}
  # ANF volume create is async; default Trident poll is ~2s per CSI attempt. Premium
  # pools on a new account often need several minutes before reaching Available.
  volumeCreateTimeout: "600"
  sdkTimeout: "120"
  defaults:
    exportRule: "${EXPORT_CIDRS}"
    size: "100Gi"
