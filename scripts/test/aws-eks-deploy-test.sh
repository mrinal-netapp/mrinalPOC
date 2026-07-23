#!/usr/bin/env bash
# Offline validation for AWS EKS Agent Studio deployment (branch vs main).
# Exercises helm template rendering for EKS overlays only (no cluster access).
#
# Usage:
#   scripts/test/aws-eks-deploy-test.sh
#   make eks-test-deploy

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

HELM_ROOT="${HELM_ROOT:-deployments/helm}"
ENDPOINT="${ENDPOINT:-eks-test.example.com}"
CONTAINER_IMAGE_REPO="${CONTAINER_IMAGE_REPO:-123456789012.dkr.ecr.us-east-1.amazonaws.com/agentstudio}"
IMAGE_TAG="${IMAGE_TAG:-test}"
KEYCLOAK_HOSTNAME="${KEYCLOAK_HOSTNAME:-https://auth.${ENDPOINT}:8443}"
KEYCLOAK_NAMESPACE="${KEYCLOAK_NAMESPACE:-agentstudio-identity}"
DATABASE_NAMESPACE="${DATABASE_NAMESPACE:-database}"
SERVICES_NAMESPACE="${SERVICES_NAMESPACE:-agentstudio-services}"

pass=0
fail=0
skip=0

run_test() {
  local name="$1"
  shift
  if "$@"; then
    echo "PASS  $name"
    pass=$((pass + 1))
  else
    echo "FAIL  $name" >&2
    fail=$((fail + 1))
  fi
}

skip_test() {
  local name="$1"
  local reason="$2"
  echo "SKIP  $name ($reason)"
  skip=$((skip + 1))
}

require_helm() {
  command -v helm >/dev/null 2>&1
}

helm_deps() {
  local chart="$1"
  helm dependency update "$chart" --quiet 2>/dev/null || helm dependency update "$chart"
}

export_test_keycloak_secrets() {
  export KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD='test-bootstrap-admin'
  export POSTGRES_PASSWORD='test-postgres-password'
  export KEYCLOAK_OIDC_SECRET_GATEWAY='test-gateway-secret'
  export KEYCLOAK_OIDC_SECRET_LAKEKEEPER='test-lakekeeper-secret'
  export KEYCLOAK_OIDC_SECRET_WORKFLOW_ENGINE='test-workflow-secret'
  export KEYCLOAK_OIDC_SECRET_ANALYTICS_ENGINE='test-analytics-secret'
  export KEYCLOAK_OIDC_SECRET_CONFIG_SERVICE='test-config-secret'
  export KEYCLOAK_OIDC_SECRET_STORAGE_MANAGER='test-storage-secret'
  export KEYCLOAK_OIDC_SECRET_AGENT_SERVICE='test-agent-secret'
  export KEYCLOAK_OIDC_SECRET_CONNECTOR_WORKER='test-connector-secret'
  export KEYCLOAK_OIDC_SECRET_ARTIFACT_SERVICE='test-artifact-secret'
  export KEYCLOAK_ENTRA_APP_CLIENT_ID='00000000-0000-0000-0000-000000000001'
  export KEYCLOAK_TENANT_ID='00000000-0000-0000-0000-000000000002'
  export KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID='00000000-0000-0000-0000-000000000003'
  export KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID='00000000-0000-0000-0000-000000000004'
}

EKS_TIER_SET=(
  --set "global.imageRepository=${CONTAINER_IMAGE_REPO}"
  --set "global.imageTag=${IMAGE_TAG}"
  --set "global.endpoint=${ENDPOINT}"
  --set "endpoint=${ENDPOINT}"
)

template_tier() {
  local release="$1"
  local chart="$2"
  local namespace="$3"
  shift 3
  helm template "$release" "$chart" \
    --namespace "$namespace" \
    -f "${chart}/values.yaml" \
    -f "${chart}/values-eks.yaml" \
    "${EKS_TIER_SET[@]}" \
    "$@"
}

test_helm_available() {
  require_helm
}

test_make_helm_tier_template_eks() {
  make helm-tier-template-eks \
    CONTAINER_IMAGE_REPO="$CONTAINER_IMAGE_REPO" \
    ENDPOINT="$ENDPOINT" \
    >/dev/null
}

test_database_eks_fsx_probes_and_storage() {
  helm_deps "${HELM_ROOT}/database"
  local out
  out="$(helm template database-smoke "${HELM_ROOT}/database" \
    --namespace "$DATABASE_NAMESPACE" \
    -f "${HELM_ROOT}/database/values.yaml" \
    -f "${HELM_ROOT}/database/values-eks.yaml")"
  grep -q 'storageClass: "fsxn-nas"' <<<"$out"
  grep -q 'failureThreshold: 40' <<<"$out"
  grep -q 'startupProbe:' <<<"$out"
}

test_workers_eks_s3gateway_rwx_fsx() {
  helm_deps "${HELM_ROOT}/workers"
  local out
  out="$(template_tier workers-smoke "${HELM_ROOT}/workers" agentstudio-workers)"
  grep -q 'ReadWriteMany' <<<"$out"
  grep -q 'fsxn-nas' <<<"$out"
}

test_services_eks_nlb_and_cross_ns_gateway() {
  helm_deps "${HELM_ROOT}/services"
  local out
  out="$(template_tier services-smoke "${HELM_ROOT}/services" "$SERVICES_NAMESPACE")"
  grep -q 'aws-load-balancer-scheme: internet-facing' <<<"$out"
  grep -q 'aws-load-balancer-nlb-target-type: ip' <<<"$out"
  grep -q 'from: All' <<<"$out"
  grep -q 'fsxn-nas' <<<"$out"
  grep -q 'ReadWriteMany' <<<"$out"
}

test_platform_eks_renders() {
  helm_deps "${HELM_ROOT}/platform"
  template_tier platform-smoke "${HELM_ROOT}/platform" agentstudio-platform \
    --set-string "lakekeeper.catalog.extraInitContainers[0].image=${CONTAINER_IMAGE_REPO}/init-tools:${IMAGE_TAG}" \
    >/dev/null
}

test_llm_gateway_eks_renders() {
  helm_deps "${HELM_ROOT}/llm-gateway"
  template_tier llm-gateway-smoke "${HELM_ROOT}/llm-gateway" agentstudio-llm-gateway \
    --set bifrost.metrics.serviceMonitor.enabled=false \
    --set bifrost.persistence.fixPermissions=true \
    >/dev/null
}

test_console_eks_renders() {
  helm_deps "${HELM_ROOT}/console"
  template_tier console-smoke "${HELM_ROOT}/console" agentstudio-console >/dev/null
}

test_observability_eks_renders() {
  helm_deps "${HELM_ROOT}/observability"
  local out
  out="$(helm template observability-smoke "${HELM_ROOT}/observability" \
    --namespace monitoring \
    -f "${HELM_ROOT}/observability/values.yaml" \
    -f "${HELM_ROOT}/observability/values-eks.yaml" \
    "${EKS_TIER_SET[@]}" \
    --set grafana-proxy.hostname="grafana.${ENDPOINT}" \
    --set grafana-proxy.keycloak.issuer="http://keycloak.${KEYCLOAK_NAMESPACE}.svc.cluster.local:8080/realms/nemo" \
    --set grafana-proxy.keycloak.publicIssuer="https://auth.${ENDPOINT}/realms/nemo" \
    --api-versions monitoring.coreos.com/v1)"
  grep -q 'backend: postgresql' <<<"$out"
  grep -q 'existingSecret: "grafana-proxy-session-secret"' <<<"$out"
  grep -q 'kind: Deployment' <<<"$out"
}

test_identity_eks_keycloak_template() {
  export_test_keycloak_secrets
  local out
  out="$(make helm-identity-template-eks \
    KEYCLOAK_HOSTNAME="$KEYCLOAK_HOSTNAME" \
    ENDPOINT="$ENDPOINT" \
    KEYCLOAK_NAMESPACE="$KEYCLOAK_NAMESPACE" \
    2>/dev/null)"
  grep -q 'kind: HTTPRoute' <<<"$out"
  grep -q "auth.${ENDPOINT}" <<<"$out"
  grep -q 'kind: StatefulSet' <<<"$out"
  grep -q 'azure-entra' <<<"$out"
  ! grep -q 'change-me-bootstrap-admin' <<<"$out"
}

echo "=== aws-eks-deploy-test (${REPO_ROOT}) ==="
echo "  ENDPOINT=${ENDPOINT}  REPO=${CONTAINER_IMAGE_REPO}  TAG=${IMAGE_TAG}"

if ! require_helm; then
  skip_test helm_tier_template_eks "helm not in PATH"
  skip_test database_eks_fsx "helm not in PATH"
  skip_test workers_eks_s3gateway_rwx "helm not in PATH"
  skip_test services_eks_nlb_gateway "helm not in PATH"
  skip_test platform_eks_renders "helm not in PATH"
  skip_test llm_gateway_eks_renders "helm not in PATH"
  skip_test console_eks_renders "helm not in PATH"
  skip_test observability_eks_renders "helm not in PATH"
  skip_test identity_eks_keycloak_template "helm not in PATH"
else
  run_test helm_available test_helm_available
  run_test helm_tier_template_eks test_make_helm_tier_template_eks
  run_test database_eks_fsx test_database_eks_fsx_probes_and_storage
  run_test workers_eks_s3gateway_rwx test_workers_eks_s3gateway_rwx_fsx
  run_test services_eks_nlb_gateway test_services_eks_nlb_and_cross_ns_gateway
  run_test platform_eks_renders test_platform_eks_renders
  run_test llm_gateway_eks_renders test_llm_gateway_eks_renders
  run_test console_eks_renders test_console_eks_renders
  run_test observability_eks_renders test_observability_eks_renders
  run_test identity_eks_keycloak_template test_identity_eks_keycloak_template
fi

echo "=== results: ${pass} passed, ${fail} failed, ${skip} skipped ==="
[ "$fail" -eq 0 ]
