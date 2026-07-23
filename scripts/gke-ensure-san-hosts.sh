#!/usr/bin/env bash
set -euo pipefail

# Ensure GKE SAN (Ubuntu) nodes are ready for Trident GCNV SAN (iSCSI) mounts.
#
# Two failure modes this guards against on (re)deploy:
#   1) SAN nodes lack open-iscsi/multipath-tools, so DB RWO volumes never attach
#      ("open-iscsi tools not found on host").
#   2) The Trident node pod read /etc/iscsi/initiatorname.iscsi BEFORE open-iscsi
#      was installed, so it registered the node with an EMPTY iSCSI IQN. The GCNV
#      host group is then built without that IQN and the LUN is masked from the
#      node -> "no devices present yet" / attach timeouts, even though the tools
#      are now installed.
#
# Remediation (idempotent, safe to re-run):
#   a) Apply a host bootstrap DaemonSet that installs open-iscsi/multipath-tools
#      and starts iscsid/multipathd on every SAN node.
#   b) Only when a SAN node has no registered IQN, restart the Trident node
#      DaemonSet so it re-reads the (now populated) initiator name and re-registers
#      with GCNV. Healthy clusters skip this -> no disruption on normal redeploys.
#   c) Gate until every SAN node reports a non-empty IQN before returning, so the
#      DB pod only schedules once its node can actually mount its LUN.

SAN_NODE_LABEL="${SAN_NODE_LABEL:-agentstudio.netapp.io/san=true}"
SAN_HOST_BOOTSTRAP_NAMESPACE="${SAN_HOST_BOOTSTRAP_NAMESPACE:-kube-system}"
SAN_HOST_BOOTSTRAP_DS_NAME="${SAN_HOST_BOOTSTRAP_DS_NAME:-san-host-bootstrap}"
TRIDENT_NAMESPACE="${TRIDENT_NAMESPACE:-trident}"
TRIDENT_NODE_DS="${TRIDENT_NODE_DS:-trident-node-linux}"
SAN_HOST_BOOTSTRAP_TIMEOUT="${SAN_HOST_BOOTSTRAP_TIMEOUT:-10m}"
TRIDENT_NODE_RESTART_TIMEOUT="${TRIDENT_NODE_RESTART_TIMEOUT:-300s}"
IQN_WAIT_TIMEOUT="${IQN_WAIT_TIMEOUT:-300}"

log() { echo "[gke-san-hosts] $*"; }

san_nodes="$(kubectl get nodes -l "${SAN_NODE_LABEL}" \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)"

if [[ -z "${san_nodes}" ]]; then
  log "No SAN nodes match '${SAN_NODE_LABEL}'; assuming NAS-only cluster, skipping."
  exit 0
fi

log "SAN nodes:"
for n in ${san_nodes}; do log "  - ${n}"; done

log "Applying SAN host bootstrap DaemonSet '${SAN_HOST_BOOTSTRAP_DS_NAME}' (ns ${SAN_HOST_BOOTSTRAP_NAMESPACE})..."
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

log "Waiting for SAN host bootstrap rollout..."
kubectl rollout status daemonset/"${SAN_HOST_BOOTSTRAP_DS_NAME}" \
  -n "${SAN_HOST_BOOTSTRAP_NAMESPACE}" --timeout="${SAN_HOST_BOOTSTRAP_TIMEOUT}"

node_iqn() {
  kubectl -n "${TRIDENT_NAMESPACE}" get tridentnode "$1" \
    -o jsonpath='{.iqn}' 2>/dev/null || true
}

# Restart Trident node pods only if a SAN node has no registered IQN, so a
# healthy redeploy stays a no-op (no node CSI plugin churn).
needs_restart=0
for node in ${san_nodes}; do
  if [[ -z "$(node_iqn "${node}")" ]]; then
    log "SAN node ${node} has no registered iSCSI IQN."
    needs_restart=1
  fi
done

if [[ "${needs_restart}" == "1" ]]; then
  if kubectl -n "${TRIDENT_NAMESPACE}" get ds/"${TRIDENT_NODE_DS}" >/dev/null 2>&1; then
    log "Restarting Trident node DaemonSet '${TRIDENT_NODE_DS}' to re-register IQNs..."
    kubectl -n "${TRIDENT_NAMESPACE}" rollout restart ds/"${TRIDENT_NODE_DS}"
    kubectl -n "${TRIDENT_NAMESPACE}" rollout status ds/"${TRIDENT_NODE_DS}" \
      --timeout="${TRIDENT_NODE_RESTART_TIMEOUT}" || true
  else
    log "WARN: Trident node DaemonSet '${TRIDENT_NODE_DS}' not found in ns ${TRIDENT_NAMESPACE}; skipping restart."
  fi
fi

# Gate until every SAN node reports a non-empty IQN.
log "Waiting (up to ${IQN_WAIT_TIMEOUT}s) for all SAN nodes to register an iSCSI IQN..."
deadline=$(( SECONDS + IQN_WAIT_TIMEOUT ))
while true; do
  missing=""
  for node in ${san_nodes}; do
    if [[ -z "$(node_iqn "${node}")" ]]; then
      missing="${missing} ${node}"
    fi
  done
  if [[ -z "${missing}" ]]; then
    log "All SAN nodes have a registered iSCSI IQN."
    break
  fi
  if (( SECONDS >= deadline )); then
    log "ERROR: timed out waiting for IQN registration on:${missing}"
    log "       Inspect: kubectl -n ${TRIDENT_NAMESPACE} get tridentnode"
    log "       and the '${SAN_HOST_BOOTSTRAP_DS_NAME}' pods on those nodes."
    exit 1
  fi
  sleep 5
done
