#!/usr/bin/env bash
#
# Provision the shared Allure VM (allure-docker-service + UI + caddy) on Azure.
#
# Public-IP, IP-only design: the VM gets a STATIC public IP, TLS is self-signed
# (caddy serves a cert whose SAN is that public IP), and access is restricted by
# NSG source allowlists on 22 (SSH) and 443 (service). No DNS name, no
# VNet/subnet/private-DNS wiring — the endpoint is https://<public-ip>.
#
# NO baked defaults: every input below is REQUIRED and supplied by the caller.
# Run as a single command (see README.md). Safe to re-run (existing resources
# are detected and skipped/updated).
#
# Required inputs (all):
#   SUBSCRIPTION_ID        Azure subscription id
#   LOCATION               Azure region (e.g. eastus2)
#   ALLURE_RG              resource group for the VM
#   VM_NAME                VM name
#   VM_SIZE                VM size (e.g. Standard_D8s_v3)
#   VM_IMAGE               VM image (e.g. Ubuntu2404)
#   DATA_DISK_GB           data-disk size in GB (Allure history storage)
#   ADMIN_USERNAME         VM admin username
#   ALLURE_ADMIN_PASSWORD  Allure service admin password (also the repo secret)
#   ALLOWED_SSH_SOURCE     CIDR/IP allowed to SSH (port 22) — your Mac egress IP
#   ALLOWED_HTTPS_SOURCES  space-separated CIDRs/IPs allowed on 443
#                          (your Mac egress IP + the self-hosted runner egress IP)
set -euo pipefail

REQUIRED=(
  SUBSCRIPTION_ID LOCATION ALLURE_RG VM_NAME VM_SIZE VM_IMAGE
  DATA_DISK_GB ADMIN_USERNAME ALLURE_ADMIN_PASSWORD
  ALLOWED_SSH_SOURCE ALLOWED_HTTPS_SOURCES
)
missing=()
for v in "${REQUIRED[@]}"; do [[ -n "${!v:-}" ]] || missing+=("$v"); done
if (( ${#missing[@]} )); then
  {
    echo "Missing required input(s): ${missing[*]}"
    echo "Every input is required (no defaults). Provide all of:"
    printf '  %s\n' "${REQUIRED[@]}"
  } >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v az >/dev/null       || { echo "az CLI not found" >&2; exit 1; }
command -v envsubst >/dev/null || { echo "envsubst not found (install gettext)" >&2; exit 1; }

az account set --subscription "$SUBSCRIPTION_ID"

PIP_NAME="${VM_NAME}-pip"
NSG_NAME="${VM_NAME}-nsg"

echo ">> Resource group: $ALLURE_RG"
az group create -n "$ALLURE_RG" -l "$LOCATION" -o none

echo ">> Static public IP: $PIP_NAME"
az network public-ip show -g "$ALLURE_RG" -n "$PIP_NAME" -o none 2>/dev/null \
  || az network public-ip create -g "$ALLURE_RG" -n "$PIP_NAME" \
       --sku Standard --allocation-method Static --version IPv4 -o none
ALLURE_PUBLIC_IP="$(az network public-ip show -g "$ALLURE_RG" -n "$PIP_NAME" --query ipAddress -o tsv)"
echo ">> Public IP: $ALLURE_PUBLIC_IP"

echo ">> NSG + source allowlist rules: $NSG_NAME"
az network nsg show -g "$ALLURE_RG" -n "$NSG_NAME" -o none 2>/dev/null \
  || az network nsg create -g "$ALLURE_RG" -n "$NSG_NAME" -o none
# SSH (22) from the admin/Mac egress IP only.
az network nsg rule create -g "$ALLURE_RG" --nsg-name "$NSG_NAME" -n allow-ssh \
  --priority 300 --direction Inbound --access Allow --protocol Tcp \
  --destination-port-ranges 22 --source-address-prefixes $ALLOWED_SSH_SOURCE -o none 2>/dev/null \
  || az network nsg rule update -g "$ALLURE_RG" --nsg-name "$NSG_NAME" -n allow-ssh \
       --priority 300 --destination-port-ranges 22 \
       --source-address-prefixes $ALLOWED_SSH_SOURCE -o none
# HTTPS (443) from Mac egress + self-hosted runner egress only.
az network nsg rule create -g "$ALLURE_RG" --nsg-name "$NSG_NAME" -n allow-https \
  --priority 320 --direction Inbound --access Allow --protocol Tcp \
  --destination-port-ranges 443 --source-address-prefixes $ALLOWED_HTTPS_SOURCES -o none 2>/dev/null \
  || az network nsg rule update -g "$ALLURE_RG" --nsg-name "$NSG_NAME" -n allow-https \
       --priority 320 --destination-port-ranges 443 \
       --source-address-prefixes $ALLOWED_HTTPS_SOURCES -o none

echo ">> Rendering cloud-init"
export ALLURE_ADMIN_PASSWORD ALLURE_PUBLIC_IP
RENDERED="$(mktemp)"; trap 'rm -f "$RENDERED"' EXIT
envsubst '${ALLURE_ADMIN_PASSWORD} ${ALLURE_PUBLIC_IP}' \
  < "$SCRIPT_DIR/azure-cloud-init.yaml" > "$RENDERED"

echo ">> VM: $VM_NAME ($VM_SIZE, public IP $ALLURE_PUBLIC_IP, ${DATA_DISK_GB}GB data disk)"
az vm show -g "$ALLURE_RG" -n "$VM_NAME" -o none 2>/dev/null \
  || az vm create \
       -g "$ALLURE_RG" -n "$VM_NAME" -l "$LOCATION" \
       --image "$VM_IMAGE" --size "$VM_SIZE" \
       --public-ip-address "$PIP_NAME" \
       --nsg "$NSG_NAME" \
       --data-disk-sizes-gb "$DATA_DISK_GB" \
       --admin-username "$ADMIN_USERNAME" --generate-ssh-keys \
       --custom-data "$RENDERED" -o none

cat <<EOF

Done. Verify (allow ~2-3 min for first-boot cloud-init to pull images):

  ssh $ADMIN_USERNAME@$ALLURE_PUBLIC_IP \\
    'docker ps; curl -sk https://127.0.0.1/allure-docker-service/version'

Endpoints (accept the self-signed cert warning in a browser):
  Dashboard (UI): https://$ALLURE_PUBLIC_IP/
  API:            https://$ALLURE_PUBLIC_IP/allure-docker-service

Then set repo vars/secrets:
  ALLURE_ENDPOINT=https://$ALLURE_PUBLIC_IP, ALLURE_VERIFY_TLS=0,
  ALLURE_USERNAME=admin, ALLURE_PASSWORD=<the password you passed>.
EOF
