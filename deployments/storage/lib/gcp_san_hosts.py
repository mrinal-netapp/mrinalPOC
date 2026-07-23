"""GKE SAN node iSCSI host prep (reconcile)."""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

LIB_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(LIB_DIR))

from reconcile import ReconcileError, die, kubectl_jsonpath, log, run  # noqa: E402
from render import render_template  # noqa: E402


def ensure_san_hosts(
    trident_namespace: str = "trident",
    san_node_label: str = "agentstudio.netapp.io/san=true",
    ds_name: str = "san-host-bootstrap",
    ds_namespace: str = "kube-system",
    trident_node_ds: str = "trident-node-linux",
    iqn_wait_timeout: int = 300,
) -> None:
    result = run(
        [
            "kubectl",
            "get",
            "nodes",
            "-l",
            san_node_label,
            "-o",
            'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
        ],
        capture=True,
        check=False,
    )
    san_nodes = [n for n in (result.stdout or "").splitlines() if n.strip()]
    if not san_nodes:
        log(f"no SAN nodes match {san_node_label}; skipping")
        return

    log("SAN nodes: " + ", ".join(san_nodes))
    ds_yaml = render_template(
        "gcp/san-host-daemonset.yaml.tpl",
        {"DS_NAME": ds_name, "DS_NAMESPACE": ds_namespace},
    )
    run(["kubectl", "apply", "-f", "-"], input_text=ds_yaml)
    log("waiting for SAN host bootstrap DaemonSet rollout...")
    run(
        [
            "kubectl",
            "rollout",
            "status",
            f"daemonset/{ds_name}",
            "-n",
            ds_namespace,
            "--timeout=10m",
        ]
    )

    def node_iqn(node: str) -> str:
        return kubectl_jsonpath("{.iqn}", f"tridentnode/{node}", trident_namespace)

    needs_restart = any(not node_iqn(n) for n in san_nodes)
    if needs_restart:
        try:
            run(["kubectl", "-n", trident_namespace, "get", f"ds/{trident_node_ds}"], capture=True)
            log(f"restarting Trident node DaemonSet {trident_node_ds} to re-register IQNs")
            run(["kubectl", "-n", trident_namespace, "rollout", "restart", f"ds/{trident_node_ds}"])
            run(
                [
                    "kubectl",
                    "-n",
                    trident_namespace,
                    "rollout",
                    "status",
                    f"ds/{trident_node_ds}",
                    "--timeout=300s",
                ],
                check=False,
            )
        except subprocess.CalledProcessError:
            log(f"WARN: Trident node DaemonSet {trident_node_ds} not found; skipping restart")
    else:
        log("all SAN nodes already have IQN; skipping Trident node restart")

    deadline = time.time() + iqn_wait_timeout
    while time.time() < deadline:
        missing = [n for n in san_nodes if not node_iqn(n)]
        if not missing:
            log("all SAN nodes have registered iSCSI IQN")
            return
        time.sleep(5)
    raise ReconcileError(f"timed out waiting for IQN on nodes: {', '.join(missing)}")


def main() -> None:
    parser = argparse.ArgumentParser(description="GKE SAN host iSCSI reconcile")
    parser.add_argument("--trident-namespace", default="trident")
    parser.add_argument("--san-node-label", default="agentstudio.netapp.io/san=true")
    parser.add_argument("--ds-name", default="san-host-bootstrap")
    parser.add_argument("--ds-namespace", default="kube-system")
    parser.add_argument("--trident-node-ds", default="trident-node-linux")
    parser.add_argument("--iqn-wait-timeout", type=int, default=300)
    args = parser.parse_args()
    ensure_san_hosts(
        trident_namespace=args.trident_namespace,
        san_node_label=args.san_node_label,
        ds_name=args.ds_name,
        ds_namespace=args.ds_namespace,
        trident_node_ds=args.trident_node_ds,
        iqn_wait_timeout=args.iqn_wait_timeout,
    )


if __name__ == "__main__":
    try:
        main()
    except ReconcileError as exc:
        die(str(exc))
    except subprocess.CalledProcessError as exc:
        die(f"command failed: {exc}")
