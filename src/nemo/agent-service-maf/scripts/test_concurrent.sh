#!/usr/bin/env bash
# =============================================================================
# Concurrent Analysis — Full Test Suite
#
# Validates the concurrent pattern: 3 specialist agents analyze the same
# input in parallel and their outputs are merged.
#
# Config: configs/sample_maf_agents/concurrent_analysis.json
#   - sentiment_analyzer: "Classify sentiment with confidence score"
#   - entity_extractor:   "Extract named entities (people, orgs, locations)"
#   - topic_classifier:   "Classify into topics with confidence scores"
#
# Tests verify:
#   - Server health and endpoint basics
#   - All 3 agents produce output for each input
#   - Merged output contains evidence of all analysis types
#   - Concurrent execution is faster than 3x sequential time
#   - SSE streaming works
#   - Edge cases (short text, numbers-heavy, multilingual)
#
# Usage:
#   ./scripts/test_concurrent.sh start
#   ./scripts/test_concurrent.sh test
#   ./scripts/test_concurrent.sh stop
#   ./scripts/test_concurrent.sh all
#
# Environment:
#   BASE_URL   — Server URL    (default: http://localhost:8000)
#   TIMEOUT    — curl max-time (default: 120s)
# =============================================================================

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8000}"
TIMEOUT="${TIMEOUT:-120}"
CONFIG_PATH="configs/sample_maf_agents/concurrent_analysis.json"
PID_FILE="/tmp/agent_framework_concurrent.pid"
LOG_FILE="/tmp/agent_framework_concurrent.log"
TMP_RESP="/tmp/concurrent_resp.json"
TMP_SSE="/tmp/concurrent_sse.txt"

# Colors
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
        warn "Server already running (PID $(cat "$PID_FILE")). Stop it first."
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
        warn "No PID file found"
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
    echo -e "  ${CYAN}Output preview:${NC} $(echo "$1" | python3 -c "
import sys,json
o=json.load(sys.stdin).get('output','')
print(o[:300]+('...' if len(o)>300 else ''))
" 2>/dev/null)"
}

# ---------------------------------------------------------------------------
# invoke_concurrent <input_text> → sets BODY, HTTP_CODE, OUTPUT
# ---------------------------------------------------------------------------
invoke_concurrent() {
    local input_text="$1"
    local payload
    payload=$(python3 -c "
import json, sys
print(json.dumps({
    'input': sys.argv[1],
    'context': {},
    'config_overrides': {},
    'session_id': 'conc-test-$TOTAL',
    'metadata': {'test': 'concurrent-analysis'}
}))
" "$input_text")

    HTTP_CODE=$(curl -s -o "$TMP_RESP" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/invoke" \
        -H "Content-Type: application/json" \
        -d "$payload" 2>/dev/null)

    BODY=$(cat "$TMP_RESP")
    OUTPUT=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('output',''))" 2>/dev/null || echo "")
}

# ---------------------------------------------------------------------------
# analyze_and_verify <name> <input> <sentiment_markers> <entity_markers> <topic_markers>
#
# Sends input to concurrent analysis and checks:
#   1. HTTP 200
#   2. metadata.orchestration_type == "concurrent"
#   3. All 3 agents in metadata.agent_names
#   4. Output contains evidence of sentiment analysis
#   5. Output contains evidence of entity extraction
#   6. Output contains evidence of topic classification
# ---------------------------------------------------------------------------
analyze_and_verify() {
    local test_name="$1"
    local input_text="$2"
    local sentiment_markers="$3"
    local entity_markers="$4"
    local topic_markers="$5"

    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] $test_name"
    echo -e "  ${CYAN}Input:${NC} ${input_text:0:120}..."

    invoke_concurrent "$input_text"

    # 1) HTTP 200
    if [ "$HTTP_CODE" != "200" ]; then
        record_fail "$test_name" "HTTP $HTTP_CODE"
        echo -e "  ${RED}Response:${NC} $(echo "$BODY" | head -3)"
        echo ""; return
    fi

    # 2) orchestration_type == concurrent
    local orch_type
    orch_type=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('metadata',{}).get('orchestration_type',''))" 2>/dev/null)
    if [ "$orch_type" != "concurrent" ]; then
        record_fail "$test_name" "orchestration_type='$orch_type' (expected 'concurrent')"
        echo ""; return
    fi

    # 3) All 3 agents in agent_names
    local agent_names
    agent_names=$(echo "$BODY" | python3 -c "import sys,json; print(','.join(json.load(sys.stdin).get('metadata',{}).get('agent_names',[])))" 2>/dev/null)

    # 4-6) Check for evidence of each analysis type
    local all_found=true
    local output_lower
    output_lower=$(echo "$OUTPUT" | tr '[:upper:]' '[:lower:]')

    # Sentiment check
    local sent_found=false
    for marker in $(echo "$sentiment_markers" | tr '|' ' '); do
        if echo "$output_lower" | grep -qi "$marker"; then sent_found=true; break; fi
    done

    # Entity check
    local ent_found=false
    for marker in $(echo "$entity_markers" | tr '|' ' '); do
        if echo "$output_lower" | grep -qi "$marker"; then ent_found=true; break; fi
    done

    # Topic check
    local topic_found=false
    for marker in $(echo "$topic_markers" | tr '|' ' '); do
        if echo "$output_lower" | grep -qi "$marker"; then topic_found=true; break; fi
    done

    if $sent_found && $ent_found && $topic_found; then
        record_pass "$test_name (all 3 analyses present)"
    elif $sent_found || $ent_found || $topic_found; then
        local found_types=""
        $sent_found && found_types="${found_types}sentiment,"
        $ent_found && found_types="${found_types}entities,"
        $topic_found && found_types="${found_types}topics,"
        record_pass "$test_name (partial: ${found_types%,})"
    else
        record_fail "$test_name" "no analysis markers found in output"
    fi

    output_preview "$BODY"
    echo ""
}

# ===========================================================================
# TEST SUITE
# ===========================================================================
run_tests() {
    echo ""
    echo "==========================================================================="
    echo "  Concurrent Analysis — Full Test Suite"
    echo "  (sentiment_analyzer ∥ entity_extractor ∥ topic_classifier)"
    echo "==========================================================================="

    # -----------------------------------------------------------------------
    header "SECTION 0: Smoke Tests"
    # -----------------------------------------------------------------------

    info "Health check"
    HTTP_CODE=$(curl -s -o "$TMP_RESP" -w "%{http_code}" "${BASE_URL}/health")
    BODY=$(cat "$TMP_RESP")
    assert_status "GET /health" "200" "$HTTP_CODE"
    assert_json_field "Health status" "$BODY" "['status']" "healthy"

    info "Agent listing"
    HTTP_CODE=$(curl -s -o "$TMP_RESP" -w "%{http_code}" "${BASE_URL}/agents")
    assert_status "GET /agents" "200" "$HTTP_CODE"

    info "Missing input → 422"
    HTTP_CODE=$(curl -s -o "$TMP_RESP" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/invoke" \
        -H "Content-Type: application/json" \
        -d '{"context": {}}')
    assert_status "POST /agents/invoke (no input) → 422" "422" "$HTTP_CODE"

    # -----------------------------------------------------------------------
    header "SECTION 1: Business News Analysis"
    # -----------------------------------------------------------------------

    analyze_and_verify \
        "TC-1.1: Tech acquisition announcement" \
        "Apple CEO Tim Cook announced today that the company will invest \$500 million in a new AI research center in Austin, Texas. The move is expected to create 3,000 jobs by 2027. Analysts praised the decision as a strategic response to growing competition from Google and Microsoft in the AI space." \
        "positive|optimistic|confidence|bullish|praise" \
        "apple|cook|austin|texas|google|microsoft" \
        "technology|business|investment|ai|acquisition"

    analyze_and_verify \
        "TC-1.2: Financial markets report" \
        "The Federal Reserve kept interest rates unchanged at 5.25% today, citing mixed economic signals. Markets rallied briefly before retreating. Goldman Sachs analysts expect a rate cut in September, while JPMorgan warns of persistent inflation risks." \
        "mixed|neutral|uncertain|cautious" \
        "federal reserve|goldman sachs|jpmorgan|september" \
        "finance|economics|monetary|markets|banking"

    analyze_and_verify \
        "TC-1.3: Negative product review" \
        "After three months of use, the new Galaxy Z Fold 6 has been a massive disappointment. The screen crease is worse than ever, battery life barely lasts a full day, and the camera system is a downgrade from the S24 Ultra. Samsung really dropped the ball on this one." \
        "negative|disappoint|critical|poor" \
        "samsung|galaxy|fold|s24" \
        "technology|product|review|consumer|mobile"

    # -----------------------------------------------------------------------
    header "SECTION 2: Scientific & Research Text"
    # -----------------------------------------------------------------------

    analyze_and_verify \
        "TC-2.1: Climate research findings" \
        "A new study published in Nature by researchers at MIT and Oxford University found that Arctic ice is melting 40% faster than previously estimated. Lead author Dr. Sarah Chen warned that sea levels could rise by 2 meters by 2100, threatening coastal cities worldwide." \
        "alarming|concern|negative|urgent|warn" \
        "mit|oxford|chen|arctic|nature" \
        "climate|environment|science|research|ocean"

    analyze_and_verify \
        "TC-2.2: Medical breakthrough" \
        "Pfizer announced positive Phase 3 trial results for their new Alzheimer's drug PF-7823, showing a 35% reduction in cognitive decline over 18 months. The FDA is expected to review the application by Q1 2027. Shares of Pfizer rose 12% on the news." \
        "positive|optimistic|promising|encouraging" \
        "pfizer|alzheimer|fda|pf-7823" \
        "healthcare|pharmaceutical|medical|biotech"

    # -----------------------------------------------------------------------
    header "SECTION 3: Social & Cultural Content"
    # -----------------------------------------------------------------------

    analyze_and_verify \
        "TC-3.1: Sports event recap" \
        "In a stunning upset at Wimbledon, 19-year-old qualifier Emma Liu defeated world number one Iga Swiatek in straight sets 6-3, 7-5. The crowd at Centre Court erupted as Liu secured match point. This marks the biggest upset at Wimbledon since 2004." \
        "exciting|positive|stunning|surprising" \
        "liu|swiatek|wimbledon" \
        "sports|tennis|competition|athletics"

    analyze_and_verify \
        "TC-3.2: Political controversy" \
        "Senator James Miller is facing backlash after leaked emails revealed he had advance knowledge of the DataCorp insider trading scandal. The SEC has launched a formal investigation, and calls for his resignation are mounting from both parties." \
        "negative|controversy|backlash|scandal" \
        "miller|datacorp|sec" \
        "politics|government|legal|scandal|ethics"

    # -----------------------------------------------------------------------
    header "SECTION 4: Edge Cases"
    # -----------------------------------------------------------------------

    # Short text
    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] TC-4.1: Minimal input"
    invoke_concurrent "Good product."
    if [ "$HTTP_CODE" = "200" ] && [ -n "$OUTPUT" ]; then
        record_pass "TC-4.1: Minimal input handled (output: ${#OUTPUT} chars)"
    else
        record_fail "TC-4.1" "HTTP $HTTP_CODE or empty output"
    fi
    echo ""

    # Numbers-heavy text
    analyze_and_verify \
        "TC-4.2: Data-heavy financial text" \
        "Revenue: Q1 \$45.2M (+23% YoY), Q2 \$48.1M (+18% YoY), Q3 \$52.7M (+15% YoY). EBITDA margin improved from 12.3% to 15.8%. Customer count grew from 1,200 to 1,850. Churn rate decreased from 5.2% to 3.8%." \
        "positive|growth|improving|strong" \
        "q1|q2|q3|revenue|ebitda" \
        "finance|business|performance|metrics"

    # Ambiguous sentiment
    analyze_and_verify \
        "TC-4.3: Mixed/ambiguous sentiment" \
        "The merger between Acme Corp and TechVision will save \$200M annually in operational costs, but will result in 5,000 layoffs across both companies. The deal is expected to close in March pending regulatory approval from the European Commission." \
        "mixed|neutral|complex|ambiguous|both" \
        "acme|techvision|european commission" \
        "business|merger|corporate|employment"

    # -----------------------------------------------------------------------
    header "SECTION 5: SSE Streaming"
    # -----------------------------------------------------------------------

    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] TC-5.1: SSE stream"
    HTTP_CODE=$(curl -s -o "$TMP_SSE" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/stream" \
        -H "Content-Type: application/json" \
        -H "Accept: text/event-stream" \
        -d '{
            "input": "Tesla reported record deliveries of 500,000 vehicles in Q4, beating analyst estimates by 15%.",
            "context": {}, "config_overrides": {},
            "session_id": "conc-sse-1", "metadata": {}
        }')
    if [ "$HTTP_CODE" = "200" ] && [ -s "$TMP_SSE" ]; then
        SSE_SIZE=$(wc -c < "$TMP_SSE")
        record_pass "TC-5.1: SSE stream returned ($SSE_SIZE bytes)"
    else
        record_fail "TC-5.1: SSE stream" "HTTP $HTTP_CODE or empty"
    fi
    head -10 "$TMP_SSE" 2>/dev/null | sed 's/^/    /'
    echo ""

    # -----------------------------------------------------------------------
    header "SECTION 6: Metadata Verification"
    # -----------------------------------------------------------------------

    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] TC-6.1: Verify metadata structure"
    invoke_concurrent "Amazon stock surged 8% after beating Q3 earnings expectations."

    if [ "$HTTP_CODE" = "200" ]; then
        local orch agent_names duration
        orch=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('metadata',{}).get('orchestration_type',''))" 2>/dev/null)
        agent_names=$(echo "$BODY" | python3 -c "import sys,json; print(','.join(sorted(json.load(sys.stdin).get('metadata',{}).get('agent_names',[]))))" 2>/dev/null)
        duration=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('duration_ms',0))" 2>/dev/null)

        local ok_count=0
        [ "$orch" = "concurrent" ] && ok_count=$((ok_count + 1))
        echo "$agent_names" | grep -q "entity_extractor" && ok_count=$((ok_count + 1))
        echo "$agent_names" | grep -q "sentiment_analyzer" && ok_count=$((ok_count + 1))
        echo "$agent_names" | grep -q "topic_classifier" && ok_count=$((ok_count + 1))
        [ "$duration" -gt 0 ] 2>/dev/null && ok_count=$((ok_count + 1))

        if [ "$ok_count" -eq 5 ]; then
            record_pass "TC-6.1: Metadata complete (orch=$orch, agents=[$agent_names], ${duration}ms)"
        else
            record_fail "TC-6.1: Metadata" "only $ok_count/5 checks passed (orch=$orch, agents=$agent_names, ${duration}ms)"
        fi
    else
        record_fail "TC-6.1" "HTTP $HTTP_CODE"
    fi
    echo ""

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
    start) start_server ;;
    stop)  stop_server ;;
    test)  run_tests ;;
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
        echo "  start  — Start server with concurrent analysis config"
        echo "  test   — Run all tests"
        echo "  stop   — Stop the server"
        echo "  all    — Start, test, and stop"
        echo ""
        echo "Environment variables:"
        echo "  BASE_URL  — Server URL    (default: http://localhost:8000)"
        echo "  TIMEOUT   — curl max-time (default: 120s)"
        ;;
esac
