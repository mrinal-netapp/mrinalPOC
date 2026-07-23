#!/usr/bin/env bash
# deployments/gcp/scripts/infra.sh -- GCP infra runner (Infrastructure Manager).
#
# Invoked by `make infra CLOUD=gcp ENV=<env> ACTION=<verb>`. Reads envs/<env>.yaml,
# maps structured sections into Terraform variables, and drives Infrastructure Manager:
#
#   plan    -> gcloud infra-manager previews create   (read-only preview)
#   apply   -> gcloud infra-manager deployments apply (upsert deployment)
#   destroy -> gcloud infra-manager deployments delete (guarded)
#
# ACTION=create is accepted as a deprecated alias for apply.
#
# GCNV/Trident/DNS/app deploy remain in scripts/gke-*.sh and make deploy CLOUD=gke.
#
# Env/var inputs:
#   GCP_SERVICE_ACCOUNT  IM runner SA (same as CI OIDC login). GitHub Environment
#                        var in CI; export locally for `make infra`.
#   CONFIRM              destroy confirmation (must equal <env>)
#   TF_VERSION_CONSTRAINT  Terraform version for IM (default: =1.5.7)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GCP_DIR="$(dirname "$SCRIPT_DIR")"
DEPLOY_DIR="$(dirname "$GCP_DIR")"
STACKS_DIR="$GCP_DIR/stacks"
ENVS_DIR="$GCP_DIR/envs"

# shellcheck source=../../_lib/common.sh
source "$DEPLOY_DIR/_lib/common.sh"

ENV_NAME=""
ACTION=""
TF_VERSION_CONSTRAINT="${TF_VERSION_CONSTRAINT:-=1.5.7}"

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

require_cmd gcloud "Install the Google Cloud SDK: https://cloud.google.com/sdk/docs/install"
require_cmd python3 "Python 3 is required to transform env YAML into Terraform inputs"

ENV_FILE="$ENVS_DIR/$ENV_NAME.yaml"
[[ -f "$ENV_FILE" ]] || die "env config not found: $ENV_FILE"
[[ -d "$STACKS_DIR" ]] || die "Terraform stacks directory not found: $STACKS_DIR"

read_env_meta() {
  python3 - "$ENV_FILE" <<'PY'
import sys
import yaml

with open(sys.argv[1], encoding="utf-8") as fh:
    root = yaml.safe_load(fh) or {}
fields = [
    root.get("projectId") or "",
    root.get("location") or "",
    root.get("deploymentId") or "",
]
print("\t".join(fields))
PY
}

IFS=$'\t' read -r PROJECT_ID LOCATION DEPLOYMENT_ID <<< "$(read_env_meta)"

for v in PROJECT_ID LOCATION DEPLOYMENT_ID; do
  val="${!v}"
  [[ -n "$val" && "$val" != "null" ]] || die "env config $ENV_FILE is missing required key: $v"
done

# IM Terraform executor — same SA as GitHub OIDC login (vars.GCP_SERVICE_ACCOUNT), not env yaml.
SERVICE_ACCOUNT_EMAIL="${GCP_SERVICE_ACCOUNT:-}"

INPUTS_FILE="$(mktemp -t gcp-infra-inputs-XXXXXX.tfvars)"
trap 'rm -f "$INPUTS_FILE"' EXIT

python3 - "$ENV_FILE" >"$INPUTS_FILE" <<'PY'
import json
import sys

import yaml

with open(sys.argv[1], encoding="utf-8") as fh:
    root = yaml.safe_load(fh) or {}

app = root.get("application") or {}
net = root.get("networking") or {}
gke = root.get("gke") or {}
storage = root.get("storage")
edge = root.get("edge")
dns_cfg = root.get("dns") or {}
tags_cfg = root.get("tags") or {}
container_registry = root.get("containerRegistry") or {}


def pick(*values, default=None):
    for value in values:
        if value is None:
            continue
        if isinstance(value, str) and value == "":
            continue
        return value
    return default


def normalize_taints(taints):
    normalized = []
    for taint in taints or []:
        if not isinstance(taint, dict):
            continue
        effect = pick(taint.get("effect"), taint.get("Effect"), default="NO_SCHEDULE")
        normalized.append(
            {
                "key": pick(taint.get("key"), taint.get("Key")),
                "value": str(pick(taint.get("value"), taint.get("Value"), default="")),
                "effect": str(effect).upper(),
            }
        )
    return normalized


def normalize_pool(pool):
    labels = pool.get("labels") or {}
    if not isinstance(labels, dict):
        labels = {}
    return {
        "name": pool["name"],
        "machine_type": pick(pool.get("machineType"), pool.get("machine_type"), default="e2-standard-4"),
        "min_count": int(pick(pool.get("minCount"), pool.get("min_count"), default=1)),
        "max_count": int(pick(pool.get("maxCount"), pool.get("max_count"), default=1)),
        "disk_size_gb": int(pick(pool.get("diskSizeGiB"), pool.get("disk_size_gb"), default=100)),
        "image_type": pick(pool.get("imageType"), pool.get("image_type"), default="COS_CONTAINERD"),
        "labels": {str(k): str(v) for k, v in labels.items()},
        "taints": normalize_taints(pool.get("taints")),
    }


node_pools = [normalize_pool(p) for p in (gke.get("nodePools") or gke.get("node_pools") or [])]
if not node_pools:
    node_pools = [normalize_pool({"name": "general", "machineType": "e2-standard-4", "minCount": 1, "maxCount": 2})]

creator = pick(tags_cfg.get("creator"), default="agentstudio")

payload = {
    "project_id": root["projectId"],
    "location": root["location"],
    "labels": {"creator": str(creator)},
    "endpoint": pick(app.get("endpoint"), default="agentstudio.test"),
    "networking": {
        "vpc_name": pick(net.get("vpcName"), net.get("vpc_name"), default="vpc-agentstudio"),
        "subnet_name": pick(net.get("subnetName"), net.get("subnet_name"), default="snet-gke"),
        "subnet_cidr": pick(net.get("subnetCidr"), net.get("subnet_cidr"), default="10.252.0.0/20"),
        "pods_secondary_cidr": pick(
            net.get("podsSecondaryCidr"), net.get("pods_secondary_cidr"), default="10.4.0.0/16"
        ),
        "services_secondary_cidr": pick(
            net.get("servicesSecondaryCidr"),
            net.get("services_secondary_cidr"),
            default="10.5.0.0/20",
        ),
        "psa_range_name": pick(
            net.get("psaRangeName"), net.get("psa_range_name"), default="agentstudio-psa"
        ),
        "psa_prefix_length": int(
            pick(net.get("psaPrefixLength"), net.get("psa_prefix_length"), default=20)
        ),
    },
    "gke": {
        "cluster_name": pick(gke.get("clusterName"), gke.get("cluster_name"), default="gke-agentstudio"),
        "release_channel": pick(gke.get("releaseChannel"), gke.get("release_channel"), default="REGULAR"),
        "kubernetes_version": pick(
            gke.get("kubernetesVersion"), gke.get("kubernetes_version"), default=""
        ),
        "deletion_protection": bool(pick(gke.get("deletionProtection"), gke.get("deletion_protection"), default=True)),
        "node_pools": node_pools,
    },
}

if storage:
    payload["storage"] = {
        "gcnv_location": pick(storage.get("gcnvLocation"), storage.get("gcnv_location"), default=root["location"]),
        "nas_pool_name": pick(storage.get("nasPoolName"), storage.get("nas_pool_name"), default="sp-agentstudio-nas"),
        "san_pool_name": pick(storage.get("sanPoolName"), storage.get("san_pool_name"), default="sp-agentstudio-san"),
        "nas_capacity_gib": int(pick(storage.get("nasCapacityGiB"), storage.get("nas_capacity_gib"), default=4096)),
        "san_capacity_gib": int(pick(storage.get("sanCapacityGiB"), storage.get("san_capacity_gib"), default=4096)),
        "nas_service_level": str(pick(storage.get("nasServiceLevel"), storage.get("nas_service_level"), default="STANDARD")).upper(),
    }

trident_cfg = (storage or {}).get("trident") or {}
payload["trident"] = {
    "enabled": bool(pick(trident_cfg.get("enabled"), default=True)),
    "gsa_name": pick(trident_cfg.get("gsaName"), trident_cfg.get("gsa_name"), default="trident-controller"),
    "namespace": pick(trident_cfg.get("namespace"), default="trident"),
    "kubernetes_service_account": pick(
        trident_cfg.get("serviceAccount"),
        trident_cfg.get("kubernetesServiceAccount"),
        trident_cfg.get("kubernetes_service_account"),
        default="trident-controller",
    ),
}

if edge:
    payload["edge"] = {
        "gateway_address_name": pick(
            edge.get("gatewayAddressName"), edge.get("gateway_address_name"), default="agentstudio-gw-ip"
        ),
    }

payload["dns"] = {
    "create_zone": bool(pick(dns_cfg.get("createZone"), dns_cfg.get("create_zone"), default=False)),
    "zone_name": pick(dns_cfg.get("zoneName"), dns_cfg.get("zone_name"), default=""),
    "dns_name": pick(dns_cfg.get("dnsName"), dns_cfg.get("dns_name"), default=""),
    "app_record_name": pick(dns_cfg.get("appRecordName"), dns_cfg.get("app_record_name"), default="app"),
    "auth_record_name": pick(dns_cfg.get("authRecordName"), dns_cfg.get("auth_record_name"), default="auth"),
}

if container_registry.get("mode", "shared") == "shared":
    repo_id = pick(container_registry.get("repositoryId"), container_registry.get("repository_id"), default="")
    if repo_id:
        payload["container_registry"] = {
            "mode": "shared",
            "location": pick(container_registry.get("location"), default=root["location"]),
            "repository_id": repo_id.split("/")[-1] if "/" in repo_id else repo_id,
        }


def hcl_key(key: str) -> str:
    if key.replace("_", "").replace("-", "").isalnum() and not key[0].isdigit():
        return key
    return json.dumps(key)


def hcl_value(value, indent=0):
    pad = "  " * indent
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, dict):
        if not value:
            return "{}"
        lines = ["{"]
        for key, item in value.items():
            rendered = hcl_value(item, indent + 1)
            hkey = hcl_key(str(key))
            if "\n" in rendered:
                lines.append(f"{pad}  {hkey} = {rendered}")
            else:
                lines.append(f"{pad}  {hkey} = {rendered}")
        lines.append(f"{pad}}}")
        return "\n".join(lines)
    if isinstance(value, list):
        if not value:
            return "[]"
        lines = ["["]
        for item in value:
            rendered = hcl_value(item, indent + 1)
            if "\n" in rendered:
                lines.append(f"{pad}  {rendered},")
            else:
                lines.append(f"{pad}  {rendered},")
        lines.append(f"{pad}]")
        return "\n".join(lines)
    raise TypeError(f"unsupported tfvars type: {type(value)!r}")


for key, value in payload.items():
    rendered = hcl_value(value)
    if "\n" in rendered:
        print(f"{key} = {rendered}")
    else:
        print(f"{key} = {rendered}")
    print()
PY

deployment_resource="projects/${PROJECT_ID}/locations/${LOCATION}/deployments/${DEPLOYMENT_ID}"
service_account_flag=()
if [[ -n "$SERVICE_ACCOUNT_EMAIL" && "$SERVICE_ACCOUNT_EMAIL" != "null" ]]; then
  service_account_flag=(--service-account="projects/${PROJECT_ID}/serviceAccounts/${SERVICE_ACCOUNT_EMAIL}")
fi

run_gcp_preflight() {
  local errors=0

  if [[ "$PROJECT_ID" == REPLACE_WITH_* ]]; then
    if [[ "$ACTION" == "apply" || "$ACTION" == "destroy" ]]; then
      log_error "projectId is still a placeholder in $ENV_FILE"
      errors=1
    else
      log_warn "projectId is a placeholder — IM preview requires a real GCP project"
    fi
  fi

  if [[ "$ACTION" != "plan" ]]; then
    if [[ -z "$SERVICE_ACCOUNT_EMAIL" || "$SERVICE_ACCOUNT_EMAIL" == REPLACE_WITH_* ]]; then
      log_error "GCP_SERVICE_ACCOUNT is required for ACTION=$ACTION (IM runner SA — same as CI OIDC login)"
      log_error "  CI: GitHub Environment 'gcp' var GCP_SERVICE_ACCOUNT (passed to make infra step)"
      log_error "  Local: export GCP_SERVICE_ACCOUNT=<sa>@<project>.iam.gserviceaccount.com"
      errors=1
    fi
  fi

  if ! gcloud config get-value project >/dev/null 2>&1; then
    log_warn "gcloud may not be authenticated — run: gcloud auth login"
  fi

  gcloud services enable config.googleapis.com container.googleapis.com compute.googleapis.com \
    servicenetworking.googleapis.com netapp.googleapis.com dns.googleapis.com artifactregistry.googleapis.com \
    cloudquotas.googleapis.com \
    --project="$PROJECT_ID" >/dev/null 2>&1 || log_warn "could not enable required APIs (check permissions)"

  if [[ "$errors" -ne 0 ]]; then
    return 1
  fi
  log_info "Preflight OK"
}

print_im_deployment_status() {
  gcloud infra-manager deployments describe "$deployment_resource" \
    --project="$PROJECT_ID" \
    --format="yaml(name,state,errorCode,errorLogs)" 2>/dev/null || log_warn "deployment not found or not yet created"
}

# Fetch and print Terraform errors IM wrote to GCS (errorLogs on the deployment).
print_im_error_logs() {
  local error_logs
  error_logs="$(gcloud infra-manager deployments describe "$deployment_resource" \
    --project="$PROJECT_ID" \
    --format='value(errorLogs)' 2>/dev/null | tr -d '[:space:]' || true)"
  [[ -n "$error_logs" && "$error_logs" != "null" ]] || return 0

  echo ""
  log_error "─── Terraform apply errors (Infrastructure Manager) ───"
  log_error "source: $error_logs"
  if gcloud storage cat "$error_logs" 2>/dev/null | head -120; then
    :
  elif command -v gsutil >/dev/null 2>&1 && gsutil -q cat "$error_logs" 2>/dev/null | head -120; then
    :
  else
    log_warn "could not read error log (need storage.objects.get on the IM blueprint bucket)"
    log_warn "fetch manually: gcloud storage cat '$error_logs'"
  fi
  log_error "─── end errors ───"
  echo ""
}

print_deploy_hints() {
  local cluster_name vpc_name gateway_name trident_gsa env_yaml
  env_yaml="$DEPLOY_DIR/_lib/env_yaml.py"
  cluster_name="$(python3 "$env_yaml" --file "$ENV_FILE" --path gke.clusterName)"
  vpc_name="$(python3 "$env_yaml" --file "$ENV_FILE" --path networking.vpcName)"
  gateway_name="$(python3 "$env_yaml" --file "$ENV_FILE" --path edge.gatewayAddressName)"
  trident_gsa="$(python3 "$env_yaml" --file "$ENV_FILE" --path storage.trident.gsaName --default trident-controller)"
  echo ""
  log_info "Post-infra verification (platform ready for make storage + deploy):"
  printf '  gcloud container clusters get-credentials %s --region %s --project %s\n' "$cluster_name" "$LOCATION" "$PROJECT_ID"
  printf '  kubectl get nodes\n'
  echo ""
  log_info "Trident auth (infra-managed GSA + Workload Identity):"
  printf '  gcloud iam service-accounts describe %s@%s.iam.gserviceaccount.com\n' "$trident_gsa" "$PROJECT_ID"
  printf '  gcloud projects get-iam-policy %s --flatten=bindings --filter="bindings.members:serviceAccount:%s@%s.iam.gserviceaccount.com" --format="table(bindings.role)"\n' \
    "$PROJECT_ID" "$trident_gsa" "$PROJECT_ID"
  printf '  # Expect roles/netapp.admin; WI binding on trident/trident-controller\n'
  if [[ -n "$gateway_name" ]]; then
    log_info "Edge Helm: set networking.gke.io/load-balancer-ip-addresses in values-gke.yaml to:"
    printf '  projects/%s/regions/%s/addresses/%s\n' "$PROJECT_ID" "$LOCATION" "$gateway_name"
  fi
  echo ""
  log_info "Next: make storage CLOUD=gcp ENV=%s" "$ENV_NAME"
  log_info "See deployments/docs/preprod-infra-validation.md for full checklist."
}

log_info "cloud=gcp env=$ENV_NAME action=$ACTION"
log_info "project=$PROJECT_ID location=$LOCATION deployment=$DEPLOYMENT_ID"
if [[ -n "$SERVICE_ACCOUNT_EMAIL" ]]; then
  log_info "im_runner_sa=$SERVICE_ACCOUNT_EMAIL"
fi

case "$ACTION" in
  plan)
    run_gcp_preflight || die "preflight checks failed"
    preview_id="preview-${DEPLOYMENT_ID}-$(date +%s)"
    log_info "plan is read-only for cloud infra (VPC/GKE/GCNV) — IM runs terraform plan in a sandbox build."
    log_info "Expect '+ create' lines in the plan output; nothing is applied until ACTION=apply."
    if gcloud infra-manager deployments describe "$deployment_resource" \
      --project="$PROJECT_ID" >/dev/null 2>&1; then
      log_info "plan (IM preview against existing deployment)"
      gcloud infra-manager previews create "$preview_id" \
        --project="$PROJECT_ID" \
        --location="$LOCATION" \
        --deployment="$deployment_resource" \
        --local-source="$STACKS_DIR" \
        --inputs-file="$INPUTS_FILE" \
        "${service_account_flag[@]}" \
        --tf-version-constraint="$TF_VERSION_CONSTRAINT"
    else
      log_info "plan (IM standalone preview — deployment does not exist yet; greenfield)"
      gcloud infra-manager previews create "$preview_id" \
        --project="$PROJECT_ID" \
        --location="$LOCATION" \
        --local-source="$STACKS_DIR" \
        --inputs-file="$INPUTS_FILE" \
        "${service_account_flag[@]}" \
        --tf-version-constraint="$TF_VERSION_CONSTRAINT"
    fi

    log_info "preview id: $preview_id"
    gcloud infra-manager previews describe "projects/${PROJECT_ID}/locations/${LOCATION}/previews/${preview_id}" \
      --project="$PROJECT_ID" \
      --format="yaml(name,previewArtifacts,state,errorCode)" 2>/dev/null || true
    echo ""
    log_info "Verify nothing was provisioned (should be empty until apply):"
    printf '  gcloud infra-manager deployments list --project=%s --location=%s\n' "$PROJECT_ID" "$LOCATION"
    printf '  gcloud container clusters list --project=%s --filter="name:%s"\n' "$PROJECT_ID" "$(python3 "$DEPLOY_DIR/_lib/env_yaml.py" --file "$ENV_FILE" --path gke.clusterName)"
    log_info "To create resources: make infra CLOUD=gcp ENV=%s ACTION=apply" "$ENV_NAME"
    ;;
  apply)
    run_gcp_preflight || die "preflight checks failed"
    log_info "applying Infrastructure Manager deployment (blocks until complete)"
    apply_rc=0
    set +e
    gcloud infra-manager deployments apply "$deployment_resource" \
      --project="$PROJECT_ID" \
      --local-source="$STACKS_DIR" \
      --inputs-file="$INPUTS_FILE" \
      "${service_account_flag[@]}" \
      --tf-version-constraint="$TF_VERSION_CONSTRAINT" \
      --quota-validation=ENABLED
    apply_rc=$?
    set -e
    if [[ "$apply_rc" -ne 0 ]]; then
      log_error "deployment apply failed"
      print_im_deployment_status
      print_im_error_logs
      die "stack deploy failed for env '$ENV_NAME'"
    fi
    log_ok "deployment '$DEPLOYMENT_ID' applied for env '$ENV_NAME'"
    print_im_deployment_status
    print_deploy_hints
    ;;
  destroy)
    confirm_destroy "$ENV_NAME"
    log_warn "deleting Infrastructure Manager deployment '$DEPLOYMENT_ID' in $LOCATION"
    if ! gcloud infra-manager deployments describe "$deployment_resource" \
      --project="$PROJECT_ID" >/dev/null 2>&1; then
      log_warn "deployment '$DEPLOYMENT_ID' does not exist — nothing to destroy"
      exit 0
    fi
    gcloud infra-manager deployments delete "$deployment_resource" \
      --project="$PROJECT_ID" \
      --quiet
    log_ok "deployment '$DEPLOYMENT_ID' destroyed for env '$ENV_NAME'"
    ;;
  *)
    die "invalid action '$ACTION' (plan|apply|destroy)"
    ;;
esac
