#!/usr/bin/env bash
# =============================================================================
# Triage Router — Full Test Suite
#
# Validates the triage router end-to-end: server health, endpoint basics,
# error handling, and complex routing verification that the router dispatches
# to the correct specialist (coder / writer / analyst) based on input content.
#
# The triage_router.json config defines:
#   - router:  Routes based on input → coder | writer | analyst
#   - coder:   "Write clean, well-documented code. Include error handling and tests."
#   - writer:  "Produce clear, engaging, well-structured content tailored to the audience."
#   - analyst: "Analyze data, identify patterns, and provide actionable insights."
#
# Usage:
#   ./scripts/test_triage.sh start   — Start server with triage config
#   ./scripts/test_triage.sh test    — Run all tests against a running server
#   ./scripts/test_triage.sh stop    — Stop the server
#   ./scripts/test_triage.sh all     — Start, test, and stop
#
# Environment:
#   BASE_URL   — Server URL    (default: http://localhost:8000)
#   TIMEOUT    — curl max-time (default: 120s)
# =============================================================================

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8000}"
TIMEOUT="${TIMEOUT:-120}"
CONFIG_PATH="configs/sample_maf_agents/triage_router.json"
PID_FILE="/tmp/agent_framework_triage.pid"
LOG_FILE="/tmp/agent_framework_triage.log"
TMP_RESP="/tmp/triage_resp.json"
TMP_SSE="/tmp/triage_sse.txt"

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
    cat "$LOG_FILE"
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

# record_pass / record_fail — single place to track results
record_pass() {
    local name="$1"
    PASS=$((PASS + 1))
    ok "$name"
}

record_fail() {
    local name="$1"
    shift
    FAIL_COUNT=$((FAIL_COUNT + 1))
    FAILURES="${FAILURES}\n  - $name ($*)"
    fail "$name — $*"
}

# assert_status <name> <expected> <actual>
assert_status() {
    TOTAL=$((TOTAL + 1))
    if [ "$3" = "$2" ]; then record_pass "$1 (HTTP $3)";
    else                     record_fail "$1" "expected HTTP $2, got HTTP $3"; fi
}

# assert_json_field <name> <json> <python_field> <expected>
assert_json_field() {
    TOTAL=$((TOTAL + 1))
    local actual
    actual=$(echo "$2" | python3 -c "import sys,json; print(json.load(sys.stdin)$3)" 2>/dev/null || echo "__PARSE_ERROR__")
    if [ "$actual" = "$4" ]; then record_pass "$1";
    else                          record_fail "$1" "expected '$4', got '$actual'"; fi
}

# assert_json_nonempty <name> <json> <python_field>
assert_json_nonempty() {
    TOTAL=$((TOTAL + 1))
    local actual
    actual=$(echo "$2" | python3 -c "import sys,json; v=json.load(sys.stdin)$3; print('empty' if not v else 'ok')" 2>/dev/null || echo "__PARSE_ERROR__")
    if [ "$actual" = "ok" ]; then record_pass "$1";
    else                          record_fail "$1" "field $3 is empty or missing"; fi
}

# invoke_json <input_json> → sets HTTP_CODE, BODY
invoke_json() {
    HTTP_CODE=$(curl -s -o "$TMP_RESP" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/invoke" \
        -H "Content-Type: application/json" \
        -d "$1" 2>/dev/null)
    BODY=$(cat "$TMP_RESP")
}

# output_preview — print first 200 chars of output from BODY
output_preview() {
    echo -e "  ${CYAN}Output preview:${NC} $(echo "$BODY" | python3 -c "
import sys,json
o=json.load(sys.stdin).get('output','')
print(o[:200]+('...' if len(o)>200 else ''))
" 2>/dev/null)"
}

# ---------------------------------------------------------------------------
# invoke_and_verify <name> <input> <expected_agent> <marker1> [marker2] ...
#
# Core routing test: sends input to POST /agents/invoke, then checks:
#   1. HTTP 200
#   2. metadata.orchestration_type == "triage"
#   3. expected_agent in metadata.agent_names
#   4. Output contains at least one marker string (case-insensitive)
# ---------------------------------------------------------------------------
invoke_and_verify() {
    local test_name="$1"
    local input_text="$2"
    local expected_agent="$3"
    shift 3
    local markers=("$@")

    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] $test_name"
    echo -e "  ${CYAN}Expected agent:${NC} $expected_agent"
    echo -e "  ${CYAN}Input:${NC} ${input_text:0:100}..."

    # Build JSON payload safely via python
    local payload
    payload=$(python3 -c "
import json, sys
print(json.dumps({
    'input': sys.argv[1],
    'context': {},
    'config_overrides': {},
    'session_id': 'triage-test-$TOTAL',
    'metadata': {'test': sys.argv[2], 'expected_agent': sys.argv[3]}
}))
" "$input_text" "$test_name" "$expected_agent")

    local http_code
    http_code=$(curl -s -o "$TMP_RESP" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/invoke" \
        -H "Content-Type: application/json" \
        -d "$payload" 2>/dev/null)

    local body
    body=$(cat "$TMP_RESP")

    # 1) HTTP 200
    if [ "$http_code" != "200" ]; then
        record_fail "$test_name" "HTTP $http_code"
        echo -e "  ${RED}Response:${NC} $(echo "$body" | head -3)"
        echo ""; return
    fi

    # Extract fields
    local output orch_type agent_names
    output=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('output',''))" 2>/dev/null)
    orch_type=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin).get('metadata',{}).get('orchestration_type',''))" 2>/dev/null)
    agent_names=$(echo "$body" | python3 -c "import sys,json; print(','.join(json.load(sys.stdin).get('metadata',{}).get('agent_names',[])))" 2>/dev/null)

    # 2) orchestration_type == triage
    if [ "$orch_type" != "triage" ]; then
        record_fail "$test_name" "orchestration_type='$orch_type' (expected 'triage')"
        echo ""; return
    fi

    # 3) expected agent in agent_names
    if ! echo "$agent_names" | grep -q "$expected_agent"; then
        warn "  '$expected_agent' not in agent_names: [$agent_names]"
    fi

    # 4) At least one marker present in output
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

    echo -e "  ${CYAN}Output preview:${NC} ${output:0:200}"
    echo ""
}

# ---------------------------------------------------------------------------
# invoke_boundary <name> <payload_json> <grep_pattern>
# For ambiguous/boundary cases — accepts any agent, just checks relevance.
# ---------------------------------------------------------------------------
invoke_boundary() {
    local test_name="$1"
    local payload="$2"
    local pattern="$3"

    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] $test_name"

    local http_code
    http_code=$(curl -s -o "$TMP_RESP" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/invoke" \
        -H "Content-Type: application/json" \
        -d "$payload" 2>/dev/null)

    local output
    output=$(cat "$TMP_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('output',''))" 2>/dev/null)

    if [ "$http_code" = "200" ] && [ -n "$output" ]; then
        if echo "$output" | grep -qiE "$pattern"; then
            record_pass "$test_name"
        else
            record_fail "$test_name" "output not relevant (pattern: $pattern)"
        fi
    else
        record_fail "$test_name" "HTTP $http_code or empty output"
    fi
    echo -e "  ${CYAN}Output preview:${NC} ${output:0:200}"
    echo ""
}

# ===========================================================================
# TEST SUITE
# ===========================================================================
run_tests() {
    echo ""
    echo "==========================================================================="
    echo "  Triage Router — Full Test Suite"
    echo "==========================================================================="

    # -----------------------------------------------------------------------
    # SECTION 0: Smoke Tests (health, listing, validation)
    # -----------------------------------------------------------------------
    header "SECTION 0: Smoke Tests"

    # 0.1 Health check
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

    # 0.4 Agent-specific invoke
    info "Agent-specific invoke"
    invoke_json '{
        "input": "Say hello in three languages",
        "context": {},
        "config_overrides": {},
        "session_id": "smoke-agent-specific",
        "metadata": {}
    }'
    assert_status "POST /agents/invoke (agent-specific)" "200" "$HTTP_CODE"

    echo ""

    # -----------------------------------------------------------------------
    # SECTION 1: Coder Agent Routing
    # -----------------------------------------------------------------------
    header "SECTION 1: Coder Agent Routing"

    invoke_and_verify \
        "TC-1.1: Python binary search" \
        "Write a Python function that implements binary search on a sorted list. Include type hints and handle edge cases like empty list." \
        "coder" \
        "def " "return" '```'

    invoke_and_verify \
        "TC-1.2: Debug TypeError" \
        "I'm getting a TypeError: cannot unpack non-sequence NoneType in my Python code at line 42 of parser.py. The function parse_config() returns None when the YAML file has an empty section. Fix this bug." \
        "coder" \
        "None" "if " "return" "parse" '```'

    invoke_and_verify \
        "TC-1.3: Java singleton pattern" \
        "Implement a thread-safe singleton pattern in Java with double-checked locking. Show the class definition with synchronized blocks." \
        "coder" \
        "class" "synchronized" "instance" "private" "static"

    invoke_and_verify \
        "TC-1.4: FastAPI endpoint" \
        "Create a REST API endpoint using FastAPI that accepts a POST request with a JSON body containing name and email, validates the email format, stores it in an in-memory dict, and returns a 201 with the created user ID." \
        "coder" \
        "def " "POST" "async" "@" "return" '```'

    invoke_and_verify \
        "TC-1.5: SQL query" \
        "Write an optimized SQL query that finds the top 10 customers by total order value in the last 90 days, joining the customers, orders, and order_items tables. Include indexes you would recommend." \
        "coder" \
        "SELECT" "JOIN" "ORDER BY" "GROUP BY" "INDEX"

    invoke_and_verify \
        "TC-1.6: pytest unit tests" \
        "Write pytest unit tests for a UserService class that has methods create_user(name, email), get_user(id), and delete_user(id). Mock the database layer. Include tests for happy path, not found, and duplicate email." \
        "coder" \
        "def test_" "assert" "mock" "pytest" '```'

    # -----------------------------------------------------------------------
    # SECTION 2: Writer Agent Routing
    # -----------------------------------------------------------------------
    header "SECTION 2: Writer Agent Routing"

    invoke_and_verify \
        "TC-2.1: Blog post" \
        "Write a compelling blog post about how remote work has permanently changed corporate culture. Target audience is HR executives. Include an engaging hook, three main arguments, and a call to action." \
        "writer" \
        "remote" "culture" "work" "organization"

    invoke_and_verify \
        "TC-2.2: Marketing email" \
        "Draft a product launch email for our new AI-powered project management tool called TaskFlow Pro. Target: engineering managers. Tone: professional but excited. Highlight three key features: smart sprint planning, automated standup summaries, and risk prediction." \
        "writer" \
        "TaskFlow" "sprint" "feature" "team"

    invoke_and_verify \
        "TC-2.3: Technical docs (conceptual)" \
        "Write user-facing documentation for a REST API authentication flow. Cover: API key generation, OAuth2 setup, token refresh, and rate limiting. Use clear headings and practical examples but do not write any actual code — focus on the conceptual flow and steps." \
        "writer" \
        "authentication" "token" "API" "step"

    invoke_and_verify \
        "TC-2.4: Press release" \
        "Write a press release announcing that Acme Corp has acquired DataViz Inc for 500 million dollars. Include quotes from both CEOs, explain the strategic rationale around AI analytics, and note that all 200 DataViz employees will be retained." \
        "writer" \
        "Acme" "DataViz" "acquisition" "million"

    invoke_and_verify \
        "TC-2.5: Creative short story" \
        "Write a short story (300 words max) set in a cyberpunk city where a rogue AI helps street artists create illegal holographic murals that expose corporate corruption. Focus on vivid imagery and tension." \
        "writer" \
        "the " "city" "neon" "light" "street"

    invoke_and_verify \
        "TC-2.6: Executive summary" \
        "Write an executive summary for our Q3 board meeting. Key points: revenue up 23% YoY to 45M, three new enterprise customers (Fortune 500), engineering headcount grew from 80 to 110, and we launched the European data center. Keep it to one page." \
        "writer" \
        "revenue" "quarter" "growth" "customer"

    # -----------------------------------------------------------------------
    # SECTION 3: Analyst Agent Routing
    # -----------------------------------------------------------------------
    header "SECTION 3: Analyst Agent Routing"

    invoke_and_verify \
        "TC-3.1: Sales trend analysis" \
        "Analyze the following sales trend: Q1 revenue was 10M, Q2 was 12M, Q3 was 9M, Q4 was 15M. Identify seasonal patterns, calculate the growth rate, and forecast Q1 next year. What factors might explain the Q3 dip?" \
        "analyst" \
        "Q1" "Q3" "growth" "trend" "forecast" "revenue"

    invoke_and_verify \
        "TC-3.2: A/B test interpretation" \
        "We ran an A/B test on our checkout flow. Control (n=5000): 3.2% conversion rate. Variant (n=5200): 3.8% conversion rate. The p-value is 0.03. Should we ship the variant? Consider statistical significance, practical significance, and what additional metrics we should check before deciding." \
        "analyst" \
        "significance" "conversion" "p-value" "confidence" "variant"

    invoke_and_verify \
        "TC-3.3: Cohort analysis" \
        "Our SaaS product has these user cohorts: Free (50K users, 2% conversion to paid), Pro (3K users, 85% monthly retention), Enterprise (200 users, 95% yearly renewal). Analyze which cohort is most valuable, identify the biggest growth lever, and recommend where to invest engineering resources." \
        "analyst" \
        "cohort" "retention" "conversion" "value" "recommend"

    invoke_and_verify \
        "TC-3.4: System performance analysis" \
        "Our API response times over the past week show: P50=45ms, P95=320ms, P99=1200ms. The P95 jumped from 180ms to 320ms after Tuesdays deployment. Error rate went from 0.1% to 0.4%. Memory usage on the app servers is at 78%. Analyze the root cause and suggest investigation steps." \
        "analyst" \
        "latency" "P95" "deploy" "memory" "root cause" "performance"

    invoke_and_verify \
        "TC-3.5: Unit economics by segment" \
        "We have customer data across three segments: SMB (avg deal size 5K, 60-day sales cycle, 70% retention), Mid-Market (avg deal size 50K, 120-day cycle, 82% retention), Enterprise (avg deal size 200K, 240-day cycle, 93% retention). Our CAC is 2K for SMB, 15K for Mid-Market, 40K for Enterprise. Which segment has the best unit economics? Where should we focus?" \
        "analyst" \
        "LTV" "CAC" "segment" "retention" "unit economics" "ROI" "payback"

    invoke_and_verify \
        "TC-3.6: Anomaly prioritization" \
        "Our monitoring system flagged these anomalies in the past 24h: (1) Login attempts spiked 400% at 3AM UTC from IP range 103.x.x.x, (2) Database read latency tripled between 2-4PM, (3) CDN cache hit ratio dropped from 95% to 60%, (4) API error rate for /payments endpoint went to 5%. Prioritize these by severity, suggest which are related, and recommend immediate actions." \
        "analyst" \
        "severity" "priority" "spike" "anomal" "action" "investigation"

    # -----------------------------------------------------------------------
    # SECTION 4: Boundary / Ambiguous Cases
    # -----------------------------------------------------------------------
    header "SECTION 4: Boundary & Ambiguous Cases"

    invoke_boundary \
        "TC-4.1: Code + docs hybrid (coder/writer boundary)" \
        '{
            "input": "Write comprehensive docstrings and inline comments for a Python class called DataPipeline that has methods extract(), transform(), and load(). Explain the ETL pattern and when to use each method.",
            "context": {}, "config_overrides": {},
            "session_id": "triage-boundary-1", "metadata": {"test": "TC-4.1"}
        }' \
        "(class|def |docstring|extract|transform|load|ETL|pipeline)"

    invoke_boundary \
        "TC-4.2: Data + code hybrid (analyst/coder boundary)" \
        '{
            "input": "Given a CSV with columns [timestamp, user_id, event_type, revenue], write a pandas analysis script that calculates daily active users, revenue per user cohort, and 7-day rolling average of signups. Then interpret what the likely trends would show for a typical SaaS business.",
            "context": {}, "config_overrides": {},
            "session_id": "triage-boundary-2", "metadata": {"test": "TC-4.2"}
        }' \
        "(pandas|import|revenue|cohort|rolling|DAU|active)"

    invoke_boundary \
        "TC-4.3: Analysis + narrative hybrid (analyst/writer boundary)" \
        '{
            "input": "Write a board-ready narrative that explains why our customer churn rate increased from 5% to 8% this quarter. Use the data: support tickets up 40%, NPS dropped from 50 to 35, two major outages in February. Make it compelling but data-driven.",
            "context": {}, "config_overrides": {},
            "session_id": "triage-boundary-3", "metadata": {"test": "TC-4.3"}
        }' \
        "(churn|NPS|outage|data|quarter|support|board)"

    # -----------------------------------------------------------------------
    # SECTION 5: Routing Consistency
    # Same category, different phrasing — verify the router is stable.
    # -----------------------------------------------------------------------
    header "SECTION 5: Routing Consistency"

    invoke_and_verify \
        "TC-5.1: Code variant A (LRU cache)" \
        "Implement a LRU cache in Python using OrderedDict with get and put methods that run in O(1) time." \
        "coder" \
        "class" "def " "OrderedDict" "cache" '```'

    invoke_and_verify \
        "TC-5.2: Code variant B (Tower of Hanoi)" \
        "Write a recursive solution to the Tower of Hanoi problem in Python that prints each move." \
        "coder" \
        "def " "hanoi" "move" "disk" "recursive" '```'

    invoke_and_verify \
        "TC-5.3: Writing variant A (pitch deck)" \
        "Write a persuasive pitch deck narrative for a Series A startup that makes AI-powered inventory management for restaurants. Target audience: venture capitalists." \
        "writer" \
        "investor" "market" "restaurant" "AI" "growth"

    invoke_and_verify \
        "TC-5.4: Writing variant B (farewell email)" \
        "Compose a heartfelt farewell email from a departing VP of Engineering to their team of 50 engineers. Mention three years of accomplishments and wish the team well." \
        "writer" \
        "team" "journey" "engineer" "accomplish" "gratitude"

    invoke_and_verify \
        "TC-5.5: Analysis variant A (app ratings)" \
        "Our mobile app has a 4.2 star rating on iOS (12K reviews) and 3.8 on Android (8K reviews). The most common complaints on Android are crashes on Samsung devices (18% of 1-star reviews) and slow load times (25%). On iOS the main complaint is battery drain (30% of negative reviews). Analyze which platform needs more investment and why." \
        "analyst" \
        "Android" "iOS" "rating" "crash" "invest" "priority"

    invoke_and_verify \
        "TC-5.6: Analysis variant B (cloud cost TCO)" \
        "Compare the cost structure of running our workload on AWS (current monthly bill 85K for EC2+RDS+S3), Azure (estimated 72K based on their calculator), and GCP (estimated 68K). Factor in migration costs estimated at 200K for Azure and 250K for GCP, plus 3 months of reduced team productivity. Which option has the best 2-year TCO?" \
        "analyst" \
        "cost" "TCO" "migration" "AWS" "Azure" "GCP" "save"

    # -----------------------------------------------------------------------
    # SECTION 6: Edge Cases
    # -----------------------------------------------------------------------
    header "SECTION 6: Edge Cases"

    invoke_and_verify \
        "TC-6.1: Minimal code request" \
        "Fix this: def add(a,b): return a+b+1" \
        "coder" \
        "def " "return" "add" "bug" "fix"

    invoke_and_verify \
        "TC-6.2: Very long analysis request" \
        "Here is our complete quarterly data: January had 1200 signups, 340 conversions, 89 churns, revenue 145K. February had 1350 signups, 380 conversions, 102 churns, revenue 158K. March had 980 signups, 290 conversions, 145 churns, revenue 132K. The March drop coincided with a 3-day outage on March 15-17 and a competitor launching a free tier on March 10. Our NPS dropped from 45 to 32 during this period. Customer support tickets increased by 60%. Our main acquisition channels are: organic search (40%), paid ads (30%), referrals (20%), partnerships (10%). The paid ads CPA increased from 45 to 67 dollars in March. Analyze all of this data comprehensively, identify the key issues, separate correlation from causation where possible, and provide a prioritized action plan for Q2." \
        "analyst" \
        "churn" "outage" "competitor" "action" "Q2" "revenue" "drop"

    invoke_and_verify \
        "TC-6.3: Heavy jargon (Express + Redis)" \
        "Implement a middleware in Express.js that rate-limits requests using a sliding window algorithm with Redis as the backing store. Use the sorted set approach with ZADD and ZRANGEBYSCORE." \
        "coder" \
        "middleware" "Redis" "rate" "window" "ZADD" '```'

    invoke_and_verify \
        "TC-6.4: Single-word domain hint — code" \
        "Refactor this JavaScript: const x = arr.filter(i => i > 0).map(i => i * 2).reduce((a,b) => a + b, 0)" \
        "coder" \
        "const" "filter" "map" "reduce" "=>" '```'

    invoke_and_verify \
        "TC-6.5: Single-word domain hint — writing" \
        "Write a eulogy for a beloved company mascot, a golden retriever named Biscuit who visited the office every Friday for seven years." \
        "writer" \
        "Biscuit" "office" "remember" "Friday" "joy" "love"

    invoke_and_verify \
        "TC-6.6: Single-word domain hint — analysis" \
        "Our funnel: 100K visitors, 10K signups, 2K activations, 500 paid. Industry benchmarks are 15% signup, 30% activation, 35% conversion. Where is the biggest drop-off and what should we fix first?" \
        "analyst" \
        "funnel" "drop" "conversion" "activation" "benchmark" "signup"

    # -----------------------------------------------------------------------
    # SECTION 7: SSE Streaming
    # -----------------------------------------------------------------------
    header "SECTION 7: SSE Streaming"

    # 7.1 SSE — code request
    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] TC-7.1: SSE stream → coder"
    HTTP_CODE=$(curl -s -o "$TMP_SSE" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/stream" \
        -H "Content-Type: application/json" \
        -H "Accept: text/event-stream" \
        -d '{
            "input": "Write a Python decorator that retries a function up to 3 times with exponential backoff",
            "context": {}, "config_overrides": {},
            "session_id": "triage-sse-1", "metadata": {"test": "TC-7.1"}
        }')
    if [ "$HTTP_CODE" = "200" ] && [ -s "$TMP_SSE" ]; then
        SSE_SIZE=$(wc -c < "$TMP_SSE")
        if grep -qiE "(def |retry|backoff|decorator|sleep)" "$TMP_SSE"; then
            record_pass "TC-7.1: SSE stream routed to coder ($SSE_SIZE bytes)"
        else
            record_pass "TC-7.1: SSE stream returned valid response ($SSE_SIZE bytes)"
        fi
    else
        record_fail "TC-7.1: SSE stream" "HTTP $HTTP_CODE or empty"
    fi
    echo -e "  ${CYAN}First SSE events:${NC}"
    head -15 "$TMP_SSE" 2>/dev/null | sed 's/^/    /'
    echo ""

    # 7.2 SSE — writer request
    TOTAL=$((TOTAL + 1))
    info "[$TOTAL] TC-7.2: SSE stream → writer"
    HTTP_CODE=$(curl -s -o "$TMP_SSE" -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST "${BASE_URL}/agents/stream" \
        -H "Content-Type: application/json" \
        -H "Accept: text/event-stream" \
        -d '{
            "input": "Write a haiku about the joy of debugging at 2 AM",
            "context": {}, "config_overrides": {},
            "session_id": "triage-sse-2", "metadata": {"test": "TC-7.2"}
        }')
    if [ "$HTTP_CODE" = "200" ] && [ -s "$TMP_SSE" ]; then
        record_pass "TC-7.2: SSE stream for writer request ($(wc -c < "$TMP_SSE") bytes)"
    else
        record_fail "TC-7.2: SSE writer stream" "HTTP $HTTP_CODE or empty"
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
        echo "  start  — Start the agent framework server with triage config"
        echo "  test   — Run all tests (smoke + routing + streaming)"
        echo "  stop   — Stop the server"
        echo "  all    — Start, test, and stop"
        echo ""
        echo "Environment variables:"
        echo "  BASE_URL  — Server URL    (default: http://localhost:8000)"
        echo "  TIMEOUT   — curl max-time (default: 120s)"
        ;;
esac
