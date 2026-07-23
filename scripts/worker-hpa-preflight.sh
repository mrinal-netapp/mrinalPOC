#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${NAMESPACE:-agentstudio-workers}"

echo "Worker HPA preflight (namespace: ${NAMESPACE})"
echo

if ! command -v kubectl >/dev/null 2>&1; then
  echo "ERROR: kubectl is required but not found in PATH."
  exit 1
fi

if ! command -v rg >/dev/null 2>&1; then
  echo "ERROR: rg (ripgrep) is required but not found in PATH."
  exit 1
fi

echo "[1/5] Checking Kubernetes metrics APIs..."
kubectl get apiservices | rg "metrics.k8s.io|custom.metrics.k8s.io"

echo "[2/5] Checking metrics-server raw endpoint..."
kubectl get --raw "/apis/metrics.k8s.io/v1beta1/nodes" >/dev/null
echo "OK: metrics-server API is reachable."

echo "[3/5] Checking custom metrics raw endpoint..."
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1" >/dev/null
echo "OK: custom metrics API is reachable."

echo "[4/5] Checking expected worker custom metric names..."
CUSTOM_METRICS_DOC="$(kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1")"
echo "${CUSTOM_METRICS_DOC}" | rg "temporal_queue_backlog_kb|temporal_queue_backlog_dataset|temporal_queue_backlog_connector"

echo "[5/7] Checking workers-kb CPU request is configured..."
CPU_REQUEST="$(kubectl get deploy workers-kb -n "${NAMESPACE}" -o jsonpath='{.spec.template.spec.containers[0].resources.requests.cpu}' || true)"
if [ -z "${CPU_REQUEST}" ]; then
  echo "ERROR: workers-kb CPU request is empty. HPA CPU utilization needs CPU requests."
  exit 1
fi
echo "OK: workers-kb CPU request is '${CPU_REQUEST}'."

echo "[6/7] Checking workers-dataset CPU request is configured..."
DS_CPU_REQUEST="$(kubectl get deploy workers-dataset -n "${NAMESPACE}" -o jsonpath='{.spec.template.spec.containers[0].resources.requests.cpu}' || true)"
if [ -z "${DS_CPU_REQUEST}" ]; then
  echo "ERROR: workers-dataset CPU request is empty. HPA metrics need CPU requests."
  exit 1
fi
echo "OK: workers-dataset CPU request is '${DS_CPU_REQUEST}'."

echo "[7/7] Checking HPA scale-down is not blocked by dual metrics..."
DS_HPA_METRICS="$(kubectl get hpa workers-dataset -n "${NAMESPACE}" -o jsonpath='{.spec.metrics[*].type}' 2>/dev/null || true)"
if echo "${DS_HPA_METRICS}" | rg -q "Resource.*Pods|Pods.*Resource"; then
  echo "WARNING: workers-dataset HPA has both Resource (CPU) and Pods (custom) metrics."
  echo "  autoscaling/v2 takes the MAX across metrics — CPU can veto scale-down."
  echo "  Consider removing targetCPUUtilizationPercentage when customMetric is enabled."
fi

echo
echo "Preflight checks passed."
