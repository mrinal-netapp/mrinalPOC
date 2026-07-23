#!/usr/bin/env bash
# =============================================================================
# AgentStudio GCP Deployment Utility
#
# Single entry point for provisioning GKE infrastructure (cluster, GCNV,
# ExternalDNS) and deploying the application stack via Helm charts.
#
# Reads configuration from a YAML file and delegates to existing phase
# scripts and Makefile targets.
#
# Prerequisites: gcloud (authenticated), helm, kubectl, yq (v4+)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Colours
RED='\033[0;31m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
CYAN='\033[1;36m'
BOLD='\033[1m'
NC='\033[0m'
SEP="════════════════════════════════════════════════════════════════"

# Defaults
CONFIG_FILE="${REPO_ROOT}/deploy-config.yaml"
COMMAND=""
RESUME_FROM=""
DRY_RUN=0
YES=0
STATE_DIR="${REPO_ROOT}/.deploy-state"
STATE_FILE="${STATE_DIR}/cloud-auto.env"

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
usage() {
  cat <<EOF
${BOLD}AgentStudio GCP Deployment Utility${NC}

${BOLD}Usage:${NC}
  $0 <command> [options]

${BOLD}Commands:${NC}
  --provision-infra     Provision GKE cluster, GCNV storage, and ExternalDNS only
  --deploy              Deploy application services via Helm only (infra must exist)
  --all                 Full pipeline: provision infra + deploy services
  --status              Show deployment status (helm releases, pods, storage, DNS)
  --teardown            Tear down Helm releases (preserves GKE cluster, GCNV, PVCs)

${BOLD}Options:${NC}
  -c, --config FILE     Path to YAML config file (default: deploy-config.yaml)
  --resume-from PHASE   Resume from a phase: preflight, storage, dns, deploy, verify
  --dry-run             Show what would run without executing anything
  --yes                 Skip confirmation prompts (required for --teardown in scripts)
  -h, --help            Show this help message

${BOLD}Examples:${NC}
  $0 --all -c deploy-config.yaml
  $0 --provision-infra -c deploy-config.yaml
  $0 --deploy -c deploy-config.yaml
  $0 --deploy --resume-from deploy
  $0 --status -c deploy-config.yaml
  ONTAP_PASSWORD='...' $0 --all -c deploy-config.yaml
  $0 --teardown --yes -c deploy-config.yaml

${BOLD}Environment variables (sensitive, never put in config file):${NC}
  ONTAP_PASSWORD        NetApp ONTAP password (required for --provision-infra / --all)
  GHCR_PAT              GitHub PAT (required when image_repo starts with ghcr.io)
EOF
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
parse_args() {
  if [[ $# -eq 0 ]]; then
    usage
    exit 0
  fi

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --provision-infra) COMMAND="provision" ;;
      --deploy)          COMMAND="deploy" ;;
      --all)             COMMAND="all" ;;
      --status)          COMMAND="status" ;;
      --teardown)        COMMAND="teardown" ;;
      -c|--config)
        shift
        CONFIG_FILE="$1"
        ;;
      --resume-from)
        shift
        RESUME_FROM="$1"
        ;;
      --dry-run)  DRY_RUN=1 ;;
      --yes)      YES=1 ;;
      -h|--help)  usage; exit 0 ;;
      *)
        echo -e "${RED}ERROR: Unknown argument: $1${NC}" >&2
        usage >&2
        exit 1
        ;;
    esac
    shift
  done

  if [[ -z "${COMMAND}" ]]; then
    echo -e "${RED}ERROR: No command specified. Use --all, --provision-infra, --deploy, --status, or --teardown.${NC}" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# yq helper: read a key, return empty string for null/missing
# ---------------------------------------------------------------------------
yq_read() {
  local key="$1"
  local val
  val="$(yq eval "${key} // \"\"" "${CONFIG_FILE}" 2>/dev/null || echo "")"
  if [[ "${val}" == "null" || "${val}" == "~" ]]; then
    val=""
  fi
  echo "${val}"
}

yq_read_bool() {
  local key="$1"
  local default="${2:-false}"
  local val
  val="$(yq eval "${key}" "${CONFIG_FILE}" 2>/dev/null || echo "${default}")"
  case "${val}" in
    true|True|TRUE|1|yes|Yes) echo "1" ;;
    *) echo "0" ;;
  esac
}

# ---------------------------------------------------------------------------
# Load config from YAML
# ---------------------------------------------------------------------------
load_config() {
  if [[ ! -f "${CONFIG_FILE}" ]]; then
    echo -e "${RED}ERROR: Config file not found: ${CONFIG_FILE}${NC}" >&2
    echo "  Copy deploy-config.example.yaml to deploy-config.yaml and fill in your values." >&2
    exit 1
  fi

  echo -e "${CYAN}Loading config from: ${CONFIG_FILE}${NC}"

  # GCP
  export GCP_PROJECT_ID="$(yq_read '.gcp.project_id')"
  export CLOUD_CLI_PROFILE="$(yq_read '.gcp.cli_profile')"

  # Cluster
  export K8S_CLUSTER_NAME="$(yq_read '.cluster.name')"
  export K8S_CLUSTER_LOCATION="$(yq_read '.cluster.location')"
  export AUTO_CREATE_CLUSTER="$(yq_read_bool '.cluster.auto_create' true)"
  export AUTO_CREATE_NODE_POOL="$(yq_read_bool '.cluster.auto_create_node_pool' true)"
  export NODE_ARCHITECTURE="$(yq_read '.cluster.node_architecture')"
  [[ -z "${NODE_ARCHITECTURE}" ]] && NODE_ARCHITECTURE="amd64"
  export GKE_MACHINE_TYPE="$(yq_read '.cluster.machine_type')"
  export GKE_NODEPOOL_NAME="$(yq_read '.cluster.node_pool_name')"
  export GKE_NODEPOOL_NUM_NODES="$(yq_read '.cluster.node_pool_num_nodes')"
  [[ -z "${GKE_NODEPOOL_NUM_NODES}" ]] && GKE_NODEPOOL_NUM_NODES="3"
  export GKE_DISK_SIZE_GB="$(yq_read '.cluster.disk_size_gb')"
  [[ -z "${GKE_DISK_SIZE_GB}" ]] && GKE_DISK_SIZE_GB="100"
  export GKE_SUBNETWORK="$(yq_read '.cluster.subnetwork')"
  export GKE_NODE_LOCATIONS="$(yq_read '.cluster.node_locations')"
  export GKE_NODE_TAINTS="$(yq_read '.cluster.node_taints')"
  export GKE_RELEASE_CHANNEL="$(yq_read '.cluster.release_channel')"
  [[ -z "${GKE_RELEASE_CHANNEL}" ]] && GKE_RELEASE_CHANNEL="regular"
  export GKE_CLUSTER_VERSION="$(yq_read '.cluster.cluster_version')"

  # Network
  export NETWORK_VPC_NAME="$(yq_read '.network.vpc_name')"
  export ENDPOINT="$(yq_read '.network.endpoint')"

  # Storage
  export STORAGE_BACKEND="$(yq_read '.storage.backend')"
  [[ -z "${STORAGE_BACKEND}" ]] && STORAGE_BACKEND="gcnv"
  export GCNV_LOCATION="$(yq_read '.storage.gcnv_location')"
  export GCNV_NETWORK="$(yq_read '.storage.gcnv_network')"
  export STORAGE_SERVICE_LEVEL="$(yq_read '.storage.service_level')"
  [[ -z "${STORAGE_SERVICE_LEVEL}" ]] && STORAGE_SERVICE_LEVEL="premium"
  export STORAGE_POOL_CAPACITY_GIB="$(yq_read '.storage.pool_capacity_gib')"
  [[ -z "${STORAGE_POOL_CAPACITY_GIB}" ]] && STORAGE_POOL_CAPACITY_GIB="4096"
  export STORAGE_POOL_NAME="$(yq_read '.storage.pool_name')"
  export USE_EXISTING_STORAGE_POOL="$(yq_read_bool '.storage.use_existing_pool' false)"
  export TRIDENT_STORAGE_CLASS="$(yq_read '.storage.trident_storage_class')"
  [[ -z "${TRIDENT_STORAGE_CLASS}" ]] && TRIDENT_STORAGE_CLASS="ontap-nas"
  export TRIDENT_INSTALL="$(yq_read_bool '.storage.trident_install' true)"
  export EXISTING_TRIDENT_BACKEND_NAME="$(yq_read '.storage.existing_trident_backend')"

  # Credentials
  export NETAPP_MANAGEMENT_LIF="$(yq_read '.credentials.netapp_management_lif')"
  export NETAPP_SVM="$(yq_read '.credentials.netapp_svm')"
  export ONTAP_USERNAME="$(yq_read '.credentials.ontap_username')"
  [[ -z "${ONTAP_USERNAME}" ]] && ONTAP_USERNAME="vsadmin"
  export ONTAP_DATA_LIF="$(yq_read '.credentials.ontap_data_lif')"

  # DNS
  export DNS_ZONE_NAME="$(yq_read '.dns.zone_name')"
  export EXTERNALDNS_TXT_OWNER_ID="$(yq_read '.dns.txt_owner_id')"
  export GCP_DNS_SA_EMAIL="$(yq_read '.dns.sa_email')"
  export EXTERNALDNS_SOURCE_MODE="$(yq_read '.dns.source_mode')"
  [[ -z "${EXTERNALDNS_SOURCE_MODE}" ]] && EXTERNALDNS_SOURCE_MODE="gateway"
  export EXTERNALDNS_TXT_PREFIX="$(yq_read '.dns.txt_prefix')"
  [[ -z "${EXTERNALDNS_TXT_PREFIX}" ]] && EXTERNALDNS_TXT_PREFIX="txt"
  export EXTERNALDNS_POLICY="$(yq_read '.dns.policy')"
  [[ -z "${EXTERNALDNS_POLICY}" ]] && EXTERNALDNS_POLICY="upsert-only"

  # Deployment
  export DEPLOYMENT_NAME="$(yq_read '.deployment.name')"
  export SERVICES_NAMESPACE="$(yq_read '.deployment.namespace')"
  [[ -z "${SERVICES_NAMESPACE}" ]] && SERVICES_NAMESPACE="agentstudio-services"
  export DATABASE_NAMESPACE="$(yq_read '.deployment.database_namespace')"
  [[ -z "${DATABASE_NAMESPACE}" ]] && DATABASE_NAMESPACE="database"
  export CONTAINER_IMAGE_REPO="$(yq_read '.deployment.image_repo')"
  export IMAGE_TAG="$(yq_read '.deployment.image_tag')"
  local force_pull_val
  force_pull_val="$(yq_read_bool '.deployment.force_pull' false)"
  if [[ "${force_pull_val}" == "1" ]]; then
    export FORCE_PULL=1
  else
    unset FORCE_PULL 2>/dev/null || true
  fi
  export HELM_EXTRA_ARGS="$(yq_read '.deployment.helm_extra_args')"
  export CERT_MANAGER_GATEWAY_TLS="$(yq_read_bool '.deployment.cert_manager_tls' false)"
  export ARCH_PIN_WORKLOADS="$(yq_read_bool '.deployment.arch_pin_workloads' false)"
  export OBSERVABILITY="$(yq_read_bool '.deployment.observability' false)"

  # Always GCP
  export CLOUD_PROVIDER="gcp"
}

# ---------------------------------------------------------------------------
# Load sensitive values from environment (never from config file)
# ---------------------------------------------------------------------------
load_secrets() {
  # ONTAP_PASSWORD: required for provision-infra and all (unless using existing backend)
  if [[ "${COMMAND}" == "provision" || "${COMMAND}" == "all" ]]; then
    if [[ -z "${EXISTING_TRIDENT_BACKEND_NAME}" && -z "${ONTAP_PASSWORD:-}" ]]; then
      echo -e "${RED}ERROR: ONTAP_PASSWORD environment variable is required for storage provisioning.${NC}" >&2
      echo "  export ONTAP_PASSWORD='your-password'" >&2
      exit 1
    fi
    export ONTAP_PASSWORD="${ONTAP_PASSWORD:-}"
  fi

  # GHCR_PAT: required when image repo is ghcr.io
  if [[ -n "${CONTAINER_IMAGE_REPO}" ]] && echo "${CONTAINER_IMAGE_REPO}" | grep -q "^ghcr.io"; then
    if [[ -z "${GHCR_PAT:-}" ]]; then
      echo -e "${RED}ERROR: GHCR_PAT environment variable is required when image_repo uses ghcr.io.${NC}" >&2
      echo "  export GHCR_PAT='ghp_...'" >&2
      exit 1
    fi
    export GHCR_PAT
  fi
}

# ---------------------------------------------------------------------------
# Validate prerequisites (binaries)
# ---------------------------------------------------------------------------
validate_prereqs() {
  local missing=()
  for bin in gcloud helm kubectl yq; do
    if ! command -v "${bin}" >/dev/null 2>&1; then
      missing+=("${bin}")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo -e "${RED}ERROR: Required tools not found: ${missing[*]}${NC}" >&2
    echo "  Install them and ensure they are on your PATH." >&2
    exit 1
  fi

  # Validate yq is v4+ (mikefarah/yq, not the Python one)
  if ! yq eval '.' /dev/null >/dev/null 2>&1; then
    echo -e "${RED}ERROR: yq v4+ (mikefarah/yq) is required. The installed yq may be the Python version.${NC}" >&2
    echo "  Install from: https://github.com/mikefarah/yq" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Validate config: check all required fields for the chosen command
# ---------------------------------------------------------------------------
validate_config() {
  local missing=()

  # Always required (except for status which is best-effort)
  if [[ "${COMMAND}" != "status" ]]; then
    [[ -z "${GCP_PROJECT_ID}" ]]      && missing+=("gcp.project_id")
    [[ -z "${K8S_CLUSTER_NAME}" ]]    && missing+=("cluster.name")
    [[ -z "${K8S_CLUSTER_LOCATION}" ]] && missing+=("cluster.location")
    [[ -z "${ENDPOINT}" ]]            && missing+=("network.endpoint")
    [[ -z "${DEPLOYMENT_NAME}" ]]     && missing+=("deployment.name")
  fi

  # Provision-infra and all
  if [[ "${COMMAND}" == "provision" || "${COMMAND}" == "all" ]]; then
    [[ -z "${NETWORK_VPC_NAME}" ]]    && missing+=("network.vpc_name")
    [[ -z "${GCNV_LOCATION}" ]]       && missing+=("storage.gcnv_location")
    [[ -z "${DNS_ZONE_NAME}" ]]       && missing+=("dns.zone_name")
    [[ -z "${EXTERNALDNS_TXT_OWNER_ID}" ]] && missing+=("dns.txt_owner_id")
    [[ -z "${GCP_DNS_SA_EMAIL}" ]]    && missing+=("dns.sa_email")

    # GCNV network required when creating a new pool
    if [[ "${USE_EXISTING_STORAGE_POOL}" != "1" && -z "${GCNV_NETWORK}" ]]; then
      missing+=("storage.gcnv_network (required when creating a new storage pool)")
    fi

    # Trident credentials required when not reusing an existing backend
    if [[ -z "${EXISTING_TRIDENT_BACKEND_NAME}" ]]; then
      [[ -z "${NETAPP_MANAGEMENT_LIF}" ]] && missing+=("credentials.netapp_management_lif")
      [[ -z "${NETAPP_SVM}" ]]            && missing+=("credentials.netapp_svm")
    fi
  fi

  # Deploy and all
  if [[ "${COMMAND}" == "deploy" || "${COMMAND}" == "all" ]]; then
    [[ -z "${NETWORK_VPC_NAME}" ]]    && missing+=("network.vpc_name")
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo -e "${RED}ERROR: Missing required configuration fields:${NC}" >&2
    for field in "${missing[@]}"; do
      echo -e "  ${RED}-${NC} ${field}" >&2
    done
    echo "" >&2
    echo "  Edit ${CONFIG_FILE} and fill in the missing values." >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Phase runner (with resume-from and dry-run support)
# ---------------------------------------------------------------------------
CURRENT_PHASE=""
PHASE_ORDER=(preflight storage workload-identity dns foundation identity platform-deps platform verify)

should_run_phase() {
  local phase="$1"
  if [[ -z "${RESUME_FROM}" ]]; then
    return 0
  fi
  local dominated=1  # skip until we reach RESUME_FROM
  for p in "${PHASE_ORDER[@]}"; do
    if [[ "${p}" == "${RESUME_FROM}" ]]; then
      dominated=0    # run from here onward
    fi
    if [[ "${p}" == "${phase}" ]]; then
      return "${dominated}"
    fi
  done
  return 0
}

run_phase() {
  local phase="$1"
  shift

  if ! should_run_phase "${phase}"; then
    echo -e "${YELLOW}  Skipping phase: ${phase} (--resume-from=${RESUME_FROM})${NC}"
    return 0
  fi

  CURRENT_PHASE="${phase}"
  echo ""
  echo -e "${CYAN}${SEP}${NC}"
  echo -e "${CYAN}  Phase: ${phase}${NC}"
  echo -e "${CYAN}${SEP}${NC}"

  if [[ "${DRY_RUN}" == "1" ]]; then
    echo -e "${YELLOW}  [dry-run] Would execute: $*${NC}"
    return 0
  fi

  "$@"
  echo "LAST_SUCCESSFUL_PHASE=${phase}" >> "${STATE_FILE}"
}

on_failure() {
  echo ""
  echo -e "${RED}${SEP}${NC}"
  echo -e "${RED}  FAILED at phase: ${CURRENT_PHASE:-unknown}${NC}"
  echo -e "${RED}${SEP}${NC}"
  echo ""
  echo -e "Resume with:"
  echo -e "  $0 ${COMMAND:+--${COMMAND}} --resume-from=${CURRENT_PHASE:-unknown} -c ${CONFIG_FILE}"
  echo ""
  echo -e "Quick checks:"
  echo -e "  kubectl get pods -A"
  echo -e "  kubectl get events -A --sort-by=.metadata.creationTimestamp"
  echo -e "  helm list -A"
}

# ---------------------------------------------------------------------------
# Overlay builders (for Trident StorageClass and arch nodeSelector)
# ---------------------------------------------------------------------------
build_storage_overlay_files() {
  local workdir="${STATE_DIR}/overlays"
  mkdir -p "${workdir}"
  DB_OVERLAY="${workdir}/database-values-trident.auto.yaml"
  NEMO_OVERLAY="${workdir}/nemo-values-trident.auto.yaml"
  cat > "${DB_OVERLAY}" <<EOF
postgresql:
  primary:
    persistence:
      storageClass: "${TRIDENT_STORAGE_CLASS}"
EOF
  cat > "${NEMO_OVERLAY}" <<EOF
global:
  storageClass: "${TRIDENT_STORAGE_CLASS}"
EOF
}

build_arch_overlay_files() {
  local workdir="${STATE_DIR}/overlays"
  local arch_key="kubernetes.io/arch"
  mkdir -p "${workdir}"
  NEMO_ARCH_OVERLAY="${workdir}/nemo-values-arch.auto.yaml"
  KEYCLOAK_ARCH_OVERLAY="${workdir}/keycloak-values-arch.auto.yaml"

  cat > "${NEMO_ARCH_OVERLAY}" <<EOF
nodeSelector:
  ${arch_key}: "${NODE_ARCHITECTURE}"
s3gateway:
  nodeSelector:
    ${arch_key}: "${NODE_ARCHITECTURE}"
storage-manager:
  nodeSelector:
    ${arch_key}: "${NODE_ARCHITECTURE}"
kb-retrieval-service:
  nodeSelector:
    ${arch_key}: "${NODE_ARCHITECTURE}"
apigateway-service:
  nodeSelector:
    ${arch_key}: "${NODE_ARCHITECTURE}"
agent-service:
  nodeSelector:
    ${arch_key}: "${NODE_ARCHITECTURE}"
config-service:
  nodeSelector:
    ${arch_key}: "${NODE_ARCHITECTURE}"
gui:
  nodeSelector:
    ${arch_key}: "${NODE_ARCHITECTURE}"
workflow-engine:
  nodeSelector:
    ${arch_key}: "${NODE_ARCHITECTURE}"
analytics-engine:
  nodeSelector:
    ${arch_key}: "${NODE_ARCHITECTURE}"
litellm:
  nodeSelector:
    ${arch_key}: "${NODE_ARCHITECTURE}"
temporal:
  nodeSelector:
    ${arch_key}: "${NODE_ARCHITECTURE}"
EOF

  cat > "${KEYCLOAK_ARCH_OVERLAY}" <<EOF
nodeSelector:
  ${arch_key}: "${NODE_ARCHITECTURE}"
EOF
}

# ---------------------------------------------------------------------------
# Workload Identity binding for ExternalDNS
# ---------------------------------------------------------------------------
bind_workload_identity() {
  echo "Binding Workload Identity for ExternalDNS..."
  local member="serviceAccount:${GCP_PROJECT_ID}.svc.id.goog[external-dns/external-dns]"

  if [[ "${DRY_RUN}" == "1" ]]; then
    echo -e "${YELLOW}  [dry-run] Would bind ${GCP_DNS_SA_EMAIL} -> ${member}${NC}"
    return 0
  fi

  # Check if binding already exists (avoid noisy re-binds)
  local existing
  existing="$(gcloud iam service-accounts get-iam-policy "${GCP_DNS_SA_EMAIL}" \
    --project="${GCP_PROJECT_ID}" --format=json 2>/dev/null || echo "{}")"

  if echo "${existing}" | grep -q "${member}" 2>/dev/null; then
    echo -e "${GREEN}  Workload Identity binding already exists.${NC}"
    return 0
  fi

  gcloud iam service-accounts add-iam-policy-binding "${GCP_DNS_SA_EMAIL}" \
    --role="roles/iam.workloadIdentityUser" \
    --member="${member}" \
    --project="${GCP_PROJECT_ID}" \
    --quiet

  echo -e "${GREEN}  Workload Identity binding created.${NC}"
}

# ---------------------------------------------------------------------------
# Command: provision infrastructure
# ---------------------------------------------------------------------------
run_provision() {
  echo -e "\n${BOLD}Provisioning GKE infrastructure...${NC}"

  run_phase preflight "${SCRIPT_DIR}/gke-preflight.sh"

  run_phase storage "${SCRIPT_DIR}/gke-provision-gcnv.sh"

  # Bind Workload Identity after cluster exists but before ExternalDNS deploy
  run_phase workload-identity bind_workload_identity

  run_phase dns "${SCRIPT_DIR}/gke-deploy-externaldns.sh"

  echo -e "\n${GREEN}Infrastructure provisioning complete.${NC}"
}

# ---------------------------------------------------------------------------
# Command: deploy application
# ---------------------------------------------------------------------------
run_deploy() {
  echo -e "\n${BOLD}Deploying AgentStudio application...${NC}"

  build_storage_overlay_files
  local EXTRA_OVERLAYS="-f ${DB_OVERLAY} -f ${NEMO_OVERLAY}"
  local IDENTITY_OVERLAYS=""

  if [[ "${ARCH_PIN_WORKLOADS}" == "1" ]]; then
    build_arch_overlay_files
    EXTRA_OVERLAYS="${EXTRA_OVERLAYS} -f ${NEMO_ARCH_OVERLAY}"
    IDENTITY_OVERLAYS="-f ${KEYCLOAK_ARCH_OVERLAY}"
  fi

  local common_make_args=(
    ENDPOINT="${ENDPOINT}"
    SERVICES_NAMESPACE="${SERVICES_NAMESPACE}"
    DATABASE_NAMESPACE="${DATABASE_NAMESPACE}"
    DEPLOYMENT_NAME="${DEPLOYMENT_NAME}"
  )

  if [[ -n "${CONTAINER_IMAGE_REPO}" ]]; then
    common_make_args+=(CONTAINER_IMAGE_REPO="${CONTAINER_IMAGE_REPO}")
  fi
  if [[ -n "${IMAGE_TAG}" ]]; then
    common_make_args+=(IMAGE_TAG="${IMAGE_TAG}")
  fi
  if [[ -n "${FORCE_PULL:-}" ]]; then
    common_make_args+=(FORCE_PULL="${FORCE_PULL}")
  fi
  if [[ "${CERT_MANAGER_GATEWAY_TLS}" == "1" ]]; then
    common_make_args+=(CERT_MANAGER_GATEWAY_TLS=1)
  fi

  if [[ "${OBSERVABILITY}" == "1" ]]; then
    run_phase foundation make -C "${REPO_ROOT}" deploy-observability "${common_make_args[@]}"
  fi

  run_phase foundation make -C "${REPO_ROOT}" deploy-foundation \
    "${common_make_args[@]}" \
    HELM_EXTRA_ARGS="${EXTRA_OVERLAYS} ${HELM_EXTRA_ARGS:-}"

  run_phase identity make -C "${REPO_ROOT}" deploy-identity \
    "${common_make_args[@]}" \
    HELM_EXTRA_ARGS="${IDENTITY_OVERLAYS} ${HELM_EXTRA_ARGS:-}"

  run_phase workers make -C "${REPO_ROOT}" helm-workers-upgrade CLOUD=gke \
    "${common_make_args[@]}" \
    HELM_EXTRA_ARGS="${EXTRA_OVERLAYS} ${HELM_EXTRA_ARGS:-}"

  run_phase platform make -C "${REPO_ROOT}" helm-platform-upgrade CLOUD=gke \
    "${common_make_args[@]}" \
    HELM_EXTRA_ARGS="${EXTRA_OVERLAYS} ${HELM_EXTRA_ARGS:-}"

  run_phase llm-gateway make -C "${REPO_ROOT}" helm-llm-gateway-upgrade CLOUD=gke \
    "${common_make_args[@]}" \
    HELM_EXTRA_ARGS="${HELM_EXTRA_ARGS:-}"

  run_phase services make -C "${REPO_ROOT}" helm-services-upgrade CLOUD=gke \
    "${common_make_args[@]}" \
    HELM_EXTRA_ARGS="${EXTRA_OVERLAYS} ${HELM_EXTRA_ARGS:-}"

  run_phase console make -C "${REPO_ROOT}" helm-console-upgrade CLOUD=gke \
    "${common_make_args[@]}" \
    HELM_EXTRA_ARGS="${HELM_EXTRA_ARGS:-}"

  run_phase verify "${SCRIPT_DIR}/gke-postcheck.sh"

  echo -e "\n${GREEN}Application deployment complete.${NC}"
  echo ""
  echo -e "${BOLD}Access:${NC}"
  echo -e "  Console:    https://app.${ENDPOINT}:8443/console"
  echo -e "  Auth:       https://auth.${ENDPOINT}:8443"
  echo -e "  Catalog:    https://catalog.${ENDPOINT}:8443"
  echo -e "  Workflows:  https://workflows.${ENDPOINT}:8443"
}

# ---------------------------------------------------------------------------
# Command: status
# ---------------------------------------------------------------------------
run_status() {
  local ns="${SERVICES_NAMESPACE:-agentstudio-services}"
  local db_ns="${DATABASE_NAMESPACE:-database}"

  echo -e "\n${BOLD}Deployment Status${NC}"

  echo -e "\n${CYAN}=== Helm Releases ===${NC}"
  helm list -A 2>/dev/null || echo "  (no releases or helm not connected)"

  echo -e "\n${CYAN}=== Pods (${ns}) ===${NC}"
  kubectl get pods -n "${ns}" -o wide 2>/dev/null || echo "  (namespace not found)"

  echo -e "\n${CYAN}=== Pods (${db_ns}) ===${NC}"
  kubectl get pods -n "${db_ns}" -o wide 2>/dev/null || echo "  (namespace not found)"

  echo -e "\n${CYAN}=== StorageClasses ===${NC}"
  kubectl get storageclass 2>/dev/null || echo "  (not available)"

  echo -e "\n${CYAN}=== PVCs ===${NC}"
  kubectl get pvc -A 2>/dev/null || echo "  (not available)"

  echo -e "\n${CYAN}=== Gateway ===${NC}"
  kubectl get gateway -n "${ns}" 2>/dev/null || echo "  (no gateway)"

  if [[ -n "${ENDPOINT}" ]]; then
    echo -e "\n${CYAN}=== DNS Check (${ENDPOINT}) ===${NC}"
    if command -v dig >/dev/null 2>&1; then
      echo "  app.${ENDPOINT}:"
      dig +short "app.${ENDPOINT}" 2>/dev/null || echo "    (no result)"
      echo "  auth.${ENDPOINT}:"
      dig +short "auth.${ENDPOINT}" 2>/dev/null || echo "    (no result)"
    else
      echo "  (dig not installed, skipping DNS check)"
    fi
  fi

  echo -e "\n${CYAN}=== ExternalDNS ===${NC}"
  kubectl get deployment external-dns -n external-dns 2>/dev/null || echo "  (not deployed)"

  echo -e "\n${CYAN}=== Trident Backends ===${NC}"
  kubectl get tbc -n trident 2>/dev/null || echo "  (no Trident backends)"
}

# ---------------------------------------------------------------------------
# Command: teardown
# ---------------------------------------------------------------------------
run_teardown() {
  if [[ "${YES}" != "1" ]]; then
    echo -e "${YELLOW}WARNING: This will uninstall all Helm releases for AgentStudio.${NC}"
    echo -e "${YELLOW}GKE cluster, GCNV storage pools, and PVCs will be preserved.${NC}"
    echo ""
    read -r -p "Are you sure? Type 'yes' to confirm: " confirm
    if [[ "${confirm}" != "yes" ]]; then
      echo "Aborted."
      exit 0
    fi
  fi

  echo -e "\n${BOLD}Tearing down Helm releases (GKE-safe: PVCs preserved)...${NC}"

  if [[ "${DRY_RUN}" == "1" ]]; then
    echo -e "${YELLOW}  [dry-run] Would helm uninstall all tier releases${NC}"
    return 0
  fi

  # Uninstall tier releases in reverse order. Do NOT call undeploy-local here:
  # that target purges hostPath PVCs/PVs which do not exist on GKE, and would
  # delete real Filestore-backed PVCs, causing data loss.
  for release_ns in \
      "console:${HELM_NS_CONSOLE:-agentstudio-console}" \
      "services:${HELM_NS_SERVICES:-agentstudio-services}" \
      "llm-gateway:${HELM_NS_LLM_GATEWAY:-agentstudio-llm-gateway}" \
      "platform:${HELM_NS_PLATFORM:-agentstudio-platform}" \
      "workers:${HELM_NS_WORKERS:-agentstudio-workers}" \
      "identity:${HELM_NS_IDENTITY:-agentstudio-identity}" \
      "database:${HELM_NS_DATABASE:-database}"; do
    rel="${release_ns%%:*}"
    ns="${release_ns##*:}"
    helm uninstall "${rel}" --namespace "${ns}" 2>/dev/null || true
  done

  echo -e "\n${GREEN}Teardown complete. PVCs preserved.${NC}"
}

# ---------------------------------------------------------------------------
# Print config summary
# ---------------------------------------------------------------------------
print_summary() {
  echo ""
  echo -e "${BOLD}Configuration Summary${NC}"
  echo -e "${SEP}"
  echo -e "  Command:          ${COMMAND}"
  echo -e "  Config file:      ${CONFIG_FILE}"
  echo -e "  GCP project:      ${GCP_PROJECT_ID}"
  echo -e "  Cluster:          ${K8S_CLUSTER_NAME} (${K8S_CLUSTER_LOCATION})"
  echo -e "  Architecture:     ${NODE_ARCHITECTURE}"
  echo -e "  VPC:              ${NETWORK_VPC_NAME}"
  echo -e "  Endpoint:         ${ENDPOINT}"
  echo -e "  Deployment:       ${DEPLOYMENT_NAME}"
  echo -e "  Namespace:        ${SERVICES_NAMESPACE}"
  if [[ "${COMMAND}" == "provision" || "${COMMAND}" == "all" ]]; then
    echo -e "  Storage backend:  ${STORAGE_BACKEND}"
    echo -e "  GCNV location:    ${GCNV_LOCATION}"
    echo -e "  Storage class:    ${TRIDENT_STORAGE_CLASS}"
    echo -e "  DNS zone:         ${DNS_ZONE_NAME}"
    echo -e "  DNS SA:           ${GCP_DNS_SA_EMAIL}"
  fi
  if [[ -n "${CONTAINER_IMAGE_REPO}" ]]; then
    echo -e "  Image repo:       ${CONTAINER_IMAGE_REPO}"
  fi
  if [[ -n "${IMAGE_TAG}" ]]; then
    echo -e "  Image tag:        ${IMAGE_TAG}"
  fi
  if [[ -n "${RESUME_FROM}" ]]; then
    echo -e "  Resume from:      ${RESUME_FROM}"
  fi
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo -e "  ${YELLOW}DRY RUN — no changes will be made${NC}"
  fi
  echo -e "${SEP}"
  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  parse_args "$@"
  validate_prereqs

  # Status doesn't strictly require a config file
  if [[ "${COMMAND}" == "status" && ! -f "${CONFIG_FILE}" ]]; then
    SERVICES_NAMESPACE="${SERVICES_NAMESPACE:-agentstudio-services}"
    DATABASE_NAMESPACE="${DATABASE_NAMESPACE:-database}"
    ENDPOINT="${ENDPOINT:-}"
    run_status
    exit 0
  fi

  load_config
  load_secrets
  validate_config

  # Prepare state directory
  mkdir -p "${STATE_DIR}"
  if [[ "${COMMAND}" != "status" && "${DRY_RUN}" != "1" ]]; then
    : > "${STATE_FILE}"
  fi

  print_summary

  # Set up error trap
  trap 'on_failure' ERR

  case "${COMMAND}" in
    provision)
      run_provision
      ;;
    deploy)
      run_deploy
      ;;
    all)
      run_provision
      run_deploy
      ;;
    status)
      run_status
      ;;
    teardown)
      run_teardown
      ;;
  esac
}

main "$@"
