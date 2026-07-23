#!/usr/bin/env bash
# Configure Kubernetes cluster for NetApp ONTAP (on-prem) or AWS FSx for NetApp ONTAP (FSxN)
# storage via Trident CSI. Supports config file (YAML) or single-backend mode via env.
# See deployments/storage/README.md for config format and variables.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Defaults (overridable by env or config file)
TRIDENT_NAMESPACE="${TRIDENT_NAMESPACE:-trident}"
TRIDENT_INSTALL="${TRIDENT_INSTALL:-1}"
TRIDENT_HELM_VERSION="${TRIDENT_HELM_VERSION:-100.2410.0}"
TRIDENT_HELM_RELEASE_NAME="${TRIDENT_HELM_RELEASE_NAME:-trident}"
BACKEND_TYPE="${BACKEND_TYPE:-ontap}"
ONTAP_STORAGE_TYPES="${ONTAP_STORAGE_TYPES:-nas,san}"

CONFIG_FILE="${CONFIG_FILE:-}"

usage() {
    echo "Usage: $0"
    echo "  With config file: CONFIG_FILE=path/to/trident-backends.yaml $0"
    echo "  Single-backend ontap: ONTAP_MANAGEMENT_LIF=... ONTAP_SVM=... ONTAP_USERNAME=... ONTAP_PASSWORD=... $0"
    echo "  Single-backend FSxN:  BACKEND_TYPE=fsxn FSX_FILESYSTEM_ID=... ONTAP_SVM=... [FSXN_CREDENTIALS_ARN=... or ONTAP_USERNAME/ONTAP_PASSWORD]"
    echo "    Use ONTAP_STORAGE_TYPES=nas (not STORAGE_DRIVERS). Username must be vsadmin for FSx SVM API."
    echo "    K8s secret path: set FSX_MANAGEMENT_LIF (+ FSX_DATA_LIF for NAS) or AWS_REGION for auto-resolve."
    echo "  STORAGE_DRIVERS=ontap-nas is accepted as an alias for ONTAP_STORAGE_TYPES=nas."
    echo "  Set TRIDENT_INSTALL=0 to skip Trident install (cluster already has Trident)."
    echo "  See deployments/storage/README.md for full variable list."
}

# Map STORAGE_DRIVERS (ontap-nas / ontap-san) → ONTAP_STORAGE_TYPES (nas / san).
normalize_storage_driver_env() {
    if [ -z "${STORAGE_DRIVERS:-}" ]; then
        return 0
    fi
    local mapped="" d
    local IFS=','
    for d in $STORAGE_DRIVERS; do
        d=$(echo "$d" | tr -d ' ')
        case "$d" in
            ontap-nas|nas) mapped="${mapped:+$mapped,}nas" ;;
            ontap-san|san) mapped="${mapped:+$mapped,}san" ;;
            *)
                echo -e "${RED}Error: Unknown STORAGE_DRIVERS value '${d}' (use ontap-nas, ontap-san, nas, or san)${NC}" >&2
                return 1
                ;;
        esac
    done
    export ONTAP_STORAGE_TYPES="$mapped"
    echo -e "${YELLOW}STORAGE_DRIVERS=${STORAGE_DRIVERS} → ONTAP_STORAGE_TYPES=${ONTAP_STORAGE_TYPES}${NC}"
}

# FSx SVM REST API user is always vsadmin (password = --svm-admin-password from create-storage-virtual-machine).
normalize_fsxn_credentials() {
    if [ -z "${ONTAP_PASSWORD:-}" ] && [ -n "${FSX_ADMIN_PASSWORD:-}" ]; then
        export ONTAP_PASSWORD="$FSX_ADMIN_PASSWORD"
        echo -e "${GREEN}Using ONTAP_PASSWORD from FSX_ADMIN_PASSWORD${NC}"
    fi
    if [ -z "${ONTAP_USERNAME:-}" ]; then
        export ONTAP_USERNAME=vsadmin
    fi
    if [ "$ONTAP_USERNAME" != "vsadmin" ]; then
        echo -e "${RED}Error: FSx SVM Trident backends require ONTAP_USERNAME=vsadmin (got '${ONTAP_USERNAME}').${NC}" >&2
        echo -e "${RED}  fsxadmin is the file-system admin, not the SVM ONTAP API user. Use the SVM password from Step 3.4.${NC}" >&2
        return 1
    fi
    if [ -z "${ONTAP_PASSWORD:-}" ]; then
        echo -e "${RED}Error: Set ONTAP_PASSWORD or FSX_ADMIN_PASSWORD (same value as --svm-admin-password in Step 3.4).${NC}" >&2
        return 1
    fi
    return 0
}

# Test vsadmin/password against SVM management LIF from an EKS node (before applying TridentBackendConfig).
test_fsxn_ontap_credentials() {
    local ns="$1"
    local mgmt_lif="$2"
    local user="$3"
    local pass="$4"

    if [ "${FSXN_SKIP_CRED_CHECK:-0}" = "1" ]; then
        echo -e "${YELLOW}Skipping FSx credential check (FSXN_SKIP_CRED_CHECK=1).${NC}"
        return 0
    fi

    local node
    node=$(kubectl get pods -n "$ns" -l app=controller -o jsonpath='{.items[0].spec.nodeName}' 2>/dev/null || true)
    if [ -z "$node" ]; then
        node=$(kubectl get nodes -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
    fi
    if [ -z "$node" ]; then
        echo -e "${YELLOW}Warning: No node found for credential check; continuing.${NC}"
        return 0
    fi

    echo -e "${YELLOW}Testing ONTAP API login (vsadmin) at https://${mgmt_lif} from cluster...${NC}"
    local pod_name="trident-fsxn-cred-check-$$"
    local secret_name="${pod_name}-cred"
    kubectl create secret generic "$secret_name" \
        -n "$ns" \
        --from-literal=ONTAP_PASS="$pass" \
        --dry-run=client -o yaml | kubectl apply -f - >/dev/null
    trap 'kubectl delete secret "'"$secret_name"'" -n "'"$ns"'" --ignore-not-found >/dev/null 2>&1 || true' RETURN

    local overrides http_code
    overrides=$(cat <<EOF
{
  "spec": {
    "nodeName": "${node}",
    "containers": [{
      "name": "${pod_name}",
      "image": "curlimages/curl:8.5.0",
      "env": [{
        "name": "ONTAP_PASS",
        "valueFrom": {
          "secretKeyRef": { "name": "${secret_name}", "key": "ONTAP_PASS" }
        }
      }],
      "command": ["sh", "-c", "curl -sk -o /dev/null -w '%{http_code}' -u \"${user}:\$ONTAP_PASS\" \"https://${mgmt_lif}/api/storage/svm/svms?fields=name\""]
    }]
  }
}
EOF
)
    http_code=$(kubectl run "$pod_name" \
        -n "$ns" \
        --rm -i --restart=Never \
        --image=curlimages/curl:8.5.0 \
        --overrides="$overrides" \
        2>/dev/null | tr -d '\r' | tail -1)

    case "$http_code" in
        200)
            echo -e "${GREEN}ONTAP API credentials OK (HTTP 200).${NC}"
            return 0
            ;;
        401)
            echo -e "${RED}Error: ONTAP API returned 401 Unauthorized — username/password do not match the FSx SVM.${NC}" >&2
            echo -e "${RED}  Use ONTAP_USERNAME=vsadmin and ONTAP_PASSWORD exactly equal to FSX_ADMIN_PASSWORD from Step 3.4.${NC}" >&2
            echo -e "${RED}  Reset with: aws fsx update-storage-virtual-machine --svm-admin-password ... (see runbook Step 6a).${NC}" >&2
            return 1
            ;;
        *)
            echo -e "${YELLOW}Warning: Credential check returned HTTP ${http_code:-unknown} (not 401). Continuing; fix SG/443 if backend still fails.${NC}"
            return 0
            ;;
    esac
}

# Prerequisites
if ! command -v kubectl &>/dev/null; then
    echo -e "${RED}Error: kubectl is not installed${NC}" >&2
    exit 1
fi
if ! command -v helm &>/dev/null; then
    echo -e "${RED}Error: helm is not installed${NC}" >&2
    exit 1
fi
if ! kubectl cluster-info &>/dev/null; then
    echo -e "${RED}Error: Cannot connect to Kubernetes cluster${NC}" >&2
    exit 1
fi

# Config file mode: require yq
if [ -n "$CONFIG_FILE" ]; then
    if [ ! -f "$CONFIG_FILE" ]; then
        echo -e "${RED}Error: CONFIG_FILE=$CONFIG_FILE not found${NC}" >&2
        exit 1
    fi
    if ! command -v yq &>/dev/null; then
        echo -e "${RED}Error: CONFIG_FILE is set but yq is not installed. Install yq v4+ (e.g. https://github.com/mikefarah/yq) to use config file.${NC}" >&2
        exit 1
    fi
    if ! yq eval '.' "$CONFIG_FILE" &>/dev/null; then
        echo -e "${RED}Error: yq failed to parse config file. Ensure yq v4+ (yq eval) is available.${NC}" >&2
        exit 1
    fi
fi

# -----------------------------------------------------------------------------
# Install Trident (if requested)
# -----------------------------------------------------------------------------
install_trident() {
    local do_install="${1:-1}"
    local ns="$2"
    local chart_version="$3"
    if [ "$do_install" != "1" ] && [ "$do_install" != "true" ]; then
        echo -e "${GREEN}Skipping Trident install (TRIDENT_INSTALL=0 or installTrident=false).${NC}"
        return 0
    fi
    echo -e "${YELLOW}Installing Trident CSI...${NC}"
    # Preconfigured clusters may already have Trident installed outside this Helm release.
    # In that case, avoid a conflicting helm install/upgrade and proceed.
    if kubectl get crd tridentbackendconfigs.trident.netapp.io &>/dev/null || \
       kubectl get crd tridentconfigurators.trident.netapp.io &>/dev/null; then
        echo -e "${GREEN}Detected existing Trident CRDs; skipping Helm install.${NC}"
        return 0
    fi
    if helm list -n "$ns" -q 2>/dev/null | grep -q "^${TRIDENT_HELM_RELEASE_NAME}$"; then
        echo -e "${GREEN}Trident already installed (release: ${TRIDENT_HELM_RELEASE_NAME}).${NC}"
        return 0
    fi
    helm repo add netapp-trident https://netapp.github.io/trident-helm-chart 2>/dev/null || true
    helm repo update netapp-trident 2>/dev/null || true
    kubectl create namespace "$ns" 2>/dev/null || true
    helm upgrade --install "$TRIDENT_HELM_RELEASE_NAME" netapp-trident/trident-operator \
        --version "$chart_version" \
        --create-namespace \
        --namespace "$ns" \
        --wait \
        --timeout 5m
    echo -e "${GREEN}Trident installed. Waiting for operator to register CRDs...${NC}"
    # Operator creates CRDs after it starts; wait for operator rollout then poll for CRD
    for dep in trident-operator "${TRIDENT_HELM_RELEASE_NAME}-trident-operator"; do
        if kubectl get deployment "$dep" -n "$ns" &>/dev/null; then
            kubectl rollout status deployment/"$dep" -n "$ns" --timeout=120s
            break
        fi
    done
    sleep 10
    local crd_timeout=120
    local elapsed=0
    while [ $elapsed -lt $crd_timeout ]; do
        if kubectl get crd tridentbackendconfigs.trident.netapp.io &>/dev/null; then
            kubectl wait --for=condition=established --timeout=30s crd/tridentbackendconfigs.trident.netapp.io
            echo -e "${GREEN}Trident CRDs ready.${NC}"
            break
        fi
        sleep 5
        elapsed=$((elapsed + 5))
    done
    if ! kubectl get crd tridentbackendconfigs.trident.netapp.io &>/dev/null; then
        echo -e "${RED}Error: TridentBackendConfig CRD not found after ${crd_timeout}s. Ensure the Trident operator is running: kubectl get pods -n $ns${NC}" >&2
        exit 1
    fi
    echo -e "${GREEN}Trident ready.${NC}"
}

# -----------------------------------------------------------------------------
# Create Kubernetes Secret for ONTAP/FSxN credentials (username/password)
# -----------------------------------------------------------------------------
create_backend_secret() {
    local ns="$1"
    local secret_name="$2"
    if [ -z "$ONTAP_USERNAME" ] || [ -z "$ONTAP_PASSWORD" ]; then
        echo -e "${RED}Error: ONTAP_USERNAME and ONTAP_PASSWORD must be set for backend $secret_name${NC}" >&2
        return 1
    fi
    kubectl create secret generic "$secret_name" \
        --from-literal=username="$ONTAP_USERNAME" \
        --from-literal=password="$ONTAP_PASSWORD" \
        -n "$ns" \
        --dry-run=client -o yaml | kubectl apply -f -
    echo -e "${GREEN}Secret $secret_name created/updated in $ns${NC}"
}

# Verify Trident credential secret exists with required keys (username, password).
verify_backend_secret() {
    local ns="$1"
    local secret_name="$2"
    if ! kubectl get secret "$secret_name" -n "$ns" >/dev/null 2>&1; then
        echo -e "${RED}Error: Secret ${secret_name} not found in namespace ${ns}.${NC}" >&2
        echo "  Create it first (see docs/deployment/aws-agentstudio-complete-runbook.md Step 3.1)." >&2
        return 1
    fi
    for key in username password; do
        if ! kubectl get secret "$secret_name" -n "$ns" -o "jsonpath={.data.${key}}" 2>/dev/null | grep -q .; then
            echo -e "${RED}Error: Secret ${secret_name} in ${ns} is missing key '${key}' (expected username + password).${NC}" >&2
            return 1
        fi
    done
    return 0
}

# Resolve FSx SVM management/NFS DNS names (required for K8s-secret FSx backends).
resolve_fsxn_svm_endpoints() {
    local fsx_id="$1"
    local svm_name="$2"
    if [ -z "${AWS_REGION:-}" ]; then
        echo -e "${RED}Error: AWS_REGION must be set to resolve FSx SVM endpoints (or set FSX_MANAGEMENT_LIF explicitly).${NC}" >&2
        return 1
    fi
    local region="${AWS_REGION}"

    if [ -n "${FSX_MANAGEMENT_LIF:-}" ]; then
        echo -e "${GREEN}Using FSX_MANAGEMENT_LIF=${FSX_MANAGEMENT_LIF}${NC}"
        [ -n "${FSX_DATA_LIF:-}" ] && echo -e "${GREEN}Using FSX_DATA_LIF=${FSX_DATA_LIF}${NC}"
        return 0
    fi

    if ! command -v aws &>/dev/null; then
        echo -e "${RED}Error: Set FSX_MANAGEMENT_LIF (and FSX_DATA_LIF for NAS) or install aws CLI to auto-resolve from FSx.${NC}" >&2
        return 1
    fi

    echo -e "${YELLOW}Resolving FSx SVM endpoints (file-system ${fsx_id}, svm ${svm_name}, region ${region})...${NC}"
    local mgmt nfs
    # FSx API filters only support file-system-id (not SVM name) — match Name in JMESPath.
    mgmt=$(aws fsx describe-storage-virtual-machines --region "$region" \
        --filters "Name=file-system-id,Values=${fsx_id}" \
        --query "StorageVirtualMachines[?Name==\`${svm_name}\`].Endpoints.Management.DNSName | [0]" \
        --output text 2>/dev/null || true)
    nfs=$(aws fsx describe-storage-virtual-machines --region "$region" \
        --filters "Name=file-system-id,Values=${fsx_id}" \
        --query "StorageVirtualMachines[?Name==\`${svm_name}\`].Endpoints.Nfs.DNSName | [0]" \
        --output text 2>/dev/null || true)

    if [ -z "$mgmt" ] || [ "$mgmt" = "None" ] || [ "$mgmt" = "null" ]; then
        echo -e "${YELLOW}Listing SVMs on ${fsx_id} (check ONTAP_SVM name and AWS_REGION=${region}):${NC}" >&2
        aws fsx describe-storage-virtual-machines --region "$region" \
            --filters "Name=file-system-id,Values=${fsx_id}" \
            --query 'StorageVirtualMachines[*].{Name:Name,Lifecycle:Lifecycle,Mgmt:Endpoints.Management.DNSName,Nfs:Endpoints.Nfs.DNSName}' \
            --output table 2>/dev/null || true
        echo -e "${RED}Error: Could not resolve Management DNS for SVM '${svm_name}'. Set FSX_MANAGEMENT_LIF and FSX_DATA_LIF on the make line.${NC}" >&2
        return 1
    fi
    export FSX_MANAGEMENT_LIF="$mgmt"
    if [ -n "$nfs" ] && [ "$nfs" != "None" ] && [ "$nfs" != "null" ]; then
        export FSX_DATA_LIF="${FSX_DATA_LIF:-$nfs}"
    fi
    echo -e "${GREEN}FSX_MANAGEMENT_LIF=${FSX_MANAGEMENT_LIF}${NC}"
    [ -n "${FSX_DATA_LIF:-}" ] && echo -e "${GREEN}FSX_DATA_LIF=${FSX_DATA_LIF}${NC}"
    return 0
}

# -----------------------------------------------------------------------------
# Ensure StorageClass can be applied even if immutable fields changed
# -----------------------------------------------------------------------------
ensure_storage_class_recreatable() {
    local sc_name="$1"
    local desired_binding_mode="$2"
    if ! kubectl get storageclass "$sc_name" &>/dev/null; then
        return 0
    fi

    local current_binding_mode
    current_binding_mode=$(kubectl get storageclass "$sc_name" -o jsonpath='{.volumeBindingMode}' 2>/dev/null || true)
    [ -z "$current_binding_mode" ] && current_binding_mode="Immediate"

    if [ "$current_binding_mode" != "$desired_binding_mode" ]; then
        echo -e "${YELLOW}StorageClass ${sc_name} exists with volumeBindingMode=${current_binding_mode}, but desired is ${desired_binding_mode}. Recreating StorageClass to satisfy immutable field change...${NC}"
        if ! kubectl delete storageclass "$sc_name"; then
            echo -e "${RED}Error: Failed to delete existing StorageClass ${sc_name}. Delete it manually and retry.${NC}" >&2
            return 1
        fi
    fi
}

# -----------------------------------------------------------------------------
# Apply TridentBackendConfig (ontap) and StorageClass
# -----------------------------------------------------------------------------
apply_ontap_backend() {
    local ns="$1"
    local backend_name="$2"
    local driver="$3"
    local management_lif="$4"
    local svm="$5"
    local data_lif="${6:-}"
    local secret_name="$7"
    local storage_class_name="${8:-$driver}"
    local aggregate="${9:-}"
    local storage_pools="${10:-}"

    local spec_aggregate=""
    [ -n "$aggregate" ] && spec_aggregate="
  aggregate: ${aggregate}"

    local tbc_yaml
    if [ -n "$data_lif" ] && [ "$driver" = "ontap-nas" ]; then
        tbc_yaml=$(cat <<EOF
apiVersion: trident.netapp.io/v1
kind: TridentBackendConfig
metadata:
  name: ${backend_name}
  namespace: ${ns}
spec:
  version: 1
  backendName: ${backend_name}
  storageDriverName: ${driver}
  managementLIF: ${management_lif}
  dataLIF: ${data_lif}
  svm: ${svm}
  credentials:
    name: ${secret_name}${spec_aggregate}
EOF
)
    else
        tbc_yaml=$(cat <<EOF
apiVersion: trident.netapp.io/v1
kind: TridentBackendConfig
metadata:
  name: ${backend_name}
  namespace: ${ns}
spec:
  version: 1
  backendName: ${backend_name}
  storageDriverName: ${driver}
  managementLIF: ${management_lif}
  svm: ${svm}
  credentials:
    name: ${secret_name}${spec_aggregate}
EOF
)
    fi
    echo "$tbc_yaml" | kubectl apply -f -

    # StorageClass
    local vol_binding="Immediate"
    if [ "$driver" = "ontap-san" ]; then
        vol_binding="WaitForFirstConsumer"
    fi
    ensure_storage_class_recreatable "$storage_class_name" "$vol_binding" || return 1
    local sc_storage_pools=""
    [ -n "$storage_pools" ] && sc_storage_pools="
  storagePools: \"${storage_pools}\""
    local sc_default_ann=""
    if [ "$driver" = "ontap-nas" ]; then
        sc_default_ann="
  annotations:
    storageclass.kubernetes.io/is-default-class: \"true\""
    fi

    if [ "$driver" = "ontap-san" ]; then
        cat <<EOF | kubectl apply -f -
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ${storage_class_name}${sc_default_ann}
provisioner: csi.trident.netapp.io
parameters:
  backendType: "${driver}"${sc_storage_pools}
reclaimPolicy: Retain
volumeBindingMode: ${vol_binding}
allowVolumeExpansion: true
EOF
    else
        cat <<EOF | kubectl apply -f -
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ${storage_class_name}${sc_default_ann}
provisioner: csi.trident.netapp.io
parameters:
  backendType: "${driver}"${sc_storage_pools}
reclaimPolicy: Retain
volumeBindingMode: ${vol_binding}
allowVolumeExpansion: true
mountOptions:
  - nfsvers=4.0
  - nolock
  - soft
  - timeo=50
  - retrans=3
EOF
    fi
    echo -e "${GREEN}TridentBackendConfig ${backend_name} and StorageClass ${storage_class_name} applied.${NC}"
}

# -----------------------------------------------------------------------------
# Apply TridentBackendConfig (FSxN) and StorageClass
# -----------------------------------------------------------------------------
apply_fsxn_backend() {
    local ns="$1"
    local backend_name="$2"
    local driver="$3"
    local fsx_id="$4"
    local svm="$5"
    local cred_type="$6"   # awsarn or k8sSecret
    local cred_name="$7"   # ARN or Secret name
    local storage_class_name="${8:-$driver}"
    local storage_pools="${9:-}"

    local spec_extra=""
    local cred_spec
    if [ "$cred_type" = "awsarn" ]; then
        # FSx API path: credentials must be AWS Secrets Manager (type awsarn).
        spec_extra="
  aws:
    fsxFilesystemID: ${fsx_id}"
        cred_spec="name: \"${cred_name}\"
    type: awsarn"
    else
        # K8s secret path: use management/data LIFs (do not combine aws.fsxFilesystemID + K8s secret).
        if [ -z "${FSX_MANAGEMENT_LIF:-}" ]; then
            echo -e "${RED}Error: FSX_MANAGEMENT_LIF is required for FSx backends using a Kubernetes secret.${NC}" >&2
            return 1
        fi
        spec_extra="
  managementLIF: ${FSX_MANAGEMENT_LIF}"
        if [ "$driver" = "ontap-nas" ]; then
            if [ -z "${FSX_DATA_LIF:-}" ]; then
                echo -e "${RED}Error: FSX_DATA_LIF is required for ontap-nas (NFS data LIF).${NC}" >&2
                return 1
            fi
            spec_extra="${spec_extra}
  dataLIF: ${FSX_DATA_LIF}"
        fi
        cred_spec="name: ${cred_name}"
    fi

    local tbc_yaml
    tbc_yaml=$(cat <<EOF
apiVersion: trident.netapp.io/v1
kind: TridentBackendConfig
metadata:
  name: ${backend_name}
  namespace: ${ns}
spec:
  version: 1
  backendName: ${backend_name}
  storageDriverName: ${driver}
  svm: ${svm}${spec_extra}
  credentials:
    ${cred_spec}
EOF
)
    echo "$tbc_yaml" | kubectl apply -f -

    local vol_binding="Immediate"
    if [ "$driver" = "ontap-san" ]; then
        vol_binding="WaitForFirstConsumer"
    fi
    ensure_storage_class_recreatable "$storage_class_name" "$vol_binding" || return 1
    local sc_storage_pools=""
    [ -n "$storage_pools" ] && sc_storage_pools="
  storagePools: \"${storage_pools}\""
    local sc_default_ann=""
    if [ "$driver" = "ontap-nas" ]; then
        sc_default_ann="
  annotations:
    storageclass.kubernetes.io/is-default-class: \"true\""
    fi

    if [ "$driver" = "ontap-san" ]; then
        cat <<EOF | kubectl apply -f -
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ${storage_class_name}${sc_default_ann}
provisioner: csi.trident.netapp.io
parameters:
  backendType: "${driver}"${sc_storage_pools}
reclaimPolicy: Retain
volumeBindingMode: ${vol_binding}
allowVolumeExpansion: true
EOF
    else
        cat <<EOF | kubectl apply -f -
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ${storage_class_name}${sc_default_ann}
provisioner: csi.trident.netapp.io
parameters:
  backendType: "${driver}"${sc_storage_pools}
reclaimPolicy: Retain
volumeBindingMode: ${vol_binding}
allowVolumeExpansion: true
mountOptions:
  - nfsvers=4.0
  - nolock
  - soft
  - timeo=50
  - retrans=3
EOF
    fi
    echo -e "${GREEN}TridentBackendConfig ${backend_name} and StorageClass ${storage_class_name} applied.${NC}"
}

# -----------------------------------------------------------------------------
# Single-backend mode (no config file)
# -----------------------------------------------------------------------------
run_single_backend_mode() {
    local ns="$TRIDENT_NAMESPACE"
    if [ "$BACKEND_TYPE" = "ontap" ]; then
        if [ -z "$ONTAP_MANAGEMENT_LIF" ] || [ -z "$ONTAP_SVM" ]; then
            echo -e "${RED}Error: ONTAP_MANAGEMENT_LIF and ONTAP_SVM are required for ontap backend${NC}" >&2
            usage >&2
            exit 1
        fi
        if [ -z "$ONTAP_USERNAME" ] || [ -z "$ONTAP_PASSWORD" ]; then
            echo -e "${RED}Error: ONTAP_USERNAME and ONTAP_PASSWORD must be set (e.g. export) for ontap backend${NC}" >&2
            exit 1
        fi
        install_trident "$TRIDENT_INSTALL" "$ns" "$TRIDENT_HELM_VERSION"
        secret_name="ontap-backend-secret"
        create_backend_secret "$ns" "$secret_name" || exit 1
        for st in $(echo "$ONTAP_STORAGE_TYPES" | tr ',' ' '); do
            st=$(echo "$st" | tr -d ' ')
            [ -z "$st" ] && continue
            if [ "$st" = "nas" ]; then
                apply_ontap_backend "$ns" "ontap-nas-backend" "ontap-nas" \
                    "$ONTAP_MANAGEMENT_LIF" "$ONTAP_SVM" "$ONTAP_DATA_LIF" "$secret_name" "ontap-nas" \
                    "${ONTAP_AGGREGATE:-}" "${ONTAP_STORAGE_POOLS:-}"
            elif [ "$st" = "san" ]; then
                apply_ontap_backend "$ns" "ontap-san-backend" "ontap-san" \
                    "$ONTAP_MANAGEMENT_LIF" "$ONTAP_SVM" "" "$secret_name" "ontap-san" \
                    "${ONTAP_AGGREGATE:-}" "${ONTAP_STORAGE_POOLS:-}"
            fi
        done
    elif [ "$BACKEND_TYPE" = "fsxn" ]; then
        if [ -z "$FSX_FILESYSTEM_ID" ] || [ -z "$ONTAP_SVM" ]; then
            echo -e "${RED}Error: FSX_FILESYSTEM_ID and ONTAP_SVM are required for fsxn backend${NC}" >&2
            usage >&2
            exit 1
        fi
        install_trident "$TRIDENT_INSTALL" "$ns" "$TRIDENT_HELM_VERSION"
        cred_type=""
        cred_name=""
        if [ -n "$FSXN_CREDENTIALS_ARN" ]; then
            cred_type="awsarn"
            cred_name="$FSXN_CREDENTIALS_ARN"
        elif [ -n "$ONTAP_USERNAME" ] || [ -n "$ONTAP_PASSWORD" ] || [ -n "${FSX_ADMIN_PASSWORD:-}" ]; then
            normalize_fsxn_credentials || exit 1
            cred_type="k8sSecret"
            secret_name="fsxn-backend-secret"
            resolve_fsxn_svm_endpoints "$FSX_FILESYSTEM_ID" "$ONTAP_SVM" || exit 1
            create_backend_secret "$ns" "$secret_name" || exit 1
            verify_backend_secret "$ns" "$secret_name" || exit 1
            test_fsxn_ontap_credentials "$ns" "$FSX_MANAGEMENT_LIF" "$ONTAP_USERNAME" "$ONTAP_PASSWORD" || exit 1
            cred_name="$secret_name"
        else
            echo -e "${RED}Error: For FSxN set either FSXN_CREDENTIALS_ARN or ONTAP_USERNAME/ONTAP_PASSWORD${NC}" >&2
            exit 1
        fi
        for st in $(echo "$ONTAP_STORAGE_TYPES" | tr ',' ' '); do
            st=$(echo "$st" | tr -d ' ')
            [ -z "$st" ] && continue
            if [ "$st" = "nas" ]; then
                apply_fsxn_backend "$ns" "fsxn-nas-backend" "ontap-nas" \
                    "$FSX_FILESYSTEM_ID" "$ONTAP_SVM" "$cred_type" "$cred_name" "fsxn-nas" \
                    "${ONTAP_STORAGE_POOLS:-}"
            elif [ "$st" = "san" ]; then
                apply_fsxn_backend "$ns" "fsxn-san-backend" "ontap-san" \
                    "$FSX_FILESYSTEM_ID" "$ONTAP_SVM" "$cred_type" "$cred_name" "fsxn-san" \
                    "${ONTAP_STORAGE_POOLS:-}"
            fi
        done
    else
        echo -e "${RED}Error: BACKEND_TYPE must be ontap or fsxn${NC}" >&2
        exit 1
    fi
}

# -----------------------------------------------------------------------------
# Config file mode: read backends and apply each
# -----------------------------------------------------------------------------
run_config_file_mode() {
    local ns install_trident_val chart_ver
    ns=$(yq eval ".tridentNamespace // \"$TRIDENT_NAMESPACE\"" "$CONFIG_FILE")
    install_trident_val=$(yq eval '.installTrident // true' "$CONFIG_FILE")
    chart_ver=$(yq eval ".tridentHelmVersion // \"$TRIDENT_HELM_VERSION\"" "$CONFIG_FILE")
    [ -z "$ns" ] || [ "$ns" = "null" ] && ns="$TRIDENT_NAMESPACE"
    [ "$install_trident_val" = "null" ] && install_trident_val="true"
    [ -z "$chart_ver" ] || [ "$chart_ver" = "null" ] && chart_ver="$TRIDENT_HELM_VERSION"

    install_trident "$install_trident_val" "$ns" "$chart_ver"

    local backend_count
    backend_count=$(yq eval '.backends | length' "$CONFIG_FILE")
    [ -z "$backend_count" ] && backend_count=0
    [ "$backend_count" = "null" ] && backend_count=0

    for ((i=0; i<backend_count; i++)); do
        local name type driver management_lif svm data_lif fsx_id
        local credentials_from_env cred_type cred_name sc_name aggregate storage_pools
        name=$(yq eval ".backends[$i].name" "$CONFIG_FILE")
        type=$(yq eval ".backends[$i].type" "$CONFIG_FILE")
        driver=$(yq eval ".backends[$i].storageDriverName" "$CONFIG_FILE")
        management_lif=$(yq eval ".backends[$i].managementLIF" "$CONFIG_FILE")
        svm=$(yq eval ".backends[$i].svm" "$CONFIG_FILE")
        data_lif=$(yq eval ".backends[$i].dataLIF" "$CONFIG_FILE")
        fsx_id=$(yq eval ".backends[$i].fsxFilesystemID" "$CONFIG_FILE")
        credentials_from_env=$(yq eval ".backends[$i].credentialsFromEnv" "$CONFIG_FILE")
        cred_type=$(yq eval ".backends[$i].credentials.type" "$CONFIG_FILE")
        cred_name=$(yq eval ".backends[$i].credentials.name" "$CONFIG_FILE")
        sc_name=$(yq eval ".backends[$i].storageClass.name" "$CONFIG_FILE")
        aggregate=$(yq eval ".backends[$i].aggregate" "$CONFIG_FILE")
        storage_pools=$(yq eval ".backends[$i].storageClass.storagePools" "$CONFIG_FILE")
        [ "$sc_name" = "null" ] || [ -z "$sc_name" ] && sc_name="$driver"
        [ "$data_lif" = "null" ] && data_lif=""
        [ "$cred_type" = "null" ] && cred_type=""
        [ "$cred_name" = "null" ] && cred_name=""
        [ "$aggregate" = "null" ] && aggregate=""
        [ "$storage_pools" = "null" ] && storage_pools=""

        if [ "$type" = "ontap" ]; then
            if [ "$credentials_from_env" = "true" ] || [ "$credentials_from_env" = "1" ]; then
                create_backend_secret "$ns" "${name}-secret" || exit 1
                cred_name="${name}-secret"
            fi
            if [ -z "$cred_name" ]; then
                echo -e "${RED}Error: backend $name (ontap) needs credentialsFromEnv: true or credentials.name${NC}" >&2
                exit 1
            fi
            apply_ontap_backend "$ns" "$name" "$driver" "$management_lif" "$svm" "$data_lif" "$cred_name" "$sc_name" "$aggregate" "$storage_pools"
        elif [ "$type" = "fsxn" ]; then
            if [ "$credentials_from_env" = "true" ] || [ "$credentials_from_env" = "1" ]; then
                create_backend_secret "$ns" "${name}-secret" || exit 1
                cred_type="k8sSecret"
                cred_name="${name}-secret"
            fi
            if [ -z "$cred_name" ]; then
                echo -e "${RED}Error: backend $name (fsxn) needs credentials (awsarn or credentialsFromEnv)${NC}" >&2
                exit 1
            fi
            if [ -z "$cred_type" ] || [ "$cred_type" = "null" ]; then
                if [[ "$cred_name" == arn:aws:secretsmanager:* ]]; then
                    cred_type="awsarn"
                else
                    cred_type="k8sSecret"
                fi
            fi
            if [ "$cred_type" = "k8sSecret" ]; then
                [ -n "$management_lif" ] && [ "$management_lif" != "null" ] && export FSX_MANAGEMENT_LIF="$management_lif"
                [ -n "$data_lif" ] && [ "$data_lif" != "null" ] && export FSX_DATA_LIF="$data_lif"
                resolve_fsxn_svm_endpoints "$fsx_id" "$svm" || exit 1
                verify_backend_secret "$ns" "$cred_name" || exit 1
            fi
            apply_fsxn_backend "$ns" "$name" "$driver" "$fsx_id" "$svm" "$cred_type" "$cred_name" "$sc_name" "$storage_pools"
        else
            echo -e "${YELLOW}Skipping backend $name: unsupported type $type${NC}"
        fi
    done
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
echo -e "${GREEN}Configuring ONTAP/FSxN storage (Trident CSI)${NC}"
normalize_storage_driver_env || exit 1
if [ -n "$CONFIG_FILE" ]; then
    echo "Using config file: $CONFIG_FILE"
    run_config_file_mode
else
    echo "Single-backend mode: BACKEND_TYPE=$BACKEND_TYPE"
    run_single_backend_mode
fi
echo -e "${GREEN}Done. Verify with: kubectl get tbc -n $TRIDENT_NAMESPACE && kubectl get storageclass${NC}"
