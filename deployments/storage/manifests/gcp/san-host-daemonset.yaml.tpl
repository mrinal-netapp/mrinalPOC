apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ${DS_NAME}
  namespace: ${DS_NAMESPACE}
spec:
  selector:
    matchLabels:
      app: ${DS_NAME}
  template:
    metadata:
      labels:
        app: ${DS_NAME}
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
                systemctl enable --now multipathd
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
