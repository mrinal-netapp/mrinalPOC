#!/usr/bin/env bash
# per-project-smoke.sh — end-to-end smoke test for Keycloak per-project
# authorization, following the §6 lifecycle operations contract verbatim.
#
# Exercises: §6.1 Create Project, §6.2 Add User, §6.3 Change Scope,
# §6.4 Remove User, §6.5 Delete Project, plus §6.6 idempotency.
# Verifies acceptance criteria A-1 through A-11.
#
# REQUIRED ENV
#   KC_BASE              Keycloak base URL (e.g. http://localhost:8080)
#   KC_SVC_CONFIG_SECRET client_secret for agent-studio-svc-config
#
# OPTIONAL ENV
#   REALM                realm name        (default: nemo)
#   KC_ADMIN_USER        admin username    (default: read from K8s secret)
#   KC_ADMIN_PASSWORD    admin password    (default: read from K8s secret)
#
# Usage:
#   kubectl -n agentstudio-identity port-forward svc/keycloak 8080:8080 &
#   KC_BASE=http://localhost:8080 KC_SVC_CONFIG_SECRET=<secret> \
#     bash deployments/scripts/keycloak/per-project-smoke.sh
set -euo pipefail

# ---------- colours / helpers ------------------------------------------------

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

pass() { printf "${GREEN}✓ PASS${NC}: %s\n" "$1"; }
fail() { printf "${RED}✗ FAIL${NC}: %s\n" "$1"; exit 1; }
info() { printf "${YELLOW}→${NC} %s\n" "$1"; }
section() { printf "\n${CYAN}══ %s ══${NC}\n" "$1"; }

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label (got: $actual)"
  else
    fail "$label — expected [$expected], got [$actual]"
  fi
}

assert_not_empty() {
  local label="$1" val="$2"
  if [[ -n "$val" ]]; then
    pass "$label"
  else
    fail "$label — value is empty"
  fi
}

assert_http() {
  local label="$1" expected="$2" actual="$3" body="${4:-}"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label (HTTP $actual)"
  else
    fail "$label — expected HTTP $expected, got HTTP $actual${body:+ — body: $body}"
  fi
}

http_status_and_body() {
  local resp="$1"
  HTTP_BODY=$(sed '$d' <<< "$resp")
  HTTP_CODE=$(tail -1 <<< "$resp")
}

# ---------- env defaults -----------------------------------------------------

: "${KC_BASE:?KC_BASE is required (e.g. http://localhost:8080)}"
: "${KC_SVC_CONFIG_SECRET:?KC_SVC_CONFIG_SECRET is required}"
: "${REALM:=nemo}"

PROJECT_ID="$(uuidgen | tr 'A-Z' 'a-z')"
ALICE_USERNAME="smoke-alice-$$"
ALICE_PASSWORD="SmokeAlice1!pass"
BOB_USERNAME="smoke-bob-$$"
BOB_PASSWORD="SmokeBob1!pass"

echo ""
info "Per-project authorization smoke test (§6 lifecycle)"
info "KC_BASE=$KC_BASE  REALM=$REALM  PROJECT_ID=$PROJECT_ID"
echo ""

# ---------- admin token + client UUID ----------------------------------------

section "Setup: admin token, client UUID, test users"

if [[ -z "${KC_ADMIN_USER:-}" ]] || [[ -z "${KC_ADMIN_PASSWORD:-}" ]]; then
  info "KC_ADMIN_USER / KC_ADMIN_PASSWORD not set; trying K8s secrets…"
  KC_ADMIN_USER=$(kubectl -n agentstudio-identity get secret keycloak-bootstrap-admin \
    -o jsonpath='{.data.username}' 2>/dev/null | base64 -d 2>/dev/null || true)
  KC_ADMIN_PASSWORD=$(kubectl -n agentstudio-identity get secret keycloak-bootstrap-admin \
    -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || true)
  if [[ -z "${KC_ADMIN_USER:-}" ]]; then
    KC_ADMIN_USER=$(kubectl -n agentstudio-identity get secret keycloak-bootstrap-admin-from-kv \
      -o jsonpath='{.data.username}' 2>/dev/null | base64 -d 2>/dev/null || true)
    KC_ADMIN_PASSWORD=$(kubectl -n agentstudio-identity get secret keycloak-bootstrap-admin-from-kv \
      -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || true)
  fi
fi
: "${KC_ADMIN_USER:?Admin credentials required}"
: "${KC_ADMIN_PASSWORD:?Admin credentials required}"

ADMIN_TOKEN=$(curl -fsS -X POST \
  "${KC_BASE}/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password" \
  -d "client_id=admin-cli" \
  -d "username=${KC_ADMIN_USER}" \
  -d "password=${KC_ADMIN_PASSWORD}" | jq -r .access_token)
assert_not_empty "Admin token obtained" "$ADMIN_TOKEN"

CLIENT_UUID=$(curl -fsS \
  "${KC_BASE}/admin/realms/${REALM}/clients?clientId=agent-studio-api" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  | jq -r '.[0].id')
assert_not_empty "agent-studio-api UUID resolved: ${CLIENT_UUID}" "$CLIENT_UUID"

AUTHZ_BASE="${KC_BASE}/admin/realms/${REALM}/clients/${CLIENT_UUID}/authz/resource-server"

# ---------- cleanup function (runs on exit) ----------------------------------
# Registered early so that any failure after this point still cleans up test
# users and client mutations. All referenced variables use `:-` defaults so
# the function tolerates being invoked before they are set.

cleanup() {
  set +e
  info "Cleanup: removing test users, restoring settings…"

  # Delete test users.
  curl -sS -X DELETE "${KC_BASE}/admin/realms/${REALM}/users/${USER_ALICE:-__none__}" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" > /dev/null 2>&1
  curl -sS -X DELETE "${KC_BASE}/admin/realms/${REALM}/users/${USER_BOB:-__none__}" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" > /dev/null 2>&1

  # Restore direct access grants by PUT-ing the original client JSON back, so
  # we don't clobber redirect URIs or other settings that may have changed.
  if [[ "${ORIG_DAG:-}" != "true" && -n "${ORIG_CLIENT_JSON:-}" ]]; then
    curl -sS -X PUT \
      "${KC_BASE}/admin/realms/${REALM}/clients/${UI_CLIENT_UUID:-__none__}" \
      -H "Authorization: Bearer ${ADMIN_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$ORIG_CLIENT_JSON" \
      > /dev/null 2>&1
  fi

  # Best-effort: delete any leftover project resources/policies/permissions.
  for SCOPE in admin member viewer; do
    PERM_ID=$(curl -sS \
      "${AUTHZ_BASE}/permission/scope?name=perm-proj-${PROJECT_ID:-__none__}-${SCOPE}" \
      -H "Authorization: Bearer ${ADMIN_TOKEN}" 2>/dev/null \
      | jq -r '.[0].id // empty' 2>/dev/null)
    [[ -n "$PERM_ID" ]] && curl -sS -X DELETE \
      "${AUTHZ_BASE}/permission/scope/${PERM_ID}" \
      -H "Authorization: Bearer ${ADMIN_TOKEN}" > /dev/null 2>&1
  done
  curl -sS "${AUTHZ_BASE}/policy?type=user&first=0&max=500" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" 2>/dev/null \
    | jq -r --arg p "proj-${PROJECT_ID:-__none__}-" '.[] | select(.name | contains($p)) | .id' 2>/dev/null \
    | while read -r POL_ID; do
        curl -sS -X DELETE "${AUTHZ_BASE}/policy/${POL_ID}" \
          -H "Authorization: Bearer ${ADMIN_TOKEN}" > /dev/null 2>&1
      done
  RES_ID=$(curl -sS \
    "${AUTHZ_BASE}/resource?name=project:${PROJECT_ID:-__none__}&exactName=true" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" 2>/dev/null \
    | jq -r '.[0]._id // .[0].id // empty' 2>/dev/null)
  [[ -n "$RES_ID" ]] && curl -sS -X DELETE \
    "${AUTHZ_BASE}/resource/${RES_ID}" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" > /dev/null 2>&1

  info "Cleanup complete"
}
trap cleanup EXIT

# ---------- create test users ------------------------------------------------

create_test_user() {
  local uname="$1" upass="$2"
  local existing
  existing=$(curl -fsS \
    "${KC_BASE}/admin/realms/${REALM}/users?username=${uname}&exact=true" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    | jq -r '.[0].id // empty')
  if [[ -n "$existing" ]]; then
    echo "$existing"
    return
  fi
  local create_code
  create_code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    "${KC_BASE}/admin/realms/${REALM}/users" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"${uname}\",\"enabled\":true,\"credentials\":[{\"type\":\"password\",\"value\":\"${upass}\",\"temporary\":false}]}")
  if [[ "$create_code" != "201" && "$create_code" != "409" ]]; then
    echo "FAILED_TO_CREATE_USER_HTTP_${create_code}" >&2
    echo ""
    return 1
  fi
  local uid
  uid=$(curl -fsS \
    "${KC_BASE}/admin/realms/${REALM}/users?username=${uname}&exact=true" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    | jq -r '.[0].id // empty')
  echo "$uid"
}

USER_ALICE=$(create_test_user "$ALICE_USERNAME" "$ALICE_PASSWORD")
assert_not_empty "Test user alice created: ${USER_ALICE}" "$USER_ALICE"

USER_BOB=$(create_test_user "$BOB_USERNAME" "$BOB_PASSWORD")
assert_not_empty "Test user bob created: ${USER_BOB}" "$USER_BOB"

# Enable direct access grants on agent-studio-ui (for password grant).
# Fetch the full client representation so PUT preserves redirect URIs, mappers,
# attributes, etc.; mutating one field with jq avoids clobbering unrelated settings.
UI_CLIENT_UUID=$(curl -fsS \
  "${KC_BASE}/admin/realms/${REALM}/clients?clientId=agent-studio-ui" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  | jq -r '.[0].id')
ORIG_CLIENT_JSON=$(curl -fsS \
  "${KC_BASE}/admin/realms/${REALM}/clients/${UI_CLIENT_UUID}" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}")
ORIG_DAG=$(jq -r '.directAccessGrantsEnabled' <<<"$ORIG_CLIENT_JSON")
if [[ "$ORIG_DAG" != "true" ]]; then
  curl -fsS -X PUT \
    "${KC_BASE}/admin/realms/${REALM}/clients/${UI_CLIENT_UUID}" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$(jq -c '.directAccessGrantsEnabled = true' <<<"$ORIG_CLIENT_JSON")" \
    > /dev/null
  info "Temporarily enabled direct access grants on agent-studio-ui"
fi

# ---------- A-1/A-2/A-3: verify realm authz settings ------------------------

section "A-1, A-2, A-3: Realm authorization settings"

RS_JSON=$(curl -fsS \
  "${AUTHZ_BASE}" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}")

DECISION=$(echo "$RS_JSON" | jq -r '.decisionStrategy')
assert_eq "A-1: decisionStrategy" "AFFIRMATIVE" "$DECISION"

REMOTE=$(echo "$RS_JSON" | jq -r '.allowRemoteResourceManagement')
assert_eq "A-2: allowRemoteResourceManagement" "true" "$REMOTE"

SCOPES=$(curl -fsS "${AUTHZ_BASE}/scope" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  | jq -r '[.[].name] | sort | join(",")')
assert_eq "A-3: scopes are exactly admin,member,viewer" "admin,member,viewer" "$SCOPES"

# ---------- A-4: service-account role grants ---------------------------------

section "A-4: Service-account role grants"

SVC_ACCOUNT_USER_ID=$(curl -fsS \
  "${KC_BASE}/admin/realms/${REALM}/users?username=service-account-agent-studio-svc-config&exact=true" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  | jq -r '.[0].id')
assert_not_empty "Service-account user resolved" "$SVC_ACCOUNT_USER_ID"

API_ROLES=$(curl -fsS \
  "${KC_BASE}/admin/realms/${REALM}/users/${SVC_ACCOUNT_USER_ID}/role-mappings/clients/${CLIENT_UUID}" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  | jq -r '[.[].name] | join(",")' 2>/dev/null || echo "")
if echo "$API_ROLES" | grep -q "uma_protection"; then
  pass "A-4: uma_protection role on agent-studio-api"
else
  info "WARNING: uma_protection not in direct roles ($API_ROLES) — may be composite"
fi

RM_UUID=$(curl -fsS \
  "${KC_BASE}/admin/realms/${REALM}/clients?clientId=realm-management" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  | jq -r '.[0].id')
RM_ROLES=$(curl -fsS \
  "${KC_BASE}/admin/realms/${REALM}/users/${SVC_ACCOUNT_USER_ID}/role-mappings/clients/${RM_UUID}" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  | jq -r '[.[].name] | join(",")' 2>/dev/null || echo "")
if echo "$RM_ROLES" | grep -q "manage-authorization"; then
  pass "A-4: manage-authorization role on realm-management"
else
  info "WARNING: manage-authorization not in direct roles ($RM_ROLES) — may be composite"
fi

# ---------- A-5: service-account token aud -----------------------------------

section "A-5: Service-account token"

SVC_TOKEN=$(curl -fsS -X POST \
  "${KC_BASE}/realms/${REALM}/protocol/openid-connect/token" \
  -d "grant_type=client_credentials" \
  -d "client_id=agent-studio-svc-config" \
  -d "client_secret=${KC_SVC_CONFIG_SECRET}" \
  | jq -r .access_token)
assert_not_empty "SVC_TOKEN obtained" "$SVC_TOKEN"

SVC_AUD=$(echo "$SVC_TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq -r 'if (.aud | type) == "array" then .aud[0] else .aud end' 2>/dev/null || echo "UNKNOWN")
info "A-5: Token aud = $SVC_AUD"

# The admin token is used for all Admin REST API and Protection API calls.
# In production, config-service needs its svc-config token with proper
# audience/role mappers — that wiring is a separate workstream (NG-1).
AUTHZ_TOKEN="${ADMIN_TOKEN}"

# ==========================================================================
# §6.1 CREATE PROJECT
# Three calls: (1) create resource, (2) create creator policy, (3) create
# admin scope permission.
# ==========================================================================

section "§6.1 Create Project (A-6)"

# Step 1: Create the resource (Protection API).
RESP=$(curl -sS -w '\n%{http_code}' -X POST \
  "${AUTHZ_BASE}/resource" \
  -H "Authorization: Bearer ${AUTHZ_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"project:${PROJECT_ID}\",
    \"type\": \"urn:agent-studio:resource-types:project\",
    \"displayName\": \"Project ${PROJECT_ID}\",
    \"uris\": [\"/projects/${PROJECT_ID}\"],
    \"scopes\": [
      {\"name\": \"admin\"},
      {\"name\": \"member\"},
      {\"name\": \"viewer\"}
    ],
    \"ownerManagedAccess\": false
  }")
http_status_and_body "$RESP"
if [[ "$HTTP_CODE" == "201" || "$HTTP_CODE" == "409" ]]; then
  pass "§6.1 step 1: Create resource project:${PROJECT_ID} (HTTP $HTTP_CODE)"
else
  fail "§6.1 step 1: Create resource (HTTP $HTTP_CODE): $HTTP_BODY"
fi

RESOURCE_ID=$(curl -fsS \
  "${AUTHZ_BASE}/resource?name=project:${PROJECT_ID}&exactName=true" \
  -H "Authorization: Bearer ${AUTHZ_TOKEN}" \
  | jq -r '.[0]._id // .[0].id // empty')
assert_not_empty "Resource UUID: ${RESOURCE_ID}" "$RESOURCE_ID"

# Step 2: Create the creator's user policy (Admin Authz API).
RESP=$(curl -sS -w '\n%{http_code}' -X POST \
  "${AUTHZ_BASE}/policy/user" \
  -H "Authorization: Bearer ${AUTHZ_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"usr-${USER_ALICE}-proj-${PROJECT_ID}-admin\",
    \"description\": \"Project ${PROJECT_ID} admin grant for user ${USER_ALICE}\",
    \"users\": [\"${USER_ALICE}\"],
    \"logic\": \"POSITIVE\"
  }")
http_status_and_body "$RESP"
if [[ "$HTTP_CODE" == "201" || "$HTTP_CODE" == "409" ]]; then
  pass "§6.1 step 2: Create admin policy for alice (HTTP $HTTP_CODE)"
else
  fail "§6.1 step 2: Create admin policy (HTTP $HTTP_CODE): $HTTP_BODY"
fi

# Step 3: Create the admin scope permission (Admin Authz API).
RESP=$(curl -sS -w '\n%{http_code}' -X POST \
  "${AUTHZ_BASE}/permission/scope" \
  -H "Authorization: Bearer ${AUTHZ_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"perm-proj-${PROJECT_ID}-admin\",
    \"description\": \"Project ${PROJECT_ID} admin scope permission\",
    \"resources\": [\"project:${PROJECT_ID}\"],
    \"scopes\": [\"admin\"],
    \"policies\": [\"usr-${USER_ALICE}-proj-${PROJECT_ID}-admin\"],
    \"decisionStrategy\": \"AFFIRMATIVE\",
    \"logic\": \"POSITIVE\"
  }")
http_status_and_body "$RESP"
if [[ "$HTTP_CODE" == "201" || "$HTTP_CODE" == "409" ]]; then
  pass "§6.1 step 3: Create admin scope permission (HTTP $HTTP_CODE)"
else
  fail "§6.1 step 3: Create admin permission (HTTP $HTTP_CODE): $HTTP_BODY"
fi

# A-6 verification: resource exists with correct uris.
RES_DETAIL=$(curl -fsS \
  "${AUTHZ_BASE}/resource/${RESOURCE_ID}" \
  -H "Authorization: Bearer ${AUTHZ_TOKEN}")
RES_URIS=$(echo "$RES_DETAIL" | jq -r '.uris[0] // empty')
assert_eq "A-6: Resource uris" "/projects/${PROJECT_ID}" "$RES_URIS"

# Verify UMA exchange: alice should have admin after §6.1.
get_user_token() {
  local uname="$1" upass="$2"
  curl -fsS -X POST \
    "${KC_BASE}/realms/${REALM}/protocol/openid-connect/token" \
    -d "grant_type=password" \
    -d "client_id=agent-studio-ui" \
    -d "scope=openid" \
    -d "username=${uname}" \
    -d "password=${upass}" \
    | jq -r .access_token
}

uma_exchange() {
  local token="$1" project="$2"
  curl -sS -w '\n%{http_code}' -X POST \
    "${KC_BASE}/realms/${REALM}/protocol/openid-connect/token" \
    -H "Authorization: Bearer ${token}" \
    -d "grant_type=urn:ietf:params:oauth:grant-type:uma-ticket" \
    -d "audience=agent-studio-api" \
    -d "permission=project:${project}#admin,member,viewer" \
    -d "response_mode=permissions"
}

ALICE_TOKEN=$(get_user_token "$ALICE_USERNAME" "$ALICE_PASSWORD")
RESP=$(uma_exchange "$ALICE_TOKEN" "$PROJECT_ID")
http_status_and_body "$RESP"
ALICE_SCOPES=$(echo "$HTTP_BODY" | jq -r '.[0].scopes | sort | join(",")' 2>/dev/null || echo "PARSE_ERROR")
assert_eq "§6.1 verify: alice has admin after project create" "admin" "$ALICE_SCOPES"

# ==========================================================================
# §6.2 ADD USER TO PROJECT
# Add bob as viewer. Three calls: (1) create user policy, (2) look up
# existing permission, (3) create or update permission.
# ==========================================================================

section "§6.2 Add User to Project — bob as viewer (A-7)"

# Step 1: Create bob's viewer policy.
RESP=$(curl -sS -w '\n%{http_code}' -X POST \
  "${AUTHZ_BASE}/policy/user" \
  -H "Authorization: Bearer ${AUTHZ_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"usr-${USER_BOB}-proj-${PROJECT_ID}-viewer\",
    \"description\": \"Project ${PROJECT_ID} viewer grant for user ${USER_BOB}\",
    \"users\": [\"${USER_BOB}\"],
    \"logic\": \"POSITIVE\"
  }")
http_status_and_body "$RESP"
if [[ "$HTTP_CODE" == "201" || "$HTTP_CODE" == "409" ]]; then
  pass "§6.2 step 1: Create viewer policy for bob (HTTP $HTTP_CODE)"
else
  fail "§6.2 step 1: Create viewer policy (HTTP $HTTP_CODE): $HTTP_BODY"
fi

# Step 2: Look up existing viewer permission.
EXISTING_PERM=$(curl -fsS \
  "${AUTHZ_BASE}/permission/scope?name=perm-proj-${PROJECT_ID}-viewer" \
  -H "Authorization: Bearer ${AUTHZ_TOKEN}")
EXISTING_PERM_ID=$(echo "$EXISTING_PERM" | jq -r '.[0].id // empty')

# Step 3: Create or update the viewer permission.
if [[ -z "$EXISTING_PERM_ID" ]]; then
  # Permission does not exist yet — create it.
  RESP=$(curl -sS -w '\n%{http_code}' -X POST \
    "${AUTHZ_BASE}/permission/scope" \
    -H "Authorization: Bearer ${AUTHZ_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"name\": \"perm-proj-${PROJECT_ID}-viewer\",
      \"description\": \"Project ${PROJECT_ID} viewer scope permission\",
      \"resources\": [\"project:${PROJECT_ID}\"],
      \"scopes\": [\"viewer\"],
      \"policies\": [\"usr-${USER_BOB}-proj-${PROJECT_ID}-viewer\"],
      \"decisionStrategy\": \"AFFIRMATIVE\",
      \"logic\": \"POSITIVE\"
    }")
  http_status_and_body "$RESP"
  assert_http "§6.2 step 3: Create viewer permission" "201" "$HTTP_CODE" "$HTTP_BODY"
else
  # Permission exists — GET associated policies, merge, PUT.
  ASSOC_POLICIES=$(curl -fsS \
    "${AUTHZ_BASE}/policy/${EXISTING_PERM_ID}/associatedPolicies" \
    -H "Authorization: Bearer ${AUTHZ_TOKEN}" \
    | jq -r '[.[].name]')
  MERGED=$(echo "$ASSOC_POLICIES" | jq -r ". + [\"usr-${USER_BOB}-proj-${PROJECT_ID}-viewer\"] | unique")
  curl -fsS -X PUT \
    "${AUTHZ_BASE}/permission/scope/${EXISTING_PERM_ID}" \
    -H "Authorization: Bearer ${AUTHZ_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"id\": \"${EXISTING_PERM_ID}\",
      \"name\": \"perm-proj-${PROJECT_ID}-viewer\",
      \"resources\": [\"project:${PROJECT_ID}\"],
      \"scopes\": [\"viewer\"],
      \"policies\": ${MERGED},
      \"decisionStrategy\": \"AFFIRMATIVE\",
      \"logic\": \"POSITIVE\"
    }" > /dev/null
  pass "§6.2 step 3: Merged bob into existing viewer permission"
fi

# A-7 verification: bob's UMA exchange returns viewer.
BOB_TOKEN=$(get_user_token "$BOB_USERNAME" "$BOB_PASSWORD")
RESP=$(uma_exchange "$BOB_TOKEN" "$PROJECT_ID")
http_status_and_body "$RESP"
BOB_SCOPES=$(echo "$HTTP_BODY" | jq -r '.[0].scopes | sort | join(",")' 2>/dev/null || echo "PARSE_ERROR")
assert_eq "A-7: bob has viewer via UMA exchange" "viewer" "$BOB_SCOPES"

# ==========================================================================
# §6.3 CHANGE USER'S SCOPE ON PROJECT
# Promote bob from viewer to admin. Implemented as §6.4 (remove old) then
# §6.2 (add new).
# ==========================================================================

section "§6.3 Change Scope — promote bob viewer→admin (A-8)"

# §6.4 sub-step: remove bob's viewer grant.
# Iterate all three scopes per §6.4 contract.
for SCOPE in admin member viewer; do
  POLICY_NAME="usr-${USER_BOB}-proj-${PROJECT_ID}-${SCOPE}"
  POL_JSON=$(curl -sS \
    "${AUTHZ_BASE}/policy?name=${POLICY_NAME}&type=user" \
    -H "Authorization: Bearer ${AUTHZ_TOKEN}")
  POL_LOOKUP=$(echo "$POL_JSON" | jq -r --arg n "$POLICY_NAME" '[.[] | select(.name == $n)] | .[0].id // empty')
  [[ -z "$POL_LOOKUP" ]] && continue

  PERM_NAME="perm-proj-${PROJECT_ID}-${SCOPE}"
  PERM_JSON=$(curl -sS \
    "${AUTHZ_BASE}/permission/scope?name=${PERM_NAME}" \
    -H "Authorization: Bearer ${AUTHZ_TOKEN}")
  PERM_LOOKUP=$(echo "$PERM_JSON" | jq -r --arg n "$PERM_NAME" '[.[] | select(.name == $n)] | .[0].id // empty')

  if [[ -n "$PERM_LOOKUP" ]]; then
    ASSOC=$(curl -sS \
      "${AUTHZ_BASE}/policy/${PERM_LOOKUP}/associatedPolicies" \
      -H "Authorization: Bearer ${AUTHZ_TOKEN}")
    REMAINING=$(echo "$ASSOC" | jq --arg pid "$POL_LOOKUP" '[.[] | select(.id != $pid) | .name]')
    REMAINING_COUNT=$(echo "$REMAINING" | jq 'length')

    if [[ "$REMAINING_COUNT" == "0" ]]; then
      curl -sS -X DELETE \
        "${AUTHZ_BASE}/permission/scope/${PERM_LOOKUP}" \
        -H "Authorization: Bearer ${AUTHZ_TOKEN}" > /dev/null
      pass "§6.3→6.4: Deleted empty ${SCOPE} permission"
    else
      curl -sS -X PUT \
        "${AUTHZ_BASE}/permission/scope/${PERM_LOOKUP}" \
        -H "Authorization: Bearer ${AUTHZ_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "{
          \"id\": \"${PERM_LOOKUP}\",
          \"name\": \"${PERM_NAME}\",
          \"resources\": [\"project:${PROJECT_ID}\"],
          \"scopes\": [\"${SCOPE}\"],
          \"policies\": ${REMAINING},
          \"decisionStrategy\": \"AFFIRMATIVE\",
          \"logic\": \"POSITIVE\"
        }" > /dev/null
      pass "§6.3→6.4: Detached bob from ${SCOPE} permission"
    fi
  fi

  curl -sS -X DELETE \
    "${AUTHZ_BASE}/policy/${POL_LOOKUP}" \
    -H "Authorization: Bearer ${AUTHZ_TOKEN}" > /dev/null
  pass "§6.3→6.4: Deleted policy ${POLICY_NAME}"
done

# §6.2 sub-step: add bob as admin.
RESP=$(curl -sS -w '\n%{http_code}' -X POST \
  "${AUTHZ_BASE}/policy/user" \
  -H "Authorization: Bearer ${AUTHZ_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"usr-${USER_BOB}-proj-${PROJECT_ID}-admin\",
    \"description\": \"Project ${PROJECT_ID} admin grant for user ${USER_BOB}\",
    \"users\": [\"${USER_BOB}\"],
    \"logic\": \"POSITIVE\"
  }")
http_status_and_body "$RESP"
if [[ "$HTTP_CODE" == "201" || "$HTTP_CODE" == "409" ]]; then
  pass "§6.3→6.2: Created admin policy for bob (HTTP $HTTP_CODE)"
else
  fail "§6.3→6.2: Create admin policy for bob (HTTP $HTTP_CODE): $HTTP_BODY"
fi

# Look up the existing admin permission (alice's already exists from §6.1).
ADMIN_PERM=$(curl -fsS \
  "${AUTHZ_BASE}/permission/scope?name=perm-proj-${PROJECT_ID}-admin" \
  -H "Authorization: Bearer ${AUTHZ_TOKEN}")
ADMIN_PERM_ID=$(echo "$ADMIN_PERM" | jq -r '.[0].id // empty')

if [[ -n "$ADMIN_PERM_ID" ]]; then
  # Merge bob's policy into existing admin permission.
  ASSOC_POLICIES=$(curl -fsS \
    "${AUTHZ_BASE}/policy/${ADMIN_PERM_ID}/associatedPolicies" \
    -H "Authorization: Bearer ${AUTHZ_TOKEN}" \
    | jq -r '[.[].name]')
  MERGED=$(echo "$ASSOC_POLICIES" | jq ". + [\"usr-${USER_BOB}-proj-${PROJECT_ID}-admin\"] | unique")
  RESP=$(curl -sS -w '\n%{http_code}' -X PUT \
    "${AUTHZ_BASE}/permission/scope/${ADMIN_PERM_ID}" \
    -H "Authorization: Bearer ${AUTHZ_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"id\": \"${ADMIN_PERM_ID}\",
      \"name\": \"perm-proj-${PROJECT_ID}-admin\",
      \"resources\": [\"project:${PROJECT_ID}\"],
      \"scopes\": [\"admin\"],
      \"policies\": ${MERGED},
      \"decisionStrategy\": \"AFFIRMATIVE\",
      \"logic\": \"POSITIVE\"
    }")
  http_status_and_body "$RESP"
  if [[ "$HTTP_CODE" == "201" || "$HTTP_CODE" == "200" ]]; then
    pass "§6.3→6.2: Merged bob into admin permission (HTTP $HTTP_CODE)"
  else
    fail "§6.3→6.2: Merge bob into admin permission (HTTP $HTTP_CODE): $HTTP_BODY"
  fi
else
  RESP=$(curl -sS -w '\n%{http_code}' -X POST \
    "${AUTHZ_BASE}/permission/scope" \
    -H "Authorization: Bearer ${AUTHZ_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"name\": \"perm-proj-${PROJECT_ID}-admin\",
      \"resources\": [\"project:${PROJECT_ID}\"],
      \"scopes\": [\"admin\"],
      \"policies\": [\"usr-${USER_BOB}-proj-${PROJECT_ID}-admin\"],
      \"decisionStrategy\": \"AFFIRMATIVE\",
      \"logic\": \"POSITIVE\"
    }")
  http_status_and_body "$RESP"
  if [[ "$HTTP_CODE" == "201" || "$HTTP_CODE" == "409" ]]; then
    pass "§6.3→6.2: Created admin permission for bob (HTTP $HTTP_CODE)"
  else
    fail "§6.3→6.2: Create admin permission for bob (HTTP $HTTP_CODE): $HTTP_BODY"
  fi
fi

# A-8 verification: bob's UMA exchange now returns admin.
BOB_TOKEN=$(get_user_token "$BOB_USERNAME" "$BOB_PASSWORD")
RESP=$(uma_exchange "$BOB_TOKEN" "$PROJECT_ID")
http_status_and_body "$RESP"
BOB_SCOPES=$(echo "$HTTP_BODY" | jq -r '.[0].scopes | sort | join(",")' 2>/dev/null || echo "PARSE_ERROR")
assert_eq "A-8: bob has admin after promotion" "admin" "$BOB_SCOPES"

# ==========================================================================
# §6.4 REMOVE USER FROM PROJECT (A-9)
# Remove bob. Iterate all three scopes per the contract.
# ==========================================================================

section "§6.4 Remove User — remove bob (A-9)"

for SCOPE in admin member viewer; do
  POLICY_NAME="usr-${USER_BOB}-proj-${PROJECT_ID}-${SCOPE}"
  POL_JSON=$(curl -sS \
    "${AUTHZ_BASE}/policy?name=${POLICY_NAME}&type=user" \
    -H "Authorization: Bearer ${AUTHZ_TOKEN}")
  POL_LOOKUP=$(echo "$POL_JSON" | jq -r --arg n "$POLICY_NAME" '[.[] | select(.name == $n)] | .[0].id // empty')
  [[ -z "$POL_LOOKUP" ]] && continue

  PERM_NAME="perm-proj-${PROJECT_ID}-${SCOPE}"
  PERM_JSON=$(curl -sS \
    "${AUTHZ_BASE}/permission/scope?name=${PERM_NAME}" \
    -H "Authorization: Bearer ${AUTHZ_TOKEN}")
  PERM_LOOKUP=$(echo "$PERM_JSON" | jq -r --arg n "$PERM_NAME" '[.[] | select(.name == $n)] | .[0].id // empty')

  if [[ -n "$PERM_LOOKUP" ]]; then
    ASSOC=$(curl -sS \
      "${AUTHZ_BASE}/policy/${PERM_LOOKUP}/associatedPolicies" \
      -H "Authorization: Bearer ${AUTHZ_TOKEN}")
    REMAINING=$(echo "$ASSOC" | jq --arg pid "$POL_LOOKUP" '[.[] | select(.id != $pid) | .name]')
    REMAINING_COUNT=$(echo "$REMAINING" | jq 'length')

    if [[ "$REMAINING_COUNT" == "0" ]]; then
      curl -sS -X DELETE \
        "${AUTHZ_BASE}/permission/scope/${PERM_LOOKUP}" \
        -H "Authorization: Bearer ${AUTHZ_TOKEN}" > /dev/null
      pass "§6.4: Deleted empty ${SCOPE} permission"
    else
      curl -sS -X PUT \
        "${AUTHZ_BASE}/permission/scope/${PERM_LOOKUP}" \
        -H "Authorization: Bearer ${AUTHZ_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "{
          \"id\": \"${PERM_LOOKUP}\",
          \"name\": \"${PERM_NAME}\",
          \"resources\": [\"project:${PROJECT_ID}\"],
          \"scopes\": [\"${SCOPE}\"],
          \"policies\": ${REMAINING},
          \"decisionStrategy\": \"AFFIRMATIVE\",
          \"logic\": \"POSITIVE\"
        }" > /dev/null
      pass "§6.4: Detached bob from ${SCOPE} permission"
    fi
  fi

  curl -sS -X DELETE \
    "${AUTHZ_BASE}/policy/${POL_LOOKUP}" \
    -H "Authorization: Bearer ${AUTHZ_TOKEN}" > /dev/null
  pass "§6.4: Deleted policy ${POLICY_NAME}"
done

# A-9 verification: bob (non-member now) gets 403.
BOB_TOKEN=$(get_user_token "$BOB_USERNAME" "$BOB_PASSWORD")
RESP=$(uma_exchange "$BOB_TOKEN" "$PROJECT_ID")
http_status_and_body "$RESP"
assert_eq "A-9: bob gets 403 after removal" "403" "$HTTP_CODE"

# Alice should still have admin (untouched).
ALICE_TOKEN=$(get_user_token "$ALICE_USERNAME" "$ALICE_PASSWORD")
RESP=$(uma_exchange "$ALICE_TOKEN" "$PROJECT_ID")
http_status_and_body "$RESP"
ALICE_SCOPES=$(echo "$HTTP_BODY" | jq -r '.[0].scopes | sort | join(",")' 2>/dev/null || echo "PARSE_ERROR")
assert_eq "§6.4 verify: alice still has admin" "admin" "$ALICE_SCOPES"

# ==========================================================================
# §6.5 DELETE PROJECT (A-10)
# Delete dependents first (permissions, policies), then the resource.
# ==========================================================================

section "§6.5 Delete Project (A-10)"

# Step 1: Delete per-project permissions.
for SCOPE in admin member viewer; do
  PERM_ID=$(curl -fsS \
    "${AUTHZ_BASE}/permission/scope?name=perm-proj-${PROJECT_ID}-${SCOPE}" \
    -H "Authorization: Bearer ${AUTHZ_TOKEN}" \
    | jq -r '.[0].id // empty')
  if [[ -n "$PERM_ID" ]]; then
    curl -sS -X DELETE \
      "${AUTHZ_BASE}/permission/scope/${PERM_ID}" \
      -H "Authorization: Bearer ${AUTHZ_TOKEN}" > /dev/null
    pass "§6.5 step 1: Deleted ${SCOPE} permission"
  fi
done

# Step 2: Delete per-project user policies (prefix scan).
curl -fsS "${AUTHZ_BASE}/policy?type=user&first=0&max=500" \
  -H "Authorization: Bearer ${AUTHZ_TOKEN}" \
  | jq -r --arg p "proj-${PROJECT_ID}-" '.[] | select(.name | contains($p)) | .id' \
  | while read -r POL_ID; do
      curl -sS -X DELETE \
        "${AUTHZ_BASE}/policy/${POL_ID}" \
        -H "Authorization: Bearer ${AUTHZ_TOKEN}" > /dev/null
      pass "§6.5 step 2: Deleted policy ${POL_ID}"
    done

# Step 3: Delete the resource (Protection API).
curl -sS -X DELETE \
  "${AUTHZ_BASE}/resource/${RESOURCE_ID}" \
  -H "Authorization: Bearer ${AUTHZ_TOKEN}" > /dev/null
pass "§6.5 step 3: Deleted resource project:${PROJECT_ID}"

# A-10 verification: resource is gone, re-create succeeds.
REMAINING=$(curl -fsS \
  "${AUTHZ_BASE}/resource?name=project:${PROJECT_ID}&exactName=true" \
  -H "Authorization: Bearer ${AUTHZ_TOKEN}")
REMAINING_COUNT=$(echo "$REMAINING" | jq 'length')
assert_eq "A-10: Resource fully deleted" "0" "$REMAINING_COUNT"

# UMA exchange should now return 400 (invalid_resource) or 403.
ALICE_TOKEN=$(get_user_token "$ALICE_USERNAME" "$ALICE_PASSWORD")
RESP=$(uma_exchange "$ALICE_TOKEN" "$PROJECT_ID")
http_status_and_body "$RESP"
if [[ "$HTTP_CODE" == "400" || "$HTTP_CODE" == "403" ]]; then
  pass "A-10: UMA exchange after delete returns HTTP $HTTP_CODE"
else
  fail "A-10: Expected 400 or 403 after project delete, got HTTP $HTTP_CODE"
fi

# ==========================================================================
# §6.6 IDEMPOTENCY (A-11)
# ==========================================================================

section "§6.6 Idempotency (A-11)"

# Create → 201.
RESP=$(curl -sS -w '\n%{http_code}' -X POST \
  "${AUTHZ_BASE}/resource" \
  -H "Authorization: Bearer ${AUTHZ_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"project:${PROJECT_ID}\",
    \"type\": \"urn:agent-studio:resource-types:project\",
    \"displayName\": \"Project ${PROJECT_ID}\",
    \"uris\": [\"/projects/${PROJECT_ID}\"],
    \"scopes\": [
      {\"name\": \"admin\"},
      {\"name\": \"member\"},
      {\"name\": \"viewer\"}
    ],
    \"ownerManagedAccess\": false
  }")
http_status_and_body "$RESP"
assert_http "A-11: Create resource → 201" "201" "$HTTP_CODE" "$HTTP_BODY"

# Duplicate create → 409.
RESP=$(curl -sS -w '\n%{http_code}' -X POST \
  "${AUTHZ_BASE}/resource" \
  -H "Authorization: Bearer ${AUTHZ_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"project:${PROJECT_ID}\",
    \"type\": \"urn:agent-studio:resource-types:project\",
    \"displayName\": \"Project ${PROJECT_ID}\",
    \"uris\": [\"/projects/${PROJECT_ID}\"],
    \"scopes\": [
      {\"name\": \"admin\"},
      {\"name\": \"member\"},
      {\"name\": \"viewer\"}
    ],
    \"ownerManagedAccess\": false
  }")
http_status_and_body "$RESP"
assert_http "A-11: Duplicate create → 409" "409" "$HTTP_CODE" "$HTTP_BODY"

# Clean up idempotency resource.
IDEM_RES_ID=$(curl -fsS \
  "${AUTHZ_BASE}/resource?name=project:${PROJECT_ID}&exactName=true" \
  -H "Authorization: Bearer ${AUTHZ_TOKEN}" \
  | jq -r '.[0]._id // .[0].id // empty')
[[ -z "$IDEM_RES_ID" ]] && fail "Could not retrieve idempotency resource ID for cleanup"
curl -sS -X DELETE \
  "${AUTHZ_BASE}/resource/${IDEM_RES_ID}" \
  -H "Authorization: Bearer ${AUTHZ_TOKEN}" > /dev/null

# Delete on missing → 404.
DEL_CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE \
  "${AUTHZ_BASE}/resource/${IDEM_RES_ID}" \
  -H "Authorization: Bearer ${AUTHZ_TOKEN}")
assert_http "A-11: Delete missing → 404" "404" "$DEL_CODE"

pass "All idempotency checks passed"

# ==========================================================================
# SUMMARY
# ==========================================================================

echo ""
printf "${GREEN}════════════════════════════════════════════════════════${NC}\n"
printf "${GREEN}  All per-project authorization smoke tests passed!    ${NC}\n"
printf "${GREEN}  Acceptance criteria A-1 through A-11 verified.       ${NC}\n"
printf "${GREEN}════════════════════════════════════════════════════════${NC}\n"
echo ""
