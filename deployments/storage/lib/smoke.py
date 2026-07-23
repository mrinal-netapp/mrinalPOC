"""End-to-end storage smoke test: provision a PVC, mount it, verify read/write.

Validates the full data path (dynamic provisioning + CSI node attach + mount +
R/W) that a TridentBackendConfig=Success alone does NOT prove.

By default the test provisions against an *ephemeral clone* of the target
StorageClass (reclaimPolicy=Delete) so cleanup is guaranteed when the real SC
uses Retain. Pass use_ephemeral_clone=False to exercise the production SC
directly (used for GCNV where provisioning can take 10+ minutes).

Set STORAGE_SMOKE=0 (or false/no) to skip (e.g. air-gapped clusters that cannot
pull the probe image).
"""

from __future__ import annotations

import json
import os
import secrets
import time

from reconcile import ReconcileError, kubectl_jsonpath, log, run

DEFAULT_PROBE_IMAGE = "busybox:1.36"


def _skip() -> bool:
    return os.environ.get("STORAGE_SMOKE", "1").strip().lower() in ("0", "false", "no")


def _probe_image() -> str:
    return os.environ.get("STORAGE_SMOKE_IMAGE", DEFAULT_PROBE_IMAGE)


def _apply_json(obj: dict, hint: str) -> None:
    log(f"smoke apply ({hint})")
    run(["kubectl", "apply", "-f", "-"], input_text=json.dumps(obj))


def _get_storageclass(name: str) -> dict:
    result = run(["kubectl", "get", "storageclass", name, "-o", "json"], capture=True)
    return json.loads(result.stdout or "{}")


def _ephemeral_storageclass(src: dict, eph_name: str) -> dict:
    return {
        "apiVersion": "storage.k8s.io/v1",
        "kind": "StorageClass",
        "metadata": {
            "name": eph_name,
            "labels": {"agentstudio.netapp.io/smoke": "true"},
        },
        "provisioner": src["provisioner"],
        "parameters": src.get("parameters", {}) or {},
        "mountOptions": src.get("mountOptions", []) or [],
        "allowVolumeExpansion": src.get("allowVolumeExpansion", True),
        "reclaimPolicy": "Delete",
        # WaitForFirstConsumer: matches the production GCNV StorageClass
        # templates (see gcnv-san-sc.yaml.tpl) so the smoke test exercises the
        # same binding behavior and doesn't deadlock on node pools that scale
        # to zero. Requires the PVC's consuming pod to be applied before
        # binding is expected — see smoke_test_storageclass() below.
        "volumeBindingMode": "WaitForFirstConsumer",
    }


def _pvc_manifest(name: str, namespace: str, sc_name: str, access_mode: str, size: str) -> dict:
    return {
        "apiVersion": "v1",
        "kind": "PersistentVolumeClaim",
        "metadata": {
            "name": name,
            "namespace": namespace,
            "labels": {"agentstudio.netapp.io/smoke": "true"},
        },
        "spec": {
            "accessModes": [access_mode],
            "storageClassName": sc_name,
            "resources": {"requests": {"storage": size}},
        },
    }


def _pod_manifest(
    name: str,
    namespace: str,
    pvc_name: str,
    image: str,
    *,
    node_selector: dict[str, str] | None = None,
    tolerations: list[dict] | None = None,
) -> dict:
    script = (
        "set -e; "
        "token=agentstudio-smoke-$(date +%s); "
        "echo $token > /mnt/probe/probe.txt; "
        "grep -q $token /mnt/probe/probe.txt; "
        "echo smoke-readwrite-ok"
    )
    spec: dict = {
        "restartPolicy": "Never",
        "containers": [
            {
                "name": "probe",
                "image": image,
                "command": ["sh", "-c", script],
                "volumeMounts": [{"name": "vol", "mountPath": "/mnt/probe"}],
            }
        ],
        "volumes": [{"name": "vol", "persistentVolumeClaim": {"claimName": pvc_name}}],
    }
    # Needed for StorageClasses restricted to a tainted/labeled node pool (e.g.
    # GCNV SAN's dedicated iSCSI-capable pool): without these, a
    # WaitForFirstConsumer PVC lets the scheduler place the pod on any node,
    # which may lack the CSI node capabilities (or even the host packages,
    # see san-host-daemonset.yaml.tpl) the volume actually needs.
    if node_selector:
        spec["nodeSelector"] = node_selector
    if tolerations:
        spec["tolerations"] = tolerations
    return {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": name,
            "namespace": namespace,
            "labels": {"agentstudio.netapp.io/smoke": "true"},
        },
        "spec": spec,
    }


def _wait_pvc_bound(name: str, namespace: str, *, attempts: int = 60, sleep_secs: int = 5) -> None:
    for i in range(1, attempts + 1):
        phase = kubectl_jsonpath("{.status.phase}", f"pvc/{name}", namespace)
        log(f"smoke PVC/{name} phase={phase or 'pending'} ({i}/{attempts})")
        if phase == "Bound":
            return
        time.sleep(sleep_secs)
    run(["kubectl", "describe", "pvc", name, "-n", namespace], check=False)
    raise ReconcileError(f"smoke PVC/{name} did not reach Bound — dynamic provisioning failed")


def _wait_pod_succeeded(name: str, namespace: str, *, attempts: int = 36, sleep_secs: int = 5) -> None:
    for i in range(1, attempts + 1):
        phase = kubectl_jsonpath("{.status.phase}", f"pod/{name}", namespace)
        log(f"smoke Pod/{name} phase={phase or 'pending'} ({i}/{attempts})")
        if phase == "Succeeded":
            return
        if phase == "Failed":
            break
        time.sleep(sleep_secs)
    run(["kubectl", "describe", "pod", name, "-n", namespace], check=False)
    run(["kubectl", "logs", name, "-n", namespace], check=False)
    raise ReconcileError(f"smoke Pod/{name} did not succeed — volume attach/mount/RW failed")


def _cleanup(pod: str, pvc: str, sc: str | None, namespace: str) -> None:
    run(
        ["kubectl", "delete", "pod", pod, "-n", namespace, "--ignore-not-found", "--wait=true", "--timeout=120s"],
        check=False,
    )
    run(
        ["kubectl", "delete", "pvc", pvc, "-n", namespace, "--ignore-not-found", "--wait=true", "--timeout=180s"],
        check=False,
    )
    if sc:
        run(["kubectl", "delete", "storageclass", sc, "--ignore-not-found"], check=False)


def smoke_test_storageclass(
    sc_name: str,
    *,
    namespace: str = "trident",
    access_mode: str = "ReadWriteOnce",
    size: str = "1Gi",
    pvc_wait_attempts: int = 60,
    pvc_wait_sleep_secs: int = 5,
    use_ephemeral_clone: bool = True,
    node_selector: dict[str, str] | None = None,
    tolerations: list[dict] | None = None,
) -> None:
    """Provision a PVC on sc_name (or an ephemeral clone), mount it, verify R/W, clean up.

    Pass node_selector/tolerations for StorageClasses whose provisioner only
    works from a specific tainted/labeled node pool (e.g. GCNV SAN), so the
    probe pod is guaranteed to land somewhere the volume can actually attach.
    """
    if _skip():
        log(f"smoke: STORAGE_SMOKE disabled; skipping mount test for StorageClass/{sc_name}")
        return

    log(f"smoke: StorageClass/{sc_name} accessMode={access_mode} size={size}")
    src = _get_storageclass(sc_name)
    if not src.get("provisioner"):
        raise ReconcileError(f"smoke: StorageClass/{sc_name} missing provisioner")

    if use_ephemeral_clone:
        suffix = secrets.token_hex(3)
        provision_sc = f"smoke-{sc_name}-{suffix}"[:63]
        pvc_name = f"smoke-pvc-{suffix}"
        pod_name = f"smoke-pod-{suffix}"
        eph_sc_to_delete = provision_sc
    else:
        provision_sc = sc_name
        pvc_name = f"smoke-pvc-{sc_name}"[:63]
        pod_name = f"smoke-pod-{sc_name}"[:63]
        eph_sc_to_delete = None

    try:
        if use_ephemeral_clone:
            _apply_json(_ephemeral_storageclass(src, provision_sc), f"StorageClass/{provision_sc}")
        _apply_json(_pvc_manifest(pvc_name, namespace, provision_sc, access_mode, size), f"PVC/{pvc_name}")
        # Pod must exist before waiting on the PVC: WaitForFirstConsumer
        # StorageClasses (both the ephemeral clone above and production GCNV
        # classes) only bind once a consuming pod is scheduled, so waiting on
        # PVC Bound before the pod is applied would hang forever.
        _apply_json(
            _pod_manifest(
                pod_name, namespace, pvc_name, _probe_image(), node_selector=node_selector, tolerations=tolerations
            ),
            f"Pod/{pod_name}",
        )
        _wait_pvc_bound(pvc_name, namespace, attempts=pvc_wait_attempts, sleep_secs=pvc_wait_sleep_secs)
        _wait_pod_succeeded(pod_name, namespace)
        log(f"smoke OK: provision + mount + read/write verified via StorageClass/{sc_name}")
    finally:
        _cleanup(pod_name, pvc_name, eph_sc_to_delete, namespace)
