#!/usr/bin/env bash
# Start the Temporal dev server (in-memory SQLite) on localhost:7233 and a
# web UI on localhost:8233.
#
# Foreground by default. Pass `--bg` to daemonise and write logs/pid into
# this dir's logs/.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS="${HERE}/logs"
mkdir -p "$LOGS"

if ! command -v temporal >/dev/null 2>&1; then
  echo "temporal CLI not found. Run scripts/dev-harness/install-temporal.sh first." >&2
  exit 1
fi

PORT="${TEMPORAL_PORT:-7233}"
UI_PORT="${TEMPORAL_UI_PORT:-8233}"
NAMESPACE="${TEMPORAL_NAMESPACE:-default}"
LOG_FILE="${LOGS}/temporal.log"
PID_FILE="${LOGS}/temporal.pid"

CMD=(temporal server start-dev
  --port "$PORT"
  --ui-port "$UI_PORT"
  --namespace "$NAMESPACE"
  --log-level info)

if [[ "${1:-}" == "--bg" ]]; then
  echo "Starting Temporal dev server in background (port=$PORT, ui=$UI_PORT, ns=$NAMESPACE)"
  nohup "${CMD[@]}" >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  echo "  pid=$(cat "$PID_FILE")  log=$LOG_FILE"
  echo "  Web UI: http://localhost:${UI_PORT}"
else
  echo "Starting Temporal dev server (foreground; Ctrl-C to stop)"
  echo "  Web UI will be at http://localhost:${UI_PORT}"
  exec "${CMD[@]}"
fi
