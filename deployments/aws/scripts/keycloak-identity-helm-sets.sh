#!/usr/bin/env bash
# Emit helm --set-string flags for AWS Keycloak identity install.
# Secrets are read from the environment (never committed in values-eks.yaml).
#
# Output: one line per --set-string pair as "--set-string key=value". The Makefile
# splits each line into two helm argv entries (--set-string, key=value).
#
# Required:
#   KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD
#   POSTGRES_PASSWORD                    (must match database tier password)
#   KEYCLOAK_OIDC_SECRET_GATEWAY
#   KEYCLOAK_OIDC_SECRET_LAKEKEEPER
#   KEYCLOAK_OIDC_SECRET_WORKFLOW_ENGINE
#   KEYCLOAK_OIDC_SECRET_ANALYTICS_ENGINE
#   KEYCLOAK_OIDC_SECRET_CONFIG_SERVICE
#   KEYCLOAK_OIDC_SECRET_STORAGE_MANAGER
#   KEYCLOAK_OIDC_SECRET_AGENT_SERVICE
#   KEYCLOAK_OIDC_SECRET_CONNECTOR_WORKER
#   KEYCLOAK_OIDC_SECRET_ARTIFACT_SERVICE
#
# Used by: make helm-identity-install-eks, make helm-identity-template-eks
#
# Example (lab — export before make deploy-eks):
#   export KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD='...'
#   export POSTGRES_PASSWORD='...'
#   export KEYCLOAK_OIDC_SECRET_GATEWAY='...'
#   ... (one export per KEYCLOAK_OIDC_SECRET_* above)

set -euo pipefail

REQUIRED_VARS=(
  KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD
  POSTGRES_PASSWORD
  KEYCLOAK_OIDC_SECRET_GATEWAY
  KEYCLOAK_OIDC_SECRET_LAKEKEEPER
  KEYCLOAK_OIDC_SECRET_WORKFLOW_ENGINE
  KEYCLOAK_OIDC_SECRET_ANALYTICS_ENGINE
  KEYCLOAK_OIDC_SECRET_CONFIG_SERVICE
  KEYCLOAK_OIDC_SECRET_STORAGE_MANAGER
  KEYCLOAK_OIDC_SECRET_AGENT_SERVICE
  KEYCLOAK_OIDC_SECRET_CONNECTOR_WORKER
  KEYCLOAK_OIDC_SECRET_ARTIFACT_SERVICE
)

missing=()
for name in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!name:-}" ]; then
    missing+=("$name")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "ERROR: AWS Keycloak install requires these environment variables:" >&2
  for name in "${missing[@]}"; do
    echo "  export ${name}=..." >&2
  done
  echo "" >&2
  echo "See deployments/helm/identity/values-eks.yaml and deployments/aws/scripts/keycloak-identity-secrets.env.example" >&2
  exit 1
fi

emit_set_string() {
  local key="$1"
  local value="$2"
  # Helm --set/--set-string treats comma as a separator and backslash as escape.
  value="${value//\\/\\\\}"
  value="${value//,/\\,}"
  printf '%s\n' "--set-string ${key}=${value}"
}

# realmBootstrap.additionalClients.clients indices must match values-eks.yaml order.
set_pair() {
  local oidc_key="$1"
  local rb_index="$2"
  local env_name="$3"
  local value="${!env_name}"
  emit_set_string "keycloak.oidcClients.${oidc_key}.clientSecret" "$value"
  emit_set_string "realmBootstrap.additionalClients.clients[${rb_index}].clientSecret" "$value"
}

emit_set_string keycloak.bootstrapAdmin.password "${KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD}"
emit_set_string postgres.auth.password "${POSTGRES_PASSWORD}"

set_pair gateway 11 KEYCLOAK_OIDC_SECRET_GATEWAY
set_pair lakekeeper 5 KEYCLOAK_OIDC_SECRET_LAKEKEEPER
set_pair workflowEngine 7 KEYCLOAK_OIDC_SECRET_WORKFLOW_ENGINE
set_pair analyticsEngine 1 KEYCLOAK_OIDC_SECRET_ANALYTICS_ENGINE
set_pair configService 3 KEYCLOAK_OIDC_SECRET_CONFIG_SERVICE
set_pair storageManager 6 KEYCLOAK_OIDC_SECRET_STORAGE_MANAGER
set_pair agentService 0 KEYCLOAK_OIDC_SECRET_AGENT_SERVICE
set_pair connectorWorker 4 KEYCLOAK_OIDC_SECRET_CONNECTOR_WORKER

# artifact-service: realm bootstrap only (no oidcClients entry in values-eks.yaml)
emit_set_string "realmBootstrap.additionalClients.clients[2].clientSecret" "${KEYCLOAK_OIDC_SECRET_ARTIFACT_SERVICE}"
