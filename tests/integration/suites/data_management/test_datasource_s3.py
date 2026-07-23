"""S3-compatible connector datasource lifecycle."""

from __future__ import annotations

import allure
import pytest

from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings
from lib.data_management.datasource_lifecycle import run_s3_datasource_lifecycle
from lib.utils.cleanup import PipelineResources

pytestmark = [
    pytest.mark.data_management,
    pytest.mark.datasource,
    pytest.mark.connector_s3,
    pytest.mark.s3compatible,
    allure.feature("S3 datasource lifecycle"),
]


@pytest.fixture
def s3_settings(integration_settings: IntegrationSettings) -> IntegrationSettings:
    if not integration_settings.has_s3compatible():
        pytest.skip("Set S3_* and AWS_* in .env.local")
    return integration_settings


@pytest.mark.parametrize("dm_credential_prereq", ["s3"], indirect=True)
@allure.title("S3-compatible: datasource CRUD + connection test (credential prerequisite)")
def test_s3_datasource_lifecycle(
    dm_credential_prereq: str,
    e2e_resources: PipelineResources,
    platform_client: PlatformClient,
    s3_settings: IntegrationSettings,
) -> None:
    run_s3_datasource_lifecycle(
        platform_client, s3_settings, e2e_resources, dm_credential_prereq
    )
