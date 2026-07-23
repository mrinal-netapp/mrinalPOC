#!/usr/bin/env bash
set -euo pipefail

STATE_FILE="${STATE_FILE:-.deploy-state/cloud-auto.env}"
EXTERNAL_DNS_NAMESPACE="${EXTERNAL_DNS_NAMESPACE:-external-dns}"
EXTERNALDNS_TXT_PREFIX="${EXTERNALDNS_TXT_PREFIX:-txt}"
EXTERNALDNS_POLICY="${EXTERNALDNS_POLICY:-upsert-only}"
EXTERNALDNS_SOURCE_MODE="${EXTERNALDNS_SOURCE_MODE:-gateway}"

required_vars=(
  GCP_PROJECT_ID
  DNS_ZONE_NAME
  ENDPOINT
  EXTERNALDNS_TXT_OWNER_ID
  GCP_DNS_SA_EMAIL
)

for v in "${required_vars[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    echo "ERROR: required variable missing: $v" >&2
    exit 1
  fi
done

if [[ "${EXTERNALDNS_SOURCE_MODE}" != "gateway" && "${EXTERNALDNS_SOURCE_MODE}" != "service" ]]; then
  echo "ERROR: EXTERNALDNS_SOURCE_MODE must be gateway|service" >&2
  exit 1
fi

gcloud dns managed-zones describe "${DNS_ZONE_NAME}" --project "${GCP_PROJECT_ID}" >/dev/null

kubectl create namespace "${EXTERNAL_DNS_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

kubectl create serviceaccount external-dns -n "${EXTERNAL_DNS_NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -
kubectl annotate serviceaccount external-dns \
  -n "${EXTERNAL_DNS_NAMESPACE}" \
  "iam.gke.io/gcp-service-account=${GCP_DNS_SA_EMAIL}" \
  --overwrite

helm repo add external-dns https://kubernetes-sigs.github.io/external-dns >/dev/null 2>&1 || true
helm repo update external-dns >/dev/null 2>&1 || true

sources="--set sources[0]=gateway-httproute"
if [[ "${EXTERNALDNS_SOURCE_MODE}" == "service" ]]; then
  sources="--set sources[0]=service"
fi

helm upgrade --install external-dns external-dns/external-dns \
  --namespace "${EXTERNAL_DNS_NAMESPACE}" \
  --create-namespace \
  --set provider=google \
  --set serviceAccount.create=false \
  --set serviceAccount.name=external-dns \
  --set txtOwnerId="${EXTERNALDNS_TXT_OWNER_ID}" \
  --set txtPrefix="${EXTERNALDNS_TXT_PREFIX}" \
  --set policy="${EXTERNALDNS_POLICY}" \
  --set domainFilters[0]="${ENDPOINT}" \
  --set google.project="${GCP_PROJECT_ID}" \
  ${sources}

kubectl rollout status deployment/external-dns -n "${EXTERNAL_DNS_NAMESPACE}" --timeout=180s

mkdir -p "$(dirname "${STATE_FILE}")"
{
  echo "EXTERNALDNS_READY=true"
  echo "EXTERNALDNS_NAMESPACE=${EXTERNAL_DNS_NAMESPACE}"
} >> "${STATE_FILE}"

echo "ExternalDNS deployment complete."
