#!/usr/bin/env bash
set -euo pipefail

# Resolve this script's own directory so phase scripts are invoked
# repo-relative rather than from a hardcoded absolute path.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

STATE_DIR="${STATE_DIR:-.deploy-state}"
STATE_FILE="${STATE_FILE:-${STATE_DIR}/cloud-auto.env}"
RESUME_FROM="${RESUME_FROM:-}"
SERVICES_NAMESPACE="${SERVICES_NAMESPACE:-agentstudio-services}"
DATABASE_NAMESPACE="${DATABASE_NAMESPACE:-database}"
TRIDENT_STORAGE_CLASS="${TRIDENT_STORAGE_CLASS:-ontap-nas}"
ARCH_PIN_WORKLOADS="${ARCH_PIN_WORKLOADS:-0}"
NODE_ARCHITECTURE="${NODE_ARCHITECTURE:-amd64}"
ARCH_NODE_SELECTOR_KEY="${ARCH_NODE_SELECTOR_KEY:-kubernetes.io/arch}"

mkdir -p "${STATE_DIR}"
: > "${STATE_FILE}"

run_phase() {
  local phase="$1"
  shift
  echo "=== Phase: ${phase} ==="
  "$@"
  echo "LAST_SUCCESSFUL_PHASE=${phase}" >> "${STATE_FILE}"
}

should_run() {
  local phase="$1"
  case "${RESUME_FROM}" in
    "" ) return 0 ;;
    preflight ) [[ "${phase}" == "preflight" || "${phase}" == "storage" || "${phase}" == "dns" || "${phase}" == "app" || "${phase}" == "verify" ]] ;;
    storage ) [[ "${phase}" == "storage" || "${phase}" == "dns" || "${phase}" == "app" || "${phase}" == "verify" ]] ;;
    dns ) [[ "${phase}" == "dns" || "${phase}" == "app" || "${phase}" == "verify" ]] ;;
    app ) [[ "${phase}" == "app" || "${phase}" == "verify" ]] ;;
    verify ) [[ "${phase}" == "verify" ]] ;;
    * ) echo "ERROR: invalid RESUME_FROM=${RESUME_FROM}" >&2; exit 1 ;;
  esac
}

build_storage_overlay_files() {
  local workdir="${STATE_DIR}/overlays"
  mkdir -p "${workdir}"
  DB_OVERLAY="${workdir}/database-values-trident.auto.yaml"
  TIER_OVERLAY="${workdir}/tier-values-trident.auto.yaml"
  cat > "${DB_OVERLAY}" <<EOF
postgresql:
  primary:
    persistence:
      storageClass: "${TRIDENT_STORAGE_CLASS}"
EOF
  cat > "${TIER_OVERLAY}" <<EOF
global:
  storageClass: "${TRIDENT_STORAGE_CLASS}"
EOF
}

build_arch_overlay_files() {
  local workdir="${STATE_DIR}/overlays"
  mkdir -p "${workdir}"
  TIER_ARCH_OVERLAY="${workdir}/tier-values-arch.auto.yaml"
  KEYCLOAK_ARCH_OVERLAY="${workdir}/keycloak-values-arch.auto.yaml"

  OBSERVABILITY_ARCH_OVERLAY="${workdir}/observability-values-arch.auto.yaml"
  cat > "${OBSERVABILITY_ARCH_OVERLAY}" <<EOF
phoenix:
  nodeSelector:
    ${ARCH_NODE_SELECTOR_KEY}: "${NODE_ARCHITECTURE}"
EOF

  cat > "${TIER_ARCH_OVERLAY}" <<EOF
nodeSelector:
  ${ARCH_NODE_SELECTOR_KEY}: "${NODE_ARCHITECTURE}"
s3gateway:
  nodeSelector:
    ${ARCH_NODE_SELECTOR_KEY}: "${NODE_ARCHITECTURE}"
storage-manager:
  nodeSelector:
    ${ARCH_NODE_SELECTOR_KEY}: "${NODE_ARCHITECTURE}"
kb-retrieval-service:
  nodeSelector:
    ${ARCH_NODE_SELECTOR_KEY}: "${NODE_ARCHITECTURE}"
apigateway-service:
  nodeSelector:
    ${ARCH_NODE_SELECTOR_KEY}: "${NODE_ARCHITECTURE}"
agent-service:
  nodeSelector:
    ${ARCH_NODE_SELECTOR_KEY}: "${NODE_ARCHITECTURE}"
config-service:
  nodeSelector:
    ${ARCH_NODE_SELECTOR_KEY}: "${NODE_ARCHITECTURE}"
gui:
  nodeSelector:
    ${ARCH_NODE_SELECTOR_KEY}: "${NODE_ARCHITECTURE}"
workflow-engine:
  nodeSelector:
    ${ARCH_NODE_SELECTOR_KEY}: "${NODE_ARCHITECTURE}"
analytics-engine:
  nodeSelector:
    ${ARCH_NODE_SELECTOR_KEY}: "${NODE_ARCHITECTURE}"
litellm:
  nodeSelector:
    ${ARCH_NODE_SELECTOR_KEY}: "${NODE_ARCHITECTURE}"
temporal:
  nodeSelector:
    ${ARCH_NODE_SELECTOR_KEY}: "${NODE_ARCHITECTURE}"
EOF

  cat > "${KEYCLOAK_ARCH_OVERLAY}" <<EOF
nodeSelector:
  ${ARCH_NODE_SELECTOR_KEY}: "${NODE_ARCHITECTURE}"
EOF
}

on_failure() {
  local phase="$1"
  echo "FAILED phase=${phase}"
  echo "Resume with:"
  echo "  RESUME_FROM=${phase} make deploy-gke-auto"
  echo "Quick checks:"
  echo "  kubectl get pods -A"
  echo "  kubectl get events -A --sort-by=.metadata.creationTimestamp"
  echo "  helm list -A"
}

trap 'on_failure "${CURRENT_PHASE:-unknown}"' ERR

if [[ "${CLOUD_PROVIDER:-gcp}" != "gcp" ]]; then
  echo "ERROR: deploy-cloud-auto currently supports CLOUD_PROVIDER=gcp only."
  exit 1
fi

if should_run preflight; then
  CURRENT_PHASE=preflight
  run_phase preflight "${SCRIPT_DIR}/gke-preflight.sh"
fi

if should_run storage; then
  CURRENT_PHASE=storage
  run_phase storage "${SCRIPT_DIR}/gke-provision-gcnv.sh"
fi

if should_run dns; then
  CURRENT_PHASE=dns
  run_phase dns "${SCRIPT_DIR}/gke-deploy-externaldns.sh"
fi

if should_run app; then
  CURRENT_PHASE=app
  build_storage_overlay_files
  EXTRA_OVERLAYS="-f ${DB_OVERLAY} -f ${TIER_OVERLAY}"
  IDENTITY_OVERLAYS=""
  if [[ "${ARCH_PIN_WORKLOADS}" == "1" ]]; then
    build_arch_overlay_files
    EXTRA_OVERLAYS="${EXTRA_OVERLAYS} -f ${TIER_ARCH_OVERLAY}"
    IDENTITY_OVERLAYS="-f ${KEYCLOAK_ARCH_OVERLAY}"
  fi
  run_phase app make deploy-foundation DATABASE_NAMESPACE="${DATABASE_NAMESPACE}" HELM_EXTRA_ARGS="${EXTRA_OVERLAYS} ${HELM_EXTRA_ARGS:-}"
  run_phase app make deploy-identity HELM_EXTRA_ARGS="${IDENTITY_OVERLAYS} ${HELM_EXTRA_ARGS:-}"
  run_phase app make helm-workers-upgrade CLOUD=gke SERVICES_NAMESPACE="${SERVICES_NAMESPACE}" HELM_EXTRA_ARGS="${EXTRA_OVERLAYS} ${HELM_EXTRA_ARGS:-}"
  run_phase app make helm-platform-upgrade CLOUD=gke SERVICES_NAMESPACE="${SERVICES_NAMESPACE}" HELM_EXTRA_ARGS="${EXTRA_OVERLAYS} ${HELM_EXTRA_ARGS:-}"
  run_phase app make helm-llm-gateway-upgrade CLOUD=gke SERVICES_NAMESPACE="${SERVICES_NAMESPACE}" HELM_EXTRA_ARGS="${HELM_EXTRA_ARGS:-}"
  run_phase app make helm-services-upgrade CLOUD=gke SERVICES_NAMESPACE="${SERVICES_NAMESPACE}" HELM_EXTRA_ARGS="${EXTRA_OVERLAYS} ${HELM_EXTRA_ARGS:-}"
  run_phase app make helm-console-upgrade CLOUD=gke SERVICES_NAMESPACE="${SERVICES_NAMESPACE}" HELM_EXTRA_ARGS="${HELM_EXTRA_ARGS:-}"
fi

if should_run verify; then
  CURRENT_PHASE=verify
  run_phase verify "${SCRIPT_DIR}/gke-postcheck.sh"
fi

echo "All cloud deploy phases completed."
