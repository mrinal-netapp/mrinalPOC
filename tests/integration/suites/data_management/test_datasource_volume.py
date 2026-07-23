"""NFS volume datasource lifecycle."""

from __future__ import annotations

import allure
import pytest

from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings
from lib.data_management.datasource_lifecycle import run_volume_datasource_lifecycle
from lib.utils.cleanup import PipelineResources

pytestmark = [
    pytest.mark.data_management,
    pytest.mark.datasource,
    pytest.mark.connector_volume,
    allure.feature("Volume datasource lifecycle"),
]


@pytest.fixture
def volume_settings(integration_settings: IntegrationSettings) -> IntegrationSettings:
    if not integration_settings.has_volume():
        pytest.skip("Set VOLUME_ENDPOINT in .env.local")
    return integration_settings


@allure.title("Volume: datasource CRUD + optional scan (project prerequisite)")
def test_volume_datasource_lifecycle(
    dm_project_prereq: str,
    e2e_resources: PipelineResources,
    platform_client: PlatformClient,
    volume_settings: IntegrationSettings,
) -> None:
    run_volume_datasource_lifecycle(
        platform_client, volume_settings, e2e_resources, dm_project_prereq
    )
