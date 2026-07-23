#!/usr/bin/env bash
# Emit helm argv tokens for AKS edge tier overrides driven by the env yaml
# (gateway PIP + MC resource group from deployments/azure/envs/<env>.yaml) and/or
# ENDPOINT (JWT issuer). Preprod: `make deploy CLOUD=azure ENV=preprod` sets
# DEPLOY_ENV_FILE automatically. Dev release workflow (deploy-reusable.yml):
# passes ENDPOINT from vars.AGENTSTUDIO_ENDPOINT with no ENV file — dev PIP/RG
# stay on values-aks.yaml defaults; issuer still tracks ENDPOINT.
#
# Env:
#   ENDPOINT          — public gateway FQDN (e.g. agentstudio.preprod.openeng.netapp.com)
#   DEPLOY_ENV_FILE   — path to deployments/azure/envs/<env>.yaml (optional)
#
# Output: one token per line (--set-string, key=value pairs) for the Makefile
# to read into an argv array.

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

# JWT issuer: whenever ENDPOINT is a real hostname (not the local laptop default).
if [ -n "$ENDPOINT" ] && [ "$ENDPOINT" != "agentstudio.local" ]; then
  issuer="https://auth.${ENDPOINT}/realms/nemo"
  emit_set "gateway.istio.requestAuthentication.issuer=${issuer}"
fi

if [ -z "$DEPLOY_ENV_FILE" ] || [ ! -f "$DEPLOY_ENV_FILE" ]; then
  exit 0
fi

pip_name="$(ey edge.gatewayPipName)"
if [ -z "$pip_name" ]; then
  exit 0
fi

lb_rg="$(ey edge.gatewayLbResourceGroup)"
if [ -z "$lb_rg" ]; then
  # Bicep creates the gateway PIP in the stack resourceGroup (see gateway-pip.json).
  # Legacy dev may override gatewayLbResourceGroup when the PIP lives in the AKS
  # node RG (MC_<rg>_<cluster>_<location>) instead.
  lb_rg="$(ey resourceGroup)"
fi

emit_set "gateway.istio.infrastructure.annotations.service\.beta\.kubernetes\.io/azure-pip-name=${pip_name}"
if [ -n "$lb_rg" ]; then
  emit_set "gateway.istio.infrastructure.annotations.service\.beta\.kubernetes\.io/azure-load-balancer-resource-group=${lb_rg}"
fi
