"""Best-effort teardown of all resources created by integration tests."""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from typing import Callable

import httpx

from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings
from lib.utils.object_store_client import ObjectStoreTarget, delete_seeded_object


def _log(msg: str) -> None:
    print(msg, file=sys.stderr)


def _seeded_object_store(
    settings: IntegrationSettings, label: str
) -> ObjectStoreTarget | None:
    if settings.s3_endpoint and settings.s3_bucket:
        return ObjectStoreTarget(
            label=label or "s3compatible",
            endpoint=settings.s3_endpoint,
            bucket=settings.s3_bucket,
            prefix=settings.s3_prefix,
            access_key_id=settings.aws_access_key_id,
            secret_access_key=settings.aws_secret_access_key,
            region=settings.aws_region,
        )
    return None


@dataclass
class PipelineResources:
    project_id: str = ""
    project_home_dir: str | None = None
    credential_id: str | None = None
    datasource_id: str | None = None
    dataset_id: str | None = None
    knowledge_base_id: str | None = None
    mcp_server_id: str | None = None
    # Models registered directly under the project (e.g. the models happy-path
    # suite). Project delete cascades Bifrost teardown, but we delete these
    # explicitly so the DELETE-model path is exercised and cleanup is
    # deterministic even when the project delete workflow lags.
    model_ids: list[str] = field(default_factory=list)
    seeded_s3_key: str | None = None
    seeded_object_store_label: str = ""  # e.g. s3compatible — which store was seeded
    _cleanup_done: bool = field(default=False, repr=False)


def _delete_resource(
    label: str,
    delete_fn: Callable[[], httpx.Response],
    *,
    accept: tuple[int, ...] = (200, 202, 204, 404),
) -> None:
    try:
        resp = delete_fn()
        if resp.status_code in accept:
            _log(f"[cleanup] {label}: HTTP {resp.status_code}")
        else:
            _log(f"[cleanup] {label}: HTTP {resp.status_code} body={resp.text[:500]}")
    except Exception as exc:
        _log(f"[cleanup] {label}: failed ({exc})")


def cleanup_pipeline(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
) -> None:
    """Delete API entities, platform project storage (via project delete), and seeded S3 object."""
    if resources._cleanup_done:
        return
    if not settings.integration_cleanup:
        _log("[cleanup] INTEGRATION_CLEANUP not enabled — skipping teardown")
        return
    if not resources.project_id:
        return

    _log(f"[cleanup] starting teardown for project={resources.project_id}")
    prefix = client.project_prefix(resources.project_id)

    # Child resources first (KB → dataset → connector → credential).
    if resources.knowledge_base_id:
        _delete_resource(
            f"knowledge base {resources.knowledge_base_id}",
            lambda: client.config_delete(
                f"{prefix}/knowledgebases/{resources.knowledge_base_id}"
            ),
        )

    if resources.dataset_id:
        _delete_resource(
            f"dataset {resources.dataset_id}",
            lambda: client.config_delete(f"{prefix}/datasets/{resources.dataset_id}"),
        )

    if resources.datasource_id:
        _delete_resource(
            f"datasource {resources.datasource_id}",
            lambda: client.config_delete(f"{prefix}/datasources/{resources.datasource_id}"),
        )

    if resources.mcp_server_id:
        _delete_resource(
            f"mcp server {resources.mcp_server_id}",
            lambda: client.config_delete(
                f"{prefix}/mcp-servers/{resources.mcp_server_id}"
            ),
        )

    for model_id in resources.model_ids:
        _delete_resource(
            f"model {model_id}",
            lambda mid=model_id: client.config_delete(f"{prefix}/models/{mid}"),
        )

    if resources.credential_id:
        _delete_resource(
            f"credential {resources.credential_id}",
            lambda: client.config_delete(f"{prefix}/credentials/{resources.credential_id}"),
        )

    # Project delete drops DB rows and starts workflow to remove objects under home_dir
    # (acquired dataset copies, KB vectors on platform storage, etc.).
    _delete_resource(
        f"project {resources.project_id}",
        lambda: client.config_delete(f"api/v1/projects/{resources.project_id}"),
        accept=(200, 202, 204, 404),
    )
    if resources.project_home_dir:
        _log(
            f"[cleanup] project storage cleanup workflow triggered for "
            f"{resources.project_home_dir} (async)"
        )

    if resources.seeded_s3_key:
        store = _seeded_object_store(settings, resources.seeded_object_store_label)
        if store:
            try:
                delete_seeded_object(store, settings, resources.seeded_s3_key)
                _log(
                    f"[cleanup] deleted seeded object "
                    f"s3://{store.bucket}/{resources.seeded_s3_key}"
                )
            except Exception as exc:
                _log(f"[cleanup] seeded object delete failed ({exc})")

    resources._cleanup_done = True
    _log(f"[cleanup] teardown finished for project={resources.project_id}")
