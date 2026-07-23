#!/bin/bash
# Common Helm operations used by Makefile targets

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Create GHCR pull secret in namespace (call before Helm so Jobs/Pods can pull from ghcr.io).
# Does not patch SAs; use setup_ghcr_credentials_post after Helm to patch SAs, or pass global.imagePullSecrets to Helm.
setup_ghcr_secret() {
    local namespace=$1
    local container_image_repo=$2

    if ! echo "$container_image_repo" | grep -q "^ghcr.io"; then
        return 0
    fi

    if [ -z "$GHCR_PAT" ]; then
        echo -e "${YELLOW}Warning: CONTAINER_IMAGE_REPO uses ghcr.io but GHCR_PAT is not set. Images may fail to pull.${NC}"
        echo "  Create a PAT with read:packages and set: export GHCR_PAT=ghp_..."
        return 0
    fi

    local ghcr_user=$(echo "$container_image_repo" | sed 's|ghcr.io/||' | cut -d'/' -f1)
    if [ -z "$ghcr_user" ]; then
        echo -e "${YELLOW}Warning: Could not extract username from CONTAINER_IMAGE_REPO=$container_image_repo${NC}"
        return 1
    fi

    echo "Creating GHCR secret for user $ghcr_user in namespace $namespace..."
    if ! kubectl get secret gh-regcred -n "$namespace" >/dev/null 2>&1; then
        kubectl create secret docker-registry gh-regcred \
            --docker-server=ghcr.io \
            --docker-username="$ghcr_user" \
            --docker-password="$GHCR_PAT" \
            --docker-email="${ghcr_user}@users.noreply.github.com" \
            -n "$namespace" || {
                echo -e "${RED}Error: Failed to create GHCR secret${NC}"
                return 1
            }
        echo -e "${GREEN}GHCR secret created.${NC}"
    else
        kubectl delete secret gh-regcred -n "$namespace" >/dev/null 2>&1 || true
        kubectl create secret docker-registry gh-regcred \
            --docker-server=ghcr.io \
            --docker-username="$ghcr_user" \
            --docker-password="$GHCR_PAT" \
            --docker-email="${ghcr_user}@users.noreply.github.com" \
            -n "$namespace" || {
                echo -e "${RED}Error: Failed to update GHCR secret${NC}"
                return 1
            }
        echo -e "${GREEN}GHCR secret updated.${NC}"
    fi
    return 0
}

# Function to setup GHCR credentials (creates secret and patches default SA)
setup_ghcr_credentials() {
    local namespace=$1
    local container_image_repo=$2

    setup_ghcr_secret "$namespace" "$container_image_repo" || return 1

    echo "Patching service account $namespace to use GHCR secret..."
    if kubectl get serviceaccount "$namespace" -n "$namespace" >/dev/null 2>&1; then
        kubectl patch serviceaccount "$namespace" \
            -p '{"imagePullSecrets": [{"name": "gh-regcred"}]}' \
            -n "$namespace" || {
                echo -e "${YELLOW}Warning: Failed to patch service account${NC}"
                return 1
            }
        echo -e "${GREEN}Service account patched successfully.${NC}"
    else
        echo "Service account $namespace will be created by Helm, will patch after install."
    fi

    return 0
}

# Function to setup GHCR credentials post-install/upgrade
# This is called AFTER Helm charts are installed/upgraded
setup_ghcr_credentials_post() {
    local namespace=$1
    local container_image_repo=$2
    
    if ! echo "$container_image_repo" | grep -q "^ghcr.io"; then
        return 0
    fi
    
    if [ -z "$GHCR_PAT" ]; then
        echo -e "${YELLOW}Warning: CONTAINER_IMAGE_REPO uses ghcr.io but GHCR_PAT is not set. Images may fail to pull.${NC}"
        echo "Set GHCR_PAT environment variable with your GitHub Personal Access Token."
        return 0
    fi
    
    echo "Setting up GHCR credentials after Helm chart installation..."
    
    # Wait for namespace and service account to be created by Helm
    echo "Waiting for namespace and service account to be created..."
    local max_attempts=10
    local attempt=0
    while [ $attempt -lt $max_attempts ]; do
        if kubectl get namespace "$namespace" >/dev/null 2>&1 && \
           kubectl get serviceaccount "$namespace" -n "$namespace" >/dev/null 2>&1; then
            break
        fi
        attempt=$((attempt + 1))
        sleep 1
    done
    
    if [ $attempt -eq $max_attempts ]; then
        echo -e "${YELLOW}Warning: Namespace or service account not found after waiting. Skipping GHCR setup.${NC}"
        return 1
    fi
    
    # Extract username from container_image_repo
    local ghcr_user=$(echo "$container_image_repo" | sed 's|ghcr.io/||' | cut -d'/' -f1)
    
    if [ -z "$ghcr_user" ]; then
        echo -e "${YELLOW}Warning: Could not extract username from CONTAINER_IMAGE_REPO=$container_image_repo${NC}"
        return 1
    fi
    
    # Create GHCR secret if it doesn't exist
    echo "Creating GHCR secret for user $ghcr_user in namespace $namespace..."
    if ! kubectl get secret gh-regcred -n "$namespace" >/dev/null 2>&1; then
        kubectl create secret docker-registry gh-regcred \
            --docker-server=ghcr.io \
            --docker-username="$ghcr_user" \
            --docker-password="$GHCR_PAT" \
            --docker-email="${ghcr_user}@users.noreply.github.com" \
            -n "$namespace" || {
                echo -e "${RED}Error: Failed to create GHCR secret${NC}"
                return 1
            }
        echo -e "${GREEN}GHCR secret created successfully.${NC}"
    else
        echo "GHCR secret already exists, updating..."
        kubectl delete secret gh-regcred -n "$namespace" >/dev/null 2>&1 || true
        kubectl create secret docker-registry gh-regcred \
            --docker-server=ghcr.io \
            --docker-username="$ghcr_user" \
            --docker-password="$GHCR_PAT" \
            --docker-email="${ghcr_user}@users.noreply.github.com" \
            -n "$namespace" || {
                echo -e "${RED}Error: Failed to update GHCR secret${NC}"
                return 1
            }
        echo -e "${GREEN}GHCR secret updated successfully.${NC}"
    fi
    
    # Patch all service accounts in the namespace to use GHCR secret
    echo "Patching service accounts in namespace $namespace to use GHCR secret..."
    
    # Get all service accounts in the namespace
    local service_accounts=$(kubectl get serviceaccount -n "$namespace" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || echo "")
    
    if [ -z "$service_accounts" ]; then
        echo -e "${YELLOW}Warning: No service accounts found in namespace $namespace${NC}"
        return 1
    fi
    
    # Patch each service account
    local patched_count=0
    for sa in $service_accounts; do
        echo "Patching service account: $sa"
        if kubectl patch serviceaccount "$sa" \
            -p '{"imagePullSecrets": [{"name": "gh-regcred"}]}' \
            -n "$namespace" >/dev/null 2>&1; then
            patched_count=$((patched_count + 1))
        else
            echo -e "${YELLOW}Warning: Failed to patch service account $sa${NC}"
        fi
    done
    
    if [ $patched_count -gt 0 ]; then
        echo -e "${GREEN}Successfully patched $patched_count service account(s) with GHCR credentials.${NC}"
    else
        echo -e "${YELLOW}Warning: No service accounts were patched${NC}"
        return 1
    fi
    
    return 0
}

# Function to patch service account post-install/upgrade (deprecated - use setup_ghcr_credentials_post)
patch_service_account_post() {
    local namespace=$1
    local container_image_repo=$2
    setup_ghcr_credentials_post "$namespace" "$container_image_repo"
}

# Mirror the keycloak-bootstrap-admin Secret from the Keycloak namespace into the
# Nemo / app-services namespace so ServiceAccounts in the app namespace can mount it
# via secretKeyRef. Required by config-service whose /api/v1/setup/status route uses
# ROPC against master/admin-cli to query realm state (the only way the chart
# currently reads admin-cli credentials at runtime).
#
# Idempotent: re-runs of `make helm-platform-upgrade-aks` overwrite the mirrored Secret
# in lock-step with the source; password rotation in the source propagates within
# one make invocation. Source-of-truth always lives in the Keycloak namespace --
# we never write back to the source from here.
#
# Skipped silently if:
#   - Source Secret is absent (Keycloak chart not installed yet on this cluster)
#   - kubectl OR python3 not available (CI dry-run / templating-only paths) --
#     the body pipes kubectl output through python3, so both are required.
#
# Notes:
#   - Namespace defaults track the Makefile tier defaults (KEYCLOAK_NAMESPACE /
#     SERVICES_NAMESPACE), so calling this without explicit args targets the
#     same namespaces the rest of the deploy uses.
#   - We strip resourceVersion / uid / managedFields / namespace / creationTimestamp
#     so `kubectl apply -f -` doesn't choke on cross-namespace metadata.
#   - The mirrored Secret keeps the same name (`keycloak-bootstrap-admin`) so
#     config-service can reference it by a stable name via .Values.env (GKE) and
#     `make sync-shared-secrets` can mirror it into every consumer namespace.
mirror_keycloak_bootstrap_admin_secret() {
    local source_ns="${1:-${KEYCLOAK_NAMESPACE:-agentstudio-identity}}"
    local target_ns="${2:-${SERVICES_NAMESPACE:-agentstudio-services}}"
    local secret_name="keycloak-bootstrap-admin"

    if ! command -v kubectl >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
        return 0
    fi
    if [ "$source_ns" = "$target_ns" ]; then
        return 0
    fi
    if ! kubectl get secret "$secret_name" -n "$source_ns" >/dev/null 2>&1; then
        echo -e "${YELLOW}Note: secret/${secret_name} not found in ${source_ns}; skipping mirror to ${target_ns}.${NC}"
        echo "      (Expected on first deploy before Keycloak chart has installed; re-run after deploy-identity.)"
        return 0
    fi

    # Provision the target namespace with the standard Helm labels/annotations
    # (ensure_namespace) instead of a bare `kubectl create namespace`, so it
    # matches every other namespace this repo creates.
    ensure_namespace "$target_ns" "$target_ns"

    echo "Mirroring secret/${secret_name}: ${source_ns} -> ${target_ns}"
    kubectl get secret "$secret_name" -n "$source_ns" -o json \
        | python3 -c "import sys,json; s=json.load(sys.stdin); m=s.setdefault('metadata',{}); m['namespace']='${target_ns}'; [m.pop(k,None) for k in ('resourceVersion','uid','managedFields','creationTimestamp','ownerReferences','selfLink','generation')]; s.pop('status',None); print(json.dumps(s))" \
        | kubectl apply -f - >/dev/null || {
            echo -e "${YELLOW}Warning: failed to mirror ${secret_name} from ${source_ns} to ${target_ns}.${NC}"
            return 1
        }
}

# Map a Helm release name to its Kubernetes namespace.
#
# Reads the HELM_RELEASE_* / HELM_NS_* pairs exported by mk/common.mk
# (per-tier defaults + operator overrides) so helm-template / helm-status /
# helm-debug pick up the same namespaces the deploy macros use, instead
# of each macro hard-coding a legacy "nemo" / "database" if-else.
#
# Falls back to the release name itself when no mapping matches so
# non-tier releases (custom test installs, observability, etc.) keep
# the previous behaviour of "namespace == release name".
#
# Defaults track common.mk so this still works if a caller forgets to
# export the HELM_* env vars (e.g. invoked outside of `make`).
resolve_tier_namespace() {
    local release="$1"
    case "$release" in
        "${HELM_RELEASE_SERVICES:-services}")        echo "${HELM_NS_SERVICES:-agentstudio-services}" ;;
        "${HELM_RELEASE_CONSOLE:-console}")          echo "${HELM_NS_CONSOLE:-agentstudio-console}" ;;
        "${HELM_RELEASE_WORKERS:-workers}")          echo "${HELM_NS_WORKERS:-agentstudio-workers}" ;;
        "${HELM_RELEASE_LLM_GATEWAY:-llm-gateway}")  echo "${HELM_NS_LLM_GATEWAY:-agentstudio-llm-gateway}" ;;
        "${HELM_RELEASE_PLATFORM:-platform}")        echo "${HELM_NS_PLATFORM:-agentstudio-platform}" ;;
        "${HELM_RELEASE_IDENTITY:-identity}")        echo "${HELM_NS_IDENTITY:-agentstudio-identity}" ;;
        "${HELM_RELEASE_DATABASE:-database}")        echo "${HELM_NS_DATABASE:-database}" ;;
        *)                                           echo "$release" ;;
    esac
}

# Function to ensure namespace exists with Helm labels
ensure_namespace() {
    local namespace=$1
    local release_name=$2
    
    if ! kubectl get namespace "$namespace" >/dev/null 2>&1; then
        echo "Creating namespace $namespace..."
        kubectl create namespace "$namespace" || {
            echo -e "${RED}Error: Failed to create namespace${NC}"
            return 1
        }
        kubectl label namespace "$namespace" app.kubernetes.io/managed-by=Helm || true
        kubectl annotate namespace "$namespace" meta.helm.sh/release-name="$release_name" --overwrite || true
        kubectl annotate namespace "$namespace" meta.helm.sh/release-namespace="$namespace" --overwrite || true
    else
        echo "Namespace $namespace already exists, ensuring Helm labels/annotations..."
        kubectl label namespace "$namespace" app.kubernetes.io/managed-by=Helm --overwrite || true
        kubectl annotate namespace "$namespace" meta.helm.sh/release-name="$release_name" --overwrite || true
        kubectl annotate namespace "$namespace" meta.helm.sh/release-namespace="$namespace" --overwrite || true
    fi
}

# Resolve the base endpoint host (the domain behind app.<base> / catalog.<base> /
# auth.<base>) used to rewrite the GKE keycloak overlay's redirect URIs.
#
# Precedence (most reliable signal first):
#   1. KEYCLOAK_HOSTNAME of the form auth.<endpoint>  -> <endpoint>
#      (the documented convention; works even when ENDPOINT is unset/defaulted,
#       and self-consistent with the deploy-gke auth-host derivation).
#   2. else ENDPOINT (if non-empty)                   -> ENDPOINT
#      (covers a custom auth subdomain like login.example.com, where the auth
#       host can't tell us the base but ENDPOINT carries it).
#   3. else                                           -> fail fast.
#
# Args: $1 = KEYCLOAK_HOSTNAME, $2 = ENDPOINT (optional)
# Echoes the base host on stdout; diagnostics go to stderr.
gke_resolve_base_host() {
    local kc_hostname="$1" endpoint_raw="$2"
    local kc_host endpoint
    kc_host="$(printf '%s' "$kc_hostname" | sed -E 's#^https?://##; s#/.*##; s#:[0-9]+$##' | tr -d '[:space:]')"
    endpoint="$(printf '%s' "$endpoint_raw" | tr -d '[:space:]')"
    case "$kc_host" in
        auth.*)
            printf '%s' "${kc_host#auth.}"
            return 0
            ;;
    esac
    if [ -n "$endpoint" ]; then
        printf '%s' "$endpoint"
        return 0
    fi
    echo "ERROR: cannot derive the base endpoint for GKE redirect URIs from" >&2
    echo "       KEYCLOAK_HOSTNAME='$kc_hostname'. Use the auth.<endpoint> convention" >&2
    echo "       (KEYCLOAK_HOSTNAME=https://auth.<endpoint>:8443) or set ENDPOINT=<endpoint>." >&2
    return 1
}

# Render a copy of a cloud keycloak overlay (values-gke.yaml / values-eks.yaml /
# values-aks.yaml) with the chart-baseline `agentstudio.local` host rewritten to
# the real base endpoint, so OIDC redirectUris / webOrigins / httpRoute hosts
# point at the deploy target. Used by helm-identity-install-{gke,eks,aks} and
# matching template targets. Echoes the temp file path (caller deletes it).
#
# Args: $1 = KEYCLOAK_HOSTNAME, $2 = ENDPOINT, $3 = source values-gke.yaml path
render_gke_keycloak_values() {
    local base_host tmp
    base_host="$(gke_resolve_base_host "$1" "$2")" || return 1
    tmp="$(mktemp)" || return 1
    if ! sed "s/agentstudio\.local/${base_host}/g" "$3" > "$tmp"; then
        rm -f "$tmp"
        return 1
    fi
    echo "Rewrote agentstudio.local -> ${base_host} in $(basename "$3")" >&2
    printf '%s' "$tmp"
}

# Function to build Helm set args
build_helm_set_args() {
    local container_image_repo=$1
    local image_tag=$2
    local chart_type=$3  # "nemo" or "database"
    local force_pull=${FORCE_PULL:-}
    
    local helm_args=""
    
    if [ -n "$container_image_repo" ]; then
        helm_args="$helm_args --set global.imageRepository=$container_image_repo"
        # So keycloak-setup and other Jobs can pull from ghcr.io, pass imagePullSecrets into the chart
        if echo "$container_image_repo" | grep -q "^ghcr.io"; then
            helm_args="$helm_args --set global.imagePullSecrets[0].name=gh-regcred"
        fi
        # Override init container images in subchart values that can't use Helm templates
        # (Lakekeeper extraInitContainers are raw YAML arrays, not processed by tpl)
        local pg_client_img="${container_image_repo}/init-tools:latest"
        helm_args="$helm_args --set lakekeeper.catalog.extraInitContainers[0].image=$pg_client_img"
        helm_args="$helm_args --set lakekeeper.catalog.extraInitContainers[1].image=$pg_client_img"
    fi
    
    # database chart doesn't have project-built images; image_tag param is unused for it
    # (kept in signature for forward-compatibility)

    # Add imagePullPolicy=Always if FORCE_PULL is set
    if [ -n "$force_pull" ]; then
        if [ "$chart_type" = "database" ]; then
            helm_args="$helm_args --set postgresql.image.pullPolicy=Always"
        fi
    fi
    
    echo "$helm_args"
}


