#!/usr/bin/env bash
# deployments/_lib/trident-install-helm.sh — cloud-agnostic Trident operator install.
#
# Sourced or executed directly. Requires kubectl + helm and a working kubeconfig.
#
#   trident_install_helm [namespace] [helm_version] [extra helm args...]
#
# Environment overrides: TRIDENT_NAMESPACE, TRIDENT_HELM_VERSION

trident_install_helm() {
  local ns="${1:-${TRIDENT_NAMESPACE:-trident}}"
  local version="${2:-${TRIDENT_HELM_VERSION:-100.2410.0}}"
  shift 2 2>/dev/null || shift $# 2>/dev/null || true
  local extra_args=("$@")

  command -v kubectl >/dev/null 2>&1 || { echo "ERROR: kubectl required" >&2; return 1; }
  command -v helm >/dev/null 2>&1 || { echo "ERROR: helm required" >&2; return 1; }

  kubectl cluster-info >/dev/null 2>&1 || {
    echo "ERROR: Cannot reach Kubernetes API. Configure kubeconfig first." >&2
    return 1
  }

  kubectl get ns "$ns" >/dev/null 2>&1 || kubectl create ns "$ns"

  echo "[trident-helm] Ensuring Trident operator $version in namespace $ns..."
  helm repo add netapp-trident https://netapp.github.io/trident-helm-chart 2>/dev/null || true
  helm repo update netapp-trident
  helm upgrade --install trident netapp-trident/trident-operator \
    --namespace "$ns" \
    --create-namespace \
    --version "$version" \
    --wait --timeout 10m \
    "${extra_args[@]}"

  local dep
  for dep in trident-operator "${TRIDENT_HELM_RELEASE_NAME:-trident}-trident-operator"; do
    if kubectl get deployment "$dep" -n "$ns" >/dev/null 2>&1; then
      kubectl rollout status "deployment/$dep" -n "$ns" --timeout=180s
      break
    fi
  done

  local elapsed=0
  while [ "$elapsed" -lt 180 ]; do
    if kubectl get crd tridentbackendconfigs.trident.netapp.io >/dev/null 2>&1; then
      kubectl wait --for=condition=established --timeout=30s \
        crd/tridentbackendconfigs.trident.netapp.io 2>/dev/null || true
      break
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done

  elapsed=0
  while [ "$elapsed" -lt 300 ]; do
    if kubectl get deployment trident-controller -n "$ns" >/dev/null 2>&1; then
      kubectl wait --for=condition=available deployment/trident-controller \
        -n "$ns" --timeout=300s
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  echo "ERROR: trident-controller deployment not found after Helm install" >&2
  return 1
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  trident_install_helm "${1:-}" "${2:-}"
fi
