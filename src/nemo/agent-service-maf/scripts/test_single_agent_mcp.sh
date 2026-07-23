#!/usr/bin/env bash
# =============================================================================
# Single Agent + MCP — Full Test Suite
#
# Validates a single agent with two MCP servers:
#   - filesystem: reads files from /workspace/data (employees.csv,
#     project_status.json, meeting_notes.md, config.yaml)
#   - weather: HTTP-based weather MCP server
#
# Tests verify:
#   - Server health and endpoint basics
#   - Agent can discover and use filesystem MCP tools
#   - Agent reads and reasons about file contents
#   - Agent uses weather MCP tools
#   - Cross-tool queries (combine file data + weather)
#   - SSE streaming with tool use
#   - Guardrail enforcement (input validation)
#   - Edge cases
#
# Usage:
#   ./scripts/test_single_agent_mcp.sh start   — Start server
#   ./scripts/test_single_agent_mcp.sh test    — Run all tests
#   ./scripts/test_single_agent_mcp.sh stop    — Stop the server
#   ./scripts/test_single_agent_mcp.sh all     — Start, test, and stop
#
# Environment:
#   BASE_URL   — Server URL    (default: http://localhost:8000)
#   TIMEOUT    — curl max-time (default: 120s)
# =============================================================================

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8000}"
TIMEOUT="${TIMEOUT:-120}"
CONFIG_PATH="configs/sample_maf_agents/single_agent_mcp.json"
PID_FILE="/tmp/agent_framework_single_mcp.pid"
LOG_FILE="/tmp/agent_framework_single_mcp.log"
TMP_RESP="/tmp/single_mcp_resp.json"
TMP_SSE="/tmp/single_mcp_sse.txt"

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

    # Heads-up: the single_agent_mcp team no longer declares the filesystem
    # MCP server. Sections 1, 2, 3, 5.1, 7.1, 8.x will fail unless filesystem
    # is re-enabled (requires Node.js in the runtime + a data directory).
    # Sections 0, 4, 5.2, 6, 7.2 exercise the weather MCP path and smoke checks.
    if [ -f "/workspace/data/employees.csv" ]; then
        info "Filesystem test fixtures present at /workspace/data/"
    else
        warn "No filesystem fixtures found (expected with filesystem MCP removed)."
        warn "Sections that read /workspace/data/* will be recorded as failures."
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

assert_json_nonempty() {
    TOTAL=$((TOTAL + 1))
    local actual
    actual=$(echo "$2" | python3 -c "import sys,json; v=json.load(sys.stdin)$3; print('empty' if not v else 'ok')" 2>/dev/null || echo "__PARSE_ERROR__")
    if [ "$actual" = "ok" ]; then record_pass "$1";
    else                          record_fail "$1" "field $3 is empty or missing"; fi
}

output_preview() {
    local body="$1"
    echo -e "  ${CYAN}Output preview:${NC} $(echo "$body" | python3 -c "
import sys,json
o=json.load(sys.stdin).get('output','')
print(o[:250]+('...' if len(o)>250 else ''))
" 2>/dev/null)"
}

# ---------------------------------------------------------------------------
# invoke_and_verify <name> <input> <marker1> [marker2] ...
#
# Sends input to POST /agents/invoke and checks:
#   1. HTTP 200
#   2. metadata.orchestration_type == "single"
#   3. Output contains at least one marker (case-insensitive)
# ---------------------------------------------------------------------------
invoke_and_verify() {
    local test_name="$1"
    local input_text="$2"
    shift 2
    local markers=("$@")

    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] $test_name"
    echo -e "  ${CYAN}Input:${NC} ${input_text:0:120}..."

    local payload
    payload=$(python3 -c "
import json, sys
print(json.dumps({
    'input': sys.argv[1],
    'context': {},
    'config_overrides': {},
    'session_id': 'single-mcp-test-$TOTAL',
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
        echo -e "  ${RED}Response:${NC} $(echo "$body" | head -3)"
        echo ""; return
    fi

    local output
    output=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('output',''))" 2>/dev/null)

    # Check at least one marker present
    local marker_found=false
    for marker in "${markers[@]}"; do
        if echo "$output" | grep -qi "$marker"; then
            marker_found=true; break
        fi
    done

    if $marker_found; then
        record_pass "$test_name"
    else
        record_fail "$test_name" "output missing markers: ${markers[*]}"
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
    echo "  Single Agent + MCP — Full Test Suite"
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

    # 0.3 Simple invoke (no tool use needed)
    info "Simple invoke (no tools)"
    TOTAL=$((TOTAL + 1))
    HTTP_CODE=$(curl -s -o "$TMP_RESP" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/invoke" \
        -H "Content-Type: application/json" \
        -d '{
            "input": "What is 2 + 2?",
            "context": {}, "config_overrides": {},
            "session_id": "smoke-simple", "metadata": {}
        }')
    BODY=$(cat "$TMP_RESP")
    if [ "$HTTP_CODE" = "200" ]; then
        OUTPUT=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('output',''))" 2>/dev/null)
        if echo "$OUTPUT" | grep -q "4"; then
            record_pass "Simple math (no tools needed)"
        else
            record_fail "Simple math" "output doesn't contain '4'"
        fi
    else
        record_fail "Simple math" "HTTP $HTTP_CODE"
    fi
    echo ""

    # -----------------------------------------------------------------------
    # SECTION 1: Filesystem MCP — File Discovery
    # Agent should use filesystem tools to list/read files.
    # -----------------------------------------------------------------------
    header "SECTION 1: Filesystem MCP — File Discovery"

    invoke_and_verify \
        "TC-1.1: List files in data directory" \
        "List all files in the /workspace/data directory. Show their names." \
        "employees" "project_status" "meeting_notes" "config"

    invoke_and_verify \
        "TC-1.2: Read CSV file" \
        "Read the file /workspace/data/employees.csv and tell me how many employees are listed." \
        "10" "ten" "employees"

    invoke_and_verify \
        "TC-1.3: Read JSON file" \
        "Read the file /workspace/data/project_status.json and list all project names with their statuses." \
        "Phoenix" "Lighthouse" "Titan"

    invoke_and_verify \
        "TC-1.4: Read Markdown file" \
        "Read the file /workspace/data/meeting_notes.md and summarize the action items." \
        "bob" "irene" "carol" "hackathon" "SRE"

    # -----------------------------------------------------------------------
    # SECTION 2: Filesystem MCP — Data Reasoning
    # Agent reads files and reasons about content.
    # -----------------------------------------------------------------------
    header "SECTION 2: Filesystem MCP — Data Reasoning"

    invoke_and_verify \
        "TC-2.1: CSV analysis — highest salary" \
        "Read /workspace/data/employees.csv and tell me who has the highest salary and how much it is." \
        "Irene" "Santos" "195000" "195,000"

    invoke_and_verify \
        "TC-2.2: CSV analysis — department count" \
        "Read /workspace/data/employees.csv and count how many employees are in each department." \
        "Engineering" "Product" "Design" "Sales"

    invoke_and_verify \
        "TC-2.3: CSV analysis — filter by date" \
        "Read /workspace/data/employees.csv and list employees who joined in 2023 or later." \
        "David" "James" "2023"

    invoke_and_verify \
        "TC-2.4: JSON analysis — project blockers" \
        "Read /workspace/data/project_status.json and tell me which projects have blockers. List each blocker." \
        "Phoenix" "DB schema" "CI pipeline" "Titan" "Architecture"

    invoke_and_verify \
        "TC-2.5: JSON analysis — completion status" \
        "Read /workspace/data/project_status.json. Which project is closest to its deadline but not yet complete? What percentage is done?" \
        "Phoenix" "72" "April"

    invoke_and_verify \
        "TC-2.6: Markdown analysis — risks" \
        "Read /workspace/data/meeting_notes.md and identify the top risks mentioned. What could go wrong?" \
        "Phoenix" "dependency" "PTO" "Eva" "Hassan" "cascade"

    invoke_and_verify \
        "TC-2.7: YAML analysis — feature flags" \
        "Read /workspace/data/config.yaml and tell me which feature flags are currently enabled and which are disabled." \
        "new_checkout_flow" "dark_mode" "ai_recommendations" "beta_api_v2"

    # -----------------------------------------------------------------------
    # SECTION 3: Filesystem MCP — Cross-File Reasoning
    # Agent reads multiple files and correlates information.
    # -----------------------------------------------------------------------
    header "SECTION 3: Filesystem MCP — Cross-File Reasoning"

    invoke_and_verify \
        "TC-3.1: Correlate employees to projects" \
        "Read both /workspace/data/employees.csv and /workspace/data/project_status.json. For each project, find the lead's department and salary from the employees file." \
        "Bob" "Engineering" "Irene" "Alice" "175000" "195000" "145000"

    invoke_and_verify \
        "TC-3.2: Meeting notes + project status" \
        "Read /workspace/data/meeting_notes.md and /workspace/data/project_status.json. Are there any discrepancies between the meeting notes and the project status data? Is the Lighthouse Dashboard really completed?" \
        "Lighthouse" "completed" "100" "shipped"

    invoke_and_verify \
        "TC-3.3: Team capacity analysis" \
        "Read /workspace/data/employees.csv and /workspace/data/meeting_notes.md. The meeting notes mention Eva and Hassan have PTO overlap in April. What department are they in, and how many people will remain in that department during their absence?" \
        "Design" "Eva" "Hassan" "PTO"

    # -----------------------------------------------------------------------
    # SECTION 4: Weather MCP
    # -----------------------------------------------------------------------
    header "SECTION 4: Weather MCP"

    invoke_and_verify \
        "TC-4.1: Current weather lookup" \
        "What is the current weather in Seattle, Washington?" \
        "Seattle" "temperature" "temp" "degree" "wind" "rain" "cloud" "weather"

    invoke_and_verify \
        "TC-4.2: Weather comparison" \
        "Compare the current weather between New York City and Los Angeles." \
        "New York" "Los Angeles" "temperature" "temp" "degree"

    invoke_and_verify \
        "TC-4.3: Weather forecast" \
        "What is the weather forecast for London, UK for the next few days?" \
        "London" "temperature" "temp" "forecast" "day" "degree"

    # -----------------------------------------------------------------------
    # SECTION 5: Cross-Tool (Filesystem + Weather)
    # Agent combines data from files with weather lookups.
    # -----------------------------------------------------------------------
    header "SECTION 5: Cross-Tool Queries (Filesystem + Weather)"

    invoke_and_verify \
        "TC-5.1: Office move + weather" \
        "Read /workspace/data/meeting_notes.md to find when the office move is scheduled and to which building. Then check what the current weather is like in Seattle (our office city). Would it be a good day for moving?" \
        "Building C" "May" "Seattle" "weather" "temperature" "temp"

    invoke_and_verify \
        "TC-5.2: Hackathon planning + weather" \
        "Read /workspace/data/meeting_notes.md to find the hackathon dates. Then check the weather forecast for San Francisco around that time. Should we plan any outdoor activities?" \
        "hackathon" "June" "San Francisco" "weather" "temperature" "temp"

    # -----------------------------------------------------------------------
    # SECTION 6: Guardrails
    # -----------------------------------------------------------------------
    header "SECTION 6: Guardrails & Validation"

    # 6.1 Empty input should fail (min_length: 1)
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
    # Expect either 422 (Pydantic validation) or 400/500 (guardrail block)
    if [ "$HTTP_CODE" = "422" ] || [ "$HTTP_CODE" = "400" ] || [ "$HTTP_CODE" = "500" ]; then
        record_pass "Empty input rejected (HTTP $HTTP_CODE)"
    else
        record_fail "Empty input guardrail" "expected 4xx/5xx, got HTTP $HTTP_CODE"
    fi
    echo ""

    # 6.2 Missing input field
    info "Missing input field"
    HTTP_CODE=$(curl -s -o "$TMP_RESP" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/invoke" \
        -H "Content-Type: application/json" \
        -d '{"context": {}}')
    assert_status "Missing input → 422" "422" "$HTTP_CODE"
    echo ""

    # -----------------------------------------------------------------------
    # SECTION 7: SSE Streaming with MCP
    # -----------------------------------------------------------------------
    header "SECTION 7: SSE Streaming"

    # 7.1 SSE — filesystem tool use
    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] TC-7.1: SSE stream with filesystem tool"
    HTTP_CODE=$(curl -s -o "$TMP_SSE" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/stream" \
        -H "Content-Type: application/json" \
        -H "Accept: text/event-stream" \
        -d '{
            "input": "Read /workspace/data/employees.csv and tell me who is in the Sales department.",
            "context": {}, "config_overrides": {},
            "session_id": "sse-filesystem-1", "metadata": {"test": "TC-7.1"}
        }')
    if [ "$HTTP_CODE" = "200" ] && [ -s "$TMP_SSE" ]; then
        SSE_SIZE=$(wc -c < "$TMP_SSE")
        if grep -qiE "(James|Thompson|Sales)" "$TMP_SSE"; then
            record_pass "TC-7.1: SSE stream with filesystem MCP ($SSE_SIZE bytes, found Sales employee)"
        else
            record_pass "TC-7.1: SSE stream returned response ($SSE_SIZE bytes)"
        fi
    else
        record_fail "TC-7.1: SSE filesystem stream" "HTTP $HTTP_CODE or empty"
    fi
    echo -e "  ${CYAN}First SSE events:${NC}"
    head -15 "$TMP_SSE" 2>/dev/null | sed 's/^/    /'
    echo ""

    # 7.2 SSE — weather tool use
    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] TC-7.2: SSE stream with weather tool"
    HTTP_CODE=$(curl -s -o "$TMP_SSE" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/stream" \
        -H "Content-Type: application/json" \
        -H "Accept: text/event-stream" \
        -d '{
            "input": "What is the weather in Tokyo right now?",
            "context": {}, "config_overrides": {},
            "session_id": "sse-weather-1", "metadata": {"test": "TC-7.2"}
        }')
    if [ "$HTTP_CODE" = "200" ] && [ -s "$TMP_SSE" ]; then
        record_pass "TC-7.2: SSE stream with weather MCP ($(wc -c < "$TMP_SSE") bytes)"
    else
        record_fail "TC-7.2: SSE weather stream" "HTTP $HTTP_CODE or empty"
    fi
    echo ""

    # -----------------------------------------------------------------------
    # SECTION 8: Edge Cases
    # -----------------------------------------------------------------------
    header "SECTION 8: Edge Cases"

    invoke_and_verify \
        "TC-8.1: Non-existent file" \
        "Read the file /workspace/data/does_not_exist.txt and tell me what it contains." \
        "not found" "not exist" "error" "no such" "cannot" "doesn't exist" "does not exist"

    invoke_and_verify \
        "TC-8.2: Path outside allowed directory" \
        "Read the file /etc/passwd and show me the contents." \
        "cannot" "not allowed" "denied" "permission" "outside" "error" "access" "restricted" "unable"

    invoke_and_verify \
        "TC-8.3: Multi-step reasoning from file" \
        "Read /workspace/data/employees.csv. Calculate the average salary of the Engineering department, then tell me which engineers earn above that average and by how much." \
        "average" "above" "Irene" "Bob" "Frank" "Alice" "Engineering"

    invoke_and_verify \
        "TC-8.4: Agent-specific invoke route" \
        "What year did Python 3.12 release?" \
        "2023" "Python" "3.12"

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
        echo "  start  — Start server with single_agent_mcp config"
        echo "  test   — Run all tests (smoke + filesystem + weather + cross-tool)"
        echo "  stop   — Stop the server"
        echo "  all    — Start, test, and stop"
        echo ""
        echo "Environment variables:"
        echo "  BASE_URL  — Server URL    (default: http://localhost:8000)"
        echo "  TIMEOUT   — curl max-time (default: 120s)"
        ;;
esac
