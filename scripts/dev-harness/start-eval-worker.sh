#!/usr/bin/env bash
# Start the eval-worker as a local Node process. Artifact writes land under
# NEMO_DEFAULT_STORE_ROOT (defaults to a tmpdir below so a local dev run
# never touches /mnt/pvcs).
# config-service and agent-service are NOT mocked — set CONFIG_SERVICE_URL
# and AGENT_SERVICE_URL to reachable services before starting (e.g.
# http://host.docker.internal:8001/api/v1 for a local agent-service-maf on
# the host).
#
# Foreground by default. Pass `--bg` to daemonise.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
LOGS="${HERE}/logs"
mkdir -p "$LOGS"

WORKER_DIR="${REPO_ROOT}/src/nemo/workers/eval-worker"
LOG_FILE="${LOGS}/eval-worker.log"
PID_FILE="${LOGS}/eval-worker.pid"

export TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS:-localhost:7233}"
export TEMPORAL_NAMESPACE="${TEMPORAL_NAMESPACE:-default}"
export LOG_LEVEL="${LOG_LEVEL:-info}"
export METRICS_PORT="${METRICS_PORT:-9465}"

# POSIX store: results land under
# NEMO_DEFAULT_STORE_ROOT/projects/{pid}/evaluations/{evalId}/runs/{runId}/.
# Default to a tmpdir so a local dev run never touches /mnt/pvcs.
export NEMO_DEFAULT_STORE_ROOT="${NEMO_DEFAULT_STORE_ROOT:-/tmp/eval-worker-store}"
mkdir -p "$NEMO_DEFAULT_STORE_ROOT"

# Set CONFIG_SERVICE_URL and AGENT_SERVICE_URL to reachable services before
# running — both are always real, never mocked.

cd "$WORKER_DIR"

# Pre-bundle workflows once. The bundler aliases @/lib/evaluation/index.ts
# to workflow-safe.ts so trigger.ts (which imports node:crypto) doesn't get
# pulled into the workflow sandbox. Skip with REBUNDLE=0 if you know nothing
# in src/workflows or src/lib/evaluation changed since the last run.
if [[ "${REBUNDLE:-1}" != "0" ]]; then
  echo "Bundling workflows..."
  npx ts-node --transpile-only scripts/bundle-workflows.ts
  cp tmp/workflow-bundles-eval/workflow-bundle.js src/workflow-bundle.js
fi

# Use the locally-installed ts-node to run main.ts. --transpile-only skips
# the slow tsc type-check pass on each restart; the test/build pipelines
# still type-check.
CMD=(npx ts-node --transpile-only src/main.ts)

if [[ "${1:-}" == "--bg" ]]; then
  echo "Starting eval-worker in background"
  echo "  temporal=$TEMPORAL_ADDRESS  config-url=${CONFIG_SERVICE_URL:-<unset>}  agent-url=${AGENT_SERVICE_URL:-<unset>}  store=${NEMO_DEFAULT_STORE_ROOT}"
  nohup "${CMD[@]}" >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  echo "  pid=$(cat "$PID_FILE")  log=$LOG_FILE"
else
  echo "Starting eval-worker (foreground)"
  echo "  temporal=$TEMPORAL_ADDRESS  config-url=${CONFIG_SERVICE_URL:-<unset>}  agent-url=${AGENT_SERVICE_URL:-<unset>}  store=${NEMO_DEFAULT_STORE_ROOT}"
  exec "${CMD[@]}"
fi
