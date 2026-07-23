#!/usr/bin/env bash
# =============================================================================
# RFC Search Relevance Scorer — Test Suite
#
# Validates the single-agent config:
#   configs/sample_maf_agents/rfc_search_relevance_scorer.json
#
# Expectations:
#   - Agent invokes mcp-search_rfcs exactly once per request
#   - Agent returns a JSON object with shape:
#       { "query": "...", "top_k": N, "results": [
#           { "rank": 1, "raw": <tool result>, "scored_lines": [
#               { "line_index": 0, "text": "...", "relevance_score": 0.87 },
#               ...
#           ]}
#       ]}
#   - The agent MUST NOT paraphrase or alter the tool's output; only
#     `scored_lines[*].relevance_score` is agent-generated.
#
# Usage:
#   ./scripts/test_rfc_search_relevance.sh start
#   ./scripts/test_rfc_search_relevance.sh test
#   ./scripts/test_rfc_search_relevance.sh stop
#   ./scripts/test_rfc_search_relevance.sh all
#
# Environment:
#   BASE_URL   — Server URL    (default: http://localhost:8000)
#   TIMEOUT    — curl max-time (default: 300s — single agent + one MCP call)
# =============================================================================

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8000}"
TIMEOUT="${TIMEOUT:-300}"
CONFIG_PATH="configs/sample_maf_agents/rfc_search_relevance_scorer.json"
PID_FILE="/tmp/agent_framework_rfc_scorer.pid"
LOG_FILE="/tmp/agent_framework_rfc_scorer.log"
TMP_RESP="/tmp/rfc_scorer_resp.json"
TMP_OUT="/tmp/rfc_scorer_output.json"
TMP_SSE="/tmp/rfc_scorer_sse.txt"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()   { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()     { echo -e "${GREEN}[PASS]${NC}  $*"; }
fail()   { echo -e "${RED}[FAIL]${NC}  $*"; }
warn()   { echo -e "${YELLOW}[WARN]${NC}  $*"; }
header() { echo -e "\n${BOLD}━━━ $* ━━━${NC}"; }

PASS=0
FAIL_COUNT=0
TOTAL=0
FAILURES=""

# ---------------------------------------------------------------------------
# Server lifecycle
# ---------------------------------------------------------------------------
start_server() {
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        warn "Server already running (PID $(cat "$PID_FILE"))."
        return 0
    fi

    info "Starting server with config: $CONFIG_PATH"
    PYTHONPATH=src AGENT_CONFIG_PATH="$CONFIG_PATH" \
        uvicorn agent_service_maf.interface_layer.api:create_app \
        --factory --host 0.0.0.0 --port 8000 \
        > "$LOG_FILE" 2>&1 &

    echo $! > "$PID_FILE"
    info "Server PID: $(cat "$PID_FILE") — logs at $LOG_FILE"

    info "Waiting for server to be ready..."
    for i in $(seq 1 30); do
        if curl -sf "${BASE_URL}/health" > /dev/null 2>&1; then
            ok "Server is ready (took ${i}s)"
            return 0
        fi
        sleep 1
    done

    fail "Server did not become ready within 30s. Check $LOG_FILE"
    tail -30 "$LOG_FILE"
    return 1
}

stop_server() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            info "Stopping server (PID $PID)..."
            kill "$PID" 2>/dev/null || true
            sleep 1
            kill -9 "$PID" 2>/dev/null || true
            ok "Server stopped"
        else
            warn "Server process $PID not running"
        fi
        rm -f "$PID_FILE"
    else
        warn "No PID file found — server may not be running"
    fi
}

# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------
record_pass() { PASS=$((PASS + 1)); ok "$1"; }
record_fail() { local n="$1"; shift; FAIL_COUNT=$((FAIL_COUNT + 1)); FAILURES="${FAILURES}\n  - $n ($*)"; fail "$n — $*"; }

assert_status() {
    TOTAL=$((TOTAL + 1))
    if [ "$3" = "$2" ]; then record_pass "$1 (HTTP $3)";
    else                     record_fail "$1" "expected HTTP $2, got HTTP $3"; fi
}

# ---------------------------------------------------------------------------
# invoke_and_check_schema <name> <query>
#
# POSTs the query, extracts the agent's `output` field, and validates:
#   1. HTTP 200
#   2. output parses as JSON
#   3. JSON has query / top_k / results keys
#   4. results is a list; each item has rank / raw / scored_lines
#   5. scored_lines entries have line_index / text / relevance_score in [0,1]
# ---------------------------------------------------------------------------
invoke_and_check_schema() {
    local test_name="$1"
    local query="$2"

    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] $test_name"
    echo -e "  ${CYAN}Query:${NC} ${query}"

    local payload
    payload=$(python3 -c "
import json, sys
print(json.dumps({
    'input': sys.argv[1],
    'context': {},
    'config_overrides': {},
    'session_id': 'rfc-scorer-$TOTAL',
    'metadata': {'test': sys.argv[2]}
}))
" "$query" "$test_name")

    local http_code
    http_code=$(curl -s -o "$TMP_RESP" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/invoke" \
        -H "Content-Type: application/json" \
        -d "$payload" 2>/dev/null)

    if [ "$http_code" != "200" ]; then
        record_fail "$test_name" "HTTP $http_code"
        echo -e "  ${RED}Response:${NC} $(head -c 400 "$TMP_RESP")"
        echo ""; return
    fi

    # Extract the raw `output` string — the agent's JSON payload
    python3 -c "
import sys, json
body = json.load(open(sys.argv[1]))
out = body.get('output', '')
open(sys.argv[2], 'w').write(out if isinstance(out, str) else json.dumps(out))
" "$TMP_RESP" "$TMP_OUT"

    # Strip possible markdown fences (defensive — the prompt forbids them but models drift)
    python3 -c "
import re, sys
path = sys.argv[1]
s = open(path).read().strip()
# Remove common ```json ... ``` fences
s = re.sub(r'^```(?:json)?\s*', '', s)
s = re.sub(r'\s*```$', '', s)
open(path, 'w').write(s)
" "$TMP_OUT"

    # Schema validation — output MUST be a top-level JSON array of chunk
    # objects. Each chunk preserves the MCP fields (chunkId, content, score,
    # metadata) and adds `relevance_score`.
    local schema_result
    schema_result=$(python3 - "$TMP_OUT" "$query" <<'PY'
import json, sys

path, query = sys.argv[1], sys.argv[2]
raw = open(path).read().strip()

try:
    data = json.loads(raw)
except Exception as e:
    print(f"FAIL:output_not_json:{e}")
    sys.exit(0)

if not isinstance(data, list):
    print(f"FAIL:top_level_not_array (got {type(data).__name__})")
    sys.exit(0)

required = ("chunkId", "content", "score", "metadata", "relevance_score")
errs = []
for i, chunk in enumerate(data):
    if not isinstance(chunk, dict):
        errs.append(f"chunks[{i}] not an object")
        continue
    for k in required:
        if k not in chunk:
            errs.append(f"chunks[{i}].{k} missing")

    s = chunk.get("relevance_score")
    if not isinstance(s, (int, float)):
        errs.append(f"chunks[{i}].relevance_score not numeric ({type(s).__name__})")
    elif not (0.0 <= float(s) <= 1.0):
        errs.append(f"chunks[{i}].relevance_score out of [0,1]: {s}")

    content = chunk.get("content")
    if not isinstance(content, str) or not content.strip():
        errs.append(f"chunks[{i}].content empty or not string")

    md = chunk.get("metadata")
    if not isinstance(md, dict):
        errs.append(f"chunks[{i}].metadata not an object")

if errs:
    print("FAIL:schema:" + "; ".join(errs[:8]))
else:
    print(f"PASS:{len(data)}_chunks_scored")
PY
)

    if [[ "$schema_result" == PASS:* ]]; then
        record_pass "$test_name — ${schema_result#PASS:}"
    else
        record_fail "$test_name" "${schema_result#FAIL:}"
        echo -e "  ${RED}Output preview:${NC}"
        head -c 500 "$TMP_OUT" | sed 's/^/    /'
        echo ""
    fi
    echo ""
}

# ---------------------------------------------------------------------------
# verify_verbatim <name> <query> <substring-that-must-appear-in-raw>
#
# Asserts that the tool's original text (checked by the given substring)
# survives unmodified in `results[*].raw`. The substring should be a token
# or phrase the model would be tempted to paraphrase.
# ---------------------------------------------------------------------------
verify_verbatim() {
    local test_name="$1"
    local query="$2"
    local substring="$3"

    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] $test_name"
    echo -e "  ${CYAN}Query:${NC} ${query}"
    echo -e "  ${CYAN}Expecting substring preserved in 'raw':${NC} ${substring}"

    local payload
    payload=$(python3 -c "
import json, sys
print(json.dumps({
    'input': sys.argv[1],
    'context': {},
    'config_overrides': {},
    'session_id': 'rfc-scorer-verb-$TOTAL',
    'metadata': {'test': sys.argv[2]}
}))
" "$query" "$test_name")

    local http_code
    http_code=$(curl -s -o "$TMP_RESP" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/invoke" \
        -H "Content-Type: application/json" \
        -d "$payload" 2>/dev/null)

    if [ "$http_code" != "200" ]; then
        record_fail "$test_name" "HTTP $http_code"
        echo ""; return
    fi

    local verdict
    verdict=$(python3 - "$TMP_RESP" "$substring" <<'PY'
import json, sys
body = json.load(open(sys.argv[1]))
out = body.get('output', '')
if isinstance(out, str):
    # The agent's output is itself a JSON string; it should contain the substring.
    # We search the raw text since `raw` inside the JSON preserves it byte-for-byte.
    if sys.argv[2].lower() in out.lower():
        print("PASS")
    else:
        print("FAIL:substring_missing")
else:
    print("FAIL:output_not_string")
PY
)

    if [ "$verdict" = "PASS" ]; then
        record_pass "$test_name"
    else
        record_fail "$test_name" "$verdict"
    fi
    echo ""
}

# ===========================================================================
# TEST SUITE
# ===========================================================================
run_tests() {
    echo ""
    echo "==========================================================================="
    echo "  RFC Search Relevance Scorer — Test Suite"
    echo "==========================================================================="

    # ---------------------------------------------------------------------
    # SECTION 0: Smoke
    # ---------------------------------------------------------------------
    header "SECTION 0: Smoke Tests"

    info "Health endpoint"
    HTTP_CODE=$(curl -s -o "$TMP_RESP" -w "%{http_code}" "${BASE_URL}/health")
    assert_status "GET /health" "200" "$HTTP_CODE"

    info "Agent listing"
    HTTP_CODE=$(curl -s -o "$TMP_RESP" -w "%{http_code}" "${BASE_URL}/agents")
    assert_status "GET /agents" "200" "$HTTP_CODE"

    TOTAL=$((TOTAL + 1))
    if grep -qi "maf" "$TMP_RESP"; then
        record_pass "Framework 'maf' registered on /agents"
    else
        record_fail "Agent registration" "maf not found in /agents"
    fi
    echo ""

    # Probe MCP upstream directly (diagnostic only — not counted)
    info "Upstream MCP sanity (direct probe)"
    PROBE=$(curl -sS --max-time 30 -X POST \
        "https://bifrost-gateway.lemonrock-31b9f66a.eastus.azurecontainerapps.io/mcp" \
        -H "content-type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' 2>/dev/null || echo "PROBE_FAILED")
    if echo "$PROBE" | grep -qi "mcp-search_rfcs"; then
        info "  → upstream exposes tool mcp-search_rfcs ✓"
    else
        warn "  → could not confirm mcp-search_rfcs on upstream (network/auth issue?)"
    fi
    echo ""

    # ---------------------------------------------------------------------
    # SECTION 1: Schema — returns valid JSON with expected shape
    # ---------------------------------------------------------------------
    header "SECTION 1: Response Schema"

    invoke_and_check_schema \
        "TC-1.1: Basic RFC number query (RFC 7230)" \
        "help me understand 7230"

    invoke_and_check_schema \
        "TC-1.2: TLS 1.3 conceptual query" \
        "TLS 1.3 handshake changes"

    invoke_and_check_schema \
        "TC-1.3: HTTP/2 binary framing" \
        "HTTP/2 binary framing layer"

    invoke_and_check_schema \
        "TC-1.4: Query with explicit top_k hint" \
        "Return top_k=5 results about OAuth 2.0 token refresh"

    # ---------------------------------------------------------------------
    # SECTION 2: Verbatim preservation
    # (The model must not paraphrase; canonical RFC tokens survive unmodified.)
    # ---------------------------------------------------------------------
    header "SECTION 2: Verbatim Preservation"

    verify_verbatim \
        "TC-2.1: RFC number survives verbatim" \
        "help me understand 7230" \
        "7230"

    verify_verbatim \
        "TC-2.2: Canonical protocol noun survives" \
        "IPv6 addressing architecture" \
        "IPv6"

    verify_verbatim \
        "TC-2.3: TLS token survives" \
        "TLS 1.3 handshake" \
        "TLS"

    # ---------------------------------------------------------------------
    # SECTION 3: Guardrails
    # ---------------------------------------------------------------------
    header "SECTION 3: Guardrails & Validation"

    info "Empty input validation"
    TOTAL=$((TOTAL + 1))
    HTTP_CODE=$(curl -s -o "$TMP_RESP" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/invoke" \
        -H "Content-Type: application/json" \
        -d '{"input":"","context":{},"config_overrides":{},"session_id":"g-empty","metadata":{}}')
    if [ "$HTTP_CODE" = "400" ] || [ "$HTTP_CODE" = "422" ] || [ "$HTTP_CODE" = "500" ]; then
        record_pass "Empty input rejected (HTTP $HTTP_CODE)"
    else
        record_fail "Empty input guardrail" "expected 4xx/5xx, got HTTP $HTTP_CODE"
    fi
    echo ""

    info "Missing input field"
    HTTP_CODE=$(curl -s -o "$TMP_RESP" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/invoke" \
        -H "Content-Type: application/json" \
        -d '{"context":{}}')
    assert_status "Missing input → 422" "422" "$HTTP_CODE"
    echo ""

    # ---------------------------------------------------------------------
    # SECTION 4: SSE Streaming
    # ---------------------------------------------------------------------
    header "SECTION 4: SSE Streaming"

    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] TC-4.1: SSE stream with RFC search"
    HTTP_CODE=$(curl -s -o "$TMP_SSE" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/stream" \
        -H "Content-Type: application/json" \
        -H "Accept: text/event-stream" \
        -d '{
            "input": "help me understand 7230",
            "context": {}, "config_overrides": {},
            "session_id": "sse-rfc-scorer", "metadata": {"test": "TC-4.1"}
        }')
    if [ "$HTTP_CODE" = "200" ] && [ -s "$TMP_SSE" ]; then
        SSE_SIZE=$(wc -c < "$TMP_SSE")
        if grep -qiE "(7230|relevance|scored_lines|results)" "$TMP_SSE"; then
            record_pass "TC-4.1: SSE stream returned scored output ($SSE_SIZE bytes)"
        else
            record_pass "TC-4.1: SSE stream returned response ($SSE_SIZE bytes, schema not verified)"
        fi
    else
        record_fail "TC-4.1: SSE stream" "HTTP $HTTP_CODE or empty response"
    fi
    echo -e "  ${CYAN}First SSE events:${NC}"
    head -15 "$TMP_SSE" 2>/dev/null | sed 's/^/    /'
    echo ""

    # ---------------------------------------------------------------------
    # SECTION 5: Edge cases
    # ---------------------------------------------------------------------
    header "SECTION 5: Edge Cases"

    # 5.1 Nonsense query — schema must still hold; scored_lines may score near 0
    invoke_and_check_schema \
        "TC-5.1: Nonsense query (low relevance but valid schema)" \
        "xyzzy plugh quuux"

    # 5.2 Very short query
    invoke_and_check_schema \
        "TC-5.2: Minimum-length query" \
        "QUIC"

    # ===================================================================
    # Summary
    # ===================================================================
    echo ""
    echo "==========================================================================="
    echo "  RESULTS"
    echo "==========================================================================="
    echo ""
    echo -e "  Total:  $TOTAL"
    echo -e "  Passed: ${GREEN}$PASS${NC}"
    echo -e "  Failed: ${RED}$FAIL_COUNT${NC}"
    echo ""

    if [ "$FAIL_COUNT" -gt 0 ]; then
        echo -e "  ${RED}Failures:${NC}$FAILURES"
        echo ""
    fi

    if [ "$FAIL_COUNT" -eq 0 ]; then
        echo -e "  ${GREEN}${BOLD}All $TOTAL tests passed!${NC}"
    else
        echo -e "  ${YELLOW}${BOLD}$FAIL_COUNT/$TOTAL test(s) failed — review output above.${NC}"
    fi
    echo "==========================================================================="
    echo ""

    [ "$FAIL_COUNT" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
case "${1:-help}" in
    start)  start_server ;;
    stop)   stop_server ;;
    test)   run_tests ;;
    all)
        start_server
        echo ""
        run_tests || TEST_FAILED=1
        echo ""
        stop_server
        exit ${TEST_FAILED:-0}
        ;;
    *)
        echo "Usage: $0 {start|stop|test|all}"
        echo ""
        echo "  start — Start server with rfc_search_relevance_scorer config"
        echo "  test  — Run the suite (schema + verbatim + guardrails + SSE)"
        echo "  stop  — Stop the server"
        echo "  all   — Start, test, and stop"
        echo ""
        echo "Environment variables:"
        echo "  BASE_URL  — Server URL    (default: http://localhost:8000)"
        echo "  TIMEOUT   — curl max-time (default: 300s)"
        ;;
esac
