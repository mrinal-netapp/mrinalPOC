#!/usr/bin/env bash
# register-entra-app.sh — one-shot Azure-side provisioning for the Keycloak
# Entra ID broker (T-103).
#
# Idempotently creates everything values-aks.yaml + the realm export expect
# on the Microsoft Entra ID side so the agent-studio realm can broker
# OIDC+PKCE login through Entra:
#
#   1. Entra App Registration `agent-studio-keycloak-broker`
#        - signInAudience: AzureADMyOrg (single-tenant)
#        - web platform with redirect URI:
#            https://${KEYCLOAK_HOSTNAME}/realms/${KEYCLOAK_REALM}/broker/azure-entra/endpoint
#        - groupMembershipClaims = "SecurityGroup"
#          + optionalClaims.idToken += "groups"
#          so the id_token Keycloak receives carries the user's Entra
#          security-group memberships, which the IdP mappers
#          (AgentStudio-PlatformAdmins → platform-admin, etc.) read off.
#   2. Client secret on the App Registration, written directly to a K8s
#      Secret named `keycloak-entra-broker` in KEYCLOAK_NS. Keycloak
#      references this via realmBootstrap.broker.existingSecret.
#   3. Two Entra security groups:
#        AgentStudio-PlatformAdmins
#        AgentStudio-PlatformMembers
#      The IdP mappers in the realm export key off these by displayName at
#      runtime; their objectIds are also printed in the summary so the
#      operator can pin them in the realm export when the IdP-mapper commit
#      lands later in this branch.
#
# Each step uses `az` show-or-create idempotency. Re-running the script is
# safe and is the recommended way to reconcile drift (it'll add a new
# client secret and update the K8s Secret — old secrets remain valid until
# they expire, so the running cluster is unaffected).
#
# Required env vars (validated up front):
#   KEYCLOAK_HOSTNAME    Public hostname Keycloak issues tokens for. Used to
#                        build the Entra redirect URI.
#
# Optional env vars:
#   KEYCLOAK_NS                    default: agentstudio-identity
#   KEYCLOAK_REALM                 default: nemo  (must match the
#                                  realm name actually deployed)
#   ENTRA_APP_DISPLAY_NAME         default: agent-studio-keycloak-broker
#   ENTRA_BROKER_SECRET_K8S_NAME   default: keycloak-entra-broker
#                                  (K8s Secret name written to KEYCLOAK_NS)
#   ENTRA_BROKER_SECRET_DISPLAY    default: keycloak-broker
#                                  (friendly name on the App Registration's
#                                  "Certificates & secrets" page)
#   ENTRA_GROUP_ADMINS_NAME        default: AgentStudio-PlatformAdmins
#   ENTRA_GROUP_MEMBERS_NAME       default: AgentStudio-PlatformMembers
#
# Broker client-secret validity is hardcoded to 2 years. Rotate by
# re-running this script; the K8s Secret is updated in place.
#
# Output: prints application (client) ID, tenant ID, redirect URI, and the
# objectIds of the two security groups — everything the realm export's
# Entra IdP block + IdP-mappers will need.
#
# Pre-requisites:
#   - `az` and `kubectl` on PATH; an `az login` session whose principal has
#     Entra ID permissions to:
#       * create / read application registrations
#       * create / read security groups
#     (Application Administrator + Groups Administrator, or
#     Privileged Role Administrator equivalent.)
#   - `kubectl` pointing at the target cluster with write access to Secrets
#     in KEYCLOAK_NS.

set -euo pipefail

# ------------------------------------------------------------------- args
require_env() {
  local name="$1"
  local value="${!name:-}"
  if [ -z "$value" ]; then
    echo "ERROR: required env var $name is not set" >&2
    return 1
  fi
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: required command '$cmd' not found on PATH" >&2
    return 1
  fi
}

require_cmd az
require_cmd kubectl

require_env KEYCLOAK_HOSTNAME

# Realm path embedded in the Entra App Registration's Web redirect URI:
#   https://<KEYCLOAK_HOSTNAME>/realms/<KEYCLOAK_REALM>/broker/<idp>/endpoint
# This MUST match the realm name actually deployed to Keycloak; if it
# doesn't, Entra completes the auth flow but Keycloak rejects the
# callback with `redirect_uri_mismatch`. The chart and every deployment
# overlay (values-aks, values-local) use `nemo`, so we default here
# to match. Override only if you deploy under a different
# realm name AND have updated the chart's `realmBootstrap.realm` too.
KEYCLOAK_NS="${KEYCLOAK_NS:-agentstudio-identity}"
KEYCLOAK_REALM="${KEYCLOAK_REALM:-nemo}"
ENTRA_APP_DISPLAY_NAME="${ENTRA_APP_DISPLAY_NAME:-agent-studio-keycloak-broker}"
ENTRA_BROKER_SECRET_K8S_NAME="${ENTRA_BROKER_SECRET_K8S_NAME:-keycloak-entra-broker}"
ENTRA_BROKER_SECRET_DISPLAY="${ENTRA_BROKER_SECRET_DISPLAY:-keycloak-broker}"
ENTRA_GROUP_ADMINS_NAME="${ENTRA_GROUP_ADMINS_NAME:-AgentStudio-PlatformAdmins}"
ENTRA_GROUP_MEMBERS_NAME="${ENTRA_GROUP_MEMBERS_NAME:-AgentStudio-PlatformMembers}"

# Phase 1: broker client-secret validity is fixed at 2 years for ALL
# environments. Rotation is operator-driven (re-run this script). The
# previous form (`ENTRA_BROKER_SECRET_DURATION` env var sed-parsed into
# `--years`) accepted unvalidated input and was dropped on PR #262
# review (zero Phase 1 use case for non-default durations).
broker_secret_validity_years=2

# Whether to add the running az signed-in operator as a MEMBER of the Entra
# security groups created below. Default: true — the smoke-test runbook
# expects the operator to be able to broker-login with admin privileges
# straight after running this script. Set to "false" if the operator
# already has a different membership posture they want to keep, or if
# org policy forbids self-elevation.
#
# Membership target: ADMIN by default (which after the realm composite
# fix implies MEMBER too). Set ADD_OPERATOR_AS_GROUP=members to land in
# the non-admin group instead, or =both to be added to both.
ADD_OPERATOR_TO_GROUPS="${ADD_OPERATOR_TO_GROUPS:-true}"
ADD_OPERATOR_AS_GROUP="${ADD_OPERATOR_AS_GROUP:-admins}"  # admins | members | both

redirect_uri="https://${KEYCLOAK_HOSTNAME}/realms/${KEYCLOAK_REALM}/broker/azure-entra/endpoint"

tenant_id=$(az account show --query tenantId -o tsv)

echo "Tenant:           $tenant_id"
echo "Keycloak host:    $KEYCLOAK_HOSTNAME"
echo "Keycloak realm:   $KEYCLOAK_REALM"
echo "Redirect URI:     $redirect_uri"
echo "App registration: $ENTRA_APP_DISPLAY_NAME"
echo "K8s namespace:    $KEYCLOAK_NS"
echo "K8s Secret:       $ENTRA_BROKER_SECRET_K8S_NAME"
echo

# --------------------------------------------------------- app registration
# Lookup by displayName. Entra allows multiple apps with the same display
# name, so we filter to one explicitly — first match wins on re-runs,
# which is fine because this script is the only thing that creates apps
# with this display name.
existing_app_id=$(az ad app list \
  --display-name "$ENTRA_APP_DISPLAY_NAME" \
  --query '[0].appId' -o tsv 2>/dev/null || true)

if [ -n "$existing_app_id" ]; then
  echo "[app]  $ENTRA_APP_DISPLAY_NAME exists (appId=$existing_app_id) — reconciling settings"
  app_id="$existing_app_id"
else
  echo "[app]  creating $ENTRA_APP_DISPLAY_NAME"
  app_id=$(az ad app create \
    --display-name "$ENTRA_APP_DISPLAY_NAME" \
    --sign-in-audience AzureADMyOrg \
    --query appId -o tsv)
fi

# Reconcile redirect URI (idempotent — `az ad app update --web-redirect-uris`
# REPLACES the list, so we always end with exactly the one URI we want).
echo "[app]  setting web redirect URI"
az ad app update \
  --id "$app_id" \
  --web-redirect-uris "$redirect_uri" \
  -o none

# Reconcile groups claim. The Microsoft Graph `application` resource takes
# `groupMembershipClaims` on the top-level entity and `optionalClaims` for
# per-token-type tweaks. We want:
#   - groupMembershipClaims = "SecurityGroup"
#     (so security-group memberships are emitted; "All" would also include
#      distribution lists which we don't use)
#   - optionalClaims.idToken contains "groups"
#     (Keycloak federates the id_token, so the groups claim must ride in
#      that token, not the access_token Entra issues for itself)
#
# `az ad app update` accepts a JSON body via stdin; using the inline
# --set syntax doesn't support nested arrays cleanly, so we go through
# a tempfile to keep the structure obvious.
optional_claims_json=$(mktemp)
trap 'rm -f "$optional_claims_json"' EXIT
cat > "$optional_claims_json" <<'EOF'
{
  "groupMembershipClaims": "SecurityGroup",
  "optionalClaims": {
    "idToken": [
      { "name": "groups", "essential": false }
    ],
    "accessToken": [],
    "saml2Token": []
  }
}
EOF

echo "[app]  setting groupMembershipClaims=SecurityGroup + optionalClaims.idToken=groups"
az rest --method PATCH \
  --uri "https://graph.microsoft.com/v1.0/applications(appId='$app_id')" \
  --headers 'Content-Type=application/json' \
  --body "@$optional_claims_json" \
  -o none

# ----------------------------------------------- Microsoft Graph permissions
# Add Microsoft Graph "User.Read" delegated permission so Keycloak can fetch
# the brokered user's basic profile from Graph after sign-in (e.g. via the
# user-info endpoint). Without this, OIDC sign-in still works (basic claims
# come straight off the id_token) but any Keycloak IdP mapper that needs
# Graph data — group membership lookups beyond what's in the id_token, or
# richer profile attribute mapping — will fail with a 403.
#
# Microsoft Graph well-known IDs (stable across all tenants):
#   resourceAppId   = 00000003-0000-0000-c000-000000000000
#   User.Read scope = e1fe6dd8-ba31-4d61-89e7-88639da4683d (delegated)
#
# Idempotent: PATCH on requiredResourceAccess is a full replace, so re-runs
# converge to exactly the spec below.
graph_app_id="00000003-0000-0000-c000-000000000000"
user_read_scope_id="e1fe6dd8-ba31-4d61-89e7-88639da4683d"

required_resource_access_json=$(mktemp)
trap 'rm -f "$optional_claims_json" "$required_resource_access_json"' EXIT
cat > "$required_resource_access_json" <<EOF
{
  "requiredResourceAccess": [
    {
      "resourceAppId": "$graph_app_id",
      "resourceAccess": [
        {
          "id": "$user_read_scope_id",
          "type": "Scope"
        }
      ]
    }
  ]
}
EOF

echo "[app]  adding Microsoft Graph User.Read delegated permission"
az rest --method PATCH \
  --uri "https://graph.microsoft.com/v1.0/applications(appId='$app_id')" \
  --headers 'Content-Type=application/json' \
  --body "@$required_resource_access_json" \
  -o none

# ------------------------------------------------------- service principal
# Keycloak federates against the App Registration's Service Principal in
# this tenant. `az ad sp create-for-app` is the historic name; the newer
# CLI prefers `az ad sp create --id <appId>`. Idempotent: noop if SP
# already exists.
existing_sp_object_id=$(az ad sp list \
  --filter "appId eq '$app_id'" \
  --query '[0].id' -o tsv 2>/dev/null || true)

if [ -n "$existing_sp_object_id" ]; then
  echo "[sp]   service principal exists (objectId=$existing_sp_object_id) — skipping"
else
  echo "[sp]   creating service principal for $ENTRA_APP_DISPLAY_NAME"
  az ad sp create --id "$app_id" -o none
fi

# ----------------------------------------- admin-consent for Graph permission
# Grant tenant-wide admin consent for the Microsoft Graph User.Read permission
# we just declared, so brokered users don't see a per-user consent prompt
# during their first sign-in.
#
# This step requires one of the following Entra roles on the operator's
# account: Cloud Application Administrator, Application Administrator, or
# Global Administrator. Many operators don't have these (the app
# registration + secret + groups can all be created by a less-privileged
# Application Developer).
#
# We make this best-effort — if the operator can't consent, we print
# instructions so a tenant admin can do it later out-of-band. The brokered
# login flow still works without consent (User.Read isn't strictly
# required for OIDC sign-in), so this isn't a hard blocker.
echo "[consent] attempting tenant-wide admin consent for Graph User.Read"
if az ad app permission admin-consent --id "$app_id" -o none 2>/dev/null; then
  echo "[consent] admin consent granted"
else
  cat >&2 <<CONSENT_HELP
[consent] WARNING: az ad app permission admin-consent failed.
          Your principal lacks the Entra role required to grant tenant-wide consent.
          The brokered login still works without consent (basic OIDC sign-in does
          not require User.Read), but any IdP mapper that needs Microsoft Graph
          data will get 403s.
          Ask a tenant admin (Cloud Application Administrator / Application
          Administrator / Global Administrator) to run:
            az ad app permission admin-consent --id $app_id
          OR consent via the Azure Portal:
            Entra ID -> App registrations -> $ENTRA_APP_DISPLAY_NAME ->
            API permissions -> Grant admin consent for <tenant>
CONSENT_HELP
fi

# ---------------------------------------------------------- client secret
# Always generate a fresh secret on every run. Old secrets remain valid
# until expiry (default 2 years), so this is non-disruptive — the cluster
# keeps using the K8s Secret value until the operator bounces the pod.
# Rotate by re-running this script; the K8s Secret is updated in place.
#
# `--display-name` is the friendly tag shown in the Azure portal; the
# actual secret VALUE is generated by Entra and returned in the response.
echo "[secret] minting new client secret on $ENTRA_APP_DISPLAY_NAME (display='$ENTRA_BROKER_SECRET_DISPLAY')"
broker_secret=$(az ad app credential reset \
  --id "$app_id" \
  --display-name "$ENTRA_BROKER_SECRET_DISPLAY" \
  --years "$broker_secret_validity_years" \
  --append \
  --query password -o tsv)

if [ -z "$broker_secret" ]; then
  echo "ERROR: az ad app credential reset returned an empty password — aborting" >&2
  exit 1
fi

# Write directly to a K8s Secret (no Key Vault hop). Uses dry-run|apply so
# the operation is idempotent: re-running updates the existing Secret in place.
echo "[k8s]  writing Secret '$ENTRA_BROKER_SECRET_K8S_NAME' in namespace $KEYCLOAK_NS"
kubectl create secret generic "$ENTRA_BROKER_SECRET_K8S_NAME" \
  --namespace "$KEYCLOAK_NS" \
  --from-literal=clientSecret="$broker_secret" \
  --dry-run=client -o yaml \
| kubectl label --local -f - \
  app.kubernetes.io/managed-by=register-entra-app.sh \
  app.kubernetes.io/part-of=keycloak \
  --dry-run=client -o yaml \
| kubectl apply -f -

# Zero out the variable so it doesn't sit in the script's environment any
# longer than necessary. (It was already written to the K8s Secret.)
broker_secret=""
unset broker_secret

# ----------------------------------------------------- security groups
provision_security_group() {
  local display_name="$1"
  local mail_nickname="$2"
  local existing_group_id

  existing_group_id=$(az ad group list \
    --display-name "$display_name" \
    --query '[0].id' -o tsv 2>/dev/null || true)

  if [ -n "$existing_group_id" ]; then
    # Log line MUST go to stderr — the function's stdout is captured by
    # the caller (admins_group_id=$(provision_security_group ...)) and a
    # log line on stdout would contaminate the captured objectId,
    # breaking later `az` commands that expect a bare GUID.
    echo "[group] $display_name exists (objectId=$existing_group_id) — skipping" >&2
    echo "$existing_group_id"
    return 0
  fi

  echo "[group] creating $display_name (mailNickname=$mail_nickname)" >&2
  az ad group create \
    --display-name "$display_name" \
    --mail-nickname "$mail_nickname" \
    --query id -o tsv
}

# mail-nickname must be unique within the tenant and is required by Graph
# even for security-only groups. Derive it from the display name (lowercase,
# strip non-alphanumerics) — keeps it deterministic across re-runs and
# inspectable in the Azure portal alongside the display name.
admins_nickname=$(echo "$ENTRA_GROUP_ADMINS_NAME"   | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')
members_nickname=$(echo "$ENTRA_GROUP_MEMBERS_NAME" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')

admins_group_id=$(provision_security_group "$ENTRA_GROUP_ADMINS_NAME"   "$admins_nickname")
members_group_id=$(provision_security_group "$ENTRA_GROUP_MEMBERS_NAME" "$members_nickname")

# ----------------------------------------------- operator group membership
# Add the running az signed-in operator as a MEMBER of one or both groups
# (member, not owner — owner ≠ member in Entra; the `groups` claim in
# tokens lists groups the user is a MEMBER of, not groups they own).
#
# Without this step, a fresh smoke test breaks at the broker login: the
# operator's first brokered login produces a JWT with groups=[], neither
# IdP role mapper fires, realm_access.roles=[], and every protected page
# returns 401. The fix is to be a MEMBER of at least one of the platform
# groups so the IdP mapper can grant the corresponding realm role.
add_operator_to_group() {
  local display_name="$1"
  local group_id="$2"
  local caller_oid="$3"

  if [ -z "$group_id" ]; then
    echo "[member] WARNING: group $display_name has no objectId — skipping membership add" >&2
    return 0
  fi

  # Membership check: az ad group member check returns {"value": true|false}.
  # We use --query value -o tsv for clean parseable output.
  local already_member
  already_member=$(az ad group member check --group "$group_id" --member-id "$caller_oid" --query value -o tsv 2>/dev/null || echo "false")
  if [ "$already_member" = "true" ]; then
    echo "[member] operator already a MEMBER of $display_name — skipping"
    return 0
  fi

  echo "[member] adding operator as MEMBER of $display_name (objectId=$group_id)"
  az ad group member add --group "$group_id" --member-id "$caller_oid" -o none
}

if [ "$ADD_OPERATOR_TO_GROUPS" = "true" ]; then
  caller_oid=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || true)
  if [ -z "$caller_oid" ]; then
    echo "[member] WARNING: could not resolve signed-in user objectId (running as service principal?). Skipping operator-as-member step." >&2
    echo "[member] If you need a brokered login as this principal, add it to the appropriate group manually." >&2
  else
    case "$ADD_OPERATOR_AS_GROUP" in
      admins)
        add_operator_to_group "$ENTRA_GROUP_ADMINS_NAME" "$admins_group_id" "$caller_oid"
        ;;
      members)
        add_operator_to_group "$ENTRA_GROUP_MEMBERS_NAME" "$members_group_id" "$caller_oid"
        ;;
      both)
        add_operator_to_group "$ENTRA_GROUP_ADMINS_NAME"  "$admins_group_id"  "$caller_oid"
        add_operator_to_group "$ENTRA_GROUP_MEMBERS_NAME" "$members_group_id" "$caller_oid"
        ;;
      *)
        echo "ERROR: ADD_OPERATOR_AS_GROUP must be one of: admins, members, both (got '$ADD_OPERATOR_AS_GROUP')" >&2
        exit 1
        ;;
    esac
  fi
else
  echo "[member] ADD_OPERATOR_TO_GROUPS=false — skipping operator-as-member step"
  echo "[member] Add yourself manually before broker login, e.g.:"
  echo "[member]   az ad group member add --group <group-id> --member-id \$(az ad signed-in-user show --query id -o tsv)"
fi

# ---------------------------------------------------------------- summary
cat <<SUMMARY

------------------------------------------------------------------------
Entra broker provisioning complete.

App Registration:
  ENTRA_APP_DISPLAY_NAME        = $ENTRA_APP_DISPLAY_NAME
  ENTRA_APP_CLIENT_ID  (appId)  = $app_id
  ENTRA_TENANT_ID               = $tenant_id
  Redirect URI                  = $redirect_uri

Client secret:
  Written to K8s Secret         : namespace=$KEYCLOAK_NS, name=$ENTRA_BROKER_SECRET_K8S_NAME, key=clientSecret
  Validity                      : ~${broker_secret_validity_years} years from now
  Rotation                      : re-run this script; K8s Secret is updated in place

Security groups (objectIds — pin these in the realm export's IdP mappers
once the T-103 broker-config commit lands):
  $ENTRA_GROUP_ADMINS_NAME    = $admins_group_id
  $ENTRA_GROUP_MEMBERS_NAME   = $members_group_id

Next steps:
  1. Add platform engineers to $ENTRA_GROUP_ADMINS_NAME and end-users
     to $ENTRA_GROUP_MEMBERS_NAME in the Azure portal.
  2. Pass the Entra metadata to the helm install:
       make helm-identity-install-aks \
         KEYCLOAK_HOSTNAME=$KEYCLOAK_HOSTNAME \
         KEYCLOAK_ENTRA_APP_CLIENT_ID=$app_id \
         KEYCLOAK_TENANT_ID=$tenant_id \
         KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID=$admins_group_id \
         KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID=$members_group_id
  3. End-to-end smoke test:
     hit https://${KEYCLOAK_HOSTNAME}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/auth?...
     and verify the redirect chain reaches Entra and bounces back to the
     SPA with a Keycloak-signed JWT carrying realm_access.roles=[platform-member].
------------------------------------------------------------------------
SUMMARY
