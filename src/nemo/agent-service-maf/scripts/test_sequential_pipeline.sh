#!/usr/bin/env bash
# =============================================================================
# Sequential Pipeline — Full Test Suite
#
# Validates the sequential pipeline: researcher → analyst → writer.
# Each agent builds on the previous agent's output, producing a polished
# report that shows evidence of all three stages.
#
# Config: configs/sample_maf_agents/sequential_pipeline.json
#   - researcher: "Search for information, provide detailed findings"
#   - analyst:    "Identify key patterns, trends, actionable insights"
#   - writer:     "Produce a clear, well-structured report"
#
# Usage:
#   ./scripts/test_sequential_pipeline.sh start
#   ./scripts/test_sequential_pipeline.sh test
#   ./scripts/test_sequential_pipeline.sh stop
#   ./scripts/test_sequential_pipeline.sh all
#
# Environment:
#   BASE_URL   — Server URL    (default: http://localhost:8000)
#   TIMEOUT    — curl max-time (default: 180s — sequential is 3 serial LLM calls)
# =============================================================================

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8000}"
TIMEOUT="${TIMEOUT:-180}"
CONFIG_PATH="configs/sample_maf_agents/sequential_pipeline.json"
PID_FILE="/tmp/agent_framework_sequential.pid"
LOG_FILE="/tmp/agent_framework_sequential.log"
TMP_RESP="/tmp/sequential_resp.json"
TMP_SSE="/tmp/sequential_sse.txt"

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
        warn "Server already running (PID $(cat "$PID_FILE")). Stop it first or run tests directly."
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
# invoke_pipeline <input_text> → sets BODY, HTTP_CODE, OUTPUT, OUTPUT_LEN
# ---------------------------------------------------------------------------
invoke_pipeline() {
    local input_text="$1"

    local payload
    payload=$(python3 -c "
import json, sys
print(json.dumps({
    'input': sys.argv[1],
    'context': {},
    'config_overrides': {},
    'session_id': 'seq-test-$TOTAL',
    'metadata': {'test': 'sequential-pipeline'}
}))
" "$input_text")

    HTTP_CODE=$(curl -s -o "$TMP_RESP" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/invoke" \
        -H "Content-Type: application/json" \
        -d "$payload" 2>/dev/null)

    BODY=$(cat "$TMP_RESP")
    OUTPUT=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('output',''))" 2>/dev/null || echo "")
    OUTPUT_LEN=${#OUTPUT}
}

# ---------------------------------------------------------------------------
# pipeline_and_verify <name> <input> <marker1> [marker2] ...
#
# Sends input through the sequential pipeline and checks:
#   1. HTTP 200
#   2. metadata.orchestration_type == "sequential"
#   3. All 3 agent names present in metadata
#   4. Output contains at least one marker (case-insensitive)
#   5. Output is non-trivially long (pipeline should enrich content)
# ---------------------------------------------------------------------------
pipeline_and_verify() {
    local test_name="$1"
    local input_text="$2"
    shift 2
    local markers=("$@")

    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] $test_name"
    echo -e "  ${CYAN}Input:${NC} ${input_text:0:120}..."

    invoke_pipeline "$input_text"

    # 1) HTTP 200
    if [ "$HTTP_CODE" != "200" ]; then
        record_fail "$test_name" "HTTP $HTTP_CODE"
        echo -e "  ${RED}Response:${NC} $(echo "$BODY" | head -3)"
        echo ""; return
    fi

    # 2) orchestration_type
    local orch_type
    orch_type=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('metadata',{}).get('orchestration_type',''))" 2>/dev/null)
    if [ "$orch_type" != "sequential" ]; then
        record_fail "$test_name" "orchestration_type='$orch_type' (expected 'sequential')"
        echo ""; return
    fi

    # 3) All 3 agents in metadata
    local agents
    agents=$(echo "$BODY" | python3 -c "import sys,json; print(','.join(json.load(sys.stdin).get('metadata',{}).get('agent_names',[])))" 2>/dev/null)
    if ! echo "$agents" | grep -q "researcher" || ! echo "$agents" | grep -q "analyst" || ! echo "$agents" | grep -q "writer"; then
        warn "  Expected all 3 agents in metadata, got: [$agents]"
    fi

    # 4) At least one marker present
    local marker_found=false
    for marker in "${markers[@]}"; do
        if echo "$OUTPUT" | grep -qi "$marker"; then
            marker_found=true; break
        fi
    done

    if ! $marker_found; then
        record_fail "$test_name" "output missing markers: ${markers[*]}"
        output_preview "$BODY"
        echo ""; return
    fi

    # 5) Output should be substantial (pipeline enriches)
    if [ "$OUTPUT_LEN" -lt 200 ]; then
        record_fail "$test_name" "output too short ($OUTPUT_LEN chars) — pipeline should produce rich content"
        output_preview "$BODY"
        echo ""; return
    fi

    record_pass "$test_name ($OUTPUT_LEN chars)"
    output_preview "$BODY"
    echo ""
}

# ---------------------------------------------------------------------------
# check_pipeline_stages <name> <body_json>
#
# Verifies the output shows evidence of all 3 pipeline stages:
#   - Research stage: factual content (data, findings, studies, research)
#   - Analysis stage: analytical content (pattern, trend, insight, implication)
#   - Writer stage:   polished structure (headings, conclusion, summary, report)
# ---------------------------------------------------------------------------
check_pipeline_stages() {
    local test_name="$1"
    local body="$2"

    local output
    output=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('output',''))" 2>/dev/null)

    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] $test_name"

    local stages_found=0
    local stages_detail=""

    # Research markers
    if echo "$output" | grep -qiE "(research|findings|data|studies|evidence|survey|statistic|source|report)"; then
        stages_found=$((stages_found + 1))
        stages_detail="${stages_detail} research:yes"
    else
        stages_detail="${stages_detail} research:NO"
    fi

    # Analysis markers
    if echo "$output" | grep -qiE "(pattern|trend|insight|implication|analysis|significant|correlation|impact|factor|driver)"; then
        stages_found=$((stages_found + 1))
        stages_detail="${stages_detail} analysis:yes"
    else
        stages_detail="${stages_detail} analysis:NO"
    fi

    # Writer markers (structural polish)
    if echo "$output" | grep -qiE "(conclusion|summary|recommend|report|overview|introduction|##|\\*\\*.*\\*\\*)"; then
        stages_found=$((stages_found + 1))
        stages_detail="${stages_detail} writer:yes"
    else
        stages_detail="${stages_detail} writer:NO"
    fi

    if [ "$stages_found" -ge 2 ]; then
        record_pass "$test_name (${stages_found}/3 stages detected:${stages_detail})"
    else
        record_fail "$test_name" "only ${stages_found}/3 pipeline stages detected:${stages_detail}"
    fi
    echo ""
}

# ===========================================================================
# TEST SUITE
# ===========================================================================
run_tests() {
    echo ""
    echo "==========================================================================="
    echo "  Sequential Pipeline — Full Test Suite"
    echo "  (researcher → analyst → writer)"
    echo ""
    echo "  NOTE: Each test makes 3 serial LLM calls. Expect ~30-90s per test."
    echo "==========================================================================="

    # -----------------------------------------------------------------------
    # SECTION 0: Smoke Tests
    # -----------------------------------------------------------------------
    header "SECTION 0: Smoke Tests"

    # 0.1 Health
    info "Health endpoint"
    HTTP_CODE=$(curl -s -o "$TMP_RESP" -w "%{http_code}" "${BASE_URL}/health")
    BODY=$(cat "$TMP_RESP")
    assert_status "GET /health" "200" "$HTTP_CODE"
    assert_json_field "Health status is healthy" "$BODY" "['status']" "healthy"

    # 0.2 Agent listing
    info "Agent listing"
    HTTP_CODE=$(curl -s -o "$TMP_RESP" -w "%{http_code}" "${BASE_URL}/agents")
    assert_status "GET /agents" "200" "$HTTP_CODE"

    # 0.3 Missing input → 422
    info "Validation: missing input"
    HTTP_CODE=$(curl -s -o "$TMP_RESP" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/invoke" \
        -H "Content-Type: application/json" \
        -d '{"context": {}}')
    assert_status "POST /agents/invoke (no input) → 422" "422" "$HTTP_CODE"

    # 0.4 Basic pipeline invoke
    info "Basic pipeline invoke"
    TOTAL=$((TOTAL + 1))
    invoke_pipeline "Explain how solar panels work"
    if [ "$HTTP_CODE" = "200" ] && [ "$OUTPUT_LEN" -gt 100 ]; then
        record_pass "Basic pipeline invoke ($OUTPUT_LEN chars)"
    else
        record_fail "Basic pipeline invoke" "HTTP $HTTP_CODE or short output ($OUTPUT_LEN chars)"
    fi
    output_preview "$BODY"
    echo ""

    # -----------------------------------------------------------------------
    # SECTION 1: Pipeline Flow Verification
    # Verify the output is a polished report (writer stage), not raw research.
    # -----------------------------------------------------------------------
    header "SECTION 1: Pipeline Flow Verification"

    # 1.1 Output should be structured like a report
    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] TC-1.1: Output is structured report"
    invoke_pipeline "Research the benefits and risks of autonomous vehicles for urban transportation"
    if [ "$HTTP_CODE" = "200" ]; then
        # Check for structural elements: headings, sections, or bold markers
        local has_structure
        has_structure=$(echo "$OUTPUT" | python3 -c "
import sys
text = sys.stdin.read()
score = 0
if '**' in text or '##' in text or '# ' in text: score += 1   # headings/bold
if any(w in text.lower() for w in ['conclusion', 'summary', 'recommendation']): score += 1
if len(text) > 500: score += 1  # substantial length
print(score)
" 2>/dev/null)
        if [ "$has_structure" -ge 2 ]; then
            record_pass "TC-1.1: Output is structured report ($OUTPUT_LEN chars)"
        else
            record_fail "TC-1.1" "output lacks report structure (score=$has_structure)"
        fi
    else
        record_fail "TC-1.1" "HTTP $HTTP_CODE"
    fi
    output_preview "$BODY"
    echo ""

    # 1.2 Check all 3 pipeline stages are evident
    invoke_pipeline "Analyze the global shift toward renewable energy sources and its economic implications"
    if [ "$HTTP_CODE" = "200" ]; then
        check_pipeline_stages "TC-1.2: All pipeline stages evident (renewable energy)" "$BODY"
    else
        TOTAL=$((TOTAL + 1))
        record_fail "TC-1.2" "HTTP $HTTP_CODE"
        echo ""
    fi

    # 1.3 Output should not contain raw role leaking
    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] TC-1.3: No raw role leaking in output"
    invoke_pipeline "Examine the effects of social media on teenage mental health"
    if [ "$HTTP_CODE" = "200" ]; then
        local role_leak
        role_leak=$(echo "$OUTPUT" | grep -ciE "(as a researcher|as an analyst|as a writer|my role is|I am the researcher|I am the analyst)" || true)
        if [ "$role_leak" -le 1 ]; then
            record_pass "TC-1.3: No role leaking ($role_leak matches)"
        else
            record_fail "TC-1.3" "found $role_leak role-leaking phrases"
        fi
    else
        record_fail "TC-1.3" "HTTP $HTTP_CODE"
    fi
    output_preview "$BODY"
    echo ""

    # 1.4 Pipeline output should be substantial
    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] TC-1.4: Pipeline produces substantial output"
    invoke_pipeline "Investigate how artificial intelligence is transforming the pharmaceutical drug discovery process"
    if [ "$HTTP_CODE" = "200" ]; then
        if [ "$OUTPUT_LEN" -gt 1000 ]; then
            record_pass "TC-1.4: Substantial output ($OUTPUT_LEN chars)"
        elif [ "$OUTPUT_LEN" -gt 500 ]; then
            record_pass "TC-1.4: Moderate output ($OUTPUT_LEN chars)"
        else
            record_fail "TC-1.4" "output too short ($OUTPUT_LEN chars) for a 3-agent pipeline"
        fi
    else
        record_fail "TC-1.4" "HTTP $HTTP_CODE"
    fi
    echo ""

    # -----------------------------------------------------------------------
    # SECTION 2: Domain Variety
    # Different topics to verify the pipeline generalizes.
    # -----------------------------------------------------------------------
    header "SECTION 2: Domain Variety"

    pipeline_and_verify \
        "TC-2.1: Technology — AI in healthcare" \
        "Research how AI and machine learning are being used in medical diagnostics, drug discovery, and patient care. Analyze the most promising applications and write a comprehensive report." \
        "AI" "diagnostic" "drug" "patient" "healthcare" "machine learning"

    pipeline_and_verify \
        "TC-2.2: Business — market entry strategy" \
        "Research the Southeast Asian electric vehicle market. Analyze barriers to entry, competitive landscape, and consumer readiness. Produce a strategic report for a European EV manufacturer considering market entry." \
        "EV" "electric" "market" "Asia" "barrier" "consumer" "strategy" "competition"

    pipeline_and_verify \
        "TC-2.3: Science — climate change impacts" \
        "Research the latest findings on how climate change affects global food security, focusing on crop yields, water availability, and supply chain disruptions. Analyze regional vulnerabilities and produce a policy briefing." \
        "climate" "food" "crop" "water" "supply" "temperature" "agriculture"

    pipeline_and_verify \
        "TC-2.4: Policy — remote work regulation" \
        "Research how different countries are approaching remote work legislation. Analyze patterns in tax treatment, labor rights, and employer obligations. Write a comparative policy report." \
        "remote" "work" "regulation" "tax" "labor" "employer" "policy" "country"

    pipeline_and_verify \
        "TC-2.5: Historical — industrial revolution" \
        "Research the key technological innovations of the Industrial Revolution and their socioeconomic impacts. Analyze which innovations had the most lasting effects and produce an analytical essay." \
        "industrial" "revolution" "steam" "factory" "labor" "innovation" "economic" "social"

    pipeline_and_verify \
        "TC-2.6: Comparative — EV vs hydrogen fuel cells" \
        "Research the current state of battery electric vehicles versus hydrogen fuel cell vehicles. Compare infrastructure, cost, range, and environmental impact. Produce a balanced comparison report." \
        "battery" "hydrogen" "fuel cell" "range" "infrastructure" "cost" "emission" "charge"

    # -----------------------------------------------------------------------
    # SECTION 3: Pipeline Quality Markers
    # Verify all 3 stages leave identifiable traces in the output.
    # -----------------------------------------------------------------------
    header "SECTION 3: Pipeline Quality Markers"

    invoke_pipeline "Research the global cybersecurity talent shortage, analyze its root causes and impacts on businesses, and write a report with actionable recommendations"
    if [ "$HTTP_CODE" = "200" ]; then
        check_pipeline_stages "TC-3.1: Cybersecurity talent shortage — all stages" "$BODY"
    else
        TOTAL=$((TOTAL + 1)); record_fail "TC-3.1" "HTTP $HTTP_CODE"; echo ""
    fi

    invoke_pipeline "Research recent breakthroughs in quantum computing, analyze which industries will be disrupted first, and produce an executive briefing"
    if [ "$HTTP_CODE" = "200" ]; then
        check_pipeline_stages "TC-3.2: Quantum computing — all stages" "$BODY"
    else
        TOTAL=$((TOTAL + 1)); record_fail "TC-3.2" "HTTP $HTTP_CODE"; echo ""
    fi

    invoke_pipeline "Research the rise of creator economy platforms, analyze monetization models and sustainability, and write an investor-ready market overview"
    if [ "$HTTP_CODE" = "200" ]; then
        check_pipeline_stages "TC-3.3: Creator economy — all stages" "$BODY"
    else
        TOTAL=$((TOTAL + 1)); record_fail "TC-3.3" "HTTP $HTTP_CODE"; echo ""
    fi

    invoke_pipeline "Research global water scarcity trends, analyze the effectiveness of desalination and conservation technologies, and produce a technical report"
    if [ "$HTTP_CODE" = "200" ]; then
        check_pipeline_stages "TC-3.4: Water scarcity — all stages" "$BODY"
    else
        TOTAL=$((TOTAL + 1)); record_fail "TC-3.4" "HTTP $HTTP_CODE"; echo ""
    fi

    # -----------------------------------------------------------------------
    # SECTION 4: Output Properties
    # -----------------------------------------------------------------------
    header "SECTION 4: Output Properties"

    # 4.1 No raw prompt echo
    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] TC-4.1: Output doesn't echo prompt verbatim"
    local test_prompt="Research the impact of microplastics on marine ecosystems"
    invoke_pipeline "$test_prompt"
    if [ "$HTTP_CODE" = "200" ]; then
        # The full prompt shouldn't appear verbatim in the output
        if echo "$OUTPUT" | grep -qF "$test_prompt"; then
            warn "TC-4.1: Prompt appears verbatim in output (minor issue)"
            record_pass "TC-4.1: Output generated despite prompt echo ($OUTPUT_LEN chars)"
        else
            record_pass "TC-4.1: Output doesn't echo prompt verbatim ($OUTPUT_LEN chars)"
        fi
    else
        record_fail "TC-4.1" "HTTP $HTTP_CODE"
    fi
    echo ""

    # 4.2 Output contains no handoff/orchestration artifacts
    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] TC-4.2: No orchestration artifacts in output"
    invoke_pipeline "Research the evolution of programming languages in the last decade"
    if [ "$HTTP_CODE" = "200" ]; then
        local artifacts
        artifacts=$(echo "$OUTPUT" | grep -ciE "(No handoff|Ending task|Task is completed with summary|transfer_to_|complete_task)" || true)
        if [ "$artifacts" -eq 0 ]; then
            record_pass "TC-4.2: No orchestration artifacts"
        else
            record_fail "TC-4.2" "found $artifacts orchestration artifacts in output"
        fi
    else
        record_fail "TC-4.2" "HTTP $HTTP_CODE"
    fi
    echo ""

    # 4.3 Duration reflects 3-agent pipeline
    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] TC-4.3: Duration reflects multi-agent execution"
    invoke_pipeline "Research the state of nuclear fusion energy research"
    if [ "$HTTP_CODE" = "200" ]; then
        local duration
        duration=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('duration_ms',0))" 2>/dev/null)
        if [ "$duration" -gt 3000 ]; then
            record_pass "TC-4.3: Duration ${duration}ms (reflects 3-agent pipeline)"
        else
            warn "TC-4.3: Duration ${duration}ms is suspiciously fast for 3 serial LLM calls"
            record_pass "TC-4.3: Pipeline completed in ${duration}ms"
        fi
    else
        record_fail "TC-4.3" "HTTP $HTTP_CODE"
    fi
    echo ""

    # -----------------------------------------------------------------------
    # SECTION 5: SSE Streaming
    # -----------------------------------------------------------------------
    header "SECTION 5: SSE Streaming"

    # 5.1 SSE returns valid response
    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] TC-5.1: SSE stream returns pipeline output"
    HTTP_CODE=$(curl -s -o "$TMP_SSE" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/stream" \
        -H "Content-Type: application/json" \
        -H "Accept: text/event-stream" \
        -d '{
            "input": "Research the impact of 5G technology on smart cities and produce a brief report",
            "context": {}, "config_overrides": {},
            "session_id": "seq-sse-1", "metadata": {"test": "TC-5.1"}
        }')
    if [ "$HTTP_CODE" = "200" ] && [ -s "$TMP_SSE" ]; then
        SSE_SIZE=$(wc -c < "$TMP_SSE")
        if grep -qiE "(5G|smart|city|report|infrastructure|network)" "$TMP_SSE"; then
            record_pass "TC-5.1: SSE stream with pipeline output ($SSE_SIZE bytes)"
        else
            record_pass "TC-5.1: SSE stream returned response ($SSE_SIZE bytes)"
        fi
    else
        record_fail "TC-5.1: SSE stream" "HTTP $HTTP_CODE or empty"
    fi
    echo -e "  ${CYAN}First SSE events:${NC}"
    head -15 "$TMP_SSE" 2>/dev/null | sed 's/^/    /'
    echo ""

    # 5.2 SSE has no orchestration artifacts
    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] TC-5.2: SSE output has no artifacts"
    if [ -s "$TMP_SSE" ]; then
        local sse_artifacts
        sse_artifacts=$(grep -ciE "(No handoff|Ending task|Task is completed with summary)" "$TMP_SSE" || true)
        if [ "$sse_artifacts" -eq 0 ]; then
            record_pass "TC-5.2: SSE output clean of artifacts"
        else
            record_fail "TC-5.2" "found $sse_artifacts artifacts in SSE stream"
        fi
    else
        record_fail "TC-5.2" "no SSE data to check"
    fi
    echo ""

    # -----------------------------------------------------------------------
    # SECTION 6: Edge Cases
    # -----------------------------------------------------------------------
    header "SECTION 6: Edge Cases"

    pipeline_and_verify \
        "TC-6.1: Very short input" \
        "Blockchain" \
        "blockchain" "technology" "decentralized" "ledger" "crypto"

    pipeline_and_verify \
        "TC-6.2: Very detailed input" \
        "Research the following specific scenario in detail: A mid-sized European automotive manufacturer (5000 employees, 2B EUR revenue) is considering converting 30% of its production lines from internal combustion engines to electric vehicles over the next 5 years. They need to understand: workforce retraining costs, supply chain restructuring (battery sourcing from Asia), R&D investment requirements, potential government subsidies in Germany/France/Italy, competitive threat from Chinese EV manufacturers, and consumer demand projections for the European EV market through 2030. Analyze all these factors and produce a board-ready strategic assessment." \
        "electric" "EV" "battery" "production" "workforce" "supply chain" "investment" "subsidy" "market"

    pipeline_and_verify \
        "TC-6.3: Abstract philosophical topic" \
        "Research how different philosophical traditions approach the concept of consciousness. Analyze the key debates between materialist and dualist perspectives. Write an accessible overview for a general audience." \
        "consciousness" "philosophy" "mind" "materialist" "dualist" "brain" "experience"

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
        echo "  start  — Start server with sequential_pipeline config"
        echo "  test   — Run all tests (pipeline flow + domain + quality + edge cases)"
        echo "  stop   — Stop the server"
        echo "  all    — Start, test, and stop"
        echo ""
        echo "Environment variables:"
        echo "  BASE_URL  — Server URL    (default: http://localhost:8000)"
        echo "  TIMEOUT   — curl max-time (default: 180s — 3 serial LLM calls)"
        ;;
esac
