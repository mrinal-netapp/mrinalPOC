#!/usr/bin/env bash
# Emit helm argv tokens for EKS edge tier overrides: JWT issuer from ENDPOINT,
# NLB EIP allocation IDs from the CFN stack (or optional env yaml override).
#
# Preprod: `make deploy CLOUD=aws ENV=preprod` sets DEPLOY_ENV_FILE.
# Dev release workflow (deploy-reusable.yml): ENDPOINT only — dev EIP annotations
# stay on values-eks.yaml defaults; issuer still tracks ENDPOINT.
#
# Env:
#   ENDPOINT          — application.endpoint / tier ENDPOINT
#   DEPLOY_ENV_FILE   — deployments/aws/envs/<env>.yaml (optional)
#
# Optional env yaml keys (see deployments/aws/envs/_schema.yaml):
#   edge.gatewayEipAllocations — comma-separated eipalloc-... IDs (skip CFN lookup)
#   stackName, region            — used for CFN describe-stacks when allocations unset
#
# CFN outputs (when edge.allocateGatewayEips=true): GatewayEip1AllocationId,
# GatewayEip2AllocationId.

set -euo pipefail

ENDPOINT="${ENDPOINT:-}"
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-}"
ENV_YAML="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/_lib/env_yaml.py"

ey() {
  python3 "$ENV_YAML" --file "$DEPLOY_ENV_FILE" --path "$1"
}

emit_set() {
  printf '%s\n' --set-string
  printf '%s\n' "$1"
}

cfn_output() {
  local stack="$1" region="$2" key="$3"
  aws cloudformation describe-stacks \
    --stack-name "$stack" \
    --region "$region" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue | [0]" \
    --output text 2>/dev/null | tr -d '[:space:]'
}

# JWT issuer whenever ENDPOINT is a real hostname.
if [ -n "$ENDPOINT" ] && [ "$ENDPOINT" != "agentstudio.local" ]; then
  issuer="https://auth.${ENDPOINT}/realms/nemo"
  emit_set "gateway.istio.requestAuthentication.issuer=${issuer}"
fi

if [ -z "$DEPLOY_ENV_FILE" ] || [ ! -f "$DEPLOY_ENV_FILE" ]; then
  exit 0
fi

allocations="$(ey edge.gatewayEipAllocations)"
if [ -z "$allocations" ]; then
  stack="$(ey stackName)"
  region="$(ey region)"
  if [ -n "$stack" ] && [ -n "$region" ] && command -v aws >/dev/null 2>&1; then
    eip1="$(cfn_output "$stack" "$region" GatewayEip1AllocationId)"
    eip2="$(cfn_output "$stack" "$region" GatewayEip2AllocationId)"
    if [ -n "$eip1" ] && [ "$eip1" != "None" ] && [ -n "$eip2" ] && [ "$eip2" != "None" ]; then
      allocations="${eip1},${eip2}"
      echo "Resolved gateway EIPs from CFN stack ${stack}: ${allocations}" >&2
    fi
  fi
fi

if [ -z "$allocations" ]; then
  exit 0
fi

# Helm --set-string treats commas as pair separators; escape them in the value.
allocations_helm="${allocations//,/\\,}"

emit_set "gateway.istio.infrastructure.annotations.service\.beta\.kubernetes\.io/aws-load-balancer-eip-allocations=${allocations_helm}"
