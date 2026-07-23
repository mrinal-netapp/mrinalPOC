"""
S3-compatible object store (MinIO, s3gateway, AWS S3) → dataset → KB → search.

Configure S3_* / AWS_* in tests/integration/.env.local.
"""

from __future__ import annotations

import allure
import pytest

from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings
from lib.knowledge_base.pipeline_setup import run_s3compatible_kb_pipeline_setup
from lib.utils.cleanup import PipelineResources

pytestmark = [
    pytest.mark.kb,
    pytest.mark.s3compatible,
    allure.feature("S3-compatible KB pipeline"),
]


@pytest.fixture
def s3compatible_settings(
    integration_settings: IntegrationSettings,
) -> IntegrationSettings:
    if not integration_settings.has_s3compatible():
        pytest.skip(
            "S3-compatible test skipped — set S3_ENDPOINT, S3_BUCKET, "
            "AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY in .env.local"
        )
    return integration_settings


@allure.title("S3-compatible: connector → dataset → KB → analytics → search")
def test_s3compatible_to_kb_pipeline(
    e2e_resources: PipelineResources,
    platform_client: PlatformClient,
    s3compatible_settings: IntegrationSettings,
) -> None:
    run_s3compatible_kb_pipeline_setup(
        platform_client, s3compatible_settings, e2e_resources
    )
    assert e2e_resources.project_id
    assert e2e_resources.credential_id
    assert e2e_resources.datasource_id
    assert e2e_resources.dataset_id
    assert e2e_resources.knowledge_base_id
