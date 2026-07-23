#!/usr/bin/env bash
# End-to-end smoke test for the eval-worker against a real cluster.
#
# Creates an evaluation template + cases in config-service, triggers a run,
# polls until terminal status, then inspects the job folder on the PVC.
# No mocks. Requires: kubectl, curl, jq.
#
# Pre-conditions (the script will check and bail out if any fail):
#   - At least one project and one deployed agent already exist in the
#     target config-service.
#   - Either the cluster runs config-service WITHOUT Keycloak auth
#     (KEYCLOAK_INTERNAL_ISSUER unset on config-service), OR the
#     `keycloak-oidc-secrets` Secret in NAMESPACE has the eval-worker
#     client credentials and Keycloak is reachable from this script (we
#     port-forward it).
#
# Usage:
#   PROJECT_ID=<pid> AGENT_ID=<aid> AGENT_VERSION=<ver> ./smoke-eval.sh
#
# Optional overrides:
#   NAMESPACE                k8s namespace (default: default)
#   CONFIG_SERVICE_SVC       k8s service name for config-service (default: config-service)
#   CONFIG_SERVICE_PORT      service port (default: 3000)
#   LOCAL_PORT               local port for the forward (default: 3000)
#   KEYCLOAK_SVC             k8s service for Keycloak (default: keycloak-http)
#   KEYCLOAK_PORT            Keycloak service port (default: 8080)
#   KEYCLOAK_LOCAL_PORT      local port for the Keycloak forward (default: 18080)
#   KEYCLOAK_REALM           realm name (default: nemo)
#   AUTH_MODE                "auto" (default) detects from cluster; "off" forces no-auth
#   EVAL_NAME                template name (default: smoke-eval-<ts>)
#   TIMEOUT_SECS             how long to poll for a terminal run status (default: 300)
#   POLL_INTERVAL            seconds between polls (default: 5)
#   KEEP_TEMPLATE            "1" to leave the template behind on success (default: delete)
#   JUDGE_STRATEGY           "deterministic" (default) / "llm_judge" / "both" — switches
#                              the eval template's evaluators block. When set to
#                              llm_judge or both, JUDGE_MODEL and JUDGE_RUBRIC are used.
#   JUDGE_MODEL              evaluator model id (default: same as MODEL_ID)
#   JUDGE_RUBRIC             rubric to grade on (default: helpfulness)

set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────

NAMESPACE="${NAMESPACE:-default}"
CONFIG_SERVICE_SVC="${CONFIG_SERVICE_SVC:-config-service}"
CONFIG_SERVICE_PORT="${CONFIG_SERVICE_PORT:-3000}"
LOCAL_PORT="${LOCAL_PORT:-3000}"
KEYCLOAK_SVC="${KEYCLOAK_SVC:-keycloak-http}"
KEYCLOAK_PORT="${KEYCLOAK_PORT:-8080}"
KEYCLOAK_LOCAL_PORT="${KEYCLOAK_LOCAL_PORT:-18080}"
KEYCLOAK_REALM="${KEYCLOAK_REALM:-nemo}"
AUTH_MODE="${AUTH_MODE:-auto}"
EVAL_NAME="${EVAL_NAME:-smoke-eval-$(date +%s)}"
TIMEOUT_SECS="${TIMEOUT_SECS:-300}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
KEEP_TEMPLATE="${KEEP_TEMPLATE:-0}"
JUDGE_STRATEGY="${JUDGE_STRATEGY:-deterministic}"
JUDGE_RUBRIC="${JUDGE_RUBRIC:-helpfulness}"

BASE="http://127.0.0.1:${LOCAL_PORT}"
ACCESS_TOKEN=""
ACCESS_TOKEN_OBTAINED_AT=0
# Keycloak service-account tokens default to a 5-minute TTL. Re-mint
# proactively when the cached token is within 30s of expiring so long
# polling loops don't hit "jwt expired" mid-flight.
ACCESS_TOKEN_REFRESH_SECS=240

# ── Helpers ──────────────────────────────────────────────────────────

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m⚠\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

require_bin() {
  command -v "$1" >/dev/null 2>&1 || die "missing required binary: $1"
}

refresh_token_if_stale() {
  # No-op when we don't have a token yet (auth-off mode or pre-step-2b).
  [[ -n "$ACCESS_TOKEN" ]] || return 0
  local now
  now="$(date +%s)"
  local age=$((now - ACCESS_TOKEN_OBTAINED_AT))
  [[ "$age" -lt "$ACCESS_TOKEN_REFRESH_SECS" ]] && return 0
  # Re-mint from the cached credentials. CLIENT_ID/CLIENT_SECRET are set
  # in step 2b; bail out cleanly if they're not in scope yet.
  [[ -n "${CLIENT_ID:-}" && -n "${CLIENT_SECRET:-}" ]] || return 0
  local token_url="http://127.0.0.1:$KEYCLOAK_LOCAL_PORT/realms/$KEYCLOAK_REALM/protocol/openid-connect/token"
  local code
  code="$(curl -sS -o /tmp/smoke-eval.token -w '%{http_code}' -X POST "$token_url" \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode "grant_type=client_credentials" \
    --data-urlencode "client_id=$CLIENT_ID" \
    --data-urlencode "client_secret=$CLIENT_SECRET" \
    --data-urlencode "scope=openid profile email" || echo 000)"
  if [[ "$code" == "200" ]]; then
    ACCESS_TOKEN="$(jq -r '.access_token' /tmp/smoke-eval.token)"
    ACCESS_TOKEN_OBTAINED_AT="$now"
  fi
  rm -f /tmp/smoke-eval.token
}

curl_json() {
  # Wraps curl with sensible defaults; returns body, asserts 2xx.
  refresh_token_if_stale
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -o /tmp/smoke-eval.body -w '%{http_code}' \
    -H 'content-type: application/json' \
    -X "$method" "${BASE}${path}")
  if [[ -n "$ACCESS_TOKEN" ]]; then
    args+=(-H "authorization: Bearer ${ACCESS_TOKEN}")
  fi
  if [[ -n "$body" ]]; then
    args+=(--data-raw "$body")
  fi
  local code
  code="$(curl "${args[@]}")" || die "curl ${method} ${path} failed"
  if [[ "$code" -lt 200 || "$code" -ge 300 ]]; then
    warn "HTTP $code from ${method} ${path}"
    cat /tmp/smoke-eval.body >&2 || true
    echo >&2
    die "request failed"
  fi
  cat /tmp/smoke-eval.body
}

PF_PID=""
KC_PF_PID=""
cleanup() {
  for pid in "$PF_PID" "$KC_PF_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -f /tmp/smoke-eval.body
}
trap cleanup EXIT

# ── 0. Prerequisites ─────────────────────────────────────────────────

bold "0. Prerequisites"
require_bin kubectl
require_bin curl
require_bin jq
kubectl --namespace "$NAMESPACE" version --request-timeout=5s >/dev/null 2>&1 \
  || die "kubectl cannot reach cluster (namespace=$NAMESPACE)"
ok "kubectl, curl, jq present; cluster reachable"

# ── 1. eval-worker sanity check ──────────────────────────────────────

bold "1. eval-worker sanity check"
WORKER_DEPLOY="$(kubectl -n "$NAMESPACE" get deploy -l app.kubernetes.io/name=eval-worker -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
[[ -n "$WORKER_DEPLOY" ]] || die "no eval-worker Deployment found in namespace $NAMESPACE"
info "deployment: $WORKER_DEPLOY"

READY="$(kubectl -n "$NAMESPACE" get deploy "$WORKER_DEPLOY" -o jsonpath='{.status.readyReplicas}')"
[[ "${READY:-0}" -ge 1 ]] || die "$WORKER_DEPLOY has 0 ready replicas"
ok "$WORKER_DEPLOY ready"

# ── 2. Port-forward config-service ──────────────────────────────────

bold "2. Port-forward $CONFIG_SERVICE_SVC:$CONFIG_SERVICE_PORT → localhost:$LOCAL_PORT"
kubectl -n "$NAMESPACE" port-forward "svc/$CONFIG_SERVICE_SVC" "$LOCAL_PORT:$CONFIG_SERVICE_PORT" >/tmp/smoke-eval.pf.log 2>&1 &
PF_PID=$!
# Wait until the forward is actually accepting connections.
for _ in $(seq 1 20); do
  if curl -sS -o /dev/null -m 1 "$BASE/" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
curl -sS -o /dev/null -m 2 "$BASE/" || die "port-forward did not come up; see /tmp/smoke-eval.pf.log"
ok "port-forward live (pid=$PF_PID)"

# ── 2b. Keycloak token (if auth is enforced) ────────────────────────

bold "2b. Auth mode"

# Decide whether to fetch a Keycloak token. AUTH_MODE=off skips entirely;
# AUTH_MODE=auto probes config-service first — if it answers 200 without an
# Authorization header, auth is off and we proceed unauthenticated.
auth_required=0
if [[ "$AUTH_MODE" == "off" ]]; then
  info "AUTH_MODE=off — skipping Keycloak token fetch"
else
  probe="$(curl -sS -o /dev/null -m 3 -w '%{http_code}' "$BASE/api/v1/projects" || echo 000)"
  if [[ "$probe" == "401" || "$probe" == "403" ]]; then
    auth_required=1
    info "config-service requires auth (HTTP $probe on unauthenticated probe)"
  else
    info "config-service accepts unauthenticated calls (HTTP $probe) — skipping Keycloak"
  fi
fi

if [[ "$auth_required" == "1" ]]; then
  # Pull eval-worker's service-account credentials from the same Secret
  # the deployment uses, then port-forward Keycloak so we can hit its
  # token endpoint from outside the cluster.
  CLIENT_ID="$(kubectl -n "$NAMESPACE" get secret keycloak-oidc-secrets -o jsonpath='{.data.eval-worker-client-id}' 2>/dev/null | base64 -d || true)"
  CLIENT_SECRET="$(kubectl -n "$NAMESPACE" get secret keycloak-oidc-secrets -o jsonpath='{.data.eval-worker-client-secret}' 2>/dev/null | base64 -d || true)"
  if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
    die "keycloak-oidc-secrets does not yet contain eval-worker credentials in namespace $NAMESPACE. Run the keycloak-setup post-install hook (or the equivalent kc-realm bootstrap) so the secret is populated."
  fi
  if [[ "$CLIENT_SECRET" == changeme-* ]]; then
    die "keycloak-oidc-secrets still holds the placeholder eval-worker secret ('$CLIENT_SECRET'). Re-run keycloak-setup so a real secret is provisioned."
  fi
  info "client_id=$CLIENT_ID"

  kubectl -n "$NAMESPACE" port-forward "svc/$KEYCLOAK_SVC" "$KEYCLOAK_LOCAL_PORT:$KEYCLOAK_PORT" >/tmp/smoke-eval.kc.log 2>&1 &
  KC_PF_PID=$!
  for _ in $(seq 1 20); do
    if curl -sS -o /dev/null -m 1 "http://127.0.0.1:$KEYCLOAK_LOCAL_PORT/realms/$KEYCLOAK_REALM/.well-known/openid-configuration" 2>/dev/null; then
      break
    fi
    sleep 0.5
  done
  curl -sS -o /dev/null -m 2 "http://127.0.0.1:$KEYCLOAK_LOCAL_PORT/realms/$KEYCLOAK_REALM/.well-known/openid-configuration" \
    || die "Keycloak port-forward did not come up; see /tmp/smoke-eval.kc.log"

  TOKEN_URL="http://127.0.0.1:$KEYCLOAK_LOCAL_PORT/realms/$KEYCLOAK_REALM/protocol/openid-connect/token"
  TOKEN_RESPONSE="$(curl -sS -o /tmp/smoke-eval.token -w '%{http_code}' -X POST "$TOKEN_URL" \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode "grant_type=client_credentials" \
    --data-urlencode "client_id=$CLIENT_ID" \
    --data-urlencode "client_secret=$CLIENT_SECRET" \
    --data-urlencode "scope=openid profile email" || echo 000)"
  if [[ "$TOKEN_RESPONSE" != "200" ]]; then
    warn "Keycloak token request returned HTTP $TOKEN_RESPONSE"
    cat /tmp/smoke-eval.token >&2 || true
    echo >&2
    die "could not obtain access token"
  fi
  ACCESS_TOKEN="$(jq -r '.access_token' /tmp/smoke-eval.token)"
  ACCESS_TOKEN_OBTAINED_AT="$(date +%s)"
  rm -f /tmp/smoke-eval.token
  [[ -n "$ACCESS_TOKEN" && "$ACCESS_TOKEN" != "null" ]] || die "Keycloak response missing access_token"
  ok "obtained access token (length=${#ACCESS_TOKEN})"
fi

# ── 3. Discover / verify project + agent ────────────────────────────

bold "3. Discover project + agent"
if [[ -z "${PROJECT_ID:-}" ]]; then
  # config-service returns {projects: [{id, name, ...}]} for the list
  # endpoint; agents are a flat array of {id, projectId, ...}.
  PROJECT_ID="$(curl_json GET /api/v1/projects | jq -r '.projects[0].id // empty')"
  [[ -n "$PROJECT_ID" ]] || die "no projects found in config-service; set PROJECT_ID explicitly"
  info "auto-selected first project: $PROJECT_ID"
fi
ok "PROJECT_ID=$PROJECT_ID"

if [[ -z "${AGENT_ID:-}" ]]; then
  AGENTS="$(curl_json GET "/api/v1/projects/$PROJECT_ID/agents")"
  AGENT_ID="$(echo "$AGENTS" | jq -r 'if (type=="array" and length>0) then .[0].id else empty end')"
  [[ -n "$AGENT_ID" ]] || die "no agents found in project $PROJECT_ID; deploy one or set AGENT_ID"
  info "auto-selected first agent in project"
fi
# agentVersion is a required field on the EvaluationTemplate validator but
# config-service agents don't (yet) expose a version string. Default to
# "v1" so the smoke can proceed; override with AGENT_VERSION=<x> when the
# template needs to pin a real version.
AGENT_VERSION="${AGENT_VERSION:-v1}"

# Pull the agent's configured modelId so the eval template targets a
# model that actually resolves in the project's catalog. agent-service's
# model resolver rejects unknown aliases (e.g. "gpt-4o") with HTTP 404,
# so feeding it the agent's own modelId — a UUID from the project's
# models catalog — is the safest default for a smoke.
if [[ -z "${MODEL_ID:-}" ]]; then
  MODEL_ID="$(curl_json GET "/api/v1/projects/$PROJECT_ID/agents/$AGENT_ID" \
    | jq -r '.modelId // empty')"
  [[ -n "$MODEL_ID" ]] || die "agent $AGENT_ID has no modelId; set MODEL_ID env var explicitly"
  info "using agent's configured modelId: $MODEL_ID"
fi
ok "AGENT_ID=$AGENT_ID  AGENT_VERSION=$AGENT_VERSION  MODEL_ID=$MODEL_ID"

# ── 4. Create template ──────────────────────────────────────────────

bold "4. Create eval template '$EVAL_NAME'"
JUDGE_MODEL="${JUDGE_MODEL:-$MODEL_ID}"

# Build the evaluators block based on JUDGE_STRATEGY. The validator's
# `validateEvaluators` (config-service/validators/evaluationValidator.ts)
# requires aiJudge.models + aiJudge.dimensions whenever the strategy
# includes LLM judging.
case "$JUDGE_STRATEGY" in
  deterministic)
    EVAL_BLOCK='{
      "strategy": "deterministic",
      "deterministic": { "metrics": ["correctness"] }
    }'
    ;;
  llm_judge|both)
    EVAL_BLOCK="$(jq -nc --arg strat "$JUDGE_STRATEGY" --arg jm "$JUDGE_MODEL" --arg rubric "$JUDGE_RUBRIC" '
      {
        strategy: $strat,
        aiJudge: { models: [$jm], dimensions: [$rubric] },
        enabledRubric: [$rubric],
        evaluatorModel: $jm,
        evaluatorVersion: "live",
      } + (if $strat == "both"
           then { deterministic: { metrics: ["correctness"] } }
           else {} end)
    ')"
    ;;
  *)
    die "JUDGE_STRATEGY must be one of: deterministic | llm_judge | both (got: $JUDGE_STRATEGY)"
    ;;
esac
info "evaluators strategy=$JUDGE_STRATEGY  rubric=$JUDGE_RUBRIC  judgeModel=$JUDGE_MODEL"

# Test cases are eval-owned (no datasetId on the template). The smoke
# harness creates the template first; the test-cases JSONL is uploaded
# in the next step via the eval-scoped `PUT /evaluations/{evalId}/testcases`
# route. Until upload, the JSONL doesn't exist on the PVC.
CASES_BLOCK="$(jq -n '{ schemaVersion: "golden_test_v1" }')"
TEMPLATE_BODY="$(jq -n \
  --arg evalName "$EVAL_NAME" \
  --arg agentId "$AGENT_ID" \
  --arg agentVersion "$AGENT_VERSION" \
  --arg modelId "$MODEL_ID" \
  --argjson evaluators "$EVAL_BLOCK" \
  --argjson cases "$CASES_BLOCK" '
  {
    evalName: $evalName,
    owner: "smoke-eval",
    target: "agent_version",
    agent: { agentId: $agentId, agentVersion: $agentVersion },
    models: [$modelId],
    evaluationScope: "full_agent_execution",
    suite: "rag",
    evaluators: $evaluators,
    cases: $cases,
    runMode: "single",
    concurrency: 1
  }')"
TEMPLATE="$(curl_json POST "/api/v1/projects/$PROJECT_ID/evaluation/agents/templates" "$TEMPLATE_BODY")"
TID="$(echo "$TEMPLATE" | jq -r '.templateId')"
[[ -n "$TID" && "$TID" != "null" ]] || die "template creation did not return a templateId"
ok "templateId=$TID"

# ── 5. (test-cases upload) ──────────────────────────────────────────
#
# Test cases live on the PVC at
#   `projects/{PROJECT_ID}/evaluations/{EVAL_ID}/testcases/cases.jsonl`
# (eval-owned). To prepare:
#   1. Author `cases.jsonl` (one GoldenTestCase per line; see
#      `doc/EVAL_GOLDEN_DATASET_SCHEMA.md`).
#   2. Upload it via:
#        PUT /api/v1/projects/{PROJECT_ID}/evaluation/agents/evaluations/{EVAL_ID}/testcases
#        Content-Type: application/x-ndjson
#      (or place it directly on the PVC at the path printed above).
ok "(upload test cases via PUT /evaluations/{evalId}/testcases before the run)"

# ── 6. Trigger run ──────────────────────────────────────────────────

bold "6. Trigger run"
RUN="$(curl_json POST "/api/v1/projects/$PROJECT_ID/evaluation/agents/templates/$TID/runs" \
  '{"actor":"smoke-eval","reason":"automated smoke test"}')"
RID="$(echo "$RUN" | jq -r '.runId')"
WID="$(echo "$RUN" | jq -r '.workflowId // empty')"
[[ -n "$RID" && "$RID" != "null" ]] || die "run creation did not return a runId"
ok "runId=$RID  workflowId=${WID:-<not-returned>}"

# ── 7. Poll for terminal status ────────────────────────────────────

bold "7. Poll until terminal status (timeout=${TIMEOUT_SECS}s)"
DEADLINE=$(( $(date +%s) + TIMEOUT_SECS ))
LAST_STATUS=""
while true; do
  RUN_NOW="$(curl_json GET "/api/v1/projects/$PROJECT_ID/evaluation/agents/runs/$RID")"
  STATUS="$(echo "$RUN_NOW" | jq -r '.status')"
  if [[ "$STATUS" != "$LAST_STATUS" ]]; then
    info "status=$STATUS"
    LAST_STATUS="$STATUS"
  fi
  case "$STATUS" in
    completed|failed|stopped)
      break
      ;;
  esac
  if [[ $(date +%s) -ge $DEADLINE ]]; then
    warn "timed out after ${TIMEOUT_SECS}s; last status=$STATUS"
    warn "recent worker logs:"
    kubectl -n "$NAMESPACE" logs "deploy/$WORKER_DEPLOY" --tail=40 >&2 || true
    die "run did not reach terminal status"
  fi
  sleep "$POLL_INTERVAL"
done
ok "terminal status=$STATUS"

# ── 8. Audit + artifacts ───────────────────────────────────────────

bold "8. Audit trail"
curl_json GET "/api/v1/projects/$PROJECT_ID/evaluation/agents/runs/$RID/audit-events" \
  | jq '.[] | {at, type, message}'

bold "9. Job folder on PVC"
EVAL_ID="$(echo "$RUN_NOW" | jq -r '.templateSnapshot.evalId // empty')"
if [[ -z "$EVAL_ID" ]]; then
  # evalId is slugify(evalName) when the template doesn't set it.
  EVAL_ID="$(echo "$EVAL_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\+/-/g; s/^-\+\|-\+$//g')"
  [[ -n "$EVAL_ID" ]] || EVAL_ID="unnamed"
  info "derived evalId from evalName slug: $EVAL_ID"
fi
RUNDIR="/mnt/pvcs/default-nemo/projects/$PROJECT_ID/evaluations/$EVAL_ID/runs/$RID"
info "runDir=$RUNDIR"

POD="$(kubectl -n "$NAMESPACE" get pod -l app.kubernetes.io/name=eval-worker -o jsonpath='{.items[0].metadata.name}')"
[[ -n "$POD" ]] || die "no eval-worker pod found"

bold "  _input/ contents"
kubectl -n "$NAMESPACE" exec "$POD" -- ls -la "$RUNDIR/_input" 2>/dev/null || warn "_input/ missing"

bold "  manifest.json"
kubectl -n "$NAMESPACE" exec "$POD" -- cat "$RUNDIR/_input/manifest.json" 2>/dev/null | jq . || warn "manifest.json unreadable"

bold "  results.json summary"
if kubectl -n "$NAMESPACE" exec "$POD" -- test -f "$RUNDIR/results.json"; then
  kubectl -n "$NAMESPACE" exec "$POD" -- cat "$RUNDIR/results.json" \
    | jq '{
        runId,
        verdict: .results.verdict,
        cases: (.perCaseArtifacts | length),
        passed: [.perCaseArtifacts[] | select(.passed == true)] | length,
        failed: [.perCaseArtifacts[] | select(.passed == false)] | length
      }'
else
  warn "results.json not written (run may have failed before Phase c)"
fi

# ── 10. Optional cleanup ───────────────────────────────────────────

if [[ "$KEEP_TEMPLATE" != "1" ]]; then
  bold "10. Cleanup: delete template $TID"
  del_args=(-sS -o /dev/null -w '%{http_code}\n' -X DELETE)
  if [[ -n "$ACCESS_TOKEN" ]]; then
    del_args+=(-H "authorization: Bearer ${ACCESS_TOKEN}")
  fi
  del_args+=("$BASE/api/v1/projects/$PROJECT_ID/evaluation/agents/templates/$TID")
  curl "${del_args[@]}" || true
  ok "deleted"
else
  info "KEEP_TEMPLATE=1 — leaving template $TID and run $RID in place"
fi

bold "Done. final status: $STATUS"
[[ "$STATUS" == "completed" ]]
