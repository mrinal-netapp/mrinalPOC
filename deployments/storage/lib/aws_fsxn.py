"""AWS FSxN Trident storage reconcile."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

LIB_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(LIB_DIR))
sys.path.insert(0, str(LIB_DIR.parent.parent / "_lib"))

import env_yaml  # noqa: E402
from kubeconfig import _cf_output, kubeconfig_aws  # noqa: E402
from reconcile import (  # noqa: E402
    ReconcileError,
    wait_trident_orchestrator,
    die,
    ensure_storageclass,
    install_trident_helm,
    kubectl_apply_yaml,
    log,
    patch_trident_orchestrator_cloud_identity,
    run,
    verify_cluster,
    wait_tbc_success,
)
from render import render_template  # noqa: E402
from smoke import smoke_test_storageclass  # noqa: E402


def _ensure_single_default_storage_class(name: str) -> None:
    """Mark one StorageClass as default and clear the flag on all others."""
    result = run(["kubectl", "get", "storageclass", "-o", "json"], capture=True)
    for item in json.loads(result.stdout).get("items", []):
        sc = item["metadata"]["name"]
        ann = (item.get("metadata") or {}).get("annotations") or {}
        is_default = ann.get("storageclass.kubernetes.io/is-default-class") == "true"
        if sc == name:
            if not is_default:
                run(
                    [
                        "kubectl",
                        "patch",
                        "storageclass",
                        name,
                        "--type=merge",
                        "-p",
                        '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}',
                    ]
                )
        elif is_default:
            run(
                [
                    "kubectl",
                    "patch",
                    "storageclass",
                    sc,
                    "--type=merge",
                    "-p",
                    '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}',
                ]
            )


def _apply_aws_cloud_identity(namespace: str, role_arn: str) -> None:
    """Patch TridentOrchestrator before controller/CRD bootstrap (EKS Pod Identity)."""
    wait_trident_orchestrator(namespace)
    patch_trident_orchestrator_cloud_identity(
        namespace,
        "AWS",
        f"eks.amazonaws.com/role-arn: {role_arn}",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="AWS FSxN storage reconcile")
    parser.add_argument("--env-file", required=True, type=Path)
    args = parser.parse_args()
    root = env_yaml.load_path(args.env_file)
    trident = env_yaml.storage_trident(root)
    fsxn = (root.get("storage") or {}).get("fsxn") or {}

    backend = env_yaml.pick(fsxn.get("backendName"), default="fsxn-nas-backend")
    sc_name = env_yaml.pick(fsxn.get("storageClassName"), default="fsxn-nas")
    mark_default = str(env_yaml.pick(fsxn.get("markAsDefault"), default=True)).lower()

    log(f"aws env={root.get('env')} stack={root['stackName']}")
    kubeconfig_aws(args.env_file)
    verify_cluster()

    fsx_id = _cf_output(args.env_file, "FsxFileSystemId")
    svm = _cf_output(args.env_file, "FsxSvmName")
    creds_arn = _cf_output(args.env_file, "FsxSvmAdminSecretArn")
    pod_identity_role = _cf_output(args.env_file, "TridentPodIdentityRoleArn")

    cloud_identity = f"eks.amazonaws.com/role-arn: {pod_identity_role}"
    install_trident_helm(
        trident["namespace"],
        trident["helm_version"],
        extra_args=[
            "--set",
            "cloudProvider=AWS",
            "--set",
            f"cloudIdentity='{cloud_identity}'",
        ],
        post_operator_hook=lambda: _apply_aws_cloud_identity(trident["namespace"], pod_identity_role),
    )

    tbc_yaml = render_template(
        "aws/fsxn-tbc.yaml.tpl",
        {
            "BACKEND_NAME": backend,
            "TRIDENT_NAMESPACE": trident["namespace"],
            "ONTAP_SVM": svm,
            "FSX_FILESYSTEM_ID": fsx_id,
            "FSXN_CREDENTIALS_ARN": creds_arn,
        },
    )
    kubectl_apply_yaml(tbc_yaml, f"TridentBackendConfig/{backend}")
    wait_tbc_success(backend, trident["namespace"])

    sc_yaml = render_template(
        "aws/fsxn-sc.yaml.tpl",
        {
            "STORAGE_CLASS_NAME": sc_name,
            "MARK_AS_DEFAULT": mark_default,
        },
    )
    ensure_storageclass(sc_name, sc_yaml, volume_binding_mode="Immediate", reclaim_policy="Retain")
    # Re-apply so default-class annotations sync on re-run (ensure_storageclass skips when spec matches).
    kubectl_apply_yaml(sc_yaml, f"StorageClass/{sc_name}")
    if mark_default == "true":
        _ensure_single_default_storage_class(sc_name)

    smoke_test_storageclass(sc_name, namespace=trident["namespace"], access_mode="ReadWriteMany")

    log(f"done: StorageClass/{sc_name} TBC/{backend} Success")
    region = root["region"]
    cluster = _cf_output(args.env_file, "EksClusterName")
    print(f"  aws eks list-pod-identity-associations --cluster-name {cluster} --region {region} --namespace {trident['namespace']}")
    print(f"  kubectl get tbc -n {trident['namespace']}")
    print(f"  kubectl get storageclass {sc_name}")


if __name__ == "__main__":
    try:
        main()
    except ReconcileError as exc:
        die(str(exc))
    except subprocess.CalledProcessError as exc:
        die(f"command failed: {exc}")
