#!/usr/bin/env bash
set -euo pipefail

STATE_FILE="${STATE_FILE:-.deploy-state/cloud-auto.env}"
AUTO_CREATE_CLUSTER="${AUTO_CREATE_CLUSTER:-1}"
AUTO_CREATE_NODE_POOL="${AUTO_CREATE_NODE_POOL:-1}"
NODE_ARCHITECTURE="${NODE_ARCHITECTURE:-amd64}"
GKE_CLUSTER_MODE="${GKE_CLUSTER_MODE:-standard}"
GKE_NODEPOOL_NAME="${GKE_NODEPOOL_NAME:-${NODE_ARCHITECTURE}-pool}"
GKE_NODEPOOL_NUM_NODES="${GKE_NODEPOOL_NUM_NODES:-3}"
GKE_RELEASE_CHANNEL="${GKE_RELEASE_CHANNEL:-regular}"
GKE_MACHINE_TYPE="${GKE_MACHINE_TYPE:-}"
GKE_DISK_SIZE_GB="${GKE_DISK_SIZE_GB:-100}"
GKE_IMAGE_TYPE="${GKE_IMAGE_TYPE:-COS_CONTAINERD}"
AUTO_CREATE_SAN_NODE_POOL="${AUTO_CREATE_SAN_NODE_POOL:-1}"
GKE_SAN_NODEPOOL_NAME="${GKE_SAN_NODEPOOL_NAME:-san-ubuntu-pool}"
GKE_SAN_NODEPOOL_NUM_NODES="${GKE_SAN_NODEPOOL_NUM_NODES:-1}"
GKE_SAN_MACHINE_TYPE="${GKE_SAN_MACHINE_TYPE:-e2-standard-4}"
GKE_SAN_IMAGE_TYPE="${GKE_SAN_IMAGE_TYPE:-UBUNTU_CONTAINERD}"
GKE_SAN_NODE_LABELS="${GKE_SAN_NODE_LABELS:-agentstudio.netapp.io/san=true}"
GKE_SAN_NODE_TAINTS="${GKE_SAN_NODE_TAINTS:-agentstudio.netapp.io/san=true:NoSchedule}"
GKE_SAN_NODE_LOCATIONS="${GKE_SAN_NODE_LOCATIONS:-${GKE_NODE_LOCATIONS:-}}"
AUTO_BOOTSTRAP_SAN_HOSTS="${AUTO_BOOTSTRAP_SAN_HOSTS:-1}"
SAN_HOST_BOOTSTRAP_NAMESPACE="${SAN_HOST_BOOTSTRAP_NAMESPACE:-kube-system}"
SAN_HOST_BOOTSTRAP_DS_NAME="${SAN_HOST_BOOTSTRAP_DS_NAME:-san-host-bootstrap}"

required_vars=(
  CLOUD_PROVIDER
  GCP_PROJECT_ID
  K8S_CLUSTER_NAME
  K8S_CLUSTER_LOCATION
  NETWORK_VPC_NAME
  STORAGE_BACKEND
  ENDPOINT
  DNS_ZONE_NAME
)

for v in "${required_vars[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    echo "ERROR: required variable missing: $v" >&2
    exit 1
  fi
done

if [[ "${CLOUD_PROVIDER}" != "gcp" ]]; then
  echo "ERROR: gke-preflight.sh expects CLOUD_PROVIDER=gcp" >&2
  exit 1
fi

if [[ "${NODE_ARCHITECTURE}" != "amd64" && "${NODE_ARCHITECTURE}" != "arm64" ]]; then
  echo "ERROR: NODE_ARCHITECTURE must be amd64|arm64" >&2
  exit 1
fi

for bin in kubectl helm gcloud; do
  if ! command -v "${bin}" >/dev/null 2>&1; then
    echo "ERROR: ${bin} is required but not installed" >&2
    exit 1
  fi
done

if [[ -n "${CLOUD_CLI_PROFILE:-}" ]]; then
  gcloud config configurations activate "${CLOUD_CLI_PROFILE}" >/dev/null
fi

gcloud config set project "${GCP_PROJECT_ID}" >/dev/null

if [[ -z "${GKE_MACHINE_TYPE}" ]]; then
  if [[ "${NODE_ARCHITECTURE}" == "arm64" ]]; then
    GKE_MACHINE_TYPE="t2a-standard-4"
  else
    GKE_MACHINE_TYPE="e2-standard-4"
  fi
fi

if [[ "${NODE_ARCHITECTURE}" == "arm64" && "${GKE_MACHINE_TYPE}" != t2a-* ]]; then
  echo "ERROR: arm64 node pools require an Arm machine type (for example t2a-standard-4)." >&2
  exit 1
fi

cluster_exists=0
if gcloud container clusters describe "${K8S_CLUSTER_NAME}" --location "${K8S_CLUSTER_LOCATION}" --project "${GCP_PROJECT_ID}" >/dev/null 2>&1; then
  cluster_exists=1
fi

if [[ "${cluster_exists}" == "0" ]]; then
  if [[ "${AUTO_CREATE_CLUSTER}" != "1" ]]; then
    echo "ERROR: cluster '${K8S_CLUSTER_NAME}' does not exist and AUTO_CREATE_CLUSTER!=1." >&2
    exit 1
  fi

  create_args=(
    container clusters create "${K8S_CLUSTER_NAME}"
    --location "${K8S_CLUSTER_LOCATION}"
    --project "${GCP_PROJECT_ID}"
    --network "${NETWORK_VPC_NAME}"
    --release-channel "${GKE_RELEASE_CHANNEL}"
    --num-nodes "1"
    --machine-type "${GKE_MACHINE_TYPE}"
    --disk-size "${GKE_DISK_SIZE_GB}"
    --image-type "${GKE_IMAGE_TYPE}"
  )
  if [[ -n "${GKE_SUBNETWORK:-}" ]]; then
    create_args+=(--subnetwork "${GKE_SUBNETWORK}")
  fi
  if [[ "${NODE_ARCHITECTURE}" == "arm64" ]]; then
    create_args+=(--node-labels "workload-arch=arm64")
  fi
  if [[ -n "${GKE_CLUSTER_VERSION:-}" ]]; then
    create_args+=(--cluster-version "${GKE_CLUSTER_VERSION}")
  fi

  gcloud "${create_args[@]}"
fi

if [[ "${AUTO_CREATE_NODE_POOL}" == "1" ]]; then
  if ! gcloud container node-pools describe "${GKE_NODEPOOL_NAME}" \
    --cluster "${K8S_CLUSTER_NAME}" \
    --location "${K8S_CLUSTER_LOCATION}" \
    --project "${GCP_PROJECT_ID}" >/dev/null 2>&1; then
    np_args=(
      container node-pools create "${GKE_NODEPOOL_NAME}"
      --cluster "${K8S_CLUSTER_NAME}"
      --location "${K8S_CLUSTER_LOCATION}"
      --project "${GCP_PROJECT_ID}"
      --machine-type "${GKE_MACHINE_TYPE}"
      --num-nodes "${GKE_NODEPOOL_NUM_NODES}"
      --disk-size "${GKE_DISK_SIZE_GB}"
      --image-type "${GKE_IMAGE_TYPE}"
      --node-labels "workload-arch=${NODE_ARCHITECTURE}"
    )
    if [[ -n "${GKE_NODE_TAINTS:-}" ]]; then
      np_args+=(--node-taints "${GKE_NODE_TAINTS}")
    fi
    if [[ -n "${GKE_NODE_LOCATIONS:-}" ]]; then
      np_args+=(--node-locations "${GKE_NODE_LOCATIONS}")
    fi
    gcloud "${np_args[@]}"
  fi
fi

# GCNV SAN (iSCSI) workloads require Ubuntu nodes with host iSCSI tooling.
if [[ "${AUTO_CREATE_SAN_NODE_POOL}" == "1" ]]; then
  if ! gcloud container node-pools describe "${GKE_SAN_NODEPOOL_NAME}" \
    --cluster "${K8S_CLUSTER_NAME}" \
    --location "${K8S_CLUSTER_LOCATION}" \
    --project "${GCP_PROJECT_ID}" >/dev/null 2>&1; then
    san_np_args=(
      container node-pools create "${GKE_SAN_NODEPOOL_NAME}"
      --cluster "${K8S_CLUSTER_NAME}"
      --location "${K8S_CLUSTER_LOCATION}"
      --project "${GCP_PROJECT_ID}"
      --machine-type "${GKE_SAN_MACHINE_TYPE}"
      --num-nodes "${GKE_SAN_NODEPOOL_NUM_NODES}"
      --disk-size "${GKE_DISK_SIZE_GB}"
      --image-type "${GKE_SAN_IMAGE_TYPE}"
      --node-labels "${GKE_SAN_NODE_LABELS}"
      --node-taints "${GKE_SAN_NODE_TAINTS}"
    )
    if [[ -n "${GKE_SAN_NODE_LOCATIONS}" ]]; then
      san_np_args+=(--node-locations "${GKE_SAN_NODE_LOCATIONS}")
    fi
    gcloud "${san_np_args[@]}"
  fi
fi

gcloud container clusters get-credentials "${K8S_CLUSTER_NAME}" --location "${K8S_CLUSTER_LOCATION}" --project "${GCP_PROJECT_ID}" >/dev/null

if [[ "${AUTO_BOOTSTRAP_SAN_HOSTS}" == "1" ]]; then
  cat <<EOF | kubectl apply -f - >/dev/null
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ${SAN_HOST_BOOTSTRAP_DS_NAME}
  namespace: ${SAN_HOST_BOOTSTRAP_NAMESPACE}
spec:
  selector:
    matchLabels:
      app: ${SAN_HOST_BOOTSTRAP_DS_NAME}
  template:
    metadata:
      labels:
        app: ${SAN_HOST_BOOTSTRAP_DS_NAME}
    spec:
      hostPID: true
      hostNetwork: true
      nodeSelector:
        agentstudio.netapp.io/san: "true"
      tolerations:
        - key: "agentstudio.netapp.io/san"
          operator: "Equal"
          value: "true"
          effect: "NoSchedule"
      containers:
        - name: bootstrap
          image: ubuntu:24.04
          securityContext:
            privileged: true
          command:
            - /bin/bash
            - -lc
            - |
              set -euxo pipefail
              chroot /host /bin/bash -lc '
                apt-get update
                DEBIAN_FRONTEND=noninteractive apt-get install -y open-iscsi multipath-tools lsscsi sg3-utils
                printf "%s\n" "defaults {" "  user_friendly_names yes" "  find_multipaths no" "}" >/etc/multipath.conf
                systemctl daemon-reload || true
                systemctl enable --now iscsid
                systemctl restart iscsid || true
                systemctl enable --now multipathd || true
                systemctl restart multipathd || true
              '
              sleep infinity
          volumeMounts:
            - name: host-root
              mountPath: /host
      volumes:
        - name: host-root
          hostPath:
            path: /
            type: Directory
EOF
  kubectl rollout status daemonset/"${SAN_HOST_BOOTSTRAP_DS_NAME}" -n "${SAN_HOST_BOOTSTRAP_NAMESPACE}" --timeout=10m >/dev/null
fi

cluster_network_uri="$(gcloud container clusters describe "${K8S_CLUSTER_NAME}" --location "${K8S_CLUSTER_LOCATION}" --project "${GCP_PROJECT_ID}" --format='value(network)')"
cluster_subnet_uri="$(gcloud container clusters describe "${K8S_CLUSTER_NAME}" --location "${K8S_CLUSTER_LOCATION}" --project "${GCP_PROJECT_ID}" --format='value(subnetwork)')"
cluster_network="${cluster_network_uri##*/}"

if [[ "${cluster_network}" != "${NETWORK_VPC_NAME}" ]]; then
  echo "ERROR: GKE cluster is on VPC '${cluster_network}', expected '${NETWORK_VPC_NAME}'." >&2
  exit 1
fi

# Validate DNS zone exists.
if ! gcloud dns managed-zones describe "${DNS_ZONE_NAME}" --project "${GCP_PROJECT_ID}" >/dev/null 2>&1; then
  echo "ERROR: DNS zone '${DNS_ZONE_NAME}' not found in project '${GCP_PROJECT_ID}'." >&2
  exit 1
fi

# Basic NFS firewall check (best-effort: at least one allow rule for TCP 2049 on the VPC).
nfs_rule_count="$(gcloud compute firewall-rules list \
  --project "${GCP_PROJECT_ID}" \
  --filter="network~${NETWORK_VPC_NAME} AND direction=INGRESS AND allowed.tcp:2049" \
  --format='value(name)' | awk 'NF' | wc -l | tr -d ' ')"
if [[ "${nfs_rule_count}" == "0" ]]; then
  echo "ERROR: no ingress firewall rule allowing tcp:2049 found for VPC ${NETWORK_VPC_NAME}." >&2
  exit 1
fi

mkdir -p "$(dirname "${STATE_FILE}")"
{
  echo "KUBE_CONTEXT=$(kubectl config current-context)"
  echo "CLUSTER_NETWORK=${cluster_network}"
  echo "CLUSTER_SUBNETWORK=${cluster_subnet_uri##*/}"
  echo "NODE_ARCHITECTURE=${NODE_ARCHITECTURE}"
  echo "GKE_NODEPOOL_NAME=${GKE_NODEPOOL_NAME}"
  echo "GKE_SAN_NODEPOOL_NAME=${GKE_SAN_NODEPOOL_NAME}"
  echo "GKE_MACHINE_TYPE=${GKE_MACHINE_TYPE}"
  echo "PROJECT_OK=true"
  echo "VPC_VALIDATED=true"
} >> "${STATE_FILE}"

echo "Preflight checks passed."
