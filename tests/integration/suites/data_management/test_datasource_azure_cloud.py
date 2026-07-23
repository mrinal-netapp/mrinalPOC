"""Azure NetApp Files (azure_cloud) connector datasource lifecycle."""

from __future__ import annotations

import allure
import pytest

from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings
from lib.data_management.datasource_lifecycle import run_connector_datasource_lifecycle
from lib.utils.cleanup import PipelineResources

pytestmark = [
    pytest.mark.data_management,
    pytest.mark.datasource,
    pytest.mark.connector_azure_cloud,
    pytest.mark.anf,
    allure.feature("Azure cloud datasource lifecycle"),
]


@pytest.fixture
def azure_settings(integration_settings: IntegrationSettings) -> IntegrationSettings:
    if not integration_settings.has_azure_cloud():
        pytest.skip("Set AZURE_* in .env.local")
    return integration_settings


@pytest.mark.parametrize("dm_credential_prereq", ["azure_cloud"], indirect=True)
@allure.title("azure_cloud: datasource CRUD + connection test (credential prerequisite)")
def test_azure_cloud_datasource_lifecycle(
    dm_credential_prereq: str,
    e2e_resources: PipelineResources,
    platform_client: PlatformClient,
    azure_settings: IntegrationSettings,
) -> None:
    run_connector_datasource_lifecycle(
        platform_client,
        azure_settings,
        e2e_resources,
        dm_credential_prereq,
        "azure_cloud",
        label="azure-cloud",
    )
