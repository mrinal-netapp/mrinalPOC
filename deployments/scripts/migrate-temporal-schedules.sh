#!/usr/bin/env bash
# migrate-temporal-schedules.sh
#
# Run this script ONCE after any namespace migration that changes the
# config-service hostname (e.g. agentstudio → agentstudio-services).
#
# What it does:
#   1. Deletes the two auto-managed Temporal schedules whose workflow
#      inputs have the config-service URL baked in at creation time.
#   2. Restarts workflow-engine so EnsureMCPHealthSchedule /
#      EnsureReferenceEdgeReconcileSchedule recreate them with the
#      correct URL from the current CONFIG_SERVICE_URL env var.
#
# Post v<X> deployments this script is no longer needed: the Ensure*
# functions patch the action in-place on every startup (the AlreadyExists
# path now calls handle.Update). The script is retained for clusters that
# were deployed before that fix and still carry stale schedules in
# Temporal's Postgres.
#
# Usage:
#   ./deployments/scripts/migrate-temporal-schedules.sh [--context KIND_CONTEXT]
#
# Examples:
#   ./deployments/scripts/migrate-temporal-schedules.sh
#   ./deployments/scripts/migrate-temporal-schedules.sh --context kind-agentstudio

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
KUBECTL_CONTEXT=""
TEMPORAL_NS="agentstudio-platform"
SERVICES_NS="agentstudio-services"
TEMPORAL_ADDR="temporal.${TEMPORAL_NS}.svc.cluster.local:7233"

# ── Argument parsing ───────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --context)
      KUBECTL_CONTEXT="$2"; shift 2 ;;
    *)
      echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

KUBECTL="kubectl"
if [[ -n "$KUBECTL_CONTEXT" ]]; then
  KUBECTL="kubectl --context $KUBECTL_CONTEXT"
fi

# ── Helpers ────────────────────────────────────────────────────────────────────
temporal_cli() {
  $KUBECTL exec -n "$TEMPORAL_NS" deploy/temporal -- \
    temporal "$@" --address "$TEMPORAL_ADDR"
}

delete_schedule_if_exists() {
  local id="$1"
  echo "→ Checking schedule: $id"
  if temporal_cli schedule describe --schedule-id "$id" &>/dev/null; then
    temporal_cli schedule delete --schedule-id "$id"
    echo "  Deleted: $id"
  else
    echo "  Not found (already clean): $id"
  fi
}

# ── Pre-flight ─────────────────────────────────────────────────────────────────
echo "=== Temporal schedule migration ==="
echo "Context : ${KUBECTL_CONTEXT:-<current>}"
echo "Temporal namespace : $TEMPORAL_NS"
echo "Services namespace : $SERVICES_NS"
echo ""

# Confirm Temporal pod is reachable
if ! $KUBECTL get deploy/temporal -n "$TEMPORAL_NS" &>/dev/null; then
  echo "ERROR: temporal deployment not found in namespace $TEMPORAL_NS" >&2
  exit 1
fi

# ── Step 1: Delete stale auto-managed schedules ────────────────────────────────
echo "[1/2] Deleting stale auto-managed Temporal schedules..."
delete_schedule_if_exists "mcp-health-check"
delete_schedule_if_exists "dependency-lineage-sync"

# NOTE: User-created schedules (acq-* and kbsync-*) also carry the stale URL
# in their workflow input. However, their activities re-read CONFIG_SERVICE_URL
# from the pod env var at runtime, so they are self-healing without deletion.
# If you want to be thorough, list and delete them with:
#
#   temporal_cli schedule list | grep -E '^(acq|kbsync)-' | awk '{print $1}' \
#     | xargs -I{} temporal_cli schedule delete --schedule-id {}
#
# Only do this if dataset/KB recurring schedules are misbehaving.

echo ""
echo "[2/2] Restarting workflow-engine to recreate schedules with correct URLs..."
$KUBECTL rollout restart deployment/workflow-engine -n "$SERVICES_NS"
$KUBECTL rollout status deployment/workflow-engine -n "$SERVICES_NS" --timeout=120s

echo ""
echo "Waiting for EnsureMCPHealthSchedule / EnsureReferenceEdgeReconcileSchedule log lines..."
sleep 5
$KUBECTL logs -n "$SERVICES_NS" deploy/workflow-engine 2>&1 \
  | grep -E "schedule ensured|Patched.*action|mcp-health-check|dependency-lineage-sync" \
  | tail -10

echo ""
echo "=== Migration complete ==="
echo "Verify with:"
echo "  $KUBECTL logs -n $SERVICES_NS deploy/workflow-engine 2>&1 | grep -i 'schedule ensured'"
