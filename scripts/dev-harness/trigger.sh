#!/usr/bin/env bash
# Fire one evaluation through the locally-running stack and watch it complete.
#
# Pass `--runMode <mode>` to switch run mode (default: single).
#
# Examples:
#   ./trigger.sh
#   ./trigger.sh --runMode ab_compare
#   ./trigger.sh --runMode tuning_sweep
#   ./trigger.sh --runMode regression

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
WORKER_DIR="${REPO_ROOT}/src/nemo/workers/eval-worker"

export TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS:-localhost:7233}"
export WORKFLOW_ENGINE_URL="${WORKFLOW_ENGINE_URL:-http://localhost:8080}"

cd "$WORKER_DIR"
exec npx ts-node --transpile-only scripts/trigger-eval.ts "$@"
