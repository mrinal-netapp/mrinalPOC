#!/usr/bin/env bash
set -euo pipefail

STATE_FILE="${STATE_FILE:-.deploy-state/cloud-auto.env}"
SERVICES_NAMESPACE="${SERVICES_NAMESPACE:-agentstudio-services}"
TRIDENT_NAMESPACE="${TRIDENT_NAMESPACE:-trident}"
STORAGE_POOL_NAME_PREFIX="${STORAGE_POOL_NAME_PREFIX:-sp}"
TRIDENT_STORAGE_CLASS="${TRIDENT_STORAGE_CLASS:-ontap-nas}"
USE_EXISTING_STORAGE_POOL="${USE_EXISTING_STORAGE_POOL:-0}"
TRIDENT_INSTALL="${TRIDENT_INSTALL:-1}"
STORAGE_PROTOCOL="${STORAGE_PROTOCOL:-NFS}"
STORAGE_BACKEND="${STORAGE_BACKEND:-gcnv}"

required_vars=(
  GCP_PROJECT_ID
  NETWORK_VPC_NAME
  STORAGE_SERVICE_LEVEL
  STORAGE_POOL_CAPACITY_GIB
  GCNV_LOCATION
  NETAPP_SVM
)

for v in "${required_vars[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    echo "ERROR: required variable missing: $v" >&2
    exit 1
  fi
done

if [[ -z "${STORAGE_POOL_NAME:-}" ]]; then
  if [[ -z "${DEPLOYMENT_NAME:-}" ]]; then
    echo "ERROR: set DEPLOYMENT_NAME or explicit STORAGE_POOL_NAME." >&2
    exit 1
  fi
  normalized="$(echo "${DEPLOYMENT_NAME}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"
  base="${STORAGE_POOL_NAME_PREFIX}-${normalized}"
  if [[ "${#base}" -gt 63 ]]; then
    if command -v shasum >/dev/null 2>&1; then
      hash8="$(printf '%s' "${DEPLOYMENT_NAME}" | shasum -a 256 | awk '{print substr($1,1,8)}')"
    else
      hash8="$(printf '%s' "${DEPLOYMENT_NAME}" | openssl dgst -sha256 | awk '{print substr($2,1,8)}')"
    fi
    STORAGE_POOL_NAME="${base:0:54}-${hash8}"
  else
    STORAGE_POOL_NAME="${base}"
  fi
fi

if [[ "${USE_EXISTING_STORAGE_POOL}" == "1" ]]; then
  gcloud netapp storage-pools describe "${STORAGE_POOL_NAME}" --location "${GCNV_LOCATION}" --project "${GCP_PROJECT_ID}" >/dev/null
else
  if ! gcloud netapp storage-pools describe "${STORAGE_POOL_NAME}" --location "${GCNV_LOCATION}" --project "${GCP_PROJECT_ID}" >/dev/null 2>&1; then
    if [[ -z "${GCNV_NETWORK:-}" ]]; then
      echo "ERROR: GCNV_NETWORK must be set to create a new storage pool." >&2
      exit 1
    fi
    gcloud netapp storage-pools create "${STORAGE_POOL_NAME}" \
      --location "${GCNV_LOCATION}" \
      --service-level "${STORAGE_SERVICE_LEVEL}" \
      --capacity "${STORAGE_POOL_CAPACITY_GIB}GiB" \
      --network "${GCNV_NETWORK}" \
      --project "${GCP_PROJECT_ID}"
  fi
fi

storage_pool_network_uri="$(gcloud netapp storage-pools describe "${STORAGE_POOL_NAME}" --location "${GCNV_LOCATION}" --project "${GCP_PROJECT_ID}" --format='value(network)')"
storage_pool_network="${storage_pool_network_uri##*/}"
if [[ "${storage_pool_network}" != "${NETWORK_VPC_NAME}" ]]; then
  echo "ERROR: Storage pool network '${storage_pool_network}' does not match expected VPC '${NETWORK_VPC_NAME}'." >&2
  exit 1
fi

if [[ -n "${EXISTING_TRIDENT_BACKEND_NAME:-}" ]]; then
  kubectl get tbc "${EXISTING_TRIDENT_BACKEND_NAME}" -n "${TRIDENT_NAMESPACE}" >/dev/null
else
  if [[ -z "${NETAPP_MANAGEMENT_LIF:-}" || -z "${ONTAP_USERNAME:-}" || -z "${ONTAP_PASSWORD:-}" ]]; then
    echo "ERROR: NETAPP_MANAGEMENT_LIF, ONTAP_USERNAME, and ONTAP_PASSWORD are required to create a Trident backend." >&2
    exit 1
  fi
  BACKEND_TYPE="ontap" \
  TRIDENT_INSTALL="${TRIDENT_INSTALL}" \
  TRIDENT_NAMESPACE="${TRIDENT_NAMESPACE}" \
  ONTAP_MANAGEMENT_LIF="${NETAPP_MANAGEMENT_LIF}" \
  ONTAP_SVM="${NETAPP_SVM}" \
  ONTAP_USERNAME="${ONTAP_USERNAME}" \
  ONTAP_PASSWORD="${ONTAP_PASSWORD}" \
  ONTAP_STORAGE_TYPES="nas" \
  ONTAP_STORAGE_POOLS="${STORAGE_POOL_NAME}" \
  "$(dirname "$0")/configure-ontap-storage.sh"
fi

if ! kubectl get storageclass "${TRIDENT_STORAGE_CLASS}" >/dev/null 2>&1; then
  echo "ERROR: StorageClass '${TRIDENT_STORAGE_CLASS}' was not found after storage configuration." >&2
  exit 1
fi

mkdir -p "$(dirname "${STATE_FILE}")"
{
  echo "STORAGE_POOL_NAME=${STORAGE_POOL_NAME}"
  echo "STORAGE_POOL_NETWORK=${storage_pool_network}"
  echo "STORAGECLASS_READY=${TRIDENT_STORAGE_CLASS}"
} >> "${STATE_FILE}"

echo "GCNV + Trident storage configuration complete."
