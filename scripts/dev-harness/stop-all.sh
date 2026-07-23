#!/usr/bin/env bash
# Stop background processes started by the *.sh --bg scripts.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS="${HERE}/logs"

stop_pid_file() {
  local label="$1" file="$2"
  if [[ ! -f "$file" ]]; then
    echo "  $label: no pidfile, skipping"
    return
  fi
  local pid
  pid="$(cat "$file" 2>/dev/null || true)"
  if [[ -z "$pid" ]] || ! kill -0 "$pid" >/dev/null 2>&1; then
    echo "  $label: not running (pid=$pid)"
    rm -f "$file"
    return
  fi
  echo "  $label: stopping pid=$pid"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 30); do
    sleep 0.5
    kill -0 "$pid" >/dev/null 2>&1 || break
  done
  if kill -0 "$pid" >/dev/null 2>&1; then
    echo "  $label: still up, sending SIGKILL"
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$file"
}

echo "Stopping dev-harness background processes..."
stop_pid_file "eval-worker"      "${LOGS}/eval-worker.pid"
stop_pid_file "workflow-engine"  "${LOGS}/workflow-engine.pid"
stop_pid_file "temporal"         "${LOGS}/temporal.pid"
echo "Done."
