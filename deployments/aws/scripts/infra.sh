#!/usr/bin/env bash
# deployments/aws/scripts/infra.sh -- AWS infra runner (CloudFormation).
#
# Invoked by `make infra CLOUD=aws ENV=<env> ACTION=<verb>`. Reads the single
# per-env config envs/<env>.yaml, maps its structured sections (application,
# networking, eks, fsx, installer) into CloudFormation parameter overrides, and
# maps the normalized verbs to native AWS commands:
#
#   plan    -> aws cloudformation deploy --no-execute-changeset  (change-set preview)
#   apply   -> aws cloudformation deploy                          (create/update stack)
#   destroy -> aws cloudformation delete-stack (+ wait)           (guarded)
#
# ACTION=create is accepted as a deprecated alias for apply.
#
# Legacy flat `parameters:` maps in env YAML are still honored as fallbacks when
# structured keys are absent.
#
# Env/var inputs:
#   CONFIRM   destroy confirmation (must equal <env>); else prompts on TTY
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AWS_DIR="$(dirname "$SCRIPT_DIR")"
DEPLOY_DIR="$(dirname "$AWS_DIR")"
ENVS_DIR="$AWS_DIR/envs"
TEMPLATE_FILE="$AWS_DIR/stacks/agentstudio-foundation.yaml"

# shellcheck source=../../_lib/common.sh
source "$DEPLOY_DIR/_lib/common.sh"

# AWS CLI v2 pages table/json output through `less` by default; disable for scripted runs.
export AWS_PAGER=""

print_aws_stack_failure_events() {
  local stack="$1" region="$2"
  local events_json stack_status stack_reason

  log_error "stack operation failed — recent CloudFormation events for '$stack':"
  echo ""

  stack_status="$(aws cloudformation describe-stacks \
    --stack-name "$stack" \
    --region "$region" \
    --query 'Stacks[0].StackStatus' \
    --output text 2>/dev/null || echo "UNKNOWN")"
  stack_reason="$(aws cloudformation describe-stacks \
    --stack-name "$stack" \
    --region "$region" \
    --query 'Stacks[0].StackStatusReason' \
    --output text 2>/dev/null || echo "")"

  printf 'Stack status: %s\n' "$stack_status"
  if [[ -n "$stack_reason" && "$stack_reason" != "None" ]]; then
    printf 'Stack status reason: %s\n' "$stack_reason"
  fi
  if [[ "$stack_status" == "ROLLBACK_COMPLETE" ]]; then
    log_warn "stack is ROLLBACK_COMPLETE — delete it before re-running ACTION=apply:"
    log_warn "  make infra CLOUD=aws ENV=$ENV_NAME ACTION=destroy CONFIRM=$ENV_NAME"
  fi
  echo ""

  if ! events_json="$(aws cloudformation describe-stack-events \
    --stack-name "$stack" \
    --region "$region" \
    --output json 2>/dev/null)"; then
    log_warn "could not fetch stack events (stack may not exist yet)"
    return 0
  fi

  EVENTS_JSON="$events_json" python3 <<'PY'
import json
import os

events = json.loads(os.environ["EVENTS_JSON"]).get("StackEvents") or []

failed = []
for event in events:
    status = event.get("ResourceStatus") or ""
    reason = event.get("ResourceStatusReason") or ""
    if "FAILED" not in status:
        continue
    if "cancelled" in reason.lower():
        continue
    failed.append(event)

if failed:
    print("Root cause(s):")
    for event in failed:
        ts = (event.get("Timestamp") or "")[:19]
        print(
            f"  {ts}  {event.get('LogicalResourceId', '')} "
            f"({event.get('ResourceType', '')})"
        )
        print(f"    {event.get('ResourceStatus', '')}: {event.get('ResourceStatusReason', '')}")
    print()

print("Recent events (newest first):")
print(f"{'Time':<20} {'Status':<26} {'LogicalId':<35} Reason")
print("-" * 120)
for event in events[:20]:
    ts = (event.get("Timestamp") or "")[:19]
    reason = event.get("ResourceStatusReason") or ""
    if len(reason) > 55:
        reason = reason[:52] + "..."
    print(
        f"{ts:<20} {event.get('ResourceStatus', ''):<26} "
        f"{event.get('LogicalResourceId', ''):<35} {reason}"
    )
PY
}

print_aws_stack_outputs() {
  local stack="$1" region="$2"
  echo ""
  log_info "stack outputs:"
  aws cloudformation describe-stacks \
    --stack-name "$stack" \
    --region "$region" \
    --query 'Stacks[0].Outputs[*].{Key:OutputKey,Value:OutputValue}' \
    --output table 2>/dev/null || log_warn "could not fetch stack outputs"
}

print_aws_deploy_hints() {
  local env_file="$1"
  local ecr endpoint
  ecr="$(python3 -c "import yaml; cr=yaml.safe_load(open('$env_file')).get('containerRegistry') or {}; print(cr.get('loginServer',''))")"
  endpoint="$(python3 -c "import yaml; print(yaml.safe_load(open('$env_file')).get('application',{}).get('endpoint',''))")"
  echo ""
  log_info "Post-infra verification (platform ready for Trident + deploy):"
  printf '  aws eks update-kubeconfig --name %s --region %s\n' "$STACK_NAME" "$REGION"
  printf '  kubectl get nodes\n'
  if [[ -n "$ecr" ]]; then
    log_info "Shared ECR: %s (node role has ECR read; pass as CONTAINER_IMAGE_REPO at deploy)" "$ecr"
  fi
  log_info "Install AWS Load Balancer Controller Helm using LoadBalancerControllerRoleArn output."
  echo ""
  log_info "Trident auth (stack-managed EKS Pod Identity):"
  printf '  aws eks list-pod-identity-associations --cluster-name %s --region %s --namespace trident\n' \
    "$STACK_NAME" "$REGION"
  printf '  # Expect trident-controller -> TridentPodIdentityRoleArn from stack outputs\n'
  echo ""
  log_info "Next: make storage CLOUD=aws ENV=%s" "$(basename "$env_file" .yaml)"
  log_info "See deployments/docs/preprod-infra-validation.md for full checklist."
}

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

require_cmd aws "Install the AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
require_cmd python3 "Python 3 is required to transform env YAML into CloudFormation parameters"

ENV_FILE="$ENVS_DIR/$ENV_NAME.yaml"
[[ -f "$ENV_FILE" ]] || die "env config not found: $ENV_FILE
  Create it (copy an existing env) -- no other change is needed to add an environment."
[[ -f "$TEMPLATE_FILE" ]] || die "CloudFormation template not found: $TEMPLATE_FILE"

ENV_YAML="$DEPLOY_DIR/_lib/env_yaml.py"
REGION="$(python3 "$ENV_YAML" --file "$ENV_FILE" --path region)"
STACK_NAME="$(python3 "$ENV_YAML" --file "$ENV_FILE" --path stackName)"
for v in REGION STACK_NAME; do
  val="${!v}"
  [[ -n "$val" && "$val" != "null" ]] || die "env config $ENV_FILE is missing required key: $v"
done

PARAMS_FILE="$(mktemp -t aws-infra-params-XXXXXX.txt)"
trap 'rm -f "$PARAMS_FILE"' EXIT

python3 - "$ENV_FILE" >"$PARAMS_FILE" <<'PY'
import json
import sys

import yaml

env_file = sys.argv[1]
with open(env_file, encoding="utf-8") as fh:
    root = yaml.safe_load(fh) or {}

legacy = root.get("parameters") or {}
app = root.get("application") or {}
net = root.get("networking") or {}
eks = root.get("eks") or {}
fsx = root.get("fsx") or {}
installer = root.get("installer") or {}
container_registry = root.get("containerRegistry") or {}
operator_access = root.get("operatorAccess") or {}
dns_cfg = root.get("dns") or {}
edge_cfg = root.get("edge") or {}
tags_cfg = root.get("tags") or {}
storage_cfg = root.get("storage") or {}
trident_cfg = storage_cfg.get("trident") or {}


def pick(*values, default=None):
    for value in values:
        if value is None:
            continue
        if isinstance(value, str) and value == "":
            continue
        return value
    return default


stack_name = pick(root.get("stackName"), default="agentstudio")
default_svm_name = f"{stack_name}-svm"


operator_principals = operator_access.get("principalArns") or []
operator_arn = ""
if operator_principals:
    operator_arn = str(operator_principals[0])
else:
    operator_arn = pick(
        operator_access.get("principalArn"),
        legacy.get("OperatorAccessPrincipalArn"),
        default="",
    )


def comma_list(value):
    if isinstance(value, list):
        return ",".join(str(v) for v in value)
    return str(value)


def scaling_value(ng, *keys, default):
    scaling = ng.get("scaling") or {}
    for key in keys:
        if key in scaling:
            return scaling[key]
        if key in ng:
            return ng[key]
    return default


def normalize_taints(taints):
    normalized = []
    for taint in taints or []:
        if not isinstance(taint, dict):
            continue
        normalized.append(
            {
                "Key": pick(taint.get("Key"), taint.get("key")),
                "Value": str(pick(taint.get("Value"), taint.get("value"), default="")),
                "Effect": pick(taint.get("Effect"), taint.get("effect")),
            }
        )
    return normalized


def default_node_group():
    return {
        "name": "general",
        "instanceTypes": ["m6i.2xlarge"],
        "amiType": "AL2_x86_64",
        "capacityType": "ON_DEMAND",
        "scaling": {"desiredSize": 3, "minSize": 2, "maxSize": 8},
        "labels": {"workload": "general"},
        "taints": [],
        "diskSizeGiB": 0,
        "updateMaxUnavailable": 1,
    }


def first_taint(taints):
    for taint in normalize_taints(taints):
        if taint.get("Key"):
            return taint
    return None


def workload_label(labels):
    labels = labels or {}
    if "workload" in labels:
        return str(labels["workload"])
    if labels:
        return str(next(iter(labels.values())))
    return "general"


node_groups = eks.get("nodeGroups")
if not node_groups:
    node_groups = [default_node_group()]

primary = node_groups[0]
secondary = node_groups[1] if len(node_groups) > 1 else None
if len(node_groups) > 2:
    print(
        "warning: only the first two eks.nodeGroups entries are provisioned by CloudFormation today",
        file=sys.stderr,
    )

primary_taint = first_taint(primary.get("taints"))
secondary_taint = first_taint(secondary.get("taints")) if secondary else None

params = {
    "Endpoint": pick(app.get("endpoint"), legacy.get("Endpoint"), default="agentstudio.test"),
    "ProjectName": pick(app.get("projectName"), legacy.get("ProjectName"), default="agentstudio"),
    "Environment": pick(app.get("environment"), legacy.get("Environment"), default="dev"),
    "VpcCidr": pick(net.get("vpcCidr"), legacy.get("VpcCidr"), default="10.250.0.0/16"),
    "PublicSubnet1Cidr": pick(
        net.get("publicSubnet1Cidr"), legacy.get("PublicSubnet1Cidr"), default="10.250.0.0/20"
    ),
    "PublicSubnet2Cidr": pick(
        net.get("publicSubnet2Cidr"), legacy.get("PublicSubnet2Cidr"), default="10.250.16.0/20"
    ),
    "PrivateSubnet1Cidr": pick(
        net.get("privateSubnet1Cidr"), legacy.get("PrivateSubnet1Cidr"), default="10.250.32.0/20"
    ),
    "PrivateSubnet2Cidr": pick(
        net.get("privateSubnet2Cidr"), legacy.get("PrivateSubnet2Cidr"), default="10.250.48.0/20"
    ),
    "EksKubernetesVersion": pick(
        eks.get("kubernetesVersion"), legacy.get("EksKubernetesVersion"), default="1.32"
    ),
    "EksEndpointPublicAccess": "true"
    if pick(eks.get("endpointPublicAccess"), legacy.get("EksEndpointPublicAccess"), default=True)
    else "false",
    "EksEndpointPrivateAccess": "true"
    if pick(eks.get("endpointPrivateAccess"), legacy.get("EksEndpointPrivateAccess"), default=True)
    else "false",
    "EksNodeGroupName": pick(primary.get("name"), legacy.get("EksNodeGroupName"), default="general"),
    "EksNodeInstanceTypes": comma_list(
        primary.get("instanceTypes", legacy.get("EksNodeInstanceTypes", "m6i.2xlarge"))
    ),
    "EksNodeAmiType": pick(primary.get("amiType"), legacy.get("EksNodeAmiType"), default="AL2_x86_64"),
    "EksNodeCapacityType": pick(
        primary.get("capacityType"), legacy.get("EksNodeCapacityType"), default="ON_DEMAND"
    ),
    "EksNodeDesiredSize": scaling_value(primary, "desiredSize", default=3),
    "EksNodeMinSize": scaling_value(primary, "minSize", default=2),
    "EksNodeMaxSize": scaling_value(primary, "maxSize", default=8),
    "EksNodeWorkloadLabel": workload_label(primary.get("labels")),
    "EksNodeTaintKey": primary_taint["Key"] if primary_taint else "",
    "EksNodeTaintValue": primary_taint["Value"] if primary_taint else "",
    "EksNodeTaintEffect": primary_taint["Effect"] if primary_taint else "NO_SCHEDULE",
    "EksNodeDiskSizeGiB": pick(primary.get("diskSizeGiB"), legacy.get("EksNodeDiskSizeGiB"), default=0),
    "EksNodeUpdateMaxUnavailable": pick(
        primary.get("updateMaxUnavailable"), legacy.get("EksNodeUpdateMaxUnavailable"), default=1
    ),
    "EksAdditionalNodeGroupsJson": "",
    "EksNodeGroup2Name": secondary.get("name", "") if secondary else "",
    "EksNodeGroup2InstanceTypes": comma_list(
        secondary.get("instanceTypes", ["m6i.xlarge"]) if secondary else "m6i.xlarge"
    ),
    "EksNodeGroup2AmiType": secondary.get("amiType", "AL2_x86_64") if secondary else "AL2_x86_64",
    "EksNodeGroup2CapacityType": secondary.get("capacityType", "ON_DEMAND") if secondary else "ON_DEMAND",
    "EksNodeGroup2DesiredSize": scaling_value(secondary, "desiredSize", default=0) if secondary else 0,
    "EksNodeGroup2MinSize": scaling_value(secondary, "minSize", default=0) if secondary else 0,
    "EksNodeGroup2MaxSize": scaling_value(secondary, "maxSize", default=1) if secondary else 1,
    "EksNodeGroup2WorkloadLabel": workload_label(secondary.get("labels")) if secondary else "workload",
    "EksNodeGroup2TaintKey": secondary_taint["Key"] if secondary_taint else "",
    "EksNodeGroup2TaintValue": secondary_taint["Value"] if secondary_taint else "",
    "EksNodeGroup2TaintEffect": secondary_taint["Effect"] if secondary_taint else "NO_SCHEDULE",
    "FsxStorageCapacityGiB": pick(
        fsx.get("storageCapacityGiB"), legacy.get("FsxStorageCapacityGiB"), default=1024
    ),
    "FsxThroughputCapacity": pick(
        fsx.get("throughputCapacity"), legacy.get("FsxThroughputCapacity"), default=384
    ),
    "FsxDeploymentType": pick(
        fsx.get("deploymentType"), legacy.get("FsxDeploymentType"), default="SINGLE_AZ_2"
    ),
    "FsxSvmName": pick(fsx.get("svmName"), legacy.get("FsxSvmName"), default=default_svm_name),
    "InstallerInstanceType": pick(
        installer.get("instanceType"), legacy.get("InstallerInstanceType"), default="t3.large"
    ),
    "InstallerVolumeSizeGiB": pick(
        installer.get("volumeSizeGiB"), legacy.get("InstallerVolumeSizeGiB"), default=100
    ),
    "TridentHelmVersion": pick(
        trident_cfg.get("helmVersion"),
        installer.get("tridentHelmVersion"),
        legacy.get("TridentHelmVersion"),
        default="100.2410.0",
    ),
    "TridentNamespace": pick(trident_cfg.get("namespace"), default="trident"),
    "TridentServiceAccount": pick(
        trident_cfg.get("serviceAccount"),
        trident_cfg.get("serviceAccountName"),
        default="trident-controller",
    ),
    "EnableInstallerInstance": "true"
    if pick(
        installer.get("enableInstance"),
        legacy.get("EnableInstallerInstance"),
        default=True,
    )
    else "false",
    "InstallerAmiId": pick(installer.get("amiId"), legacy.get("InstallerAmiId"), default=""),
    "ContainerImageRepo": pick(
        container_registry.get("loginServer"), legacy.get("ContainerImageRepo"), default=""
    ),
    "OperatorAccessPrincipalArn": operator_arn,
    "CreateRoute53HostedZone": "true"
    if pick(dns_cfg.get("createHostedZone"), legacy.get("CreateRoute53HostedZone"), default=False)
    else "false",
    "Route53HostedZoneName": pick(
        dns_cfg.get("hostedZoneName"), legacy.get("Route53HostedZoneName"), default=""
    ),
    "AllocateGatewayEips": "true"
    if pick(edge_cfg.get("allocateGatewayEips"), legacy.get("AllocateGatewayEips"), default=False)
    else "false",
}

def format_override(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


for key, value in params.items():
    print(f"{key}={format_override(value)}")
PY

OVERRIDES=()
while IFS= read -r line; do
  OVERRIDES+=("$line")
done <"$PARAMS_FILE"

CREATOR_TAG="agentstudio"
if [[ -f "$ENV_FILE" ]]; then
  CREATOR_TAG="$(python3 -c "import yaml; t=(yaml.safe_load(open('$ENV_FILE')) or {}).get('tags') or {}; print(t.get('creator') or 'agentstudio')")"
fi

log_info "cloud=aws env=$ENV_NAME action=$ACTION"
log_info "region=$REGION stack=$STACK_NAME overrides=${#OVERRIDES[@]}"

run_aws_preflight() {
  local preflight_rc=0
  set +e
  ENV_FILE="$ENV_FILE" REGION="$REGION" STACK_NAME="$STACK_NAME" TEMPLATE_FILE="$TEMPLATE_FILE" \
    python3 - "$PARAMS_FILE" <<'PY'
import os
import re
import subprocess
import sys

import yaml

params = {}
with open(sys.argv[1], encoding="utf-8") as fh:
    for line in fh:
        line = line.strip()
        if not line or "=" not in line:
            continue
        key, value = line.split("=", 1)
        params[key] = value

env_file = os.environ["ENV_FILE"]
region = os.environ["REGION"]
stack_name = os.environ["STACK_NAME"]
template_file = os.environ["TEMPLATE_FILE"]

with open(env_file, encoding="utf-8") as fh:
    env_root = yaml.safe_load(fh) or {}

errors: list[str] = []
warnings: list[str] = []


def fail(msg: str) -> None:
    errors.append(msg)


def warn(msg: str) -> None:
    warnings.append(msg)


def aws_json(*args: str):
    proc = subprocess.run(
        ["aws", *args, "--region", region, "--output", "json"],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return None, proc.stderr.strip() or proc.stdout.strip()
    import json

    return json.loads(proc.stdout), None


# Stack must not be stuck in ROLLBACK_COMPLETE before create.
stack_status = ""
data, err = aws_json(
    "cloudformation", "describe-stacks", "--stack-name", stack_name
)
if data:
    stacks = data.get("Stacks") or []
    if stacks:
        stack_status = stacks[0].get("StackStatus") or ""
elif err and "does not exist" not in err and "ValidationError" not in err:
    warn(f"could not read stack status: {err}")

if stack_status == "ROLLBACK_COMPLETE":
    fail(
        f"stack '{stack_name}' is ROLLBACK_COMPLETE — delete it before apply:\n"
        f"  make infra CLOUD=aws ENV={env_root.get('env', '<env>')} ACTION=destroy "
        f"CONFIRM={env_root.get('env', '<env>')}"
    )

# FSx ONTAP constraints (SINGLE_AZ_2 minimum throughput is 384 MB/s; storage min 1024 GiB).
fsx_type = params.get("FsxDeploymentType", "SINGLE_AZ_2")
try:
    fsx_storage = int(params.get("FsxStorageCapacityGiB", "1024"))
except ValueError:
    fsx_storage = 0
try:
    fsx_throughput = int(params.get("FsxThroughputCapacity", "384"))
except ValueError:
    fsx_throughput = 0

if fsx_storage < 1024:
    fail(f"FsxStorageCapacityGiB={fsx_storage} is below FSx ONTAP minimum (1024 GiB)")
if fsx_type == "SINGLE_AZ_2" and fsx_throughput < 384:
    fail(
        f"FsxThroughputCapacity={fsx_throughput} is invalid for {fsx_type} "
        "(minimum 384 MB/s; 128 fails at create time)"
    )

# Installer AMI — RegionMap still uses REPLACE_ME placeholders until AMIs are built.
enable_installer = params.get("EnableInstallerInstance", "true") == "true"
ami_id = (params.get("InstallerAmiId") or "").strip()
if enable_installer:
    if ami_id:
        if not re.fullmatch(r"ami-[0-9a-f]+", ami_id):
            fail(f"InstallerAmiId '{ami_id}' is not a valid AMI id (expected ami-...)")
        else:
            img, img_err = aws_json("ec2", "describe-images", "--image-ids", ami_id)
            images = (img or {}).get("Images") or []
            if not images:
                fail(
                    f"InstallerAmiId '{ami_id}' was not found in {region} "
                    f"({img_err or 'no matching image'})"
                )
    else:
        with open(template_file, encoding="utf-8") as fh:
            template = yaml.safe_load(fh)
        region_map = (template.get("Mappings") or {}).get("RegionMap") or {}
        mapped = (region_map.get(region) or {}).get("InstallerAmi") or ""
        if "REPLACE_ME" in mapped or not re.fullmatch(r"ami-[0-9a-f]+", mapped or ""):
            fail(
                f"installer is enabled but no valid AMI is configured for {region}.\n"
                f"  RegionMap has: {mapped or '(missing)'}\n"
                f"  Set installer.amiId in {env_file}, or installer.enableInstance: false "
                f"for infra-only testing, or replace RegionMap placeholders after building AMIs."
            )

if warnings:
    print("Preflight warnings:")
    for msg in warnings:
        print(f"  - {msg}")
    print()

if errors:
    print("Preflight failed — fix before running apply/plan:", file=sys.stderr)
    for msg in errors:
        print(f"  - {msg}", file=sys.stderr)
    sys.exit(1)

print("Preflight OK")
PY
  preflight_rc=$?
  set -e
  return "$preflight_rc"
}

deploy_common_args=(
  --stack-name "$STACK_NAME"
  --template-file "$TEMPLATE_FILE"
  --capabilities CAPABILITY_NAMED_IAM
  --region "$REGION"
  --tags "creator=${CREATOR_TAG}"
)
if [[ ${#OVERRIDES[@]} -gt 0 ]]; then
  deploy_common_args+=( --parameter-overrides "${OVERRIDES[@]}" )
fi

case "$ACTION" in
  plan)
    run_aws_preflight || die "preflight checks failed"
    log_info "plan (creates a change set, does not execute it)"
    deploy_output=""
    if ! deploy_output="$(aws cloudformation deploy "${deploy_common_args[@]}" --no-execute-changeset 2>&1)"; then
      printf '%s\n' "$deploy_output" >&2
      die "plan failed while creating the change set"
    fi
    printf '%s\n' "$deploy_output"

    if printf '%s\n' "$deploy_output" | grep -qE 'No changes to deploy|is up to date'; then
      log_ok "plan: no infrastructure changes (stack '$STACK_NAME' is already up to date)"
    else
    change_set_arn="$(printf '%s\n' "$deploy_output" \
      | grep -oE 'arn:aws:cloudformation:[^[:space:]]+:changeSet/[^[:space:]]+' \
      | tail -1)"
    if [[ -z "$change_set_arn" ]]; then
      change_set_arn="$(printf '%s\n' "$deploy_output" | sed -n 's/.*change-set-name //p' | tail -1)"
    fi
    [[ -n "$change_set_arn" ]] || die "plan succeeded but could not parse the change set ARN from deploy output"

    log_info "change set: $change_set_arn"

    change_set_json="$(mktemp -t aws-changeset-XXXXXX.json)"
    trap 'rm -f "$PARAMS_FILE" "$change_set_json"' EXIT

    if ! aws cloudformation describe-change-set \
      --change-set-name "$change_set_arn" \
      --region "$REGION" \
      --output json >"$change_set_json"; then
      die "failed to describe change set $change_set_arn"
    fi

    python3 - "$change_set_json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as fh:
    cs = json.load(fh)

status = cs.get("Status", "UNKNOWN")
reason = cs.get("StatusReason") or ""
changes = cs.get("Changes") or []

print(f"\nChange set status: {status}")
if reason:
    print(f"Status reason: {reason}")

counts: dict[str, int] = {}
rows: list[tuple[str, str, str, str]] = []
for change in changes:
    rc = change.get("ResourceChange") or {}
    action = rc.get("Action") or "Unknown"
    counts[action] = counts.get(action, 0) + 1
    rows.append(
        (
            action,
            rc.get("ResourceType") or "",
            rc.get("LogicalResourceId") or "",
            rc.get("Replacement") or "",
        )
    )

if counts:
    summary = ", ".join(f"{action}={count}" for action, count in sorted(counts.items()))
    print(f"Resource changes: {summary} ({len(rows)} total)\n")
    print(f"{'Action':<10} {'Type':<45} {'LogicalId':<35} Replacement")
    print("-" * 110)
    for action, rtype, logical_id, replacement in sorted(rows, key=lambda r: (r[0], r[1], r[2])):
        rep = replacement if replacement else "-"
        print(f"{action:<10} {rtype:<45} {logical_id:<35} {rep}")
else:
    print("\nNo resource changes in this change set.")

parameters = cs.get("Parameters") or []
if parameters:
    print(f"\nParameter overrides ({len(parameters)}):")
    for param in parameters:
        key = param.get("ParameterKey", "")
        value = param.get("ParameterValue", "")
        if len(value) > 80:
            value = value[:77] + "..."
        print(f"  {key} = {value}")
PY

    if [[ "$(python3 -c "import json; print(json.load(open('$change_set_json')).get('Status',''))")" == "FAILED" ]]; then
      aws cloudformation delete-change-set \
        --change-set-name "$change_set_arn" \
        --region "$REGION" \
        --output text >/dev/null 2>&1 || true
      die "change set validation failed (see Status reason above)"
    fi

    # Preview-only: discard the change set after printing. apply builds its own.
    if aws cloudformation delete-change-set \
      --change-set-name "$change_set_arn" \
      --region "$REGION" \
      --output text >/dev/null; then
      log_info "discarded preview change set (not left in AWS)"
    else
      log_warn "could not delete preview change set: $change_set_arn"
    fi

    # First plan on a new stack leaves an empty shell in REVIEW_IN_PROGRESS — remove it.
    stack_status="$(aws cloudformation describe-stacks \
      --stack-name "$STACK_NAME" \
      --region "$REGION" \
      --query 'Stacks[0].StackStatus' \
      --output text 2>/dev/null || echo "")"
    if [[ "$stack_status" == "REVIEW_IN_PROGRESS" ]]; then
      log_info "removing placeholder stack '$STACK_NAME' (REVIEW_IN_PROGRESS, no resources)"
      aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION" --output text >/dev/null
    fi
    fi
    ;;
  apply)
    run_aws_preflight || die "preflight checks failed"
    log_info "applying CloudFormation stack '$STACK_NAME' (blocks until AWS finishes)"
    apply_rc=0
    set +e
    aws cloudformation deploy "${deploy_common_args[@]}"
    apply_rc=$?
    set -e
    if [[ "$apply_rc" -ne 0 ]]; then
      print_aws_stack_failure_events "$STACK_NAME" "$REGION"
      die "stack deploy failed for env '$ENV_NAME'"
    fi
    stack_status="$(aws cloudformation describe-stacks \
      --stack-name "$STACK_NAME" --region "$REGION" \
      --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo UNKNOWN)"
    stack_id="$(aws cloudformation describe-stacks \
      --stack-name "$STACK_NAME" --region "$REGION" \
      --query 'Stacks[0].StackId' --output text 2>/dev/null || echo "")"
    log_ok "stack '$STACK_NAME' applied for env '$ENV_NAME' (status=$stack_status)"
    [[ -n "$stack_id" && "$stack_id" != "None" ]] && log_info "stack id: $stack_id"
    print_aws_stack_outputs "$STACK_NAME" "$REGION"
    print_aws_deploy_hints "$ENV_FILE"
    ;;
  destroy)
    confirm_destroy "$ENV_NAME"
    log_warn "deleting CloudFormation stack '$STACK_NAME' in $REGION"
    aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION"
    log_info "waiting for stack delete to complete..."
    destroy_rc=0
    set +e
    aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$REGION"
    destroy_rc=$?
    set -e
    if [[ "$destroy_rc" -ne 0 ]]; then
      print_aws_stack_failure_events "$STACK_NAME" "$REGION"
      die "stack destroy failed for env '$ENV_NAME'"
    fi
    log_ok "stack '$STACK_NAME' destroyed for env '$ENV_NAME'"
    ;;
  *)
    die "invalid action '$ACTION' (plan|apply|destroy)"
    ;;
esac
