"""Structured acquired dataset lifecycle (PostgreSQL + MySQL)."""

from __future__ import annotations

import allure
import pytest

from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings
from lib.data_management.dataset_lifecycle import run_acquired_structured_dataset
from lib.data_management.prerequisites import (
    require_provider,
    setup_credential_prerequisite,
    setup_datasource_prerequisite,
)
from lib.utils.cleanup import PipelineResources

pytestmark = [
    pytest.mark.data_management,
    pytest.mark.dataset,
    pytest.mark.structured,
    allure.feature("Structured acquired dataset"),
]


@pytest.fixture(params=["postgresql", "mysql"])
def db_provider(request: pytest.FixtureRequest) -> str:
    return request.param


@pytest.fixture
def db_settings(
    integration_settings: IntegrationSettings, db_provider: str
) -> IntegrationSettings:
    require_provider(integration_settings, db_provider)
    return integration_settings


@pytest.fixture
def dm_datasource_prereq(
    platform_client: PlatformClient,
    integration_settings: IntegrationSettings,
    e2e_resources: PipelineResources,
    dm_project_prereq: str,
    db_provider: str,
    db_settings: IntegrationSettings,
) -> str:
    """Project + credential + datasource for the active DB provider."""
    label = "postgres" if db_provider == "postgresql" else "mysql"
    setup_credential_prerequisite(
        platform_client,
        integration_settings,
        e2e_resources,
        dm_project_prereq,
        provider=db_provider,
        label=label,
    )
    setup_datasource_prerequisite(
        platform_client,
        integration_settings,
        e2e_resources,
        dm_project_prereq,
        provider=db_provider,
        label=label,
    )
    return dm_project_prereq


@allure.title("Structured acquired dataset: acquire → ready → analytics query validation")
def test_acquired_structured_dataset_lifecycle(
    dm_datasource_prereq: str,
    e2e_resources: PipelineResources,
    platform_client: PlatformClient,
    db_settings: IntegrationSettings,
    db_provider: str,
) -> None:
    label = "postgres" if db_provider == "postgresql" else "mysql"
    run_acquired_structured_dataset(
        platform_client,
        db_settings,
        e2e_resources,
        dm_datasource_prereq,
        provider=db_provider,
        label=label,
    )
    assert e2e_resources.dataset_id
    assert e2e_resources.datasource_id
    assert e2e_resources.credential_id
