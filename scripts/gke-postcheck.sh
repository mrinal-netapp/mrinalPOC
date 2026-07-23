#!/usr/bin/env bash
set -euo pipefail

SERVICES_NAMESPACE="${SERVICES_NAMESPACE:-agentstudio-services}"
EXTERNAL_DNS_NAMESPACE="${EXTERNAL_DNS_NAMESPACE:-external-dns}"
TRIDENT_NAMESPACE="${TRIDENT_NAMESPACE:-trident}"
TRIDENT_STORAGE_CLASS="${TRIDENT_STORAGE_CLASS:-ontap-nas}"
ENDPOINT="${ENDPOINT:-}"

kubectl get storageclass "${TRIDENT_STORAGE_CLASS}" >/dev/null
kubectl get pvc -A
kubectl get deployments -n "${SERVICES_NAMESPACE}"
kubectl get deployment external-dns -n "${EXTERNAL_DNS_NAMESPACE}" >/dev/null
kubectl get tbc -n "${TRIDENT_NAMESPACE}" || true

gateway_ip="$(kubectl get gateway -n "${SERVICES_NAMESPACE}" -o jsonpath='{.items[0].status.addresses[0].value}' 2>/dev/null || true)"
if [[ -n "${gateway_ip}" ]]; then
  echo "Gateway address: ${gateway_ip}"
fi

if [[ -n "${ENDPOINT}" ]] && command -v dig >/dev/null 2>&1; then
  echo "DNS check for ${ENDPOINT}:"
  dig +short "${ENDPOINT}" || true
fi

echo "Post-deploy checks completed."
