#!/usr/bin/env bash
# Start the workflow-engine Go service as a local process.
#
# Disables:
#   - Keycloak auth (KEYCLOAK_INTERNAL_ISSUER unset → middleware no-op)
#   - MCP health auto-schedule
#   - reference-edge reconcile auto-schedule
#   - Redis explorer cache (no REDIS_URL set)
#
# So the engine starts cleanly without any other services running.
# Foreground by default. Pass `--bg` to daemonise.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
LOGS="${HERE}/logs"
mkdir -p "$LOGS"

ENGINE_DIR="${REPO_ROOT}/src/nemo/workflow-engine"
LOG_FILE="${LOGS}/workflow-engine.log"
PID_FILE="${LOGS}/workflow-engine.pid"

export PORT="${WORKFLOW_ENGINE_PORT:-8080}"
export TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS:-localhost:7233}"
# Disable background work the eval-worker dev flow doesn't need.
export MCP_HEALTH_SCHEDULE_AUTO_CREATE=false
export REF_EDGE_RECONCILE_AUTO_CREATE=false
# Auth middleware no-ops when KEYCLOAK_INTERNAL_ISSUER is empty.
unset KEYCLOAK_INTERNAL_ISSUER KEYCLOAK_ISSUER || true
unset REDIS_URL REDIS_SENTINEL_ADDRS WORKFLOW_ENGINE_PROGRESS_REDIS_URL || true

cd "$ENGINE_DIR"

CMD=(go run ./cmd/server)

if [[ "${1:-}" == "--bg" ]]; then
  echo "Starting workflow-engine in background"
  echo "  port=$PORT  temporal=$TEMPORAL_ADDRESS"
  nohup "${CMD[@]}" >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  echo "  pid=$(cat "$PID_FILE")  log=$LOG_FILE"
else
  echo "Starting workflow-engine (foreground)"
  echo "  port=$PORT  temporal=$TEMPORAL_ADDRESS"
  exec "${CMD[@]}"
fi
