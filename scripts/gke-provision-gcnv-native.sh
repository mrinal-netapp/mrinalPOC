#!/usr/bin/env bash
set -euo pipefail

# Bootstrap/verify dual GCNV-native Trident storage for GKE:
# - NAS backend/class for RWX workloads
# - SAN backend/class for RWO DB workloads
#
# This script is intentionally separate from legacy ONTAP/CVO flows.

require_bin() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required binary not found: $1" >&2
    exit 1
  }
}

log() {
  echo "[gke-storage] $*"
}

PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
GCNV_LOCATION="${GCNV_LOCATION:-}"
GCNV_NETWORK="${GCNV_NETWORK:-}"

TRIDENT_NS="${TRIDENT_NAMESPACE:-trident}"
TRIDENT_KSA="${TRIDENT_KSA:-trident-controller}"
TRIDENT_GSA="${TRIDENT_GSA_EMAIL:-${TRIDENT_GSA:-}}"

GCNV_NAS_POOL_NAME="${GCNV_NAS_POOL_NAME:-sp-agentstudio-gcnv-nas}"
GCNV_SAN_POOL_NAME="${GCNV_SAN_POOL_NAME:-sp-agentstudio-gcnv-san}"
GCNV_NAS_SERVICE_LEVEL="${GCNV_NAS_SERVICE_LEVEL:-standard}"
GCNV_SAN_SERVICE_LEVEL="${GCNV_SAN_SERVICE_LEVEL:-flex}"
GCNV_NAS_POOL_CAPACITY_GIB="${GCNV_NAS_POOL_CAPACITY_GIB:-4096}"
GCNV_SAN_POOL_CAPACITY_GIB="${GCNV_SAN_POOL_CAPACITY_GIB:-4096}"
GCNV_SAN_POOL_TYPE="${GCNV_SAN_POOL_TYPE:-unified}"
GCNV_SAN_MODE="${GCNV_SAN_MODE:-default}"
GCNV_SAN_ZONE="${GCNV_SAN_ZONE:-${GCNV_LOCATION}-b}"
GCNV_SAN_REPLICA_ZONE="${GCNV_SAN_REPLICA_ZONE:-${GCNV_LOCATION}-c}"

GCNV_NAS_BACKEND_NAME="${GCNV_NAS_BACKEND_NAME:-gcnv-native-nas-backend}"
GCNV_SAN_BACKEND_NAME="${GCNV_SAN_BACKEND_NAME:-gcnv-native-san-backend}"
GCNV_NAS_SC_NAME="${GCNV_NAS_SC_NAME:-gcnv-nas-rwx}"
GCNV_SAN_SC_NAME="${GCNV_SAN_SC_NAME:-gcnv-san-rwo}"
GCNV_SAN_FSTYPE="${GCNV_SAN_FSTYPE:-ext4}"

ENABLE_STORAGE_POOLS_FILTER="${ENABLE_STORAGE_POOLS_FILTER:-true}"

wait_for_pool_ready() {
  local pool_name="$1"
  local location="$2"
  local max_attempts="${3:-60}"
  local sleep_seconds="${4:-10}"
  local attempt=1
  while (( attempt <= max_attempts )); do
    local state
    state="$(gcloud netapp storage-pools describe "${pool_name}" \
      --project "${PROJECT_ID}" \
      --location "${location}" \
      --format='value(state)' 2>/dev/null || true)"
    log "Pool ${pool_name} state=${state:-unknown} (${attempt}/${max_attempts})"
    if [[ "${state}" == "READY" ]]; then
      return 0
    fi
    if [[ "${state}" == "ERROR" || "${state}" == "DISABLED" ]]; then
      echo "ERROR: pool ${pool_name} entered terminal state ${state}" >&2
      exit 1
    fi
    sleep "${sleep_seconds}"
    (( attempt++ ))
  done
  echo "ERROR: timed out waiting for pool ${pool_name} to reach READY" >&2
  exit 1
}

check_backend_healthy() {
  local backend_name="$1"
  local op_status phase msg
  op_status="$(kubectl get tbc "${backend_name}" -n "${TRIDENT_NS}" -o jsonpath='{.status.lastOperationStatus}' 2>/dev/null || true)"
  phase="$(kubectl get tbc "${backend_name}" -n "${TRIDENT_NS}" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  msg="$(kubectl get tbc "${backend_name}" -n "${TRIDENT_NS}" -o jsonpath='{.status.message}' 2>/dev/null || true)"
  if [[ "${op_status}" != "Success" ]]; then
    echo "ERROR: backend ${backend_name} not healthy. status=${op_status:-empty} phase=${phase:-empty}" >&2
    [[ -n "${msg}" ]] && echo "       message: ${msg}" >&2
    exit 1
  fi
}

# volumeBindingMode/reclaimPolicy are immutable on an existing StorageClass, so a
# plain `kubectl apply` fails outright once either differs from what's live
# (e.g. after this script's desired mode changes). Mirrors
# deployments/storage/lib/reconcile.py::ensure_storageclass: delete + recreate
# on mismatch, no-op otherwise.
apply_storageclass() {
  local name="$1"
  local manifest_file="$2"
  local desired_binding="$3"
  local current_binding
  if current_binding="$(kubectl get storageclass "${name}" -o jsonpath='{.volumeBindingMode}' 2>/dev/null)"; then
    if [[ "${current_binding}" != "${desired_binding}" ]]; then
      log "StorageClass/${name} volumeBindingMode mismatch (current=${current_binding}, desired=${desired_binding}); recreating"
      kubectl delete storageclass "${name}" >/dev/null
    fi
  fi
  kubectl apply -f "${manifest_file}" >/dev/null
}

require_bin gcloud
require_bin kubectl
require_bin helm

if [[ -z "${PROJECT_ID}" ]]; then
  echo "ERROR: GCP_PROJECT_ID is required (or set default gcloud project)." >&2
  exit 1
fi
if [[ -z "${GCNV_LOCATION}" ]]; then
  echo "ERROR: GCNV_LOCATION is required." >&2
  exit 1
fi
if [[ -z "${GCNV_NETWORK}" ]]; then
  echo "ERROR: GCNV_NETWORK is required (name=<vpc>,psa-range=<range>)." >&2
  exit 1
fi
if [[ -z "${TRIDENT_GSA}" ]]; then
  echo "ERROR: TRIDENT_GSA_EMAIL (or TRIDENT_GSA) is required." >&2
  exit 1
fi

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"

log "Using project=${PROJECT_ID} location=${GCNV_LOCATION}"

gcloud services enable netapp.googleapis.com file.googleapis.com iam.googleapis.com iamcredentials.googleapis.com --project "${PROJECT_ID}" >/dev/null
log "Assuming IAM prerequisites are already configured for ${TRIDENT_GSA} (netapp admin + workload identity binding)."

if ! gcloud netapp storage-pools describe "${GCNV_NAS_POOL_NAME}" --project "${PROJECT_ID}" --location "${GCNV_LOCATION}" >/dev/null 2>&1; then
  log "Creating NAS pool ${GCNV_NAS_POOL_NAME}"
  gcloud netapp storage-pools create "${GCNV_NAS_POOL_NAME}" \
    --project "${PROJECT_ID}" \
    --location "${GCNV_LOCATION}" \
    --service-level "${GCNV_NAS_SERVICE_LEVEL}" \
    --capacity "${GCNV_NAS_POOL_CAPACITY_GIB}GiB" \
    --network "${GCNV_NETWORK}"
fi
if ! gcloud netapp storage-pools describe "${GCNV_SAN_POOL_NAME}" --project "${PROJECT_ID}" --location "${GCNV_LOCATION}" >/dev/null 2>&1; then
  log "Creating SAN pool ${GCNV_SAN_POOL_NAME}"
  SAN_CREATE_ARGS=(
    --project "${PROJECT_ID}"
    --location "${GCNV_LOCATION}"
    --service-level "${GCNV_SAN_SERVICE_LEVEL}"
    --capacity "${GCNV_SAN_POOL_CAPACITY_GIB}GiB"
    --network "${GCNV_NETWORK}"
    --type "${GCNV_SAN_POOL_TYPE}"
    --mode "${GCNV_SAN_MODE}"
    --zone "${GCNV_SAN_ZONE}"
  )
  if [[ -n "${GCNV_SAN_REPLICA_ZONE}" ]]; then
    SAN_CREATE_ARGS+=(--replica-zone "${GCNV_SAN_REPLICA_ZONE}")
  fi
  gcloud netapp storage-pools create "${GCNV_SAN_POOL_NAME}" "${SAN_CREATE_ARGS[@]}"
else
  existing_san_type="$(gcloud netapp storage-pools describe "${GCNV_SAN_POOL_NAME}" \
    --project "${PROJECT_ID}" \
    --location "${GCNV_LOCATION}" \
    --format='value(type)' 2>/dev/null || true)"
  existing_san_level="$(gcloud netapp storage-pools describe "${GCNV_SAN_POOL_NAME}" \
    --project "${PROJECT_ID}" \
    --location "${GCNV_LOCATION}" \
    --format='value(serviceLevel)' 2>/dev/null || true)"
  if [[ "${existing_san_type^^}" != "UNIFIED" ]]; then
    echo "ERROR: existing SAN pool ${GCNV_SAN_POOL_NAME} has type=${existing_san_type:-empty}, expected UNIFIED for Trident SAN." >&2
    exit 1
  fi
  if [[ "${existing_san_level^^}" != "FLEX" ]]; then
    echo "ERROR: existing SAN pool ${GCNV_SAN_POOL_NAME} has serviceLevel=${existing_san_level:-empty}, expected FLEX for unified SAN pool." >&2
    exit 1
  fi
fi

wait_for_pool_ready "${GCNV_NAS_POOL_NAME}" "${GCNV_LOCATION}"
wait_for_pool_ready "${GCNV_SAN_POOL_NAME}" "${GCNV_LOCATION}"

helm repo add netapp-trident https://netapp.github.io/trident-helm-chart >/dev/null 2>&1 || true
helm repo update netapp-trident >/dev/null
# Clear ownership collision from previous kubectl patch runs before Helm apply.
kubectl patch tridentorchestrator trident -n "${TRIDENT_NS}" --type json -p \
  '[{"op":"remove","path":"/spec/cloudIdentity"}]' >/dev/null 2>&1 || true
helm upgrade --install trident netapp-trident/trident-operator \
  --namespace "${TRIDENT_NS}" \
  --create-namespace \
  --set cloudProvider=GCP \
  --reset-values >/dev/null

kubectl patch tridentorchestrator trident -n "${TRIDENT_NS}" --type merge -p \
  "{\"spec\":{\"cloudProvider\":\"GCP\",\"cloudIdentity\":\"iam.gke.io/gcp-service-account: ${TRIDENT_GSA}\"}}" >/dev/null
kubectl annotate serviceaccount "${TRIDENT_KSA}" -n "${TRIDENT_NS}" \
  iam.gke.io/gcp-service-account="${TRIDENT_GSA}" --overwrite >/dev/null
kubectl rollout restart deploy/trident-controller -n "${TRIDENT_NS}" >/dev/null
kubectl rollout status deploy/trident-controller -n "${TRIDENT_NS}" --timeout=180s >/dev/null

cat > /tmp/gcnv-native-nas-backend.yaml <<EOF
apiVersion: trident.netapp.io/v1
kind: TridentBackendConfig
metadata:
  name: ${GCNV_NAS_BACKEND_NAME}
  namespace: ${TRIDENT_NS}
spec:
  version: 1
  backendName: ${GCNV_NAS_BACKEND_NAME}
  storageDriverName: google-cloud-netapp-volumes
  projectNumber: "${PROJECT_NUMBER}"
  location: "${GCNV_LOCATION}"
EOF
cat > /tmp/gcnv-native-san-backend.yaml <<EOF
apiVersion: trident.netapp.io/v1
kind: TridentBackendConfig
metadata:
  name: ${GCNV_SAN_BACKEND_NAME}
  namespace: ${TRIDENT_NS}
spec:
  version: 1
  backendName: ${GCNV_SAN_BACKEND_NAME}
  storageDriverName: google-cloud-netapp-volumes-san
  projectNumber: "${PROJECT_NUMBER}"
  location: "${GCNV_LOCATION}"
EOF

if [[ "${ENABLE_STORAGE_POOLS_FILTER}" == "true" ]]; then
  cat >> /tmp/gcnv-native-nas-backend.yaml <<EOF
  storagePools:
    - "${GCNV_NAS_POOL_NAME}"
EOF
  cat >> /tmp/gcnv-native-san-backend.yaml <<EOF
  storagePools:
    - "${GCNV_SAN_POOL_NAME}"
EOF
fi

kubectl apply -f /tmp/gcnv-native-nas-backend.yaml >/dev/null
kubectl apply -f /tmp/gcnv-native-san-backend.yaml >/dev/null
sleep 3
check_backend_healthy "${GCNV_NAS_BACKEND_NAME}"
check_backend_healthy "${GCNV_SAN_BACKEND_NAME}"

# WaitForFirstConsumer: with Immediate binding, Trident has to pick topology
# before any pod/node is known. If the node pool that would serve the volume
# (e.g. the SAN-tainted pool) has scaled to zero, that fails outright ("no
# available topology found"), and the cluster autoscaler won't scale it back
# up to fix an already-unbound Immediate PVC -- a permanent deadlock
# (reproduced on gke-agentstudio-preprod). WaitForFirstConsumer defers binding
# until a pod is scheduled, which the autoscaler treats as a normal
# scale-up trigger. Keep in sync with
# deployments/storage/manifests/gcp/gcnv-{nas,san}-sc.yaml.tpl.
cat > /tmp/gcnv-nas-sc.yaml <<EOF
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ${GCNV_NAS_SC_NAME}
provisioner: csi.trident.netapp.io
parameters:
  backendType: "google-cloud-netapp-volumes"
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
EOF

cat > /tmp/gcnv-san-sc.yaml <<EOF
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ${GCNV_SAN_SC_NAME}
provisioner: csi.trident.netapp.io
parameters:
  backendType: "google-cloud-netapp-volumes-san"
  fsType: "${GCNV_SAN_FSTYPE}"
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
EOF

apply_storageclass "${GCNV_NAS_SC_NAME}" /tmp/gcnv-nas-sc.yaml WaitForFirstConsumer
apply_storageclass "${GCNV_SAN_SC_NAME}" /tmp/gcnv-san-sc.yaml WaitForFirstConsumer
kubectl get storageclass "${GCNV_NAS_SC_NAME}" >/dev/null
kubectl get storageclass "${GCNV_SAN_SC_NAME}" >/dev/null

log "GCNV-native storage ready."
log "Backends: ${GCNV_NAS_BACKEND_NAME}, ${GCNV_SAN_BACKEND_NAME}"
log "StorageClasses: ${GCNV_NAS_SC_NAME}, ${GCNV_SAN_SC_NAME}"
