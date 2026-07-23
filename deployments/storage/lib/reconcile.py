"""Shared kubectl/helm reconcile helpers for storage bootstrap."""

from __future__ import annotations

import json
import subprocess
import sys
import time
from collections.abc import Callable
from typing import Sequence


class ReconcileError(RuntimeError):
    pass


def log(msg: str) -> None:
    print(f"[storage] {msg}", flush=True)


def run(
    cmd: Sequence[str],
    *,
    check: bool = True,
    capture: bool = False,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    log(f"run: {' '.join(cmd)}")
    return subprocess.run(
        list(cmd),
        check=check,
        capture_output=capture,
        text=True,
        input=input_text,
    )


def kubectl_jsonpath(expr: str, resource: str, namespace: str | None = None) -> str:
    cmd = ["kubectl", "get", resource, "-o", f"jsonpath={expr}"]
    if namespace:
        cmd.extend(["-n", namespace])
    try:
        result = run(cmd, capture=True)
        return (result.stdout or "").strip()
    except subprocess.CalledProcessError:
        return ""


def ensure_namespace(namespace: str) -> None:
    try:
        run(["kubectl", "get", "ns", namespace], capture=True)
        log(f"namespace/{namespace} already exists")
    except subprocess.CalledProcessError:
        log(f"creating namespace/{namespace}")
        run(["kubectl", "create", "ns", namespace])


def kubectl_apply_yaml(yaml_text: str, resource_hint: str = "") -> None:
    hint = f" ({resource_hint})" if resource_hint else ""
    log(f"kubectl apply{hint}")
    run(["kubectl", "apply", "-f", "-"], input_text=yaml_text)


def patch_trident_orchestrator_cloud_identity(
    namespace: str,
    cloud_provider: str,
    cloud_identity: str,
    *,
    name: str = "trident",
) -> None:
    patch = json.dumps(
        {
            "spec": {
                "cloudProvider": cloud_provider,
                "cloudIdentity": cloud_identity,
            }
        }
    )
    run(
        [
            "kubectl",
            "patch",
            "tridentorchestrator",
            name,
            "-n",
            namespace,
            "--type",
            "merge",
            "-p",
            patch,
        ]
    )


def install_trident_helm(
    namespace: str,
    version: str,
    extra_args: list[str] | None = None,
    *,
    post_operator_hook: Callable[[], None] | None = None,
) -> None:
    ensure_namespace(namespace)
    if _trident_crd_ready():
        log("Trident CRDs already present; skipping Helm install")
        if post_operator_hook:
            post_operator_hook()
        _wait_trident_controller(namespace)
        return

    run(["helm", "repo", "add", "netapp-trident", "https://netapp.github.io/trident-helm-chart"], check=False)
    run(["helm", "repo", "update", "netapp-trident"], check=False)
    cmd = [
        "helm",
        "upgrade",
        "--install",
        "trident",
        "netapp-trident/trident-operator",
        "--namespace",
        namespace,
        "--create-namespace",
        "--version",
        version,
        "--wait",
        "--timeout",
        "10m",
    ]
    if extra_args:
        cmd.extend(extra_args)
    run(cmd)
    _wait_trident_operator(namespace)
    if post_operator_hook:
        post_operator_hook()
    _wait_trident_crds()
    _wait_trident_controller(namespace)


def _deployment_exists(name: str, namespace: str) -> bool:
    try:
        run(["kubectl", "get", "deployment", name, "-n", namespace], capture=True)
        return True
    except subprocess.CalledProcessError:
        return False


def _trident_crd_ready() -> bool:
    try:
        run(["kubectl", "get", "crd", "tridentbackendconfigs.trident.netapp.io"], capture=True)
        run(
            [
                "kubectl",
                "wait",
                "--for=condition=established",
                "crd/tridentbackendconfigs.trident.netapp.io",
                "--timeout=30s",
            ],
            capture=True,
        )
        return True
    except subprocess.CalledProcessError:
        return False


def wait_trident_orchestrator(
    namespace: str,
    name: str = "trident",
    *,
    poll_attempts: int = 60,
    poll_secs: int = 5,
) -> None:
    for i in range(1, poll_attempts + 1):
        try:
            run(["kubectl", "get", "tridentorchestrator", name, "-n", namespace], capture=True)
            log(f"tridentorchestrator/{name} ready")
            return
        except subprocess.CalledProcessError:
            log(f"waiting for tridentorchestrator/{name} ({i}/{poll_attempts})")
            time.sleep(poll_secs)
    raise ReconcileError(
        f"tridentorchestrator/{name} not created in namespace/{namespace} — "
        "check: kubectl get pods -n trident && helm status trident -n trident"
    )


def _wait_trident_operator(namespace: str, release: str = "trident") -> None:
    for dep in ("trident-operator", f"{release}-trident-operator"):
        if _deployment_exists(dep, namespace):
            log(f"waiting for deployment/{dep} rollout")
            run(["kubectl", "rollout", "status", f"deployment/{dep}", "-n", namespace, "--timeout=180s"])
            return
    log("trident-operator deployment not found yet; continuing to CRD wait")


def _wait_trident_crds(*, attempts: int = 36, sleep_secs: int = 5) -> None:
    for i in range(1, attempts + 1):
        if _trident_crd_ready():
            log("TridentBackendConfig CRD ready")
            return
        log(f"waiting for Trident CRDs ({i}/{attempts})")
        time.sleep(sleep_secs)
    raise ReconcileError(
        "TridentBackendConfig CRD not found after operator install — "
        "check: kubectl get pods -n trident && kubectl get crd | grep trident"
    )


def _wait_service_account(name: str, namespace: str, *, poll_attempts: int = 60, poll_secs: int = 5) -> None:
    for i in range(1, poll_attempts + 1):
        try:
            run(["kubectl", "get", "serviceaccount", name, "-n", namespace], capture=True)
            log(f"serviceaccount/{name} ready")
            return
        except subprocess.CalledProcessError:
            log(f"waiting for serviceaccount/{name} ({i}/{poll_attempts})")
            time.sleep(poll_secs)
    raise ReconcileError(
        f"serviceaccount/{name} not created in namespace/{namespace} — "
        "check: kubectl get tridentorchestrator -n trident && kubectl get pods -n trident"
    )


def _wait_trident_controller(namespace: str, *, poll_attempts: int = 60, poll_secs: int = 5) -> None:
    for i in range(1, poll_attempts + 1):
        if _deployment_exists("trident-controller", namespace):
            break
        log(f"waiting for deployment/trident-controller ({i}/{poll_attempts})")
        time.sleep(poll_secs)
    else:
        raise ReconcileError(
            "deployment/trident-controller not created — operator may still be installing Trident"
        )
    run(
        [
            "kubectl",
            "wait",
            "--for=condition=available",
            "deployment/trident-controller",
            "-n",
            namespace,
            "--timeout=300s",
        ],
    )


def wait_tbc_success(name: str, namespace: str, attempts: int = 18, sleep_secs: int = 10) -> None:
    for i in range(1, attempts + 1):
        status = kubectl_jsonpath("{.status.lastOperationStatus}", f"tridentbackendconfig/{name}", namespace)
        log(f"TBC/{name} status={status or 'missing'} ({i}/{attempts})")
        if status == "Success":
            return
        time.sleep(sleep_secs)
    run(["kubectl", "describe", "tridentbackendconfig", name, "-n", namespace], check=False)
    raise ReconcileError(f"TBC/{name} did not reach Success")


def ensure_storageclass(
    name: str,
    yaml_text: str,
    *,
    volume_binding_mode: str = "Immediate",
    reclaim_policy: str = "Delete",
) -> None:
    try:
        run(["kubectl", "get", "storageclass", name], capture=True)
        binding = kubectl_jsonpath("{.volumeBindingMode}", f"storageclass/{name}")
        reclaim = kubectl_jsonpath("{.reclaimPolicy}", f"storageclass/{name}")
        if binding == volume_binding_mode and reclaim == reclaim_policy:
            log(f"StorageClass/{name} already exists and matches")
            return
        log(f"StorageClass/{name} immutable mismatch (binding={binding}, reclaim={reclaim}); recreating")
        run(["kubectl", "delete", "storageclass", name])
    except subprocess.CalledProcessError:
        log(f"StorageClass/{name} not found; creating")
    kubectl_apply_yaml(yaml_text, f"StorageClass/{name}")


def verify_cluster() -> None:
    try:
        run(["kubectl", "cluster-info"], capture=True)
    except subprocess.CalledProcessError as exc:
        raise ReconcileError("Cannot reach Kubernetes API — configure kubeconfig first") from exc


def die(msg: str, code: int = 1) -> None:
    print(f"[storage] ERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)
