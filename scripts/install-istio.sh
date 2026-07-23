#!/usr/bin/env bash
# scripts/install-istio.sh -- one-time cluster-admin install of self-managed
# (upstream) Istio 1.30+ via the official Helm charts.
#
# Cloud-agnostic: same script runs against KIND, AKS, GKE, EKS. Idempotent
# (helm upgrade --install). Pin via ISTIO_VERSION; the verify script
# (scripts/verify-istio-gateway.sh) checks the live revision afterwards.
#
# Pairs with scripts/install-gateway-api.sh, which installs the upstream
# Gateway API standard-channel CRDs. Order doesn't matter -- istiod's
# Gateway API controller picks up the CRDs as soon as both are present.
#
# Usage:
#   ./scripts/install-istio.sh                       # default ISTIO_VERSION=1.30.0
#   ISTIO_VERSION=1.30.2 ./scripts/install-istio.sh  # pin a specific minor
#
# Make wrapper: `make helm-istio-install` -- mk/tier-helm.mk Layer 1.
#
# See docs/design/istio-gateway-migration.md §7 for the canonical install
# procedure this script automates.

set -euo pipefail

GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
RED=$'\033[0;31m'
NC=$'\033[0m'

ISTIO_VERSION="${ISTIO_VERSION:-1.30.0}"
ISTIO_NAMESPACE="${ISTIO_NAMESPACE:-istio-system}"
ISTIO_REPO_NAME="${ISTIO_REPO_NAME:-istio}"
ISTIO_REPO_URL="${ISTIO_REPO_URL:-https://istio-release.storage.googleapis.com/charts}"

echo -e "${GREEN}Installing self-managed Istio ${ISTIO_VERSION} into namespace ${ISTIO_NAMESPACE}${NC}"

if ! command -v helm >/dev/null 2>&1; then
  echo -e "${RED}Error: helm is not installed${NC}" >&2
  exit 1
fi
if ! command -v kubectl >/dev/null 2>&1; then
  echo -e "${RED}Error: kubectl is not installed${NC}" >&2
  exit 1
fi
if ! kubectl cluster-info >/dev/null 2>&1; then
  echo -e "${RED}Error: cannot reach the Kubernetes cluster (no kubectl context?)${NC}" >&2
  exit 1
fi

echo -e "${YELLOW}Step 1/3: helm repo add ${ISTIO_REPO_NAME}${NC}"
helm repo add "${ISTIO_REPO_NAME}" "${ISTIO_REPO_URL}" --force-update >/dev/null
helm repo update "${ISTIO_REPO_NAME}" >/dev/null

# --force-conflicts is required on AKS clusters with Azure Policy enabled:
# the Azure Policy addon's `admissionsenforcer` field manager takes
# ownership of `.webhooks[].namespaceSelector` on every cluster
# MutatingWebhookConfiguration to inject the `aks-managed-by` exclusion.
# Without --force-conflicts, helm v4's Server-Side Apply (default since
# v4) sees admissionsenforcer's claim and aborts the istio-sidecar-injector
# upgrade with "Apply failed with N conflicts". We want istiod to be the
# authoritative owner of its own webhook config; Azure Policy will
# re-reconcile its namespaceSelector exclusion on its next pass, so
# forcing ownership here is correct rather than destructive.
#
# Cloud-safety: --force-conflicts is a no-op on clusters WITHOUT a
# competing field manager (i.e. all non-AKS clusters and AKS clusters
# without Azure Policy), so it's safe to set unconditionally.
HELM_SSA_FORCE_FLAG="--force-conflicts"

echo -e "${YELLOW}Step 2/3: helm upgrade --install istio-base (CRDs)${NC}"
helm upgrade --install istio-base "${ISTIO_REPO_NAME}/base" \
  --namespace "${ISTIO_NAMESPACE}" \
  --create-namespace \
  --version "${ISTIO_VERSION}" \
  ${HELM_SSA_FORCE_FLAG} \
  --wait

echo -e "${YELLOW}Step 3/3: helm upgrade --install istiod (control plane + Gateway API controller)${NC}"
helm upgrade --install istiod "${ISTIO_REPO_NAME}/istiod" \
  --namespace "${ISTIO_NAMESPACE}" \
  --version "${ISTIO_VERSION}" \
  ${HELM_SSA_FORCE_FLAG} \
  --wait

# Sanity poke -- istiod up + GatewayClass `istio` Accepted.
echo
echo -e "${YELLOW}Verifying control plane readiness (istiod pods + GatewayClass=istio)...${NC}"
kubectl -n "${ISTIO_NAMESPACE}" rollout status deployment/istiod --timeout=120s
for i in $(seq 1 30); do
  status=$(kubectl get gatewayclass istio \
    -o jsonpath='{.status.conditions[?(@.type=="Accepted")].status}' 2>/dev/null || true)
  if [ "${status}" = "True" ]; then
    echo -e "${GREEN}GatewayClass 'istio' Accepted=True${NC}"
    break
  fi
  if [ "${i}" = "30" ]; then
    echo -e "${RED}GatewayClass 'istio' did not reach Accepted=True after 60s. Inspect:" >&2
    echo "  kubectl get gatewayclass istio -o yaml" >&2
    exit 1
  fi
  sleep 2
done

echo
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}Istio ${ISTIO_VERSION} installed.${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo
echo "Next steps:"
echo "  1. ./scripts/install-gateway-api.sh   # upstream Gateway API CRDs"
echo "  2. provisioning-service writes Secret nemo-gateway-tls into agentstudio-edge"
echo "  3. ./scripts/verify-istio-gateway.sh  # pre-deploy gate"
echo "  4. flip the chart overlay to gateway.provider=istio (per cloud)"
