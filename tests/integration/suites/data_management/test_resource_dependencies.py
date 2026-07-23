"""Cross-entity delete dependency enforcement."""

from __future__ import annotations

import allure
import pytest

from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings
from lib.data_management.builders import acquired_structured_dataset_body
from lib.data_management.lifecycle import (
    assert_connector_connection,
    create_dataset_and_store,
)
from lib.data_management.prerequisites import (
    setup_credential_prerequisite,
    setup_datasource_prerequisite,
    setup_project_prerequisite,
)
from lib.utils.cleanup import PipelineResources
from lib.utils.sql_query import resolve_sql_query

pytestmark = [
    pytest.mark.data_management,
    allure.feature("Resource delete dependencies"),
]


@pytest.fixture
def chain_settings(integration_settings: IntegrationSettings) -> IntegrationSettings:
    if not integration_settings.has_postgres():
        pytest.skip("Resource dependency test requires POSTGRES_* in .env.local")
    return integration_settings


@allure.title("Credential → datasource → dataset delete order")
def test_resource_delete_dependencies(
    e2e_resources: PipelineResources,
    platform_client: PlatformClient,
    chain_settings: IntegrationSettings,
) -> None:
    prefix = setup_project_prerequisite(
        platform_client, chain_settings, e2e_resources, label="deps"
    )

    setup_credential_prerequisite(
        platform_client,
        chain_settings,
        e2e_resources,
        prefix,
        provider="postgresql",
        label="deps",
    )

    setup_datasource_prerequisite(
        platform_client,
        chain_settings,
        e2e_resources,
        prefix,
        provider="postgresql",
        label="deps",
    )
    assert_connector_connection(
        platform_client, chain_settings, e2e_resources, prefix, step_label="postgres"
    )

    formatted_sql = resolve_sql_query(
        "postgresql",
        chain_settings.postgres_sql_query,
        chain_settings.postgres_database,
        chain_settings.postgres_schema,
        chain_settings.postgres_source_table,
    )
    dataset_body = acquired_structured_dataset_body(
        label="deps",
        datasource_id=e2e_resources.datasource_id,
        database=chain_settings.postgres_database,
        schema=chain_settings.postgres_schema,
        source_table=chain_settings.postgres_source_table,
        sql_query=formatted_sql,
    )
    create_dataset_and_store(platform_client, e2e_resources, prefix, dataset_body)
    credential_id = e2e_resources.credential_id

    with allure.step("DELETE credential blocked while datasource exists"):
        blocked = platform_client.delete_credential(prefix, credential_id)
        assert blocked.status_code == 409, blocked.text

    with allure.step("DELETE dataset"):
        del_ds = platform_client.delete_dataset(prefix, e2e_resources.dataset_id)
        assert del_ds.status_code in (200, 202, 204), del_ds.text
        e2e_resources.dataset_id = None

    with allure.step("DELETE datasource"):
        del_conn = platform_client.delete_datasource(
            prefix, e2e_resources.datasource_id
        )
        assert del_conn.status_code in (200, 204), del_conn.text
        e2e_resources.datasource_id = None

    with allure.step("DELETE credential"):
        del_cred = platform_client.delete_credential(prefix, credential_id)
        assert del_cred.status_code in (200, 204), del_cred.text
        e2e_resources.credential_id = None

    with allure.step("Verify credential gone"):
        assert platform_client.get_credential(prefix, credential_id).status_code == 404
