"""
GCP (GCNV) metrics connector -> acquired dataset -> acquisition + analytics.
Configure GCP_PROJECT_ID and GCP_SERVICE_ACCOUNT_JSON_FILE in tests/integration/.env.local.
"""

from __future__ import annotations
import allure
import pytest
from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings
from lib.knowledge_base.pipeline_setup import run_gcp_metrics_acquisition_setup
from lib.utils.cleanup import PipelineResources

pytestmark = [
    pytest.mark.gcp,
    allure.feature("GCP metrics acquisition pipeline"),
]

@pytest.fixture
def gcp_metrics_settings(
    integration_settings: IntegrationSettings,
) -> IntegrationSettings:
    if not integration_settings.has_gcp_metrics():
        pytest.skip(
            "GCP metrics test skipped - set GCP_PROJECT_ID and GCP_SERVICE_ACCOUNT_JSON_FILE "
            "in .env.local (GCP_DEFAULT_REGION optional)"
        )
    return integration_settings

@allure.title("GCP metrics: connector -> dataset -> acquisition -> analytics")
def test_gcp_metrics_acquisition_pipeline(
    e2e_resources: PipelineResources,
    platform_client: PlatformClient,
    gcp_metrics_settings: IntegrationSettings,
) -> None:
    run_gcp_metrics_acquisition_setup(
        platform_client,
        gcp_metrics_settings,
        e2e_resources,
    )
    assert e2e_resources.project_id
    assert e2e_resources.credential_id
    assert e2e_resources.datasource_id
    assert e2e_resources.dataset_id
