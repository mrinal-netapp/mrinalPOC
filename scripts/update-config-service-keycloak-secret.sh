#!/bin/bash
# Script to retrieve and update the config-service Keycloak client secret in Kubernetes

set -e

NAMESPACE="${NAMESPACE:-agentstudio-services}"
SECRET_NAME="${SECRET_NAME:-keycloak-oidc-secrets}"
KEYCLOAK_URL="${KEYCLOAK_URL:-http://keycloak.agentstudio-identity.svc.cluster.local:8080}"
KEYCLOAK_ADMIN_USER="${KEYCLOAK_ADMIN_USER:-admin}"
KEYCLOAK_ADMIN_PASSWORD="${KEYCLOAK_ADMIN_PASSWORD:-AgentstudioAdmin123!}"
REALM_NAME="${REALM_NAME:-agentstudio}"
CLIENT_ID="${CLIENT_ID:-agentstudio-config-service}"

echo "Retrieving Keycloak client secret for: $CLIENT_ID"
echo "Keycloak URL: $KEYCLOAK_URL"
echo "Realm: $REALM_NAME"
echo ""

# Get admin token
echo "Getting Keycloak admin token..."
ADMIN_TOKEN=$(curl -s -X POST "${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=${KEYCLOAK_ADMIN_USER}" \
  -d "password=${KEYCLOAK_ADMIN_PASSWORD}" \
  -d "grant_type=password" \
  -d "client_id=admin-cli" | jq -r '.access_token')

if [ -z "$ADMIN_TOKEN" ] || [ "$ADMIN_TOKEN" == "null" ]; then
  echo "Error: Failed to get admin token"
  exit 1
fi

echo "✅ Got admin token"

# Get client UUID
echo "Getting client UUID for: $CLIENT_ID"
CLIENT_UUID=$(curl -s -X GET "${KEYCLOAK_URL}/admin/realms/${REALM_NAME}/clients?clientId=${CLIENT_ID}" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" | jq -r '.[0].id')

if [ -z "$CLIENT_UUID" ] || [ "$CLIENT_UUID" == "null" ]; then
  echo "Error: Client '$CLIENT_ID' not found in realm '$REALM_NAME'"
  echo "Please run the Keycloak setup script first: scripts/keycloak-setup.py"
  exit 1
fi

echo "✅ Found client UUID: $CLIENT_UUID"

# Get client secret
echo "Getting client secret..."
CLIENT_SECRET=$(curl -s -X GET "${KEYCLOAK_URL}/admin/realms/${REALM_NAME}/clients/${CLIENT_UUID}/client-secret" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" | jq -r '.value')

if [ -z "$CLIENT_SECRET" ] || [ "$CLIENT_SECRET" == "null" ]; then
  echo "Error: Failed to get client secret"
  exit 1
fi

echo "✅ Got client secret: ${CLIENT_SECRET:0:10}..."

# Update Kubernetes secret
echo ""
echo "Updating Kubernetes secret: $SECRET_NAME in namespace: $NAMESPACE"
kubectl create secret generic "$SECRET_NAME" \
  --from-literal=config-service-client-id="$CLIENT_ID" \
  --from-literal=config-service-client-secret="$CLIENT_SECRET" \
  --namespace="$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -

echo ""
echo "✅ Successfully updated Kubernetes secret!"
echo ""
echo "The config-service should now be able to authenticate with Keycloak."
echo "You may need to restart the config-service pod for the changes to take effect:"
echo "  kubectl rollout restart deployment/config-service -n $NAMESPACE"
