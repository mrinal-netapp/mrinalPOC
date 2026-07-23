"""GKE GCNV-native dual Trident storage reconcile."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

LIB_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(LIB_DIR))
sys.path.insert(0, str(LIB_DIR.parent.parent / "_lib"))

import env_yaml  # noqa: E402
from kubeconfig import kubeconfig_gke  # noqa: E402
from reconcile import (  # noqa: E402
    ReconcileError,
    die,
    ensure_storageclass,
    kubectl_apply_yaml,
    log,
    run,
    verify_cluster,
    wait_tbc_success,
    _wait_service_account,
    _wait_trident_controller,
)
from render import render_template, storage_pools_block  # noqa: E402
from smoke import smoke_test_storageclass  # noqa: E402

# Same nodeSelector/toleration as san-host-daemonset.yaml.tpl and the
# san-ubuntu-pool node pool config (deployments/gcp/envs/*.yaml): only nodes
# in that pool have the iSCSI packages/initiator setup a GCNV SAN volume
# needs, so the smoke-test probe pod must be pinned there too.
SAN_NODE_SELECTOR = {"agentstudio.netapp.io/san": "true"}
SAN_TOLERATIONS = [{"key": "agentstudio.netapp.io/san", "operator": "Equal", "value": "true", "effect": "NoSchedule"}]


def _pick_storage(root: dict) -> dict:
    storage = root.get("storage") or {}
    gcnv = storage.get("gcnv") or {}
    trident = env_yaml.storage_trident(root)
    net = root.get("networking") or {}
    return {
        "project_id": root["projectId"],
        "location": root["location"],
        "gcnv_location": env_yaml.pick(storage.get("gcnvLocation"), storage.get("gcnv_location"), default=root["location"]),
        "nas_pool": env_yaml.pick(storage.get("nasPoolName"), storage.get("nas_pool_name"), default="sp-agentstudio-gcnv-nas"),
        "nas_service_level": str(env_yaml.pick(storage.get("nasServiceLevel"), storage.get("nas_service_level"), default="standard")).lower(),
        "san_pool": env_yaml.pick(storage.get("sanPoolName"), storage.get("san_pool_name"), default="sp-agentstudio-gcnv-san"),
        "nas_cap": str(env_yaml.pick(storage.get("nasCapacityGiB"), storage.get("nas_capacity_gib"), default=4096)),
        "san_cap": str(env_yaml.pick(storage.get("sanCapacityGiB"), storage.get("san_capacity_gib"), default=4096)),
        "vpc": env_yaml.pick(net.get("vpcName"), default="vpc-agentstudio"),
        "psa_range": env_yaml.pick(net.get("psaRangeName"), net.get("psa_range_name"), default="agentstudio-psa"),
        "trident": trident,
        "nas_backend": env_yaml.pick(gcnv.get("nasBackendName"), default="gcnv-native-nas-backend"),
        "san_backend": env_yaml.pick(gcnv.get("sanBackendName"), default="gcnv-native-san-backend"),
        "nas_sc": env_yaml.pick(gcnv.get("nasStorageClass"), default="gcnv-nas-rwx"),
        "san_sc": env_yaml.pick(gcnv.get("sanStorageClass"), default="gcnv-san-rwo"),
        "san_fstype": env_yaml.pick(gcnv.get("sanFsType"), default="ext4"),
        "gsa_email": f"{trident['gsa_name']}@{root['projectId']}.iam.gserviceaccount.com",
        "gcnv_network": f"name={env_yaml.pick(net.get('vpcName'), default='vpc-agentstudio')},psa-range={env_yaml.pick(net.get('psaRangeName'), net.get('psa_range_name'), default='agentstudio-psa')}",
    }


def _gcloud_json(args: list[str]) -> str:
    result = run(["gcloud", *args], capture=True)
    return (result.stdout or "").strip()


def _pool_exists(project: str, location: str, pool: str) -> bool:
    try:
        run(
            ["gcloud", "netapp", "storage-pools", "describe", pool, "--project", project, "--location", location],
            capture=True,
        )
        return True
    except subprocess.CalledProcessError:
        return False


def _wait_pool_ready(project: str, location: str, pool: str, attempts: int = 60) -> None:
    for i in range(1, attempts + 1):
        state = _gcloud_json(
            [
                "netapp",
                "storage-pools",
                "describe",
                pool,
                "--project",
                project,
                "--location",
                location,
                "--format=value(state)",
            ]
        )
        log(f"pool/{pool} state={state or 'unknown'} ({i}/{attempts})")
        if state == "READY":
            return
        if state in ("ERROR", "DISABLED"):
            raise ReconcileError(f"pool {pool} terminal state {state}")
        time.sleep(10)
    raise ReconcileError(f"timed out waiting for pool {pool} READY")


def _ensure_pools(cfg: dict) -> None:
    project = cfg["project_id"]
    location = cfg["gcnv_location"]
    network = cfg["gcnv_network"]

    run(
        [
            "gcloud",
            "services",
            "enable",
            "netapp.googleapis.com",
            "file.googleapis.com",
            "iam.googleapis.com",
            "iamcredentials.googleapis.com",
            "--project",
            project,
        ],
        check=False,
    )

    if not _pool_exists(project, location, cfg["nas_pool"]):
        nas_level = cfg["nas_service_level"]
        log(f"creating NAS pool {cfg['nas_pool']} (service-level={nas_level})")
        nas_cmd = [
            "gcloud",
            "netapp",
            "storage-pools",
            "create",
            cfg["nas_pool"],
            "--project",
            project,
            "--location",
            location,
            "--service-level",
            nas_level,
            "--capacity",
            f"{cfg['nas_cap']}GiB",
            "--network",
            network,
        ]
        # Flex pools are zone-redundant and require type + zone + replica-zone
        # (same as SAN); regional tiers (standard/premium/extreme) set none.
        if nas_level.lower() == "flex":
            nas_cmd.extend([
                "--type", "unified",
                "--mode", "default",
                "--zone", f"{location}-b",
                "--replica-zone", f"{location}-c",
            ])
        run(nas_cmd)
    else:
        log(f"NAS pool {cfg['nas_pool']} already exists")

    if not _pool_exists(project, location, cfg["san_pool"]):
        log(f"creating SAN pool {cfg['san_pool']}")
        san_zone = f"{location}-b"
        replica = f"{location}-c"
        run(
            [
                "gcloud",
                "netapp",
                "storage-pools",
                "create",
                cfg["san_pool"],
                "--project",
                project,
                "--location",
                location,
                "--service-level",
                "flex",
                "--capacity",
                f"{cfg['san_cap']}GiB",
                "--network",
                network,
                "--type",
                "unified",
                "--mode",
                "default",
                "--zone",
                san_zone,
                "--replica-zone",
                replica,
            ]
        )
    else:
        log(f"SAN pool {cfg['san_pool']} already exists")
        san_type = _gcloud_json(
            [
                "netapp",
                "storage-pools",
                "describe",
                cfg["san_pool"],
                "--project",
                project,
                "--location",
                location,
                "--format=value(type)",
            ]
        )
        san_level = _gcloud_json(
            [
                "netapp",
                "storage-pools",
                "describe",
                cfg["san_pool"],
                "--project",
                project,
                "--location",
                location,
                "--format=value(serviceLevel)",
            ]
        )
        if san_type.upper() != "UNIFIED":
            raise ReconcileError(f"SAN pool type={san_type} expected UNIFIED")
        if san_level.upper() != "FLEX":
            raise ReconcileError(f"SAN pool serviceLevel={san_level} expected FLEX")

    _wait_pool_ready(project, location, cfg["nas_pool"])
    _wait_pool_ready(project, location, cfg["san_pool"])


def _install_trident_gcp(trident_ns: str, gsa_email: str, ksa: str) -> None:
    run(["helm", "repo", "add", "netapp-trident", "https://netapp.github.io/trident-helm-chart"], check=False)
    run(["helm", "repo", "update", "netapp-trident"], check=False)
    run(
        ["kubectl", "patch", "tridentorchestrator", "trident", "-n", trident_ns, "--type", "json", "-p", '[{"op":"remove","path":"/spec/cloudIdentity"}]'],
        check=False,
    )
    run(
        [
            "helm",
            "upgrade",
            "--install",
            "trident",
            "netapp-trident/trident-operator",
            "--namespace",
            trident_ns,
            "--create-namespace",
            "--set",
            "cloudProvider=GCP",
            "--reset-values",
        ]
    )
    patch = json.dumps(
        {"spec": {"cloudProvider": "GCP", "cloudIdentity": f"iam.gke.io/gcp-service-account: {gsa_email}"}}
    )
    run(["kubectl", "patch", "tridentorchestrator", "trident", "-n", trident_ns, "--type", "merge", "-p", patch])
    # Operator creates trident-controller SA/deployment after reconciling the orchestrator CR.
    _wait_service_account(ksa, trident_ns)
    run(
        [
            "kubectl",
            "annotate",
            "serviceaccount",
            ksa,
            "-n",
            trident_ns,
            f"iam.gke.io/gcp-service-account={gsa_email}",
            "--overwrite",
        ]
    )
    _wait_trident_controller(trident_ns)
    run(["kubectl", "rollout", "restart", "deploy/trident-controller", "-n", trident_ns], check=False)
    run(["kubectl", "rollout", "status", "deploy/trident-controller", "-n", trident_ns, "--timeout=300s"])


def _config_from_env() -> dict:
    import os

    project = os.environ.get("GCP_PROJECT_ID") or os.environ.get("GOOGLE_CLOUD_PROJECT", "")
    location = os.environ.get("GCNV_LOCATION", "")
    network = os.environ.get("GCNV_NETWORK", "")
    gsa = os.environ.get("TRIDENT_GSA_EMAIL") or os.environ.get("TRIDENT_GSA", "")
    if not project or not location or not network or not gsa:
        raise ReconcileError(
            "GCP_PROJECT_ID, GCNV_LOCATION, GCNV_NETWORK, and TRIDENT_GSA_EMAIL are required with --from-env"
        )
    trident_ns = os.environ.get("TRIDENT_NAMESPACE", "trident")
    ksa = os.environ.get("TRIDENT_KSA", "trident-controller")
    return {
        "project_id": project,
        "location": location,
        "gcnv_location": location,
        "nas_pool": os.environ.get("GCNV_NAS_POOL_NAME", "sp-agentstudio-gcnv-nas"),
        "nas_service_level": os.environ.get("GCNV_NAS_SERVICE_LEVEL", "standard").lower(),
        "san_pool": os.environ.get("GCNV_SAN_POOL_NAME", "sp-agentstudio-gcnv-san"),
        "nas_cap": os.environ.get("GCNV_NAS_POOL_CAPACITY_GIB", "4096"),
        "san_cap": os.environ.get("GCNV_SAN_POOL_CAPACITY_GIB", "4096"),
        "vpc": "",
        "psa_range": "",
        "trident": {"namespace": trident_ns, "service_account": ksa, "helm_version": "100.2410.0", "gsa_name": ""},
        "nas_backend": os.environ.get("GCNV_NAS_BACKEND_NAME", "gcnv-native-nas-backend"),
        "san_backend": os.environ.get("GCNV_SAN_BACKEND_NAME", "gcnv-native-san-backend"),
        "nas_sc": os.environ.get("GCNV_NAS_SC_NAME", "gcnv-nas-rwx"),
        "san_sc": os.environ.get("GCNV_SAN_SC_NAME", "gcnv-san-rwo"),
        "san_fstype": os.environ.get("GCNV_SAN_FSTYPE", "ext4"),
        "gsa_email": gsa,
        "gcnv_network": network,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="GKE GCNV storage reconcile")
    parser.add_argument("--env-file", type=Path, default=None)
    parser.add_argument("--from-env", action="store_true", help="Use GCP_* / GCNV_* env vars (legacy deploy path)")
    parser.add_argument("--skip-san-hosts", action="store_true", help="Skip SAN iSCSI host prep step")
    args = parser.parse_args()

    if args.from_env:
        cfg = _config_from_env()
        ns = cfg["trident"]["namespace"]
    else:
        if not args.env_file:
            die("--env-file is required unless --from-env is set")
        root = env_yaml.load_path(args.env_file)
        cfg = _pick_storage(root)
        ns = cfg["trident"]["namespace"]
        log(f"gke env={root.get('env')} project={cfg['project_id']}")
        kubeconfig_gke(args.env_file)

    verify_cluster()

    _ensure_pools(cfg)
    project_number = _gcloud_json(["projects", "describe", cfg["project_id"], "--format=value(projectNumber)"])
    ksa = cfg["trident"]["service_account"]
    _install_trident_gcp(ns, cfg["gsa_email"], ksa)

    pools_block = storage_pools_block(cfg["nas_pool"], True)
    nas_tbc = render_template(
        "gcp/gcnv-nas-tbc.yaml.tpl",
        {
            "BACKEND_NAME": cfg["nas_backend"],
            "TRIDENT_NAMESPACE": ns,
            "PROJECT_NUMBER": project_number,
            "GCNV_LOCATION": cfg["gcnv_location"],
            "STORAGE_POOLS_BLOCK": pools_block,
        },
    )
    kubectl_apply_yaml(nas_tbc, f"TBC/{cfg['nas_backend']}")

    san_pools_block = storage_pools_block(cfg["san_pool"], True)
    san_tbc = render_template(
        "gcp/gcnv-san-tbc.yaml.tpl",
        {
            "BACKEND_NAME": cfg["san_backend"],
            "TRIDENT_NAMESPACE": ns,
            "PROJECT_NUMBER": project_number,
            "GCNV_LOCATION": cfg["gcnv_location"],
            "STORAGE_POOLS_BLOCK": san_pools_block,
        },
    )
    kubectl_apply_yaml(san_tbc, f"TBC/{cfg['san_backend']}")
    time.sleep(3)
    wait_tbc_success(cfg["nas_backend"], ns)
    wait_tbc_success(cfg["san_backend"], ns)

    nas_sc = render_template("gcp/gcnv-nas-sc.yaml.tpl", {"STORAGE_CLASS_NAME": cfg["nas_sc"]})
    san_sc = render_template(
        "gcp/gcnv-san-sc.yaml.tpl", {"STORAGE_CLASS_NAME": cfg["san_sc"], "SAN_FSTYPE": cfg["san_fstype"]}
    )
    # WaitForFirstConsumer (not the ensure_storageclass default of Immediate)
    # to match gcnv-nas-sc.yaml.tpl / gcnv-san-sc.yaml.tpl — see those files
    # for why: it avoids a provisioning deadlock when the backing node pool
    # has scaled to zero.
    ensure_storageclass(cfg["nas_sc"], nas_sc, volume_binding_mode="WaitForFirstConsumer")
    ensure_storageclass(cfg["san_sc"], san_sc, volume_binding_mode="WaitForFirstConsumer")

    if not args.skip_san_hosts:
        from gcp_san_hosts import ensure_san_hosts  # noqa: WPS433

        ensure_san_hosts(trident_namespace=ns)

    # GCNV volume create is slow (10+ min on STANDARD NAS); use production SCs and long poll.
    gcnv_smoke_wait = {"use_ephemeral_clone": False, "pvc_wait_attempts": 180, "pvc_wait_sleep_secs": 5}
    smoke_test_storageclass(cfg["nas_sc"], namespace=ns, access_mode="ReadWriteMany", **gcnv_smoke_wait)
    if not args.skip_san_hosts:
        smoke_test_storageclass(
            cfg["san_sc"],
            namespace=ns,
            access_mode="ReadWriteOnce",
            node_selector=SAN_NODE_SELECTOR,
            tolerations=SAN_TOLERATIONS,
            **gcnv_smoke_wait,
        )

    log(f"done: backends {cfg['nas_backend']}, {cfg['san_backend']}; SC {cfg['nas_sc']}, {cfg['san_sc']}")


if __name__ == "__main__":
    try:
        main()
    except ReconcileError as exc:
        die(str(exc))
    except subprocess.CalledProcessError as exc:
        die(f"command failed: {exc}")
