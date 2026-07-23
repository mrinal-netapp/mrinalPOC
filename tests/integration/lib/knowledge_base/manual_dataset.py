"""Build a manual (upload-based) unstructured dataset with no external connector.

Flow (config-service manifest API + presigned S3 PUT):
  create dataset (type=manual) -> create draft manifest -> request presigned
  upload URLs -> PUT file bytes -> commit manifest (triggers import) -> ready.

The presigned upload URL points at the project's object-store endpoint, which may
not be reachable from an external test runner. Callers should catch
ManualDatasetUnavailable and skip when that's the case.
"""

from __future__ import annotations

import httpx

from lib.common.platform_client import PlatformClient, unique_name
from lib.common.settings import IntegrationSettings
from lib.utils.cleanup import PipelineResources
from lib.utils.waits import wait_for_dataset_ready


class ManualDatasetUnavailable(RuntimeError):
    """Raised when the manual-upload path can't be exercised from this runner."""


def setup_manual_dataset(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    *,
    marker: str,
) -> str:
    """Create a manual unstructured dataset containing one small text file.

    Sets resources.dataset_id and returns it. Raises ManualDatasetUnavailable if
    the presigned upload is not reachable from the test host.
    """
    prefix = client.project_prefix(resources.project_id)
    content = (
        f"AgentStudio manual-dataset marker {marker}\n"
        f"Used by pytest to verify KB retrieval from an uploaded file.\n"
    ).encode()

    ds = client.config_post(
        f"{prefix}/datasets",
        {
            "name": unique_name("e2e-manual-ds"),
            "description": "pytest manual dataset",
            "type": "manual",
            "kind": "unstructured",
        },
    )
    assert ds.status_code == 201, ds.text
    dataset_id = ds.json()["id"]
    resources.dataset_id = dataset_id

    manifest = client.config_post(f"{prefix}/datasets/{dataset_id}/manifests", {})
    assert manifest.status_code in (200, 201), manifest.text
    manifest_id = manifest.json()["id"]

    files = client.config_patch(
        f"{prefix}/datasets/{dataset_id}/manifests/{manifest_id}/files",
        {"fileNames": [f"{marker}.txt"]},
    )
    if files.status_code not in (200, 201):
        raise ManualDatasetUnavailable(
            f"presign request failed: HTTP {files.status_code}: {files.text[:200]}"
        )
    entries = files.json()
    entries = entries if isinstance(entries, list) else entries.get("files") or []
    presigned = next((e.get("preSignedUrl") for e in entries if e.get("preSignedUrl")), None)
    if not presigned:
        raise ManualDatasetUnavailable(f"no presigned URL returned: {files.text[:200]}")

    # Upload bytes directly to the object store; may be unreachable from the runner.
    try:
        with httpx.Client(verify=settings.verify_tls, trust_env=False, timeout=60.0) as raw:
            put = raw.put(presigned, content=content, headers={"Content-Type": "text/plain"})
    except httpx.HTTPError as exc:
        raise ManualDatasetUnavailable(f"presigned upload not reachable: {exc}") from exc
    if put.status_code not in (200, 201, 204):
        raise ManualDatasetUnavailable(
            f"presigned PUT failed: HTTP {put.status_code}: {put.text[:200]}"
        )

    commit = client.config_put(
        f"{prefix}/datasets/{dataset_id}/manifests/{manifest_id}/status",
        {"status": "committed"},
    )
    assert commit.status_code in (200, 201, 202), commit.text

    wait_for_dataset_ready(
        lambda: client.config_get(f"{prefix}/datasets/{dataset_id}"),
        timeout_sec=settings.acquisition_timeout_sec,
        poll_interval_sec=settings.acquisition_poll_interval_sec,
    )
    return dataset_id
