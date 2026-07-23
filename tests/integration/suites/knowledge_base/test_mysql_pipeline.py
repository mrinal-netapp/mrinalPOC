"""
MySQL connector → structured dataset → KB → analytics + search.

Configure MYSQL_* in tests/integration/.env.local.
"""

from __future__ import annotations

import allure
import pytest

from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings
from lib.knowledge_base.pipeline_setup import run_mysql_kb_pipeline_setup
from lib.utils.cleanup import PipelineResources

pytestmark = [
    pytest.mark.kb,
    pytest.mark.mysql,
    allure.feature("MySQL KB pipeline"),
]


@pytest.fixture
def mysql_settings(integration_settings: IntegrationSettings) -> IntegrationSettings:
    if not integration_settings.has_mysql():
        pytest.skip(
            "MySQL test skipped — set MYSQL_HOST, MYSQL_DATABASE, MYSQL_USERNAME, "
            "MYSQL_PASSWORD, MYSQL_SOURCE_TABLE in .env.local "
            "(MYSQL_SQL_QUERY optional — auto-generated if omitted)"
        )
    return integration_settings


@allure.title("MySQL: connector → dataset → KB → analytics → search")
def test_mysql_to_kb_pipeline(
    e2e_resources: PipelineResources,
    platform_client: PlatformClient,
    mysql_settings: IntegrationSettings,
) -> None:
    run_mysql_kb_pipeline_setup(platform_client, mysql_settings, e2e_resources)
    assert e2e_resources.project_id
    assert e2e_resources.credential_id
    assert e2e_resources.datasource_id
    assert e2e_resources.dataset_id
    assert e2e_resources.knowledge_base_id
