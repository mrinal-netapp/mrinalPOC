#!/bin/bash
# find-keycloak-admin-credentials.sh - Find Keycloak admin credentials
#
# This script helps find Keycloak admin credentials

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
NAMESPACE=${KEYCLOAK_NAMESPACE:-agentstudio-identity}

echo -e "${GREEN}=== Keycloak Admin Credentials ===${NC}"
echo ""

# Check Keycloak secret
echo -e "${BLUE}Step 1: Checking Keycloak secret...${NC}"
SECRET=$(kubectl get secret -n "$NAMESPACE" -l app.kubernetes.io/name=keycloak -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [ -n "$SECRET" ]; then
    echo "Found secret: $SECRET"
    ADMIN_USER=$(kubectl get secret -n "$NAMESPACE" "$SECRET" -o jsonpath='{.data.admin-user}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
    ADMIN_PASSWORD=$(kubectl get secret -n "$NAMESPACE" "$SECRET" -o jsonpath='{.data.admin-password}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
    
    if [ -n "$ADMIN_USER" ]; then
        echo -e "${GREEN}Admin User: $ADMIN_USER${NC}"
    fi
    if [ -n "$ADMIN_PASSWORD" ]; then
        echo -e "${GREEN}Admin Password: $ADMIN_PASSWORD${NC}"
    fi
else
    echo -e "${YELLOW}No Keycloak secret found${NC}"
fi
echo ""

# Check values file
echo -e "${BLUE}Step 2: Checking values file...${NC}"
VALUES_FILE="${KEYCLOAK_VALUES_FILE:-deployments/helm/identity/values.yaml}"
if [ -f "$VALUES_FILE" ]; then
    echo "Checking $VALUES_FILE for admin credentials..."
    ADMIN_USER=$(grep -A 1 "adminUser:" "$VALUES_FILE" | grep -v "adminUser:" | head -1 | sed 's/^[[:space:]]*//' || echo "")
    ADMIN_PASSWORD=$(grep -A 1 "adminPassword:" "$VALUES_FILE" | grep -v "adminPassword:" | head -1 | sed 's/^[[:space:]]*//' | sed 's/"//g' || echo "")
    
    if [ -n "$ADMIN_USER" ]; then
        echo -e "${GREEN}Admin User (from values): $ADMIN_USER${NC}"
    fi
    if [ -n "$ADMIN_PASSWORD" ]; then
        echo -e "${GREEN}Admin Password (from values): $ADMIN_PASSWORD${NC}"
    fi
else
    echo -e "${YELLOW}Values file not found: $VALUES_FILE${NC}"
fi
echo ""

# Summary
echo -e "${GREEN}=== Summary ===${NC}"
echo ""
echo "Keycloak admin console: https://auth.agentstudio.local/admin"
echo "Default credentials are configured in deployments/helm/identity/values.yaml"
echo ""
