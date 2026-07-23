#!/usr/bin/env bash
# setup-anf-trident.sh — Wire up NetApp Trident + ANF NFS StorageClass on the AKS cluster.
#
# Prerequisites (senior must run once before this script):
#   NEW_KUBELET_OID=$(az aks show \
#     -g "${RG:-rg-agentstudio-dev-eus2-001}" \
#     -n "${AKS_CLUSTER_NAME:-aks-agentstudio-dev-eus2-001}" \
#     --query identityProfile.kubeletidentity.objectId -o tsv)
#
#   az role assignment create --assignee-object-id $NEW_KUBELET_OID \
#     --assignee-principal-type ServicePrincipal --role "Reader" \
#     --scope "/subscriptions/ae26acbb-72f9-440e-822f-b13ef3e4fec1/resourceGroups/rg-agentstudio-dev-eus2-001"
#
#   az role assignment create --assignee-object-id $NEW_KUBELET_OID \
#     --assignee-principal-type ServicePrincipal --role "Contributor" \
#     --scope "/subscriptions/ae26acbb-72f9-440e-822f-b13ef3e4fec1/resourceGroups/rg-agentstudio-dev-eus2-001/providers/Microsoft.NetApp/netAppAccounts/anf-agentstudio-dev-eus2-001"
#
# Usage:
#   bash scripts/setup-anf-trident.sh

set -euo pipefail

# All identifiers default to the dev environment values but can be overridden via
# environment variables so the script is safe to run against other AKS clusters:
#   AKS_CLUSTER_NAME=my-cluster RG=my-rg bash scripts/setup-anf-trident.sh
SUBSCRIPTION="${SUBSCRIPTION:-ae26acbb-72f9-440e-822f-b13ef3e4fec1}"
RG="${RG:-rg-agentstudio-dev-eus2-001}"
AKS_CLUSTER_NAME="${AKS_CLUSTER_NAME:-aks-agentstudio-dev-eus2-001}"
ANF_ACCOUNT="${ANF_ACCOUNT:-anf-agentstudio-dev-eus2-001}"
ANF_POOL="${ANF_POOL:-pool-standard-001}"
VNET="${VNET:-vnet-agentstudio-dev-eus2-001}"
ANF_SUBNET="${ANF_SUBNET:-snet-agentstudio-anf-dev-eus2-001}"
LOCATION="${LOCATION:-eastus2}"
# Set to true to mark anf-nfs as the cluster default StorageClass so that
# unrelated workloads that don't specify a storageClassName also land on ANF.
# Defaults to false — explicit opt-in only.
MARK_AS_DEFAULT="${MARK_AS_DEFAULT:-false}"

# Pin the CLI to the correct subscription so all subsequent az calls resolve
# resources from the right context, regardless of the caller's default subscription.
az account set --subscription "$SUBSCRIPTION"

TENANT=$(az account show --query tenantId -o tsv)
KUBELET_CLIENT_ID=$(az aks show -g "$RG" -n "$AKS_CLUSTER_NAME" \
  --query identityProfile.kubeletidentity.clientId -o tsv)
if [[ -z "$KUBELET_CLIENT_ID" ]]; then
  echo "ERROR: Could not resolve kubelet managed identity clientId for cluster ${AKS_CLUSTER_NAME}." >&2
  echo "       Check that the cluster uses a kubelet managed identity (not service principal)." >&2
  exit 1
fi

# Resolve subnet CIDRs for ALL node pools so the ANF export rule covers every
# pool, not just the first one. Also handles both addressPrefix (string) and
# addressPrefixes (list) depending on the subnet configuration, failing fast
# if no CIDR can be resolved.
SUBNET_IDS=$(az aks show -g "$RG" -n "$AKS_CLUSTER_NAME" \
  --query "agentPoolProfiles[*].vnetSubnetId" -o tsv \
  | tr '\t' '\n')
EXPORT_CIDRS=""
while IFS= read -r SUBNET_ID; do
  [[ -z "$SUBNET_ID" ]] && continue
  CIDR=$(az network vnet subnet show --ids "$SUBNET_ID" \
    --query "addressPrefix" -o tsv 2>/dev/null || true)
  if [[ -z "$CIDR" ]]; then
    CIDR=$(az network vnet subnet show --ids "$SUBNET_ID" \
      --query "addressPrefixes[0]" -o tsv 2>/dev/null || true)
  fi
  if [[ -z "$CIDR" ]]; then
    echo "ERROR: Could not resolve CIDR for subnet ${SUBNET_ID}. Aborting." >&2
    exit 1
  fi
  EXPORT_CIDRS="${EXPORT_CIDRS:+${EXPORT_CIDRS};}${CIDR}"
done <<< "$SUBNET_IDS"
if [[ -z "$EXPORT_CIDRS" ]]; then
  echo "ERROR: No subnet CIDRs resolved for node pools. Aborting." >&2
  exit 1
fi

echo "=== Tenant:              $TENANT"
echo "=== Kubelet clientID:    $KUBELET_CLIENT_ID"
echo "=== AKS export CIDRs:    $EXPORT_CIDRS"

# ── 0. Preflight: verify CLIs, Trident CRD, and namespace ────────────────────
echo "Running preflight checks..."
for cmd in az kubectl; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "ERROR: Required CLI '$cmd' not found in PATH. Install it and re-run." >&2; exit 1
  }
done
kubectl cluster-info >/dev/null 2>&1 || {
  echo "ERROR: Cannot reach the Kubernetes API server. Check kubeconfig/auth." >&2; exit 1
}
kubectl get crd tridentbackendconfigs.trident.netapp.io >/dev/null 2>&1 || {
  echo "ERROR: Trident CRD 'tridentbackendconfigs.trident.netapp.io' not found." >&2
  echo "       Install Trident first: https://docs.netapp.com/us-en/trident/" >&2
  exit 1
}
kubectl get ns trident >/dev/null 2>&1 || {
  echo "Namespace 'trident' not found; creating..."
  kubectl create ns trident
}
echo "Preflight checks passed."

# ── 1. Configure Trident backend ──────────────────────────────────────────────
echo ""
echo "Configuring Trident backend (azure-netapp-files, MSI)..."
kubectl apply -f - <<EOF
apiVersion: trident.netapp.io/v1
kind: TridentBackendConfig
metadata:
  name: anf-backend-nfs
  namespace: trident
spec:
  version: 1
  storageDriverName: azure-netapp-files
  subscriptionID: "${SUBSCRIPTION}"
  tenantID: "${TENANT}"
  location: "${LOCATION}"
  useManagedIdentity: true
  managedIdentityClientID: "${KUBELET_CLIENT_ID}"
  resourceGroups: ["${RG}"]
  netappAccounts: ["${ANF_ACCOUNT}"]
  capacityPools: ["${ANF_POOL}"]
  virtualNetwork: "${VNET}"
  subnet: "${ANF_SUBNET}"
  serviceLevel: Standard
  defaults:
    exportRule: "${EXPORT_CIDRS}"
    size: "100Gi"
EOF

# ── 2. Wait for backend to become Bound ───────────────────────────────────────
echo "Waiting for Trident backend to become bound..."
STATUS=""
for i in $(seq 1 18); do
  STATUS=$(kubectl get tridentbackendconfig anf-backend-nfs -n trident \
    -o jsonpath='{.status.lastOperationStatus}' 2>/dev/null || true)
  echo "  [$i] $STATUS"
  [ "$STATUS" = "Success" ] && break
  sleep 10
done

if [ "$STATUS" != "Success" ]; then
  echo ""
  echo "ERROR: Trident backend did not reach Success after $(( 18 * 10 ))s. Aborting."
  kubectl describe tridentbackendconfig anf-backend-nfs -n trident || true
  exit 1
fi

kubectl get tridentbackendconfig -n trident -o wide

# ── 3. Create the anf-nfs StorageClass ────────────────────────────────────────
# kubectl apply cannot change immutable fields (volumeBindingMode, reclaimPolicy).
# If anf-nfs already exists with different values, delete it first so the apply
# is truly idempotent across re-runs.
if kubectl get storageclass anf-nfs >/dev/null 2>&1; then
  EXISTING_BINDING=$(kubectl get sc anf-nfs -o jsonpath='{.volumeBindingMode}' 2>/dev/null || true)
  EXISTING_RECLAIM=$(kubectl get sc anf-nfs -o jsonpath='{.reclaimPolicy}' 2>/dev/null || true)
  if [[ "$EXISTING_BINDING" != "Immediate" || "$EXISTING_RECLAIM" != "Delete" ]]; then
    echo "Existing anf-nfs has immutable field mismatch (bindingMode=$EXISTING_BINDING, reclaim=$EXISTING_RECLAIM); deleting for recreation..."
    kubectl delete storageclass anf-nfs
  fi
fi
echo ""
echo "Creating anf-nfs StorageClass..."
kubectl apply -f - <<EOF
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: anf-nfs
  annotations:
    storageclass.kubernetes.io/is-default-class: "${MARK_AS_DEFAULT}"
provisioner: csi.trident.netapp.io
parameters:
  backendType: azure-netapp-files
  fsType: nfs
allowVolumeExpansion: true
reclaimPolicy: Delete
volumeBindingMode: Immediate
EOF

echo ""
echo "=== Done. anf-nfs StorageClass is ready ==="
kubectl get sc anf-nfs
echo ""
echo "Next: redeploy with HELM_EXTRA_ARGS pointing at the Trident overlay for each tier (e.g. -f deployments/helm/database/values-trident.yaml)"
