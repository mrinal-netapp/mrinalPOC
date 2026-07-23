#!/bin/bash
# Script to create Keycloak realm and OIDC clients via Admin REST API
# This script is designed to run in a Kubernetes Job
# Usage: ./scripts/setup-keycloak-realm-and-clients.sh

set -e

# Configuration from environment variables (set by Kubernetes Job)
KEYCLOAK_URL="${KEYCLOAK_URL:-http://keycloak.agentstudio-identity.svc.cluster.local:8080}"
ADMIN_USER="${KEYCLOAK_ADMIN_USER:-admin}"
ADMIN_PASSWORD="${KEYCLOAK_ADMIN_PASSWORD:-AgentstudioAdmin123!}"
REALM_NAME="${KEYCLOAK_REALM:-agentstudio}"

# Domain configuration
DOMAIN="${DOMAIN:-agentstudio.local}"
PROTOCOL="${PROTOCOL:-https}"

echo "=========================================="
echo "Keycloak Realm and OIDC Client Setup"
echo "=========================================="
echo "Keycloak URL: $KEYCLOAK_URL"
echo "Realm: $REALM_NAME"
echo "Domain: $DOMAIN"
echo ""

# Function to get admin access token
get_admin_token() {
    echo "Getting admin access token..."
    TOKEN_RESPONSE=$(curl -s -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        -d "username=$ADMIN_USER" \
        -d "password=$ADMIN_PASSWORD" \
        -d "grant_type=password" \
        -d "client_id=admin-cli")
    
    ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | grep -o '"access_token":"[^"]*' | sed 's/"access_token":"//')
    
    if [ -z "$ACCESS_TOKEN" ]; then
        echo "Error: Failed to get admin access token"
        echo "Response: $TOKEN_RESPONSE"
        exit 1
    fi
    
    echo "✅ Admin token obtained"
    echo "$ACCESS_TOKEN"
}

# Function to check if realm exists
realm_exists() {
    local token=$1
    local http_code=$(curl -s -o /dev/null -w "%{http_code}" \
        -X GET "$KEYCLOAK_URL/admin/realms/$REALM_NAME" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json")
    [ "$http_code" = "200" ]
}

# Function to create realm
create_realm() {
    local token=$1
    echo "Creating realm '$REALM_NAME'..."
    
    REALM_CONFIG=$(cat <<EOF
{
  "realm": "$REALM_NAME",
  "enabled": true,
  "displayName": "AgentStudio",
  "displayNameHtml": "<div class=\"kc-logo-text\"><span>AgentStudio</span></div>"
}
EOF
)
    
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
        -X POST "$KEYCLOAK_URL/admin/realms" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        -d "$REALM_CONFIG")
    
    if [ "$HTTP_CODE" = "201" ]; then
        echo "✅ Realm '$REALM_NAME' created successfully"
        return 0
    elif [ "$HTTP_CODE" = "409" ]; then
        echo "ℹ️  Realm '$REALM_NAME' already exists"
        return 0
    else
        echo "Error: Failed to create realm (HTTP $HTTP_CODE)"
        return 1
    fi
}

# Function to check if client exists
client_exists() {
    local token=$1
    local client_id=$2
    local http_code=$(curl -s -o /dev/null -w "%{http_code}" \
        -X GET "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients?clientId=$client_id" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json")
    [ "$http_code" = "200" ]
}

# Function to get client UUID
get_client_uuid() {
    local token=$1
    local client_id=$2
    curl -s -X GET "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients?clientId=$client_id" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" | \
        grep -o '"id":"[^"]*' | head -1 | sed 's/"id":"//'
}

# Function to get client secret
get_client_secret() {
    local token=$1
    local client_uuid=$2
    curl -s -X GET "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients/$client_uuid/client-secret" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" | \
        grep -o '"value":"[^"]*' | sed 's/"value":"//'
}

# Function to create OIDC client
create_client() {
    local token=$1
    local client_id=$2
    local client_config=$3
    
    echo "Creating client '$client_id'..."
    
    # Check if client exists
    if client_exists "$token" "$client_id"; then
        echo "ℹ️  Client '$client_id' already exists, skipping creation"
        return 0
    fi
    
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
        -X POST "$KEYCLOAK_URL/admin/realms/$REALM_NAME/clients" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        -d "$client_config")
    
    if [ "$HTTP_CODE" = "201" ]; then
        echo "✅ Client '$client_id' created successfully"
        return 0
    else
        echo "Error: Failed to create client '$client_id' (HTTP $HTTP_CODE)"
        return 1
    fi
}

# Function to update client secret in values (if file is writable)
update_client_secret() {
    local client_name=$1
    local secret=$2
    local values_file="${KEYCLOAK_VALUES_FILE:-deployments/helm/platform/values.yaml}"
    
    if [ -w "$values_file" ]; then
        # Try to update the values file (this might not work in a Job, but worth trying)
        echo "Note: Client secret for '$client_name' is: $secret"
        echo "Update $values_file manually or via Helm values"
    else
        echo "Client secret for '$client_name': $secret"
    fi
}

# Wait for Keycloak to be ready
echo "Waiting for Keycloak to be ready..."
for i in {1..60}; do
    if curl -s -f "$KEYCLOAK_URL/realms/master/.well-known/openid-configuration" > /dev/null 2>&1; then
        echo "✅ Keycloak is ready"
        break
    fi
    if [ $i -eq 60 ]; then
        echo "Error: Keycloak is not ready after 60 attempts"
        exit 1
    fi
    sleep 2
done

# Get admin token
TOKEN=$(get_admin_token)

# Create realm
if ! realm_exists "$TOKEN"; then
    create_realm "$TOKEN" || exit 1
else
    echo "ℹ️  Realm '$REALM_NAME' already exists"
fi

# Refresh token (in case it expired)
TOKEN=$(get_admin_token)

# Create GUI client (Public Client - SPA)
GUI_CLIENT_CONFIG=$(cat <<EOF
{
  "clientId": "agentstudio-gui",
  "enabled": true,
  "publicClient": true,
  "standardFlowEnabled": true,
  "directAccessGrantsEnabled": false,
  "implicitFlowEnabled": false,
  "serviceAccountsEnabled": false,
  "redirectUris": [
    "$PROTOCOL://$DOMAIN/console/*",
    "$PROTOCOL://$DOMAIN:8443/console/*",
    "http://localhost:3000/*"
  ],
  "webOrigins": [
    "$PROTOCOL://$DOMAIN",
    "$PROTOCOL://$DOMAIN:8443",
    "http://localhost:3000"
  ],
  "attributes": {
    "post.logout.redirect.uris": "$PROTOCOL://$DOMAIN/console,http://localhost:3000"
  }
}
EOF
)
create_client "$TOKEN" "agentstudio-gui" "$GUI_CLIENT_CONFIG"

# Create Gateway client (Confidential)
TOKEN=$(get_admin_token)
GATEWAY_CLIENT_CONFIG=$(cat <<EOF
{
  "clientId": "agentstudio-gateway",
  "enabled": true,
  "publicClient": false,
  "standardFlowEnabled": true,
  "directAccessGrantsEnabled": false,
  "serviceAccountsEnabled": false,
  "redirectUris": [
    "$PROTOCOL://$DOMAIN/*"
  ]
}
EOF
)
create_client "$TOKEN" "agentstudio-gateway" "$GATEWAY_CLIENT_CONFIG"

# Get gateway client secret
GATEWAY_UUID=$(get_client_uuid "$TOKEN" "agentstudio-gateway")
if [ -n "$GATEWAY_UUID" ]; then
    GATEWAY_SECRET=$(get_client_secret "$TOKEN" "$GATEWAY_UUID")
    update_client_secret "gateway" "$GATEWAY_SECRET"
fi

# Create Lakekeeper client (Confidential)
TOKEN=$(get_admin_token)
LAKEKEEPER_CLIENT_CONFIG=$(cat <<EOF
{
  "clientId": "agentstudio-lakekeeper",
  "enabled": true,
  "publicClient": false,
  "standardFlowEnabled": true,
  "directAccessGrantsEnabled": false,
  "serviceAccountsEnabled": false,
  "redirectUris": [
    "$PROTOCOL://$DOMAIN/*"
  ]
}
EOF
)
create_client "$TOKEN" "agentstudio-lakekeeper" "$LAKEKEEPER_CLIENT_CONFIG"

# Get lakekeeper client secret
LAKEKEEPER_UUID=$(get_client_uuid "$TOKEN" "agentstudio-lakekeeper")
if [ -n "$LAKEKEEPER_UUID" ]; then
    LAKEKEEPER_SECRET=$(get_client_secret "$TOKEN" "$LAKEKEEPER_UUID")
    update_client_secret "lakekeeper" "$LAKEKEEPER_SECRET"
fi

# Create service account clients
SERVICES=("workflow-engine" "analytics-engine" "config-service")

for service in "${SERVICES[@]}"; do
    TOKEN=$(get_admin_token)
    CLIENT_ID="agentstudio-$service"
    
    SERVICE_CLIENT_CONFIG=$(cat <<EOF
{
  "clientId": "$CLIENT_ID",
  "enabled": true,
  "publicClient": false,
  "standardFlowEnabled": false,
  "directAccessGrantsEnabled": false,
  "serviceAccountsEnabled": true,
  "redirectUris": []
}
EOF
)
    create_client "$TOKEN" "$CLIENT_ID" "$SERVICE_CLIENT_CONFIG"
    
    # Get client secret
    CLIENT_UUID=$(get_client_uuid "$TOKEN" "$CLIENT_ID")
    if [ -n "$CLIENT_UUID" ]; then
        CLIENT_SECRET=$(get_client_secret "$TOKEN" "$CLIENT_UUID")
        update_client_secret "$service" "$CLIENT_SECRET"
    fi
done

echo ""
echo "=========================================="
echo "✅ Keycloak setup completed successfully!"
echo "=========================================="
echo ""
echo "Realm: $REALM_NAME"
echo "Clients created:"
echo "  - agentstudio-gui (Public)"
echo "  - agentstudio-gateway (Confidential)"
echo "  - agentstudio-lakekeeper (Confidential)"
echo "  - agentstudio-workflow-engine (Service Account)"
echo "  - agentstudio-analytics-engine (Service Account)"
echo "  - agentstudio-config-service (Service Account)"
echo ""
echo "Note: Client secrets have been output above. Update Helm values if needed."
