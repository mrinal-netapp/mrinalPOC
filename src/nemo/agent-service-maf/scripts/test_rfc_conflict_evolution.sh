#!/usr/bin/env bash
# =============================================================================
# RFC Conflict & Evolution Analyzer — Full Test Suite
#
# Validates the sequential pipeline:
#   timeline_agent → diff_agent → conflict_detector → synthesizer
# backed by the rfc-metadata MCP server (SSE transport).
#
# Config: configs/sample_maf_agents/rfc_conflict_evolution_analyzer.json
#
# Pre-requisites:
#   - rfc-metadata MCP server reachable at http://mcp-rfc-metadata:8080/sse
#   - Gateway (Bifrost) URL in config is reachable
#   - Env var RFC_METADATA_API_KEY is exported (used by MCP header template)
#
# Usage:
#   ./scripts/test_rfc_conflict_evolution.sh start
#   ./scripts/test_rfc_conflict_evolution.sh test
#   ./scripts/test_rfc_conflict_evolution.sh stop
#   ./scripts/test_rfc_conflict_evolution.sh all
#
# Environment:
#   BASE_URL   — Server URL    (default: http://localhost:8000)
#   TIMEOUT    — curl max-time (default: 900s — 4-agent sequential w/ MCP tools)
# =============================================================================

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8000}"
TIMEOUT="${TIMEOUT:-900}"
CONFIG_PATH="configs/sample_maf_agents/rfc_conflict_evolution_analyzer.json"
PID_FILE="/tmp/agent_framework_rfc.pid"
LOG_FILE="/tmp/agent_framework_rfc.log"
TMP_RESP="/tmp/rfc_resp.json"
TMP_SSE="/tmp/rfc_sse.txt"

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

    if [ -z "${RFC_METADATA_API_KEY:-}" ]; then
        warn "RFC_METADATA_API_KEY is not set — MCP auth header will be empty."
    fi

    info "Starting server with config: $CONFIG_PATH"
    PYTHONPATH=src AGENT_CONFIG_PATH="$CONFIG_PATH" \
        uvicorn agent_service_maf.interface_layer.api:create_app \
        --factory --host 0.0.0.0 --port 8000 \
        > "$LOG_FILE" 2>&1 &

    echo $! > "$PID_FILE"
    info "Server PID: $(cat "$PID_FILE") — logs at $LOG_FILE"

    info "Waiting for server to be ready..."
    for i in $(seq 1 45); do
        if curl -sf "${BASE_URL}/health" > /dev/null 2>&1; then
            ok "Server is ready (took ${i}s)"
            return 0
        fi
        sleep 1
    done

    fail "Server did not become ready within 45s. Check $LOG_FILE"
    tail -40 "$LOG_FILE"
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

assert_json_field() {
    TOTAL=$((TOTAL + 1))
    local actual
    actual=$(echo "$2" | python3 -c "import sys,json; print(json.load(sys.stdin)$3)" 2>/dev/null || echo "__PARSE_ERROR__")
    if [ "$actual" = "$4" ]; then record_pass "$1";
    else                          record_fail "$1" "expected '$4', got '$actual'"; fi
}

output_preview() {
    local body="$1"
    echo -e "  ${CYAN}Output preview:${NC} $(echo "$body" | python3 -c "
import sys,json
o=json.load(sys.stdin).get('output','')
print(o[:300]+('...' if len(o)>300 else ''))
" 2>/dev/null)"
}

# ---------------------------------------------------------------------------
# invoke_and_verify_all <name> <input> <marker1> [marker2] ...
# Requires ALL markers (case-insensitive) to be present in output —
# stricter than the single-agent helper because sequential pipelines should
# produce evidence from every stage (timeline, diff, conflict, synthesis).
# ---------------------------------------------------------------------------
invoke_and_verify_all() {
    local test_name="$1"
    local input_text="$2"
    shift 2
    local markers=("$@")

    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] $test_name"
    echo -e "  ${CYAN}Input:${NC} ${input_text:0:150}..."

    local payload
    payload=$(python3 -c "
import json, sys
print(json.dumps({
    'input': sys.argv[1],
    'context': {},
    'config_overrides': {},
    'session_id': 'rfc-test-$TOTAL',
    'metadata': {'test': sys.argv[2]}
}))
" "$input_text" "$test_name")

    local http_code
    http_code=$(curl -s -o "$TMP_RESP" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/invoke" \
        -H "Content-Type: application/json" \
        -d "$payload" 2>/dev/null)

    local body
    body=$(cat "$TMP_RESP")

    if [ "$http_code" != "200" ]; then
        record_fail "$test_name" "HTTP $http_code"
        echo -e "  ${RED}Response:${NC} $(echo "$body" | head -5)"
        echo ""; return
    fi

    local output
    output=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('output',''))" 2>/dev/null)

    local missing=()
    for marker in "${markers[@]}"; do
        if ! echo "$output" | grep -qi "$marker"; then
            missing+=("$marker")
        fi
    done

    if [ "${#missing[@]}" -eq 0 ]; then
        record_pass "$test_name"
    else
        record_fail "$test_name" "missing markers: ${missing[*]}"
    fi

    output_preview "$body"
    echo ""
}

# ---------------------------------------------------------------------------
# invoke_and_verify_any — at least one marker must appear
# ---------------------------------------------------------------------------
invoke_and_verify_any() {
    local test_name="$1"
    local input_text="$2"
    shift 2
    local markers=("$@")

    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] $test_name"
    echo -e "  ${CYAN}Input:${NC} ${input_text:0:150}..."

    local payload
    payload=$(python3 -c "
import json, sys
print(json.dumps({
    'input': sys.argv[1],
    'context': {},
    'config_overrides': {},
    'session_id': 'rfc-test-$TOTAL',
    'metadata': {'test': sys.argv[2]}
}))
" "$input_text" "$test_name")

    local http_code
    http_code=$(curl -s -o "$TMP_RESP" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/invoke" \
        -H "Content-Type: application/json" \
        -d "$payload" 2>/dev/null)

    local body
    body=$(cat "$TMP_RESP")

    if [ "$http_code" != "200" ]; then
        record_fail "$test_name" "HTTP $http_code"
        echo -e "  ${RED}Response:${NC} $(echo "$body" | head -5)"
        echo ""; return
    fi

    local output
    output=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('output',''))" 2>/dev/null)

    local hit=false
    for marker in "${markers[@]}"; do
        if echo "$output" | grep -qi "$marker"; then hit=true; break; fi
    done

    if $hit; then
        record_pass "$test_name"
    else
        record_fail "$test_name" "output missing any of: ${markers[*]}"
    fi

    output_preview "$body"
    echo ""
}

# ===========================================================================
# TEST SUITE
# ===========================================================================
run_tests() {
    echo ""
    echo "==========================================================================="
    echo "  RFC Conflict & Evolution Analyzer — Full Test Suite"
    echo "==========================================================================="

    # -----------------------------------------------------------------------
    # SECTION 0: Smoke
    # -----------------------------------------------------------------------
    header "SECTION 0: Smoke Tests"

    info "Health endpoint"
    HTTP_CODE=$(curl -s -o "$TMP_RESP" -w "%{http_code}" "${BASE_URL}/health")
    BODY=$(cat "$TMP_RESP")
    assert_status "GET /health" "200" "$HTTP_CODE"
    assert_json_field "Health status is healthy" "$BODY" "['status']" "healthy"

    info "Agent listing"
    HTTP_CODE=$(curl -s -o "$TMP_RESP" -w "%{http_code}" "${BASE_URL}/agents")
    assert_status "GET /agents" "200" "$HTTP_CODE"

    # Confirm the sequential orchestration is wired with 4 agents
    BODY=$(cat "$TMP_RESP")
    TOTAL=$((TOTAL + 1))
    if echo "$BODY" | grep -qi "timeline_agent" && \
       echo "$BODY" | grep -qi "diff_agent" && \
       echo "$BODY" | grep -qi "conflict_detector" && \
       echo "$BODY" | grep -qi "synthesizer"; then
        record_pass "All 4 RFC agents registered (timeline/diff/conflict/synthesizer)"
    else
        record_fail "Agent registration" "expected all 4 agents in /agents response"
    fi
    echo ""

    # -----------------------------------------------------------------------
    # SECTION 1: Single-RFC Evolution (simplest happy path)
    # -----------------------------------------------------------------------
    header "SECTION 1: Single-chain Evolution"

    # TLS is the canonical case: 2246 → 4346 → 5246 → 8446
    invoke_and_verify_all \
        "TC-1.1: TLS protocol evolution end-to-end" \
        "How has TLS authentication evolved across RFCs? Walk me through the chain from the earliest TLS RFC to the current standard." \
        "2246" "4346" "5246" "8446" "TLS"

    # HTTP evolution across RFCs
    invoke_and_verify_all \
        "TC-1.2: HTTP protocol evolution (1.1 → 2 → 3)" \
        "Trace the evolution of HTTP from HTTP/1.1 to HTTP/3. Which RFCs define each version and what were the major changes?" \
        "2616" "7230" "9110" "HTTP" "evolution"

    # IPv6 core evolution
    invoke_and_verify_any \
        "TC-1.3: IPv6 addressing evolution" \
        "Summarize how the IPv6 addressing architecture has evolved across RFCs." \
        "2373" "3513" "4291" "IPv6"

    # -----------------------------------------------------------------------
    # SECTION 2: Conflict Detection
    # -----------------------------------------------------------------------
    header "SECTION 2: Conflict Detection"

    # TLS 1.2 vs 1.3 — classic cipher-suite deprecation & handshake diff
    invoke_and_verify_all \
        "TC-2.1: TLS 1.2 vs TLS 1.3 conflicts" \
        "Do RFC 5246 (TLS 1.2) and RFC 8446 (TLS 1.3) conflict in their handshake requirements or cipher suite rules? Identify specific contradictions." \
        "5246" "8446" "handshake" "cipher"

    # HTTP/1.1 persistence semantics drift
    invoke_and_verify_any \
        "TC-2.2: HTTP/1.1 persistence semantics across RFC 2616 and RFC 7230" \
        "Does RFC 2616 conflict with RFC 7230 on persistent connection semantics? Be specific about sections." \
        "2616" "7230" "conflict" "persistent"

    # OAuth 2.0 vs 2.1 draft — requirement-level changes
    invoke_and_verify_any \
        "TC-2.3: OAuth 2.0 requirement changes" \
        "What requirement-level changes (MUST / SHOULD) occurred between OAuth 2.0 (RFC 6749) and later OAuth RFCs or errata? Flag any contradictions." \
        "6749" "OAuth" "MUST" "SHOULD"

    # -----------------------------------------------------------------------
    # SECTION 3: Ambiguity / Requirement-mismatch queries
    # -----------------------------------------------------------------------
    header "SECTION 3: Ambiguities & Requirement Mismatches"

    invoke_and_verify_any \
        "TC-3.1: JSON Web Token (JWT) ambiguities" \
        "Are there any ambiguities or implementation-dependent behaviors in the JWT RFC chain (7519 and related)?" \
        "7519" "JWT" "ambig"

    invoke_and_verify_any \
        "TC-3.2: SMTP extensions — conflicting mandates" \
        "Do any SMTP extension RFCs (e.g., RFC 5321 vs its extensions) impose conflicting requirements on servers?" \
        "5321" "SMTP"

    # -----------------------------------------------------------------------
    # SECTION 4: Synthesizer behavior — narrative quality
    # -----------------------------------------------------------------------
    header "SECTION 4: Synthesizer Narrative Quality"

    # The synthesizer should produce structured output with
    # headings, executive summary, and a recommendation block.
    invoke_and_verify_all \
        "TC-4.1: Synthesizer produces executive summary + recommendation" \
        "Produce a full evolution and conflict analysis for the TLS RFC chain. Include recommendations for implementers." \
        "summary" "recommend" "implement" "TLS" "8446"

    # -----------------------------------------------------------------------
    # SECTION 5: Guardrails
    # -----------------------------------------------------------------------
    header "SECTION 5: Guardrails & Validation"

    # 5.1 Empty input (min_length: 5 per config)
    info "Empty input validation"
    TOTAL=$((TOTAL + 1))
    HTTP_CODE=$(curl -s -o "$TMP_RESP" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/invoke" \
        -H "Content-Type: application/json" \
        -d '{
            "input": "",
            "context": {}, "config_overrides": {},
            "session_id": "guardrail-empty", "metadata": {}
        }')
    if [ "$HTTP_CODE" = "422" ] || [ "$HTTP_CODE" = "400" ] || [ "$HTTP_CODE" = "500" ]; then
        record_pass "Empty input rejected (HTTP $HTTP_CODE)"
    else
        record_fail "Empty input guardrail" "expected 4xx/5xx, got HTTP $HTTP_CODE"
    fi
    echo ""

    # 5.2 Too-short input (3 chars, below min_length 5)
    info "Too-short input validation"
    TOTAL=$((TOTAL + 1))
    HTTP_CODE=$(curl -s -o "$TMP_RESP" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/invoke" \
        -H "Content-Type: application/json" \
        -d '{
            "input": "hi",
            "context": {}, "config_overrides": {},
            "session_id": "guardrail-short", "metadata": {}
        }')
    if [ "$HTTP_CODE" = "400" ] || [ "$HTTP_CODE" = "422" ] || [ "$HTTP_CODE" = "500" ]; then
        record_pass "Too-short input rejected (HTTP $HTTP_CODE)"
    else
        record_fail "Too-short guardrail" "expected 4xx/5xx, got HTTP $HTTP_CODE"
    fi
    echo ""

    # 5.3 Missing input field
    info "Missing input field"
    HTTP_CODE=$(curl -s -o "$TMP_RESP" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/invoke" \
        -H "Content-Type: application/json" \
        -d '{"context": {}}')
    assert_status "Missing input → 422" "422" "$HTTP_CODE"
    echo ""

    # -----------------------------------------------------------------------
    # SECTION 6: SSE Streaming
    # -----------------------------------------------------------------------
    header "SECTION 6: SSE Streaming"

    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] TC-6.1: SSE stream — TLS evolution"
    HTTP_CODE=$(curl -s -o "$TMP_SSE" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/stream" \
        -H "Content-Type: application/json" \
        -H "Accept: text/event-stream" \
        -d '{
            "input": "Give me a short summary of the TLS RFC chain: 2246, 4346, 5246, 8446.",
            "context": {}, "config_overrides": {},
            "session_id": "sse-rfc-tls", "metadata": {"test": "TC-6.1"}
        }')
    if [ "$HTTP_CODE" = "200" ] && [ -s "$TMP_SSE" ]; then
        SSE_SIZE=$(wc -c < "$TMP_SSE")
        if grep -qiE "(TLS|2246|8446)" "$TMP_SSE"; then
            record_pass "TC-6.1: SSE stream with RFC pipeline ($SSE_SIZE bytes, TLS markers found)"
        else
            record_pass "TC-6.1: SSE stream returned response ($SSE_SIZE bytes)"
        fi
    else
        record_fail "TC-6.1: SSE stream" "HTTP $HTTP_CODE or empty response"
    fi
    echo -e "  ${CYAN}First SSE events:${NC}"
    head -20 "$TMP_SSE" 2>/dev/null | sed 's/^/    /'
    echo ""

    # -----------------------------------------------------------------------
    # SECTION 7: Edge cases
    # -----------------------------------------------------------------------
    header "SECTION 7: Edge Cases"

    # 7.1 RFC that has no known obsoleters/updates (should still produce a coherent answer)
    invoke_and_verify_any \
        "TC-7.1: Standalone RFC (no obsoletes/updated-by)" \
        "Describe the evolution of RFC 1149 (IP over Avian Carriers). Are there any related or updating RFCs?" \
        "1149" "avian" "carrier" "humor" "update"

    # 7.2 Non-existent RFC number — agents should gracefully report nothing found
    invoke_and_verify_any \
        "TC-7.2: Non-existent RFC number" \
        "Analyze the evolution of RFC 99999. What does it say?" \
        "not found" "no such" "does not exist" "unknown" "unable" "no results" "cannot find"

    # 7.3 Multi-topic query — tests that pipeline stays on task
    invoke_and_verify_any \
        "TC-7.3: Multi-topic: TLS and DTLS relationship" \
        "How are TLS and DTLS related across their RFC chains? Do they conflict?" \
        "TLS" "DTLS" "6347" "9147"

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
    start)
        start_server
        ;;
    stop)
        stop_server
        ;;
    test)
        run_tests
        ;;
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
        echo "  start  — Start server with RFC analyzer config"
        echo "  test   — Run the full suite (smoke + evolution + conflict + SSE)"
        echo "  stop   — Stop the server"
        echo "  all    — Start, test, and stop"
        echo ""
        echo "Environment variables:"
        echo "  BASE_URL               — Server URL    (default: http://localhost:8000)"
        echo "  TIMEOUT                — curl max-time (default: 900s)"
        echo "  RFC_METADATA_API_KEY   — Bearer token for rfc-metadata MCP server"
        ;;
esac
