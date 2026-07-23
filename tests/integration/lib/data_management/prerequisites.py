"""Composable prerequisites for data-management integration tests.

Layering (each suite runs independently via make targets):

  project + RBAC  →  credential  →  datasource  →  dataset

Credential tests only need ``setup_project_prerequisite``.
Datasource tests need project + credential (reuse fixture, do not depend on
credential *tests* having run).
Dataset tests need project + credential + datasource.
"""

from __future__ import annotations

import allure
import pytest

from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings
from lib.data_management.builders import (
    credential_for_provider,
    datasource_connector_body,
    volume_datasource_body,
)
from lib.data_management.lifecycle import (
    assert_connector_connection,
    create_credential_and_store,
    create_datasource_and_store,
    create_project,
)
from lib.utils.cleanup import PipelineResources
from lib.utils.object_store_client import ObjectStoreTarget, object_store_from_s3_settings


def resolve_primary_provider(settings: IntegrationSettings) -> str:
    """Pick the first configured connector provider for this environment."""
    if settings.has_postgres():
        return "postgresql"
    if settings.has_s3compatible():
        return "s3"
    if settings.has_ontap_metrics():
        return "ontap"
    if settings.has_gcp_metrics():
        return "gcp"
    if settings.has_azure_cloud():
        return "azure_cloud"
    return ""


def require_provider(settings: IntegrationSettings, provider: str) -> None:
    """Skip when ``provider`` is not configured in .env.local."""
    checks = {
        "postgresql": settings.has_postgres,
        "mysql": settings.has_mysql,
        "s3": settings.has_s3compatible,
        "ontap": settings.has_ontap_metrics,
        "gcp": settings.has_gcp_metrics,
        "azure_cloud": settings.has_azure_cloud,
        "redash": settings.has_redash,
        "volume": settings.has_volume,
    }
    fn = checks.get(provider)
    if fn is None or not fn():
        pytest.skip(f"Provider {provider!r} not configured in .env.local")


def setup_project_prerequisite(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    *,
    label: str = "dm",
    metadata: dict | None = None,
) -> str:
    """Create project with Keycloak RBAC + service account; return API prefix."""
    if resources.project_id:
        return client.project_prefix(resources.project_id)
    meta = metadata or {"source": "pytest-data-management"}
    return create_project(
        client, settings, resources, label=label, metadata=meta
    )


def setup_credential_prerequisite(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    prefix: str,
    *,
    provider: str,
    label: str | None = None,
) -> str:
    """Ensure a credential exists on ``resources``; return credential id."""
    if resources.credential_id:
        return resources.credential_id
    label = label or provider
    body = credential_for_provider(settings, provider, label=label)
    with allure.step(f"Prerequisite: credential ({provider})"):
        return create_credential_and_store(
            client, resources, prefix, body, step_label=f"{label} credential"
        )


def setup_datasource_prerequisite(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    prefix: str,
    *,
    provider: str,
    label: str | None = None,
    store: ObjectStoreTarget | None = None,
    run_connection_test: bool = True,
) -> str:
    """Ensure connector datasource exists; return datasource id."""
    if resources.datasource_id:
        return resources.datasource_id
    assert resources.credential_id, "credential prerequisite missing"
    label = label or provider
    if store is None and provider == "s3":
        store = object_store_from_s3_settings(settings)
    ds_body = datasource_connector_body(
        settings,
        provider,
        resources.credential_id,
        label=label,
        store=store,
    )
    with allure.step(f"Prerequisite: datasource ({provider})"):
        ds_id = create_datasource_and_store(
            client, resources, prefix, ds_body, step_label=f"{label} datasource"
        )
    if run_connection_test:
        assert_connector_connection(
            client, settings, resources, prefix, step_label=label
        )
    return ds_id


def setup_volume_datasource_prerequisite(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    prefix: str,
) -> str:
    """Ensure a volume datasource exists (no credential required)."""
    if resources.datasource_id:
        return resources.datasource_id
    ds_body = volume_datasource_body(settings)
    with allure.step("Prerequisite: volume datasource"):
        return create_datasource_and_store(
            client, resources, prefix, ds_body, step_label="volume datasource"
        )
