#!/usr/bin/env bash
# deployments/azure/scripts/infra.sh -- Azure infra runner (Deployment Stacks).
#
# Invoked by `make infra CLOUD=azure ENV=<env> ACTION=<verb>`. Reads the single
# per-env config envs/<env>.yaml, fans it into stacks/main.bicep parameters,
# and maps the normalized verbs to native Azure commands:
#
#   plan    -> az deployment group what-if   (read-only diff; previews deletes)
#   apply   -> az stack group create         (declarative upsert; lifecycle-managed)
#   destroy -> az stack group delete         (guarded; removes managed resources)
#
# ACTION=create is accepted as a deprecated alias for apply.
#
# ENV is free-form: any envs/<env>.yaml works with no script change. Ordering /
# dependencies live in main.bicep, never here -- this script is a thin runner.
#
# Env/var inputs:
#   UNMANAGE        override actionOnUnmanage (detachAll|deleteResources|deleteAll)
#   DENY_SETTINGS   --deny-settings-mode for create (default: none)
#   CONFIRM         destroy confirmation (must equal <env>); else prompts on TTY
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AZURE_DIR="$(dirname "$SCRIPT_DIR")"
DEPLOY_DIR="$(dirname "$AZURE_DIR")"
STACKS_DIR="$AZURE_DIR/stacks"
ENVS_DIR="$AZURE_DIR/envs"
TEMPLATE_FILE="$STACKS_DIR/main.bicep"

# shellcheck source=../../_lib/common.sh
source "$DEPLOY_DIR/_lib/common.sh"

ENV_NAME=""
ACTION=""

usage() {
  cat >&2 <<EOF
Usage: infra.sh --env <env> --action <plan|apply|destroy>
  --env     environment name; resolves $ENVS_DIR/<env>.yaml
  --action  plan (default) | apply | destroy  (create is deprecated alias for apply)
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)    ENV_NAME="${2:-}"; shift 2 ;;
    --action) ACTION="${2:-}";   shift 2 ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$ENV_NAME" ]] || usage
ACTION="${ACTION:-plan}"
normalize_infra_action

# Tooling.
require_cmd az "Install the Azure CLI: https://learn.microsoft.com/cli/azure/install-azure-cli"
require_cmd yq "Install mikefarah yq v4+: https://github.com/mikefarah/yq"

# Resolve and validate the env config (this is the generic-over-ENV check).
ENV_FILE="$ENVS_DIR/$ENV_NAME.yaml"
[[ -f "$ENV_FILE" ]] || die "env config not found: $ENV_FILE
  Create it (copy an existing env) -- no other change is needed to add an environment."
[[ -f "$TEMPLATE_FILE" ]] || die "root template not found: $TEMPLATE_FILE"

# Runner-only keys.
RESOURCE_GROUP="$(yq '.resourceGroup' "$ENV_FILE")"
LOCATION="$(yq '.location' "$ENV_FILE")"
SUBSCRIPTION_ID="$(yq '.subscriptionId' "$ENV_FILE")"
STACK_NAME="$(yq '.stackName' "$ENV_FILE")"
YAML_UNMANAGE="$(yq '.actionOnUnmanage // "deleteResources"' "$ENV_FILE")"

for v in RESOURCE_GROUP LOCATION STACK_NAME; do
  val="${!v}"
  [[ -n "$val" && "$val" != "null" ]] || die "env config $ENV_FILE is missing required key: $v"
done

# Effective unmanage action: per-run UNMANAGE override -> yaml -> deleteResources.
EFFECTIVE_UNMANAGE="${UNMANAGE:-}"
[[ -n "$EFFECTIVE_UNMANAGE" ]] || EFFECTIVE_UNMANAGE="$YAML_UNMANAGE"
case "$EFFECTIVE_UNMANAGE" in
  detachAll|deleteResources|deleteAll) ;;
  *) die "invalid unmanage action '$EFFECTIVE_UNMANAGE' (detachAll|deleteResources|deleteAll)" ;;
esac
DENY_SETTINGS="${DENY_SETTINGS:-none}"

# Select subscription when a real one is configured.
if [[ -n "$SUBSCRIPTION_ID" && "$SUBSCRIPTION_ID" != "null" && "$SUBSCRIPTION_ID" != REPLACE_WITH_* ]]; then
  az account set --subscription "$SUBSCRIPTION_ID"
fi

# Build the ARM parameters file from the yaml: drop runner-only keys, wrap each
# remaining top-level key as { "value": <v> }. Only yq is required.
# `storage` is consumed by `make storage`, not main.bicep.
PARAMS_FILE="$(mktemp -t infra-params-XXXXXX.json)"
trap 'rm -f "$PARAMS_FILE"' EXIT
yq -o=json '
  {
    "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
    "contentVersion": "1.0.0.0",
    "parameters": (
      del(.env) | del(.subscriptionId) | del(.resourceGroup) | del(.stackName) | del(.actionOnUnmanage) | del(.storage) | del(.endpoint) | del(.keycloak) | del(.deploy)
      | with_entries(.value = {"value": .value})
    )
  }
' "$ENV_FILE" > "$PARAMS_FILE"

log_info "cloud=azure env=$ENV_NAME action=$ACTION"
log_info "resourceGroup=$RESOURCE_GROUP location=$LOCATION stack=$STACK_NAME"

ensure_resource_group() {
  if [[ "$(az group exists --name "$RESOURCE_GROUP")" != "true" ]]; then
    log_info "creating resource group $RESOURCE_GROUP ($LOCATION)"
    az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none
  fi
}

print_deploy_hints() {
  local cluster_name pip_name acr_server anf_account sub_id
  cluster_name="$(yq '.aks.clusterName' "$ENV_FILE")"
  pip_name="$(yq '.edge.gatewayPipName // ""' "$ENV_FILE")"
  acr_server="$(yq '.containerRegistry.loginServer // ""' "$ENV_FILE")"
  anf_account="$(yq '.anf.anfAccountName // ""' "$ENV_FILE")"
  sub_id="$(yq '.subscriptionId // ""' "$ENV_FILE")"
  echo ""
  log_info "Post-infra verification (platform ready for make storage + deploy):"
  printf '  az aks get-credentials -g %s -n %s\n' "$RESOURCE_GROUP" "$cluster_name"
  printf '  kubectl get nodes\n'
  if [[ -n "$acr_server" && "$acr_server" != "null" ]]; then
    log_info "Shared ACR: %s (AcrPull granted to kubelet MI when mode=shared)" "$acr_server"
  fi
  if [[ -n "$pip_name" && "$pip_name" != "null" ]]; then
    log_info "Edge Helm: set service.beta.kubernetes.io/azure-pip-name in values-aks.yaml to: %s" "$pip_name"
    log_info "Stack grants AKS cluster identity Network Contributor on that PIP (main.bicep) when edge.gatewayPipName is set."
  fi
  if [[ -n "$anf_account" && "$anf_account" != "null" && -n "$sub_id" && "$sub_id" != "null" ]]; then
    echo ""
    log_info "Trident auth (kubelet MI -> ANF) — expect Reader on RG + Contributor on ANF account:"
    printf '  KUBELET_OID=$(az aks show -g %s -n %s --query identityProfile.kubeletidentity.objectId -o tsv)\n' \
      "$RESOURCE_GROUP" "$cluster_name"
    printf '  az role assignment list --assignee-object-id "$KUBELET_OID" \\\n'
    printf '    --scope /subscriptions/%s/resourceGroups/%s -o table\n' "$sub_id" "$RESOURCE_GROUP"
    printf '  az role assignment list --assignee-object-id "$KUBELET_OID" \\\n'
    printf '    --scope /subscriptions/%s/resourceGroups/%s/providers/Microsoft.NetApp/netAppAccounts/%s -o table\n' \
      "$sub_id" "$RESOURCE_GROUP" "$anf_account"
  fi
  echo ""
  log_info "Next: make storage CLOUD=azure ENV=%s" "$ENV_NAME"
}

case "$ACTION" in
  plan)
    ensure_resource_group
    log_info "plan is read-only for cloud infra (VNet/AKS/ANF/ACR) — previewing creates, updates, and deletes."
    log_info "Nothing is applied until ACTION=apply."
    az deployment group what-if \
      --resource-group "$RESOURCE_GROUP" \
      --template-file "$TEMPLATE_FILE" \
      --parameters "@$PARAMS_FILE"
    ;;
  apply)
    ensure_resource_group
    log_info "applying stack '$STACK_NAME' (action-on-unmanage=$EFFECTIVE_UNMANAGE, deny-settings=$DENY_SETTINGS)"
    az stack group create \
      --name "$STACK_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --template-file "$TEMPLATE_FILE" \
      --parameters "@$PARAMS_FILE" \
      --action-on-unmanage "$EFFECTIVE_UNMANAGE" \
      --deny-settings-mode "$DENY_SETTINGS" \
      --yes
    log_ok "stack '$STACK_NAME' applied for env '$ENV_NAME'"
    print_deploy_hints
    ;;
  destroy)
    confirm_destroy "$ENV_NAME"
    log_warn "destroying stack '$STACK_NAME' in $RESOURCE_GROUP (action-on-unmanage=deleteAll)"
    az stack group delete \
      --name "$STACK_NAME" \
      --resource-group "$RESOURCE_GROUP" \
      --action-on-unmanage deleteAll \
      --yes
    log_ok "stack '$STACK_NAME' destroyed for env '$ENV_NAME'"
    ;;
  *)
    die "invalid action '$ACTION' (plan|apply|destroy)"
    ;;
esac
