"""Redash API connector datasource lifecycle."""

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
    pytest.mark.connector_redash,
    allure.feature("Redash datasource lifecycle"),
]


@pytest.fixture
def redash_settings(integration_settings: IntegrationSettings) -> IntegrationSettings:
    if not integration_settings.has_redash():
        pytest.skip("Set REDASH_URL and REDASH_API_KEY in .env.local")
    return integration_settings


@pytest.mark.parametrize("dm_credential_prereq", ["redash"], indirect=True)
@allure.title("Redash: datasource CRUD + connection test (credential prerequisite)")
def test_redash_datasource_lifecycle(
    dm_credential_prereq: str,
    e2e_resources: PipelineResources,
    platform_client: PlatformClient,
    redash_settings: IntegrationSettings,
) -> None:
    run_connector_datasource_lifecycle(
        platform_client,
        redash_settings,
        e2e_resources,
        dm_credential_prereq,
        "redash",
        label="redash",
    )
