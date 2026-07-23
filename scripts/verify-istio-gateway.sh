#!/usr/bin/env bash
# scripts/verify-istio-gateway.sh -- pre-deploy gate that asserts every
# cluster-side prereq for `gateway.provider=istio` is in place.
#
# Cloud-agnostic: every assertion (istiod readiness, GatewayClass acceptance,
# Gateway API CRD bundle version, edge-namespace TLS Secret, K8s version
# compat) is identical on AKS, GKE, EKS.
#
# Exit codes:
#   0 = pass
#   1 = at least one prereq missing
#
# Used as the FIRST cluster-touching step in deploy-reusable.yml when
# GATEWAY_PROVIDER=istio (see .github/workflows/deploy-reusable.yml). Make
# wrapper: `make verify-istio-gateway` -- mk/tier-helm.mk Layer 1.
#
# Reference: docs/design/istio-gateway-migration.md §8.3 / §10.

set -euo pipefail

GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
RED=$'\033[0;31m'
NC=$'\033[0m'

ISTIO_NAMESPACE="${ISTIO_NAMESPACE:-istio-system}"
EDGE_NAMESPACE="${EDGE_NAMESPACE:-agentstudio-edge}"
TLS_SECRET_NAME="${TLS_SECRET_NAME:-nemo-gateway-tls}"
# Pinned version expected by `scripts/install-gateway-api.sh`. Bumped in
# lockstep with that script.
EXPECTED_GW_API_BUNDLE="${EXPECTED_GW_API_BUNDLE:-v1.4.1}"

failures=0

fail() {
  echo -e "${RED}FAIL${NC}: $*" >&2
  failures=$((failures + 1))
}

pass() {
  echo -e "${GREEN}OK${NC}: $*"
}

echo -e "${YELLOW}Verifying Istio gateway prerequisites...${NC}"
echo "  istio namespace : ${ISTIO_NAMESPACE}"
echo "  edge namespace  : ${EDGE_NAMESPACE}"
echo "  TLS secret      : ${TLS_SECRET_NAME}"
echo "  expected GW API : ${EXPECTED_GW_API_BUNDLE}"
echo

# 1. istiod Helm release deployed.
istiod_status=$(helm -n "${ISTIO_NAMESPACE}" status istiod -o json 2>/dev/null \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["info"]["status"])' 2>/dev/null || true)
if [ "${istiod_status}" = "deployed" ]; then
  pass "helm release istiod is 'deployed' in ${ISTIO_NAMESPACE}"
else
  fail "helm release istiod is not deployed in ${ISTIO_NAMESPACE} (got: ${istiod_status:-<missing>})."
  echo "    Fix: run 'make helm-istio-install' (cluster-admin)." >&2
fi

# 2. GatewayClass 'istio' Accepted=True (created by istiod's controller).
gw_class_status=$(kubectl get gatewayclass istio \
  -o jsonpath='{.status.conditions[?(@.type=="Accepted")].status}' 2>/dev/null || true)
if [ "${gw_class_status}" = "True" ]; then
  pass "GatewayClass 'istio' Accepted=True"
else
  fail "GatewayClass 'istio' is not Accepted (got: ${gw_class_status:-<missing>})."
  echo "    Fix: ensure istiod is healthy: kubectl -n ${ISTIO_NAMESPACE} get pods -l app=istiod" >&2
fi

# 3. Gateway API CRDs at expected bundle version.
gw_api_bundle=$(kubectl get crd gateways.gateway.networking.k8s.io \
  -o jsonpath='{.metadata.annotations.gateway\.networking\.k8s\.io/bundle-version}' 2>/dev/null || true)
if [ -z "${gw_api_bundle}" ]; then
  fail "Gateway API CRD bundle annotation missing (CRDs not installed?)."
  echo "    Fix: ./scripts/install-gateway-api.sh" >&2
elif [ "${gw_api_bundle}" != "${EXPECTED_GW_API_BUNDLE}" ]; then
  echo -e "${YELLOW}WARN${NC}: Gateway API CRD bundle is ${gw_api_bundle}, expected ${EXPECTED_GW_API_BUNDLE}."
  echo "    Either bump EXPECTED_GW_API_BUNDLE in this script + scripts/install-gateway-api.sh"
  echo "    in lock-step, or re-apply the pinned bundle."
else
  pass "Gateway API CRD bundle is ${gw_api_bundle}"
fi

# 4. TLS Secret exists in the edge namespace.
secret_type=$(kubectl -n "${EDGE_NAMESPACE}" get secret "${TLS_SECRET_NAME}" \
  -o jsonpath='{.type}' 2>/dev/null || true)
if [ "${secret_type}" = "kubernetes.io/tls" ]; then
  pass "Secret ${EDGE_NAMESPACE}/${TLS_SECRET_NAME} exists (type=kubernetes.io/tls)"
else
  fail "Secret ${EDGE_NAMESPACE}/${TLS_SECRET_NAME} not found (or wrong type: ${secret_type:-<missing>})."
  echo "    Fix: provisioning-service should write nemo-gateway-tls into ${EDGE_NAMESPACE}." >&2
  echo "    KIND fallback: NAMESPACE=${EDGE_NAMESPACE} ./scripts/prepare-nemo-gateway.sh" >&2
fi

# 5. K8s version >= 1.28 (the floor Istio 1.30 supports).
k8s_version=$(kubectl version -o json 2>/dev/null \
  | python3 -c 'import sys,json; v=json.load(sys.stdin)["serverVersion"]; print(v["major"]+"."+v["minor"].rstrip("+"))' \
  2>/dev/null || true)
if [ -z "${k8s_version}" ]; then
  echo -e "${YELLOW}WARN${NC}: could not read serverVersion; skipping K8s compat check."
else
  major=${k8s_version%.*}
  minor=${k8s_version#*.}
  if [ "${major}" -lt 1 ] || { [ "${major}" -eq 1 ] && [ "${minor}" -lt 28 ]; }; then
    fail "Kubernetes ${k8s_version} is below Istio 1.30 supported minimum (1.28)."
  else
    pass "Kubernetes server version ${k8s_version} is in Istio 1.30 supported matrix"
  fi
fi

echo
if [ "${failures}" -gt 0 ]; then
  echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
  echo -e "${RED}${failures} prerequisite check(s) failed.${NC}"
  echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
  echo
  echo "See docs/design/istio-gateway-migration.md §7 for the full" >&2
  echo "cluster-admin prerequisites runbook." >&2
  exit 1
fi

echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}All Istio gateway prerequisites satisfied.${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
