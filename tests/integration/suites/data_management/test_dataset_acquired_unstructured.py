"""Unstructured acquired dataset lifecycle (S3-compatible)."""

from __future__ import annotations

import allure
import pytest

from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings
from lib.data_management.dataset_lifecycle import run_acquired_unstructured_dataset
from lib.utils.cleanup import PipelineResources

pytestmark = [
    pytest.mark.data_management,
    pytest.mark.dataset,
    pytest.mark.unstructured,
    pytest.mark.s3compatible,
    allure.feature("Unstructured acquired dataset"),
]


@pytest.fixture
def s3_settings(integration_settings: IntegrationSettings) -> IntegrationSettings:
    if not integration_settings.has_s3compatible():
        pytest.skip("Set S3_* in .env.local")
    return integration_settings


@pytest.mark.parametrize("dm_datasource_prereq", ["s3"], indirect=True)
@allure.title("S3-compatible: unstructured acquired dataset → ready (datasource prerequisite)")
def test_acquired_unstructured_dataset_lifecycle(
    dm_datasource_prereq: str,
    e2e_resources: PipelineResources,
    platform_client: PlatformClient,
    s3_settings: IntegrationSettings,
) -> None:
    run_acquired_unstructured_dataset(
        platform_client, s3_settings, e2e_resources, dm_datasource_prereq
    )
    assert e2e_resources.dataset_id
