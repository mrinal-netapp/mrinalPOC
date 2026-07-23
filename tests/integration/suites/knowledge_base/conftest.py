"""Shared fixtures for the KB config/detail/playground tests.

A single ready S3 dataset (and one ready KB) is provisioned once per session and
reused across the config-matrix, retrieval, and detail-page tests to keep runtime
bounded. All are gated on S3_* and skip when it's not configured.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass

import pytest

from lib.common.auth import KeycloakAuth
from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings
from lib.knowledge_base.kb_helpers import build_kb
from lib.knowledge_base.pipeline_setup import setup_s3compatible_ready_dataset
from lib.utils.cleanup import PipelineResources, cleanup_pipeline


@dataclass
class KbDatasetCtx:
    client: PlatformClient
    project_id: str
    prefix: str
    dataset_id: str
    search_marker: str


@pytest.fixture(scope="session")
def s3_ready_dataset(
    integration_settings: IntegrationSettings, keycloak_auth: KeycloakAuth
) -> KbDatasetCtx:
    """One ready S3 dataset for the whole session (project + connector + dataset)."""
    settings = integration_settings
    if not settings.has_s3compatible():
        pytest.skip("KB config/detail/playground tests need S3_* in .env.local")

    client = PlatformClient(settings, keycloak_auth)
    resources = PipelineResources()
    prefix, search_marker = setup_s3compatible_ready_dataset(client, settings, resources)
    ctx = KbDatasetCtx(
        client=client,
        project_id=resources.project_id,
        prefix=prefix,
        dataset_id=resources.dataset_id,
        search_marker=search_marker,
    )
    try:
        yield ctx
    finally:
        if settings.integration_cleanup:
            cleanup_pipeline(client, settings, resources)
        client.close()


@pytest.fixture(scope="session")
def s3_ready_kb(
    s3_ready_dataset: KbDatasetCtx, integration_settings: IntegrationSettings
) -> str:
    """One ready hybrid KB on the shared dataset, reused by detail/retrieval tests."""
    ctx = s3_ready_dataset
    settings = integration_settings
    kb_id = build_kb(ctx.client, settings, ctx.prefix, ctx.dataset_id, indexingMode="hybrid")
    try:
        yield kb_id
    finally:
        if settings.integration_cleanup:
            try:
                ctx.client.config_delete(f"{ctx.prefix}/knowledgebases/{kb_id}")
            except Exception as exc:
                print(f"[kb-teardown] delete {kb_id} failed: {exc}", file=sys.stderr)
