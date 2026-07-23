"""GCP metrics connector datasource lifecycle."""

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
    pytest.mark.connector_gcp,
    pytest.mark.gcp,
    allure.feature("GCP datasource lifecycle"),
]


@pytest.fixture
def gcp_settings(integration_settings: IntegrationSettings) -> IntegrationSettings:
    if not integration_settings.has_gcp_metrics():
        pytest.skip("Set GCP_PROJECT_ID and GCP_SERVICE_ACCOUNT_JSON_FILE in .env.local")
    return integration_settings


@pytest.mark.parametrize("dm_credential_prereq", ["gcp"], indirect=True)
@allure.title("GCP: datasource CRUD + connection test (credential prerequisite)")
def test_gcp_datasource_lifecycle(
    dm_credential_prereq: str,
    e2e_resources: PipelineResources,
    platform_client: PlatformClient,
    gcp_settings: IntegrationSettings,
) -> None:
    run_connector_datasource_lifecycle(
        platform_client,
        gcp_settings,
        e2e_resources,
        dm_credential_prereq,
        "gcp",
        label="gcp",
    )
