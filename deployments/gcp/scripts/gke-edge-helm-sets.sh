#!/usr/bin/env bash
# Emit helm argv tokens for GKE edge tier overrides: JWT issuer from ENDPOINT,
# and the LoadBalancer static IP from the env yaml (edge.gatewayAddressName).
#
# Preprod: `make deploy CLOUD=gke ENV=preprod` sets DEPLOY_ENV_FILE.
# Dev release workflow: ENDPOINT only — no static IP pinning; issuer tracks ENDPOINT.
#
# Static IP binding (why gateway.addresses, not just the annotation):
#   The edge Gateway is Istio-managed (gatewayClassName: istio), so istiod
#   auto-provisions a plain L4 LoadBalancer Service. GKE's L4 service controller
#   does NOT honor the networking.gke.io/load-balancer-ip-addresses annotation —
#   that annotation is only read by the GKE-managed (L7) Gateway controller — so
#   annotation-only pinning silently falls back to an ephemeral IP. The mechanism
#   that actually binds is Gateway API spec.addresses (chart: gateway.addresses),
#   which istiod translates into the Service's spec.loadBalancerIP; GKE honors
#   that. We therefore resolve the reserved address NAME to its literal IP (via
#   gcloud, authenticated in the deploy job) and emit gateway.addresses. The
#   annotation is still emitted for documentation / L7 parity.
#
# Env:
#   ENDPOINT          — application.endpoint / tier ENDPOINT
#   DEPLOY_ENV_FILE   — deployments/gcp/envs/<env>.yaml (optional)
#
# Optional env yaml keys (see deployments/gcp/envs/_schema.yaml):
#   edge.gatewayLoadBalancerAddress — full annotation value (projects/.../addresses/<name>)
#   edge.gatewayAddressName         — short name; assembled with projectId + location
#   projectId                       — GCP project (required when using gatewayAddressName)
#   location                        — GCP region  (required when using gatewayAddressName)

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

# Resolve a reserved regional address NAME to its literal IP and emit it as
# gateway.addresses[0] (the field that actually binds the LB on GKE). No-op if
# gcloud is unavailable or the address cannot be resolved — the deploy then
# falls back to an ephemeral IP rather than failing.
emit_addresses() {
  local name="$1" project="$2" region="$3" ip=""
  command -v gcloud >/dev/null 2>&1 || return 0
  ip="$(gcloud compute addresses describe "$name" \
    --project "$project" --region "$region" \
    --format='value(address)' 2>/dev/null || true)"
  [ -n "$ip" ] || return 0
  emit_set "gateway.addresses[0].type=IPAddress"
  emit_set "gateway.addresses[0].value=${ip}"
}

# JWT issuer whenever ENDPOINT is a real hostname (not local).
if [ -n "$ENDPOINT" ] && [ "$ENDPOINT" != "agentstudio.local" ]; then
  issuer="https://auth.${ENDPOINT}/realms/nemo"
  emit_set "gateway.istio.requestAuthentication.issuer=${issuer}"
fi

if [ -z "$DEPLOY_ENV_FILE" ] || [ ! -f "$DEPLOY_ENV_FILE" ]; then
  exit 0
fi

# Full annotation value wins if explicitly set.
full_addr="$(ey edge.gatewayLoadBalancerAddress)"
if [ -n "$full_addr" ]; then
  emit_set "gateway.istio.infrastructure.annotations.networking\.gke\.io/load-balancer-ip-addresses=${full_addr}"
  # Parse projects/<p>/regions/<r>/addresses/<n> to resolve the literal IP.
  p="$(printf '%s' "$full_addr" | sed -E 's#projects/([^/]+)/.*#\1#')"
  r="$(printf '%s' "$full_addr" | sed -E 's#.*/regions/([^/]+)/.*#\1#')"
  n="$(printf '%s' "$full_addr" | sed -E 's#.*/addresses/([^/]+).*#\1#')"
  [ -n "$n" ] && [ -n "$p" ] && [ -n "$r" ] && emit_addresses "$n" "$p" "$r"
  exit 0
fi

# Otherwise assemble from projectId + location + gatewayAddressName.
addr_name="$(ey edge.gatewayAddressName)"
if [ -n "$addr_name" ]; then
  project="$(ey projectId)"
  region="$(ey location)"
  if [ -n "$project" ] && [ -n "$region" ]; then
    emit_set "gateway.istio.infrastructure.annotations.networking\.gke\.io/load-balancer-ip-addresses=projects/${project}/regions/${region}/addresses/${addr_name}"
    emit_addresses "$addr_name" "$project" "$region"
  fi
fi
