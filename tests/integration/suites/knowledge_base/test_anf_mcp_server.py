"""
Azure NetApp Files managed MCP server (anf_mcp) provisioning and tool listing.

Configure AZURE_* in .env.local. Verifies read and write tools are discoverable
via config-service; tool invocation is not exercised.
"""

from __future__ import annotations

import allure
import pytest

from lib.anf_pipeline_setup import run_anf_mcp_server_setup
from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings
from lib.utils.cleanup import PipelineResources

pytestmark = [
    pytest.mark.anf,
    pytest.mark.mcp,
    allure.feature("ANF MCP server"),
]


@pytest.fixture
def anf_mcp_settings(integration_settings: IntegrationSettings) -> IntegrationSettings:
    if not integration_settings.has_azure_cloud():
        pytest.skip(
            "ANF MCP test skipped — set AZURE_TENANT_ID, AZURE_CLIENT_ID, "
            "AZURE_CLIENT_SECRET, AZURE_SUBSCRIPTION_ID, and AZURE_DEFAULT_REGION "
            "in .env.local"
        )
    return integration_settings


@allure.title("ANF MCP: provision managed server and list read + write tools")
def test_anf_mcp_server_provision_and_list_tools(
    e2e_resources: PipelineResources,
    platform_client: PlatformClient,
    anf_mcp_settings: IntegrationSettings,
) -> None:
    run_anf_mcp_server_setup(platform_client, anf_mcp_settings, e2e_resources)
    assert e2e_resources.project_id
    assert e2e_resources.credential_id
    assert e2e_resources.mcp_server_id
