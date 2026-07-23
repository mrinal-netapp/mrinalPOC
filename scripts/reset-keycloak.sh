#!/bin/bash
# reset-keycloak.sh - Reset Keycloak installation
#
# This script completely resets Keycloak by:
# 1. Uninstalling Keycloak Helm release
# 2. Deleting Keycloak resources
# 3. Dropping the Keycloak database

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
RELEASE_NAME=${KEYCLOAK_RELEASE_NAME:-keycloak}

echo -e "${GREEN}=== Resetting Keycloak ==="
echo ""
echo -e "${RED}WARNING: This will permanently delete all Keycloak data!${NC}"
echo "This includes:"
echo "  - All users"
echo "  - All realms"
echo "  - All OIDC clients"
echo "  - All configuration"
echo ""
read -p "Are you sure you want to continue? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
    echo "Aborted."
    exit 0
fi

# Step 1: Uninstall Keycloak Helm release
echo -e "${BLUE}Step 1: Uninstalling Keycloak Helm release...${NC}"
make helm-keycloak-uninstall || echo "Release may not exist, continuing..."

# Step 2: Delete remaining resources
echo -e "${BLUE}Step 2: Deleting remaining Keycloak resources...${NC}"
kubectl delete svc,deployment,job,secret,configmap -n "$NAMESPACE" -l app.kubernetes.io/name=keycloak 2>/dev/null || echo "No resources to delete"

# Step 3: Drop the Keycloak database
echo -e "${BLUE}Step 3: Dropping Keycloak database...${NC}"
POSTGRES_POD=$(kubectl get pods -n "$DB_NAMESPACE" -l app.kubernetes.io/component=postgresql -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || \
    kubectl get pods -n "$DB_NAMESPACE" --no-headers 2>/dev/null | grep -i postgresql | head -1 | awk '{print $1}' || echo "")

if [ -z "$POSTGRES_POD" ]; then
    echo -e "${RED}Error: Could not find PostgreSQL pod${NC}"
    exit 1
fi

echo "Dropping database 'keycloak'..."
kubectl exec -i -n "$DB_NAMESPACE" "$POSTGRES_POD" -- psql -U postgres -c "DROP DATABASE IF EXISTS keycloak;" 2>/dev/null || echo "Database may not exist"

echo -e "${GREEN}Keycloak reset complete!${NC}"
echo ""
echo "To reinstall Keycloak, run:"
echo "  make helm-keycloak-upgrade"
echo ""
