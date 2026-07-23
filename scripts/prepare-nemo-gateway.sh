#!/bin/bash
# Script to prepare SSL certificates and TLS secrets for AgentStudio deployment Gateway API
# This script is called by the Makefile before Helm upgrade to ensure certificates are ready.
# Supports cert-manager-first operation (shared/prod), plus mkcert/openssl fallback for local/manual TLS secrets.
# Set USE_OPENSSL=1 to force openssl. Set FORCE_LEGACY_TLS_PREP=1 to bypass cert-manager auto-skip.
# Set ENDPOINT to your custom domain (e.g. nemo-demo.example.com).
# Cert filenames: nemo-gateway-cert.pem / nemo-gateway-key.pem.
# If you change ENDPOINT after a previous run, delete the TLS secret and re-run so SANs match.
#
# SAN rationale (single-label wildcard contract):
#   The chart targets clusters whose wildcard DNS covers ONLY single-label
#   subdomains (i.e. *.${ENDPOINT} resolves; ${ENDPOINT} apex and *.ws.${ENDPOINT} /
#   *.s3.${ENDPOINT} two-deep names do NOT). The cert therefore includes
#   *.${ENDPOINT} as a single wildcard SAN that covers app./auth./catalog./
#   workflows./phoenix./s3./ws-<id>. hosts. The apex ${ENDPOINT} SAN is also
#   included for backward compatibility with environments where DNS does
#   resolve the apex; clusters without apex DNS simply won't ever present it.
#   The legacy *.s3.${ENDPOINT} and *.ws.${ENDPOINT} (two labels deep) SANs
#   are NOT included — they were unreachable under a single-label wildcard
#   anyway, and S3 has moved to path-style addressing while workspaces moved
#   to ws-<id>.${ENDPOINT}.

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
DOMAIN="${ENDPOINT:-agentstudio.local}"
DOMAIN=$(echo "$DOMAIN" | xargs)
# Console host (single-label public host for the API gateway + console).
# Defaults to app.${DOMAIN}; override with CONSOLE_SUBDOMAIN to use e.g. "console".
CONSOLE_SUBDOMAIN="${CONSOLE_SUBDOMAIN:-app}"
CONSOLE_HOST="${CONSOLE_SUBDOMAIN}.${DOMAIN}"

# CERT_DIR: default to $HOME/.nemo-gateway-certs; fallback when HOME unset
# (e.g. some self-hosted GHA runners). Always normalise to an absolute path
# below -- step 3 does `cd "$CERT_DIR"` and later steps reference files via
# "$CERT_DIR/$CERT_FILE"; a relative CERT_DIR would resolve to a non-existent
# nested path after the cd (e.g. ./.nemo-gateway-certs/.nemo-gateway-certs/...)
# and kubectl create secret would fail with "Cannot read file ...: no such
# file or directory" even though the cert was generated fine.
if [ -n "${HOME}" ]; then
    CERT_DIR="${CERT_DIR:-$HOME/.nemo-gateway-certs}"
else
    CERT_DIR="${CERT_DIR:-$(pwd)/.nemo-gateway-certs}"
fi
# Defensive: even if the caller passed CERT_DIR=./something explicitly, make
# it absolute before the `cd` happens so the post-cd path math stays correct.
mkdir -p "$CERT_DIR"
CERT_DIR="$(cd "$CERT_DIR" && pwd)"
TLS_SECRET_NAME="${TLS_SECRET_NAME:-nemo-gateway-tls}"
# Default to the new edge namespace introduced by the Istio migration. The
# Istio Gateway listener's certificateRef resolves same-namespace by default,
# so the Secret must live where the Gateway resource lives -- agentstudio-edge.
# Older callers can keep passing NAMESPACE=agentstudio-services explicitly
# until they migrate.
NAMESPACE="${NAMESPACE:-agentstudio-edge}"

# Fixed cert filenames (domain-agnostic)
CERT_FILE="nemo-gateway-cert.pem"
KEY_FILE="nemo-gateway-key.pem"

echo -e "${GREEN}Preparing Gateway API certificates for AgentStudio deployment${NC}"
echo "Domain: $DOMAIN"
echo "Console host: $CONSOLE_HOST"
echo "Namespace: $NAMESPACE"
echo ""

# Check prerequisites: kubectl required; either mkcert or openssl required
if ! command -v kubectl &> /dev/null; then
    echo -e "${RED}Error: kubectl is not installed${NC}"
    exit 1
fi

if ! kubectl cluster-info &> /dev/null; then
    echo -e "${RED}Error: Cannot connect to Kubernetes cluster${NC}"
    exit 1
fi

# Step 0: If an existing secret has both a non-expiring cert AND SANs that match the current
# DOMAIN, skip regeneration. We must check SANs because changing $ENDPOINT does not invalidate
# the existing cert's expiration, and a cert from a previous endpoint will silently keep
# serving the wrong hostname (e.g. s3.agentstudio.local vs s3.${DOMAIN}) -> browser/SDK
# certificate-mismatch failures.
if kubectl get secret "$TLS_SECRET_NAME" -n "$NAMESPACE" &> /dev/null; then
    CRT_TMP=$(mktemp)
    trap 'rm -f "$CRT_TMP"' EXIT
    if kubectl get secret "$TLS_SECRET_NAME" -n "$NAMESPACE" -o jsonpath='{.data.tls\.crt}' | base64 -d > "$CRT_TMP" 2>/dev/null && [ -s "$CRT_TMP" ]; then
        if openssl x509 -in "$CRT_TMP" -noout -checkend 2592000 &>/dev/null; then
            # Required SANs the current ENDPOINT must cover. The single-label
            # wildcard *.${DOMAIN} is included so any single-label subdomain
            # (app./auth./catalog./workflows./phoenix./s3./ws-<id>.) is covered
            # without enumerating each. The apex ${DOMAIN} SAN is kept for
            # backward compatibility with environments where the apex resolves.
            REQUIRED_SANS=("${DOMAIN}" "*.${DOMAIN}" "${CONSOLE_HOST}" "auth.${DOMAIN}" "s3.${DOMAIN}" "catalog.${DOMAIN}")
            EXISTING_SANS=$(openssl x509 -in "$CRT_TMP" -noout -ext subjectAltName 2>/dev/null \
                | tr ',' '\n' | sed -n 's/^[[:space:]]*DNS:\(.*\)$/\1/p' | tr -d ' ')
            missing_san=""
            for san in "${REQUIRED_SANS[@]}"; do
                if ! echo "$EXISTING_SANS" | grep -qx "$san"; then
                    missing_san="$san"
                    break
                fi
            done
            if [ -z "$missing_san" ]; then
                echo -e "${GREEN}Existing certificate is still valid and covers all SANs for ${DOMAIN}; skipping regeneration.${NC}"
                echo "TLS Secret: $TLS_SECRET_NAME in namespace $NAMESPACE"
                exit 0
            fi
            echo -e "${YELLOW}Existing certificate is unexpired but is missing SAN '${missing_san}' (likely from a prior ENDPOINT). Regenerating.${NC}"
        fi
    fi
    rm -f "$CRT_TMP"
    trap - EXIT
fi

# Cert-manager clusters: skip mkcert/openssl unless forced — Helm must issue the leaf cert when CERT_MANAGER_GATEWAY_TLS=1.
if [ "${FORCE_LEGACY_TLS_PREP:-0}" != "1" ] && kubectl get crd certificates.cert-manager.io &> /dev/null; then
    if [ "${CERT_MANAGER_GATEWAY_TLS:-0}" = "1" ]; then
        echo -e "${GREEN}cert-manager detected and CERT_MANAGER_GATEWAY_TLS=1: Helm will create Certificate -> Secret ${TLS_SECRET_NAME}.${NC}"
        echo "ENDPOINT=${DOMAIN} is passed to Helm as --set endpoint / global.endpoint (Certificate SANs follow chart helpers)."
        exit 0
    fi
    echo -e "${YELLOW}cert-manager is installed but ${TLS_SECRET_NAME} is missing.${NC}"
    echo "  Recommended: redeploy Phase 4 with CERT_MANAGER_GATEWAY_TLS=1 (Makefile passes cert-manager issuer flags)."
    echo "  Or create the TLS secret manually / use FORCE_LEGACY_TLS_PREP=1 to run this script's openssl/mkcert path."
    echo -e "${YELLOW}Skipping local certificate generation (cert-manager CRDs present).${NC}"
    exit 0
fi

USE_MKCERT=false
USE_OPENSSL=false
if ! command -v openssl &> /dev/null && ! command -v mkcert &> /dev/null; then
    echo -e "${RED}Error: Neither mkcert nor openssl is available. Install mkcert (e.g. brew install mkcert) or openssl.${NC}"
    echo "For AWS/cloud or CI without mkcert, set USE_OPENSSL=1 and ensure openssl is installed."
    exit 1
fi

force_openssl=false
if [ "${USE_OPENSSL:-}" = "1" ] || [ "${USE_OPENSSL:-}" = "true" ] || [ "${USE_OPENSSL:-}" = "yes" ]; then
    force_openssl=true
fi

# mkcert is local-dev fallback only: use it for localhost/.local domains unless openssl is forced.
if [ "$force_openssl" = false ] && command -v mkcert &> /dev/null && [[ "$DOMAIN" == "localhost" || "$DOMAIN" == *.local ]]; then
    USE_MKCERT=true
else
    USE_MKCERT=false
fi

# Build list of domains for certificate.
# *.${DOMAIN} is the single-label wildcard SAN that covers every subdomain we
# expose (app./auth./catalog./workflows./phoenix./s3./ws-<id>.). The named
# entries are kept for clarity and for SAN-by-name verification in step 0.
# The two-deep wildcards (*.s3., *.ws.) are intentionally omitted: they would
# be unreachable under a single-label DNS wildcard, and the corresponding
# routing patterns have been retired (S3 is path-style only; workspaces are
# ws-<id>.${DOMAIN}).
DOMAINS=(
    "${DOMAIN}"
    "*.${DOMAIN}"
    "${CONSOLE_HOST}"
    "auth.${DOMAIN}"
    "catalog.${DOMAIN}"
    "workflows.${DOMAIN}"
    "phoenix.${DOMAIN}"
    "s3.${DOMAIN}"
    "localhost"
    "127.0.0.1"
)

# Step 2: Ensure namespace exists
echo -e "${YELLOW}Step 2: Ensuring namespace exists...${NC}"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
echo -e "${GREEN}✅ Namespace ready${NC}"

# Step 3: Generate SSL certificates (mkcert or openssl path)
echo -e "${YELLOW}Step 3: Generating SSL certificates...${NC}"
# CERT_DIR was already mkdir'd + normalised to an absolute path during init.
cd "$CERT_DIR"

if [ "$USE_MKCERT" = true ]; then
    # --- mkcert path ---
    if [ ! -d "$(mkcert -CAROOT 2>/dev/null)" ]; then
        echo -e "${YELLOW}Installing mkcert local CA...${NC}"
        mkcert -install
        echo -e "${GREEN}✅ mkcert CA installed${NC}"
    fi
    printf "Generating wildcard certificate for: %s\n" "${DOMAINS[@]}"
    if ! mkcert "${DOMAINS[@]}"; then
        echo -e "${RED}Failed to generate certificate with mkcert.${NC}"
        exit 1
    fi
    sleep 1
    GENERATED_CERT=""
    GENERATED_KEY=""
    shopt -s nullglob
    for file in _wildcard.*.pem; do
        if [ -f "$file" ] && [[ "$file" != *"-key.pem" ]]; then
            cert_basename=$(basename "$file" .pem)
            GENERATED_KEY="${cert_basename}-key.pem"
            if [ -f "$GENERATED_KEY" ]; then
                GENERATED_CERT="$file"
                break
            fi
        fi
    done
    shopt -u nullglob
    if [ -z "$GENERATED_CERT" ] || [ -z "$GENERATED_KEY" ]; then
        GENERATED_CERT=$(ls -t *.pem 2>/dev/null | grep -v -- "-key.pem" | head -1)
        if [ -n "$GENERATED_CERT" ]; then
            cert_basename=$(basename "$GENERATED_CERT" .pem)
            GENERATED_KEY="${cert_basename}-key.pem"
            [ -f "$GENERATED_KEY" ] || GENERATED_KEY=$(ls -t *-key.pem 2>/dev/null | head -1)
        else
            GENERATED_KEY=$(ls -t *-key.pem 2>/dev/null | head -1)
        fi
    fi
    if [ -n "$GENERATED_CERT" ] && [ -f "$GENERATED_CERT" ] && [ -n "$GENERATED_KEY" ] && [ -f "$GENERATED_KEY" ]; then
        mv "$GENERATED_CERT" "$CERT_FILE"
        mv "$GENERATED_KEY" "$KEY_FILE"
        echo -e "${GREEN}✅ Certificates generated (mkcert) and saved as $CERT_FILE / $KEY_FILE${NC}"
    else
        echo -e "${RED}Error: Could not find mkcert-generated certificate files in $CERT_DIR${NC}"
        exit 1
    fi
else
    # --- openssl path (AWS/cloud/CI) ---
    OPENSSL_CNF=$(mktemp)
    trap 'rm -f "$OPENSSL_CNF"' EXIT
    # Build [alt_names] with DNS.1, DNS.2, ...
    ALT_NAMES=""
    i=1
    for d in "${DOMAINS[@]}"; do
        ALT_NAMES="${ALT_NAMES}DNS.${i} = ${d}"$'\n'
        i=$((i + 1))
    done
    cat > "$OPENSSL_CNF" << EOF
[req]
distinguished_name = req_dn
req_extensions = v3_req
prompt = no
[req_dn]
CN = ${DOMAIN}
[v3_req]
subjectAltName = @alt_names
[alt_names]
${ALT_NAMES}
EOF
    if ! openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
        -keyout "$KEY_FILE" -out "$CERT_FILE" \
        -subj "/CN=${DOMAIN}" \
        -config "$OPENSSL_CNF" -extensions v3_req; then
        echo -e "${RED}Failed to generate certificate with openssl.${NC}"
        exit 1
    fi
    rm -f "$OPENSSL_CNF"
    trap - EXIT
    echo -e "${GREEN}✅ Certificates generated (openssl) and saved as $CERT_FILE / $KEY_FILE${NC}"
fi

# Step 4: Check for Gateway API CRDs
echo -e "${YELLOW}Step 4: Checking for Gateway API CRDs...${NC}"
if kubectl get crd gateways.gateway.networking.k8s.io &> /dev/null; then
    echo -e "${GREEN}✅ Gateway API CRDs already installed${NC}"
else
    echo -e "${YELLOW}Gateway API CRDs not found. Please install them first:${NC}"
    echo "  make install-gateway-api"
    echo "  or"
    echo "  kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.0.0/standard-install.yaml"
    echo ""
    echo -e "${YELLOW}Continuing with certificate setup...${NC}"
fi

# Step 5: Check for Gateway NGINX controller
GATEWAY_NAMESPACE="nginx-gateway"
echo -e "${YELLOW}Step 5: Checking for Gateway NGINX controller...${NC}"
if kubectl get deployment -n "$GATEWAY_NAMESPACE" nginx-gateway &> /dev/null 2>&1 || \
   kubectl get deployment -n "$GATEWAY_NAMESPACE" gateway-nginx &> /dev/null 2>&1; then
    echo -e "${GREEN}✅ Gateway NGINX controller found${NC}"
else
    echo -e "${YELLOW}Gateway NGINX controller not found.${NC}"
    echo -e "${YELLOW}Please install it using: make install-gateway-api${NC}"
    echo ""
fi

# Step 6: Create or update TLS Secret
echo -e "${YELLOW}Step 6: Creating/updating Kubernetes TLS secret...${NC}"
if kubectl get secret "$TLS_SECRET_NAME" -n "$NAMESPACE" &> /dev/null; then
    echo "Secret already exists. Updating..."
    kubectl delete secret "$TLS_SECRET_NAME" -n "$NAMESPACE" || true
    sleep 1
fi

kubectl create secret tls "$TLS_SECRET_NAME" \
  --namespace="$NAMESPACE" \
  --cert="$CERT_DIR/$CERT_FILE" \
  --key="$CERT_DIR/$KEY_FILE" \
  --dry-run=client -o yaml | kubectl apply -f -

echo -e "${GREEN}✅ TLS secret created/updated${NC}"

# Summary
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ AgentStudio Gateway API certificates prepared successfully!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "Certificate location: $CERT_DIR/"
echo "  - Certificate: $CERT_FILE"
echo "  - Key: $KEY_FILE"
echo ""
echo "TLS Secret: $TLS_SECRET_NAME in namespace $NAMESPACE"
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}AWS CLI Certificate Trust Configuration${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "To use AWS CLI with https://s3.${DOMAIN}:8443, configure certificate trust:"
echo ""
echo "Option 1: Disable SSL verification (for local development only):"
echo "  aws s3 ls --endpoint-url=https://s3.${DOMAIN}:8443 --no-verify-ssl s3://bucket-name/"
echo ""
if [ "$USE_MKCERT" = true ]; then
    MKCERT_CA=$(mkcert -CAROOT 2>/dev/null)/rootCA.pem
    if [ -f "$MKCERT_CA" ]; then
        echo "Option 2: Configure AWS CLI to trust mkcert CA:"
        echo "  export AWS_CA_BUNDLE=\"$MKCERT_CA\""
        echo "  aws s3 ls --endpoint-url=https://s3.${DOMAIN}:8443 s3://bucket-name/"
        echo ""
        echo "Option 3: Add to ~/.aws/config:"
        echo "  [default]"
        echo "  ca_bundle = $MKCERT_CA"
        echo ""
        echo "Mkcert CA location: $MKCERT_CA"
    fi
else
    echo "Option 2: Configure AWS CLI to trust the generated certificate (self-signed):"
    echo "  export AWS_CA_BUNDLE=\"$CERT_DIR/$CERT_FILE\""
    echo "  aws s3 ls --endpoint-url=https://s3.${DOMAIN}:8443 s3://bucket-name/"
    echo ""
    echo "For browsers: import the certificate $CERT_DIR/$CERT_FILE or accept the self-signed warning for demo."
fi
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "Next steps:"
echo "  1. Ensure Gateway API CRDs are installed: make install-gateway-api"
echo "  2. Deploy AgentStudio with Gateway API: make deploy-all-tiers-aks  (or make deploy-local for local clusters)"
echo "  3. Check Gateway status: kubectl get gateway -n $NAMESPACE"
echo "  4. Check HTTPRoute status: kubectl get httproute -n $NAMESPACE"
echo ""
