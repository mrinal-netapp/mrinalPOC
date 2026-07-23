"""Metrics-as-resource acquired datasets (GCP, ONTAP, azure_cloud)."""

from __future__ import annotations

import allure
import pytest

from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings
from lib.data_management.dataset_lifecycle import run_metrics_dataset
from lib.data_management.prerequisites import (
    require_provider,
    setup_credential_prerequisite,
    setup_datasource_prerequisite,
)
from lib.utils.cleanup import PipelineResources

pytestmark = [
    pytest.mark.data_management,
    pytest.mark.dataset,
    pytest.mark.metrics,
    pytest.mark.structured,
    allure.feature("Metrics acquired dataset"),
]


@pytest.fixture(params=["gcp", "ontap", "azure_cloud"])
def metrics_provider(request: pytest.FixtureRequest) -> str:
    return request.param


@pytest.fixture
def metrics_settings(
    integration_settings: IntegrationSettings, metrics_provider: str
) -> IntegrationSettings:
    require_provider(integration_settings, metrics_provider)
    return integration_settings


@pytest.fixture
def dm_datasource_prereq(
    platform_client: PlatformClient,
    integration_settings: IntegrationSettings,
    e2e_resources: PipelineResources,
    dm_project_prereq: str,
    metrics_provider: str,
    metrics_settings: IntegrationSettings,
) -> str:
    """Project + credential + datasource for the active metrics provider."""
    label = metrics_provider.replace("_", "-")
    setup_credential_prerequisite(
        platform_client,
        integration_settings,
        e2e_resources,
        dm_project_prereq,
        provider=metrics_provider,
        label=label,
    )
    setup_datasource_prerequisite(
        platform_client,
        integration_settings,
        e2e_resources,
        dm_project_prereq,
        provider=metrics_provider,
        label=label,
    )
    return dm_project_prereq


def _categories_for(provider: str, settings: IntegrationSettings) -> list[str]:
    if provider == "gcp":
        return ["volume_metrics", "pool_metrics", "volume_tier_metrics"]
    if provider == "ontap":
        return ["volume_metrics", "aggregate_metrics", "quota_metrics"]
    return settings.anf_metric_category_list()


@allure.title("Metrics connector: acquire → ready → metrics column validation")
def test_metrics_dataset_lifecycle(
    dm_datasource_prereq: str,
    e2e_resources: PipelineResources,
    platform_client: PlatformClient,
    metrics_settings: IntegrationSettings,
    metrics_provider: str,
) -> None:
    label = metrics_provider.replace("_", "-")
    run_metrics_dataset(
        platform_client,
        metrics_settings,
        e2e_resources,
        dm_datasource_prereq,
        provider=metrics_provider,
        label=label,
        categories=_categories_for(metrics_provider, metrics_settings),
    )
    ds = platform_client.get_dataset(
        dm_datasource_prereq,
        e2e_resources.dataset_id,
    )
    assert ds.status_code == 200
    body = ds.json()
    assert body.get("status") == "ready"
    assert body.get("namespace")
    assert body.get("catalogTableName")
