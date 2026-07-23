#!/bin/bash
# Diagnostic script for Gateway API routing issues
# Checks Gateway, HTTPRoute, and Service configurations
# This script helps diagnose why Gateway API is not routing traffic to the gateway service

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

NAMESPACE="${NAMESPACE:-agentstudio-services}"
GATEWAY_NS="${GATEWAY_NS:-nginx-gateway}"

echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}Gateway API Diagnostic Script${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""

# Check Gateway resource
echo -e "${YELLOW}1. Checking Gateway resource...${NC}"
if kubectl get gateway -n "$NAMESPACE" &> /dev/null; then
    echo -e "${GREEN}✅ Gateway resource exists${NC}"
    kubectl get gateway -n "$NAMESPACE" -o wide
    echo ""
    echo "Gateway details:"
    kubectl get gateway -n "$NAMESPACE" -o yaml | grep -A 20 "spec:" || true
    echo ""
    echo "Gateway status:"
    kubectl get gateway -n "$NAMESPACE" -o yaml | grep -A 30 "status:" || echo "  No status section found"
else
    echo -e "${RED}❌ Gateway resource not found${NC}"
fi
echo ""

# Check HTTPRoute resource
echo -e "${YELLOW}2. Checking HTTPRoute resource...${NC}"
if kubectl get httproute -n "$NAMESPACE" &> /dev/null; then
    echo -e "${GREEN}✅ HTTPRoute resource exists${NC}"
    kubectl get httproute -n "$NAMESPACE" -o wide
    echo ""
    echo "HTTPRoute details:"
    kubectl get httproute -n "$NAMESPACE" -o yaml | grep -A 30 "spec:" || true
    echo ""
    echo "HTTPRoute status:"
    kubectl get httproute -n "$NAMESPACE" -o yaml | grep -A 30 "status:" || echo "  No status section found"
else
    echo -e "${RED}❌ HTTPRoute resource not found${NC}"
fi
echo ""

# Check Gateway service
echo -e "${YELLOW}3. Checking Gateway service...${NC}"
if kubectl get svc -n "$NAMESPACE" gateway &> /dev/null; then
    echo -e "${GREEN}✅ Gateway service exists${NC}"
    kubectl get svc -n "$NAMESPACE" gateway -o wide
    echo ""
    echo "Service details:"
    kubectl get svc -n "$NAMESPACE" gateway -o yaml | grep -A 15 "spec:" || true
    echo ""
    echo "Service endpoints:"
    kubectl get endpoints -n "$NAMESPACE" gateway -o wide || echo "  No endpoints found"
else
    echo -e "${RED}❌ Gateway service not found${NC}"
fi
echo ""

# Check Gateway deployment/pods
echo -e "${YELLOW}4. Checking Gateway deployment/pods...${NC}"
if kubectl get deployment -n "$NAMESPACE" gateway &> /dev/null; then
    echo -e "${GREEN}✅ Gateway deployment exists${NC}"
    kubectl get deployment -n "$NAMESPACE" gateway -o wide
    echo ""
    kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/name=gateway -o wide || kubectl get pods -n "$NAMESPACE" | grep gateway
else
    echo -e "${RED}❌ Gateway deployment not found${NC}"
fi
echo ""

# Check Gateway NGINX controller
echo -e "${YELLOW}5. Checking Gateway NGINX controller...${NC}"
if kubectl get pods -n "$GATEWAY_NS" &> /dev/null; then
    echo -e "${GREEN}✅ Gateway NGINX namespace exists${NC}"
    kubectl get pods -n "$GATEWAY_NS" -o wide
    echo ""
    echo "Controller logs (last 20 lines):"
    CONTROLLER_POD=$(kubectl get pods -n "$GATEWAY_NS" -l app.kubernetes.io/name=nginx-gateway -o name | head -1)
    if [ -n "$CONTROLLER_POD" ]; then
        kubectl logs -n "$GATEWAY_NS" "$CONTROLLER_POD" --tail=20 || echo "  Could not fetch logs"
    else
        echo "  No controller pod found"
    fi
else
    echo -e "${RED}❌ Gateway NGINX namespace not found${NC}"
fi
echo ""

# Check GatewayClass
echo -e "${YELLOW}6. Checking GatewayClass...${NC}"
if kubectl get gatewayclass nginx &> /dev/null; then
    echo -e "${GREEN}✅ GatewayClass 'nginx' exists${NC}"
    kubectl get gatewayclass nginx -o yaml | grep -A 10 "spec:" || true
else
    echo -e "${RED}❌ GatewayClass 'nginx' not found${NC}"
    echo "Available GatewayClasses:"
    kubectl get gatewayclass || echo "  No GatewayClasses found"
fi
echo ""

# Summary
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}Diagnostic Summary${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "Key checks:"
echo "  - Gateway resource status should show 'Ready: True'"
echo "  - HTTPRoute status should show 'Accepted: True' and parent status"
echo "  - Gateway service should have endpoints"
echo "  - Gateway pods should be running"
echo "  - Gateway NGINX controller should be running"
echo ""
