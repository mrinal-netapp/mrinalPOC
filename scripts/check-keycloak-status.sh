#!/bin/bash
# check-keycloak-status.sh - Check Keycloak status
#
# This script checks if Keycloak is running and accessible

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
NAMESPACE=${KEYCLOAK_NAMESPACE:-agentstudio-identity}
DB_NAMESPACE=${DB_NAMESPACE:-database}

echo -e "${GREEN}=== Keycloak Status Check ===${NC}"
echo ""

# Step 1: Check if database exists
echo -e "${BLUE}Step 1: Checking Keycloak database...${NC}"
POSTGRES_POD=$(kubectl get pods -n "$DB_NAMESPACE" -l app.kubernetes.io/component=postgresql -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || \
    kubectl get pods -n "$DB_NAMESPACE" --no-headers 2>/dev/null | grep -i postgresql | head -1 | awk '{print $1}' || echo "")

if [ -z "$POSTGRES_POD" ]; then
    echo -e "${RED}Error: Could not find PostgreSQL pod${NC}"
    exit 1
fi

echo "PostgreSQL pod: $POSTGRES_POD"

DB_EXISTS=$(kubectl exec -i -n "$DB_NAMESPACE" "$POSTGRES_POD" -- psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='keycloak'" 2>/dev/null || echo "0")

if [ "$DB_EXISTS" != "1" ]; then
    echo -e "${YELLOW}Keycloak database does not exist yet${NC}"
    echo "This is normal for a fresh installation."
else
    echo -e "${GREEN}Keycloak database exists${NC}"
    
    # Check for tables
    TABLE_COUNT=$(kubectl exec -i -n "$DB_NAMESPACE" "$POSTGRES_POD" -- psql -U postgres -d keycloak -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')" 2>/dev/null || echo "0")
    echo "Found $TABLE_COUNT tables in database"
fi
echo ""

# Step 2: Check Keycloak pods
echo -e "${BLUE}Step 2: Checking Keycloak pods...${NC}"
PODS=$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/name=keycloak --no-headers 2>/dev/null | awk '{print $1}' || echo "")

if [ -n "$PODS" ]; then
    echo "Keycloak pods:"
    kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/name=keycloak 2>/dev/null
    echo ""
    
    for pod in $PODS; do
        POD_STATUS=$(kubectl get pod -n "$NAMESPACE" "$pod" -o jsonpath='{.status.phase}' 2>/dev/null || echo "Unknown")
        READY=$(kubectl get pod -n "$NAMESPACE" "$pod" -o jsonpath='{.status.containerStatuses[0].ready}' 2>/dev/null || echo "Unknown")
        echo "Pod: $pod"
        echo "  Status: $POD_STATUS"
        echo "  Ready: $READY"
        
        if [ "$POD_STATUS" != "Running" ] || [ "$READY" != "true" ]; then
            echo "  Recent logs:"
            kubectl logs -n "$NAMESPACE" "$pod" --tail=10 2>/dev/null | head -5 || echo "    Could not fetch logs"
        fi
        echo ""
    done
else
    echo -e "${YELLOW}No Keycloak pods found${NC}"
fi

# Step 3: Check Keycloak service
echo -e "${BLUE}Step 3: Checking Keycloak service...${NC}"
SERVICE=$(kubectl get svc -n "$NAMESPACE" -l app.kubernetes.io/name=keycloak 2>/dev/null || echo "")
if [ -n "$SERVICE" ]; then
    echo "Keycloak service:"
    kubectl get svc -n "$NAMESPACE" -l app.kubernetes.io/name=keycloak 2>/dev/null
else
    echo -e "${YELLOW}No Keycloak service found${NC}"
fi
echo ""

# Summary
echo -e "${GREEN}=== Summary ===${NC}"
echo ""
if [ -n "$PODS" ]; then
    echo -e "${GREEN}Keycloak is deployed${NC}"
    echo "Access Keycloak admin console at: https://auth.agentstudio.local/admin"
    echo "Default admin credentials are set in values-keycloak-standalone.yaml"
else
    echo -e "${RED}Keycloak is not deployed${NC}"
    echo "Run: make helm-keycloak-upgrade"
fi
echo ""
