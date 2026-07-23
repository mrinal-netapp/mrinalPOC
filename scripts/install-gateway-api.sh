#!/bin/bash
# Canonical Gateway API CRD install path. Same script runs against KIND,
# AKS, GKE, EKS clusters -- the upstream `kubernetes-sigs/gateway-api`
# standard-channel CRDs are version-stable and cloud-independent. The
# previous AKS-managed Gateway API path is deliberately not used; CRD
# upgrades are PR-reviewed (the bundle version pinned below) so they
# don't ride on cloud K8s minor upgrades.
#
# NGINX Gateway Fabric (NGF) is skipped by default — Istio is the standard
# ingress path (gateway.provider=istio). Set SKIP_NGF_INSTALL=0 (or
# GATEWAY_PROVIDER=nginx on deploy) to install NGF for the legacy rollback
# path. istiod is installed separately by `make helm-istio-install`
# (scripts/install-istio.sh).
#
# Optional env:
#   GATEWAY_API_VERSION   Bundle version pin (default v1.4.1). Match
#                         scripts/verify-istio-gateway.sh.
#   SKIP_NGF_INSTALL      Default 1 (skip NGF). Set 0 to install NGF.
#   NGF_HELM_RELEASE      Default `ngf`.
#   NGF_OCI_CHART         Default OCI chart on ghcr.io.
#   NGF_HELM_VERSION      Pin (e.g. 2.4.0); default = latest.

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

GATEWAY_API_VERSION="${GATEWAY_API_VERSION:-v1.4.1}"
GATEWAY_NAMESPACE="${GATEWAY_NAMESPACE:-nginx-gateway}"

if [ "${SKIP_NGF_INSTALL:-1}" = "1" ] || [ "${SKIP_NGF_INSTALL:-}" = "true" ]; then
    echo -e "${GREEN}Installing Gateway API CRDs (NGF skipped by default)${NC}"
else
    echo -e "${GREEN}Installing Gateway API CRDs and NGINX Gateway Fabric (NGF)${NC}"
fi
echo "Gateway API Version: $GATEWAY_API_VERSION"
echo ""

# NGF Helm install (optional override)
NGF_HELM_RELEASE="${NGF_HELM_RELEASE:-ngf}"
NGF_OCI_CHART="${NGF_OCI_CHART:-oci://ghcr.io/nginx/charts/nginx-gateway-fabric}"
NGF_HELM_VERSION="${NGF_HELM_VERSION:-}"  # e.g. "2.4.0" to pin; empty = latest

# Check prerequisites
if ! command -v kubectl &> /dev/null; then
    echo -e "${RED}Error: kubectl is not installed${NC}"
    exit 1
fi

if ! command -v helm &> /dev/null; then
    echo -e "${RED}Error: helm is not installed (required for NGF)${NC}"
    exit 1
fi

if ! kubectl cluster-info &> /dev/null; then
    echo -e "${RED}Error: Cannot connect to Kubernetes cluster${NC}"
    exit 1
fi

# Step 1: Install Gateway API CRDs
echo -e "${YELLOW}Step 1: Installing Gateway API CRDs...${NC}"
if kubectl get crd gateways.gateway.networking.k8s.io &> /dev/null; then
    echo -e "${GREEN}✅ Gateway API CRDs already installed${NC}"
    echo "Current CRDs:"
    kubectl get crd | grep gateway.networking.k8s.io || true
else
    echo "Installing Gateway API CRDs from release $GATEWAY_API_VERSION..."
    echo "Using server-side apply method..."
    if kubectl apply --server-side -f "https://github.com/kubernetes-sigs/gateway-api/releases/download/${GATEWAY_API_VERSION}/standard-install.yaml"; then
        echo -e "${GREEN}✅ Gateway API CRDs installed${NC}"
        
        # Wait for CRDs to be ready
        echo "Waiting for CRDs to be ready..."
        sleep 5
        kubectl wait --for condition=established --timeout=60s crd/gateways.gateway.networking.k8s.io || true
        kubectl wait --for condition=established --timeout=60s crd/httproutes.gateway.networking.k8s.io || true
    else
        echo -e "${RED}Error: Failed to install Gateway API CRDs${NC}"
        exit 1
    fi
fi

# Step 2: Check Kubernetes version
echo -e "${YELLOW}Step 2: Checking Kubernetes version...${NC}"
K8S_VERSION=$(kubectl version --short 2>/dev/null | grep "Server Version" | awk '{print $3}' | cut -d. -f1,2)
if [ -z "$K8S_VERSION" ]; then
    K8S_VERSION=$(kubectl version -o json 2>/dev/null | grep -o '"gitVersion":"[^"]*' | cut -d'"' -f4 | cut -d'v' -f2 | cut -d. -f1,2)
fi
if [ -n "$K8S_VERSION" ]; then
    echo "Kubernetes version: $K8S_VERSION"
    MAJOR=$(echo "$K8S_VERSION" | cut -d. -f1)
    MINOR=$(echo "$K8S_VERSION" | cut -d. -f2)
    if [ -n "$MAJOR" ] && [ -n "$MINOR" ]; then
        if [ "$MAJOR" -lt 1 ] || ([ "$MAJOR" -eq 1 ] && [ "$MINOR" -lt 24 ]); then
            echo -e "${YELLOW}⚠️  Warning: Gateway API ${GATEWAY_API_VERSION} requires Kubernetes 1.24+${NC}"
            echo "   Your version may not be fully compatible"
        fi
    fi
else
    echo -e "${YELLOW}⚠️  Warning: Could not determine Kubernetes version${NC}"
fi

# Step 3: Install NGINX Gateway Fabric (NGF) via Helm OCI -- skipped by
# default (SKIP_NGF_INSTALL=1). Opt in with SKIP_NGF_INSTALL=0.
if [ "${SKIP_NGF_INSTALL:-1}" = "1" ] || [ "${SKIP_NGF_INSTALL:-}" = "true" ]; then
    echo -e "${YELLOW}Skipping NGINX Gateway Fabric (default). For NGF rollback: SKIP_NGF_INSTALL=0 make install-gateway-api${NC}"
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}✅ Gateway API CRDs installed (NGF skipped).${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
    exit 0
fi
echo -e "${YELLOW}Step 3: Installing NGINX Gateway Fabric (NGF) controller...${NC}"
NGF_DEPLOYMENT="${NGF_HELM_RELEASE}-nginx-gateway-fabric"  # deployment name created by NGF Helm chart
if helm list -n "$GATEWAY_NAMESPACE" -q 2>/dev/null | grep -q "^${NGF_HELM_RELEASE}$"; then
    echo -e "${GREEN}✅ NGF already installed (Helm release: ${NGF_HELM_RELEASE})${NC}"
    echo "Controller status:"
    kubectl get pods -n "$GATEWAY_NAMESPACE" 2>/dev/null || true
else
    echo "Installing NGF from OCI chart: ${NGF_OCI_CHART}"
    install_failed=0
    if [ -n "$NGF_HELM_VERSION" ]; then
        echo "Using chart version: ${NGF_HELM_VERSION}"
        helm upgrade --install "$NGF_HELM_RELEASE" "$NGF_OCI_CHART" --create-namespace -n "$GATEWAY_NAMESPACE" --version "$NGF_HELM_VERSION" --wait --timeout 5m || install_failed=1
    else
        helm upgrade --install "$NGF_HELM_RELEASE" "$NGF_OCI_CHART" --create-namespace -n "$GATEWAY_NAMESPACE" --wait --timeout 5m || install_failed=1
    fi
    if [ "$install_failed" -ne 0 ]; then
        echo ""
        echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
        echo -e "${RED}Failed to install NGINX Gateway Fabric${NC}"
        echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
        echo ""
        echo "Install manually:"
        echo "  helm install ${NGF_HELM_RELEASE} ${NGF_OCI_CHART} --create-namespace -n ${GATEWAY_NAMESPACE}"
        echo ""
        echo "Docs: https://docs.nginx.com/nginx-gateway-fabric/install/helm/"
        exit 1
    fi
    echo -e "${GREEN}✅ NGF controller installed${NC}"
fi

# Wait for NGF deployment to be available (if not already waited by Helm --wait)
if kubectl get deployment -n "$GATEWAY_NAMESPACE" "$NGF_DEPLOYMENT" &>/dev/null; then
    echo "Waiting for NGF deployment to be available..."
    if kubectl wait --timeout=2m -n "$GATEWAY_NAMESPACE" "deployment/$NGF_DEPLOYMENT" --for=condition=Available 2>/dev/null; then
        echo -e "${GREEN}✅ NGF deployment is available${NC}"
    else
        echo -e "${YELLOW}⚠️  NGF may still be starting; check: kubectl get pods -n $GATEWAY_NAMESPACE${NC}"
    fi
fi

# Step 4: Verify GatewayClass
echo -e "${YELLOW}Step 4: Checking GatewayClass...${NC}"
# Wait a bit for GatewayClass to be created by the controller
sleep 5
if kubectl get gatewayclass nginx &> /dev/null; then
    echo -e "${GREEN}✅ GatewayClass 'nginx' found${NC}"
    kubectl get gatewayclass nginx
elif kubectl get gatewayclass nginx-gateway &> /dev/null; then
    echo -e "${GREEN}✅ GatewayClass 'nginx-gateway' found${NC}"
    kubectl get gatewayclass nginx-gateway
    echo -e "${YELLOW}Note: GatewayClass is named 'nginx-gateway'. Update values.yaml to use 'nginx-gateway' as className if needed.${NC}"
else
    echo -e "${YELLOW}⚠️  GatewayClass 'nginx' not found${NC}"
    echo "Gateway NGINX controller should create a GatewayClass automatically."
    echo "Waiting a bit more and checking again..."
    sleep 10
    if kubectl get gatewayclass nginx &> /dev/null; then
        echo -e "${GREEN}✅ GatewayClass 'nginx' found${NC}"
        kubectl get gatewayclass nginx
    elif kubectl get gatewayclass nginx-gateway &> /dev/null; then
        echo -e "${GREEN}✅ GatewayClass 'nginx-gateway' found${NC}"
        kubectl get gatewayclass nginx-gateway
    else
        echo -e "${YELLOW}⚠️  GatewayClass still not found. Creating default GatewayClass...${NC}"
        # Try to determine the correct controller name
        CONTROLLER_NAME="gateway.nginx.org/nginx-gateway"
        cat <<EOF | kubectl apply -f -
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: nginx
spec:
  controllerName: ${CONTROLLER_NAME}
EOF
        echo -e "${GREEN}✅ GatewayClass 'nginx' created${NC}"
    fi
fi

# Step 5: Configure NGINX Gateway controller ConfigMap for body size limits
echo -e "${YELLOW}Step 5: Configuring NGINX Gateway controller ConfigMap...${NC}"
CONFIGMAP_NAME="nginx-gateway-config"
if kubectl get configmap -n "$GATEWAY_NAMESPACE" "$CONFIGMAP_NAME" &> /dev/null; then
    echo "ConfigMap $CONFIGMAP_NAME already exists, updating..."
    kubectl patch configmap -n "$GATEWAY_NAMESPACE" "$CONFIGMAP_NAME" --type merge -p '{"data":{"client-max-body-size":"200m","proxy-send-timeout":"600s","proxy-read-timeout":"600s"}}' || true
    echo -e "${GREEN}✅ ConfigMap updated${NC}"
else
    echo "Creating ConfigMap $CONFIGMAP_NAME..."
    cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: $CONFIGMAP_NAME
  namespace: $GATEWAY_NAMESPACE
data:
  # Body size limit for uploads (200MB) - allows S3 file uploads and large dataset files
  client-max-body-size: "200m"
  # Proxy timeouts for large file uploads
  proxy-connect-timeout: "10s"
  proxy-send-timeout: "600s"
  proxy-read-timeout: "600s"
  # Keepalive connections for better performance
  upstream-keepalive-connections: "128"
  upstream-keepalive-timeout: "60s"
  upstream-keepalive-requests: "1000"
  # Buffer sizes for large uploads
  proxy-buffer-size: "32k"
  proxy-buffers-number: "16"
  proxy-busy-buffers-size: "64k"
EOF
    echo -e "${GREEN}✅ ConfigMap created${NC}"
fi

# Step 6: Align NGF service ports with AgentStudio Gateway (8080/8443)
echo -e "${YELLOW}Step 6: Aligning NGINX Gateway Service ports (8080/8443)...${NC}"
SERVICE_NAME="${NGF_HELM_RELEASE}-nginx-gateway-fabric"
if kubectl get svc -n "$GATEWAY_NAMESPACE" "$SERVICE_NAME" &> /dev/null; then
    echo "Patching service $SERVICE_NAME ports/targetPorts to 8080/8443..."
    kubectl patch svc -n "$GATEWAY_NAMESPACE" "$SERVICE_NAME" --type='json' -p='[
      {"op":"replace","path":"/spec/ports/0/port","value":8080},
      {"op":"replace","path":"/spec/ports/0/targetPort","value":8080},
      {"op":"replace","path":"/spec/ports/1/port","value":8443},
      {"op":"replace","path":"/spec/ports/1/targetPort","value":8443}
    ]' || true
    echo -e "${GREEN}✅ Service ports patched (8080/8443)${NC}"
else
    echo -e "${YELLOW}⚠️  Service $SERVICE_NAME not found; skipping port patch${NC}"
fi

# Note: NGF uses ClientSettingsPolicy (from AgentStudio chart) for client body size; ConfigMap above may be unused
echo -e "${YELLOW}Note: To restart NGF controller: kubectl rollout restart deployment -n $GATEWAY_NAMESPACE $NGF_DEPLOYMENT${NC}"

# Summary
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ Gateway API installation completed!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "Installed components:"
echo "  - Gateway API CRDs (v$GATEWAY_API_VERSION)"
echo "  - NGINX Gateway Fabric (Helm release: $NGF_HELM_RELEASE, namespace: $GATEWAY_NAMESPACE)"
echo "  - GatewayClass 'nginx'"
echo "  - Client body size: use AgentStudio ClientSettingsPolicy or ConfigMap in $GATEWAY_NAMESPACE"
echo ""
echo "Next steps:"
echo "  1. Prepare certificates: scripts/prepare-nemo-gateway.sh (called automatically by deploy-local-bootstrap-fresh)"
echo "  2. Deploy AgentStudio with Gateway API: make deploy-all-tiers-aks  (or make deploy-local for local clusters)"
echo "  3. Check Gateway status: kubectl get gateway -A"
echo "  4. Check HTTPRoute status: kubectl get httproute -A"
echo ""
echo "Useful commands:"
echo "  kubectl get gatewayclass"
echo "  kubectl get gateway -A"
echo "  kubectl get httproute -A"
echo "  kubectl get pods -n $GATEWAY_NAMESPACE"
echo "  kubectl get configmap -n $GATEWAY_NAMESPACE $CONFIGMAP_NAME"
echo ""
