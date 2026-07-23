"""
PostgreSQL connector → structured dataset → KB → analytics + search.

Configure POSTGRES_* in tests/integration/.env.local.
"""

from __future__ import annotations

import allure
import pytest

from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings
from lib.knowledge_base.pipeline_setup import run_postgres_kb_pipeline_setup
from lib.utils.cleanup import PipelineResources

pytestmark = [
    pytest.mark.kb,
    pytest.mark.postgres,
    allure.feature("PostgreSQL KB pipeline"),
]


@pytest.fixture
def postgres_settings(integration_settings: IntegrationSettings) -> IntegrationSettings:
    if not integration_settings.has_postgres():
        pytest.skip(
            "PostgreSQL test skipped — set POSTGRES_HOST, POSTGRES_DATABASE, "
            "POSTGRES_USERNAME, POSTGRES_PASSWORD, POSTGRES_SOURCE_TABLE in .env.local "
            "(POSTGRES_SQL_QUERY optional — auto-generated if omitted)"
        )
    return integration_settings


@allure.title("PostgreSQL: connector → dataset → KB → analytics → search")
def test_postgres_to_kb_pipeline(
    e2e_resources: PipelineResources,
    platform_client: PlatformClient,
    postgres_settings: IntegrationSettings,
) -> None:
    run_postgres_kb_pipeline_setup(platform_client, postgres_settings, e2e_resources)
    assert e2e_resources.project_id
    assert e2e_resources.credential_id
    assert e2e_resources.datasource_id
    assert e2e_resources.dataset_id
    assert e2e_resources.knowledge_base_id
