#!/usr/bin/env bash
# deployments/storage/storage.sh — Layer 2 Trident bootstrap (all clouds).
#
# Idempotent reconcile: re-runs apply desired state and succeed unless a real
# install/create failure occurs. Does not invoke scripts/ — logic lives under
# deployments/storage/lib/ and deployments/storage/manifests/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORAGE_DIR="$SCRIPT_DIR"
LIB_DIR="$STORAGE_DIR/lib"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"

# shellcheck source=../_lib/common.sh
source "$DEPLOY_DIR/_lib/common.sh"

CLOUD=""
ENV_NAME=""

usage() {
  cat >&2 <<EOF
Usage: storage.sh --cloud <azure|aws|gcp> --env <env>
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cloud) CLOUD="${2:-}"; shift 2 ;;
    --env)   ENV_NAME="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$CLOUD" && -n "$ENV_NAME" ]] || usage

case "$CLOUD" in
  azure|aws|gcp) ;;
  *) die "invalid --cloud '$CLOUD' (azure|aws|gcp)" ;;
esac

require_cmd python3
require_cmd kubectl

ENV_FILE="$DEPLOY_DIR/$CLOUD/envs/$ENV_NAME.yaml"
[[ -f "$ENV_FILE" ]] || die "env config not found: $ENV_FILE"

log_storage_info "cloud=$CLOUD env=$ENV_NAME"

case "$CLOUD" in
  azure)
    require_cmd az
    python3 "$LIB_DIR/azure_anf.py" --env-file "$ENV_FILE"
    ;;
  aws)
    require_cmd aws
    require_cmd helm
    python3 "$LIB_DIR/aws_fsxn.py" --env-file "$ENV_FILE"
    ;;
  gcp)
    require_cmd gcloud
    require_cmd helm
    python3 "$LIB_DIR/gcp_gcnv.py" --env-file "$ENV_FILE"
    ;;
esac

echo ""
log_storage_info "Next: make deploy CLOUD=<aks|eks|gke> ENDPOINT=... CONTAINER_IMAGE_REPO=... IMAGE_TAG=..."
log_storage_info "See deployments/docs/preprod-infra-validation.md Layer 2 checklist."
log_storage_ok "storage bootstrap complete for cloud=$CLOUD env=$ENV_NAME"
