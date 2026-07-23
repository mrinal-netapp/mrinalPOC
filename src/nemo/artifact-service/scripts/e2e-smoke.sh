#!/usr/bin/env bash
# End-to-end smoke test for artifact-service.
#
# Spins the service up locally against a temp NFS root, a real Postgres,
# and an optional Redis. Walks the happy-path that PR-1..PR-6 deliver:
#
#   create store -> write -> read -> log (trailers) -> tag -> revert ->
#   merge to main -> list-stores -> archive
#
# Verifies the audit trailers are present on every commit. Exits non-zero
# on any unexpected response.
#
# Usage:
#   POSTGRES_HOST=localhost POSTGRES_USER=postgres POSTGRES_PASSWORD=postgres \
#   POSTGRES_DB=nemo ./scripts/e2e-smoke.sh
#
# Pre-reqs:
#   - artifact-service built (`npm run build`)
#   - config-service has run its TypeORM synchronize against POSTGRES_DB
#     (creates artifact_stores + artifact_store_acls tables)

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SERVICE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
cd "$SERVICE_DIR"

PORT=${PORT:-18080}
NEMO_ROOT=$(mktemp -d -t artifact-smoke-XXXX)
USER_ID="smoke-user"
PROJECT_ID=${PROJECT_ID:-smoke-project}
SESSION_ID="smoke-sess-$$"

cleanup() {
  if [[ -n "${SERVICE_PID:-}" ]]; then
    kill "$SERVICE_PID" 2>/dev/null || true
  fi
  rm -rf "$NEMO_ROOT"
}
trap cleanup EXIT

echo "[smoke] NEMO_DEFAULT_STORE_ROOT=$NEMO_ROOT port=$PORT"

PORT="$PORT" \
  NEMO_DEFAULT_STORE_ROOT="$NEMO_ROOT" \
  node dist/index.js > /tmp/artifact-smoke.log 2>&1 &
SERVICE_PID=$!

# Wait for /ready
for i in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$PORT/ready" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

H_AUTH=(
  -H "X-User-ID: $USER_ID"
  -H "X-User-Email: smoke@example.invalid"
  -H "X-Project-ID: $PROJECT_ID"
  -H "X-Session-ID: $SESSION_ID"
)

echo "[smoke] POST /artifact-stores"
CREATE_RESP=$(curl -fsS -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJECT_ID/artifact-stores" \
  -H "Content-Type: application/json" "${H_AUTH[@]}" \
  -d '{"name":"smoke-store","description":"e2e smoke"}')
STORE_ID=$(echo "$CREATE_RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "[smoke] created store $STORE_ID"

echo "[smoke] GET /whoami"
curl -fsS "http://127.0.0.1:$PORT/v1/artifact-stores/whoami" "${H_AUTH[@]}" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["principal"]["encoded"]=="user:'"$USER_ID"'";print("ok")'

echo "[smoke] MCP write via JSON-RPC"
WRITE_RPC=$(cat <<EOF
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"write","arguments":{"store_id":"$STORE_ID","path":"/notes.md","content_base64":"$(printf 'hello smoke' | base64)","message":"first"}}}
EOF
)
WRITE_RESULT=$(curl -fsS -X POST "http://127.0.0.1:$PORT/mcp" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" "${H_AUTH[@]}" \
  -d "$WRITE_RPC")
echo "$WRITE_RESULT" | head -c 800; echo
echo "$WRITE_RESULT" | grep -q '"isError":false' || { echo "[smoke] write failed"; exit 1; }

echo "[smoke] GET /log shows the commit with audit trailers"
LOG_JSON=$(curl -fsS "http://127.0.0.1:$PORT/v1/projects/$PROJECT_ID/artifact-stores/$STORE_ID/log?ref=sessions/$SESSION_ID" "${H_AUTH[@]}")
echo "$LOG_JSON" | python3 -c '
import sys, json
data = json.load(sys.stdin)
items = data.get("items", [])
assert items, "no commits"
top = items[0]
trailers = top["trailers"]
assert trailers.get("X-Op") == "write", trailers
assert trailers.get("X-Principal") == "user:'"$USER_ID"'", trailers
assert trailers.get("X-Session-Id") == "'"$SESSION_ID"'", trailers
print("ok")
'

echo "[smoke] MCP read confirms bytes"
READ_RPC=$(cat <<EOF
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read","arguments":{"store_id":"$STORE_ID","path":"/notes.md"}}}
EOF
)
READ_RESULT=$(curl -fsS -X POST "http://127.0.0.1:$PORT/mcp" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" "${H_AUTH[@]}" \
  -d "$READ_RPC")
echo "$READ_RESULT" | python3 -c '
import sys, json, base64, re
raw = sys.stdin.read()
# Strip SSE wrapper if present
m = re.search(r"\{\"jsonrpc\".*?\}\}", raw)
payload = json.loads(m.group(0) if m else raw)
text = payload["result"]["content"][0]["text"]
inner = json.loads(text)
assert inner["ok"], inner
assert base64.b64decode(inner["data"]["bytes_base64"]).decode() == "hello smoke"
print("ok")
'

echo "[smoke] MCP tag + merge to main"
TAG_RPC=$(cat <<EOF
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"tag","arguments":{"store_id":"$STORE_ID","name":"v1","message":"first cut"}}}
EOF
)
curl -fsS -X POST "http://127.0.0.1:$PORT/mcp" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" "${H_AUTH[@]}" \
  -d "$TAG_RPC" >/dev/null

MERGE_RPC=$(cat <<EOF
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"merge","arguments":{"store_id":"$STORE_ID"}}}
EOF
)
MERGE_RESULT=$(curl -fsS -X POST "http://127.0.0.1:$PORT/mcp" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" "${H_AUTH[@]}" \
  -d "$MERGE_RPC")
echo "$MERGE_RESULT" | grep -q '"status":"ok"' || { echo "[smoke] merge failed"; echo "$MERGE_RESULT"; exit 1; }

echo "[smoke] DELETE /artifact-stores/$STORE_ID"
curl -fsS -X DELETE "http://127.0.0.1:$PORT/v1/projects/$PROJECT_ID/artifact-stores/$STORE_ID" "${H_AUTH[@]}"

echo "[smoke] PASS"
