#!/bin/bash
# validate-keycloak-config.sh - Validate Keycloak configuration
#
# This script validates Keycloak configuration

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

CONFIG_FILE="${KEYCLOAK_VALUES_FILE:-deployments/helm/identity/values.yaml}"

echo -e "${GREEN}=== Keycloak Configuration Validation ===${NC}"
echo ""

if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${RED}Error: Configuration file not found: $CONFIG_FILE${NC}"
    exit 1
fi

echo "Validating: $CONFIG_FILE"
echo ""

# Check required fields
ERRORS=0

# Check admin user
if grep -q "adminUser:" "$CONFIG_FILE"; then
    ADMIN_USER=$(grep "adminUser:" "$CONFIG_FILE" | head -1 | awk '{print $2}' | sed 's/"//g')
    if [ -z "$ADMIN_USER" ] || [ "$ADMIN_USER" = "null" ]; then
        echo -e "${RED}✗ adminUser is not set${NC}"
        ERRORS=$((ERRORS + 1))
    else
        echo -e "${GREEN}✓ adminUser: $ADMIN_USER${NC}"
    fi
else
    echo -e "${YELLOW}⚠ adminUser: Not configured (will use Keycloak defaults)${NC}"
fi

# Check admin password
if grep -q "adminPassword:" "$CONFIG_FILE"; then
    ADMIN_PASSWORD=$(grep "adminPassword:" "$CONFIG_FILE" | head -1 | awk '{print $2}' | sed 's/"//g')
    if [ -z "$ADMIN_PASSWORD" ] || [ "$ADMIN_PASSWORD" = "null" ]; then
        echo -e "${RED}✗ adminPassword is not set${NC}"
        ERRORS=$((ERRORS + 1))
    else
        echo -e "${GREEN}✓ adminPassword: Set${NC}"
    fi
else
    echo -e "${YELLOW}⚠ adminPassword: Not configured (will use Keycloak defaults)${NC}"
fi

# Check database configuration
if grep -q "externalDatabase:" "$CONFIG_FILE"; then
    echo -e "${GREEN}✓ External database configuration found${NC}"
    
    DB_HOST=$(grep -A 5 "externalDatabase:" "$CONFIG_FILE" | grep "host:" | head -1 | awk '{print $2}' | sed 's/"//g' || echo "")
    DB_NAME=$(grep -A 5 "externalDatabase:" "$CONFIG_FILE" | grep "database:" | head -1 | awk '{print $2}' | sed 's/"//g' || echo "")
    
    if [ -n "$DB_HOST" ]; then
        echo -e "  Database host: $DB_HOST"
    fi
    if [ -n "$DB_NAME" ]; then
        echo -e "  Database name: $DB_NAME"
    fi
else
    echo -e "${YELLOW}⚠ External database: Not configured (will use embedded database)${NC}"
fi

echo ""

# Summary
if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}Configuration is valid!${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Verify Keycloak is installed: make helm-keycloak-status"
    echo "  2. Check Keycloak pods: kubectl get pods -n nemo -l app.kubernetes.io/name=keycloak"
    echo "  3. Access admin console: https://auth.agentstudio.local/admin"
else
    echo -e "${RED}Configuration has $ERRORS error(s)${NC}"
    echo ""
    echo "Please fix the issues above before deploying Keycloak."
    exit 1
fi
