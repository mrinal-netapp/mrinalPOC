#!/usr/bin/env bash
# deployments/_lib/reconcile.sh — idempotent kubectl helpers (sourced by bash runners).
set -euo pipefail

reconcile_ensure_namespace() {
  local ns="$1"
  if kubectl get ns "$ns" >/dev/null 2>&1; then
    echo "[storage] namespace/$ns already exists"
  else
    echo "[storage] creating namespace/$ns"
    kubectl create ns "$ns"
  fi
}

reconcile_apply_stdin() {
  echo "[storage] kubectl apply (stdin)"
  kubectl apply -f -
}

reconcile_wait_tbc_success() {
  local name="$1" ns="$2" attempts="${3:-18}" sleep_secs="${4:-10}"
  local status="" i
  for (( i=1; i<=attempts; i++ )); do
    status="$(kubectl get tridentbackendconfig "$name" -n "$ns" \
      -o jsonpath='{.status.lastOperationStatus}' 2>/dev/null || true)"
    echo "[storage] TBC/$name status=${status:-missing} ($i/$attempts)"
    [[ "$status" == "Success" ]] && return 0
    sleep "$sleep_secs"
  done
  echo "[storage] ERROR: TBC/$name did not reach Success (last=${status:-missing})" >&2
  kubectl describe tridentbackendconfig "$name" -n "$ns" 2>/dev/null || true
  return 1
}

reconcile_ensure_storageclass() {
  local name="$1" binding="${2:-Immediate}" reclaim="${3:-Delete}"
  if ! kubectl get storageclass "$name" >/dev/null 2>&1; then
    return 2
  fi
  local existing_binding existing_reclaim
  existing_binding="$(kubectl get sc "$name" -o jsonpath='{.volumeBindingMode}' 2>/dev/null || true)"
  existing_reclaim="$(kubectl get sc "$name" -o jsonpath='{.reclaimPolicy}' 2>/dev/null || true)"
  if [[ "$existing_binding" != "$binding" || "$existing_reclaim" != "$reclaim" ]]; then
    echo "[storage] StorageClass/$name immutable mismatch; recreating"
    kubectl delete storageclass "$name"
    return 2
  fi
  echo "[storage] StorageClass/$name already exists and matches"
  return 0
}
