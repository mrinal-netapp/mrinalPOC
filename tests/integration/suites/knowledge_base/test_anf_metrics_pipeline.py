"""
Azure NetApp Files metrics connector → structured dataset → acquire → analytics.

Configure AZURE_* and optional ANF_METRIC_CATEGORIES in tests/integration/.env.local.
"""

from __future__ import annotations

import allure
import pytest

from lib.anf_pipeline_setup import run_anf_metrics_pipeline_setup
from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings
from lib.utils.cleanup import PipelineResources

pytestmark = [
    pytest.mark.anf,
    pytest.mark.metrics,
    allure.feature("ANF metrics pipeline"),
]


@pytest.fixture
def anf_settings(integration_settings: IntegrationSettings) -> IntegrationSettings:
    if not integration_settings.has_azure_cloud():
        pytest.skip(
            "ANF metrics test skipped — set AZURE_SUBSCRIPTION_ID, AZURE_DEFAULT_REGION, "
            "AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET in .env.local"
        )
    return integration_settings


@allure.title("ANF: azure_cloud connector → metrics dataset → acquire → analytics preview")
def test_anf_metrics_connector_acquire_and_preview(
    e2e_resources: PipelineResources,
    platform_client: PlatformClient,
    anf_settings: IntegrationSettings,
) -> None:
    run_anf_metrics_pipeline_setup(platform_client, anf_settings, e2e_resources)
    assert e2e_resources.project_id
    assert e2e_resources.credential_id
    assert e2e_resources.datasource_id
    assert e2e_resources.dataset_id

    ds_resp = platform_client.config_get(
        f"api/v1/projects/{e2e_resources.project_id}/datasets/{e2e_resources.dataset_id}"
    )
    assert ds_resp.status_code == 200, ds_resp.text
    assert ds_resp.json().get("status") == "ready", ds_resp.text
