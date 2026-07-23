"""
ONTAP metrics connector -> acquired dataset -> acquisition + analytics.
Configure ONTAP_* in tests/integration/.env.local.
"""

from __future__ import annotations

import os

import allure
import pytest

from lib.common.platform_client import PlatformClient, unique_name
from lib.common.settings import IntegrationSettings
from lib.knowledge_base.pipeline_setup import run_ontap_metrics_acquisition_setup
from lib.utils.cleanup import PipelineResources
from lib.utils.waits import wait_for_project_ready, wait_for_workflow_terminal

pytestmark = [
    pytest.mark.ontap,
    allure.feature("ONTAP metrics acquisition pipeline"),
]


@pytest.fixture
def ontap_metrics_settings(
    integration_settings: IntegrationSettings,
) -> IntegrationSettings:
    if not integration_settings.has_ontap_metrics():
        pytest.skip(
            "ONTAP metrics test skipped - set ONTAP_CLUSTER_URL, ONTAP_USERNAME, "
            "ONTAP_PASSWORD in .env.local (ONTAP_VERIFY_TLS and ONTAP_DEFAULT_SVM optional)"
        )
    return integration_settings


@allure.title("ONTAP metrics: connector -> dataset -> acquisition -> analytics")
def test_ontap_metrics_acquisition_pipeline(
    e2e_resources: PipelineResources,
    platform_client: PlatformClient,
    ontap_metrics_settings: IntegrationSettings,
) -> None:
    namespace, table_name = run_ontap_metrics_acquisition_setup(
        platform_client,
        ontap_metrics_settings,
        e2e_resources,
    )
    assert namespace and table_name, "dataset should expose namespace/catalog table after acquisition"
    assert e2e_resources.project_id
    assert e2e_resources.credential_id
    assert e2e_resources.datasource_id
    assert e2e_resources.dataset_id

    preview = platform_client.analytics_post(
        "/api/v1/datasets/preview",
        {
            "namespace": namespace,
            "table": table_name,
            "limit": 5,
            "offset": 0,
            "filters": [],
        },
    )
    assert preview.status_code == 200, preview.text
    columns = preview.json().get("columns") or []
    column_names = {
        c["name"] if isinstance(c, dict) else str(c)
        for c in columns
    }
    # Core ONTAP metrics schema columns should be present in acquired analytics tables.
    assert {"timestamp", "source_type", "cluster_id"} <= column_names


@allure.title("ONTAP metrics: connection test fails with invalid credentials")
def test_ontap_metrics_connection_rejects_invalid_credentials(
    e2e_resources: PipelineResources,
    platform_client: PlatformClient,
    ontap_metrics_settings: IntegrationSettings,
) -> None:
    project_name = unique_name("e2e-ontap-negative")
    project_resp = platform_client.config_post("api/v1/projects", {"name": project_name})
    assert project_resp.status_code == 201, project_resp.text
    project = project_resp.json()
    e2e_resources.project_id = project["id"]
    e2e_resources.project_home_dir = project.get("home_dir")
    prefix = platform_client.project_prefix(e2e_resources.project_id)

    # project-init is async; wait before any project-scoped call so the gateway
    # UMA-RPT swap doesn't 502 on a not-yet-registered Keycloak project resource.
    wait_for_project_ready(
        lambda: platform_client.config_get(f"{prefix}/models"),
        timeout_sec=int(os.environ.get("PROJECT_READY_TIMEOUT_SEC") or "300"),
    )

    bad_cred = platform_client.config_post(
        f"{prefix}/credentials",
        {
            "name": unique_name("e2e-ontap-bad-cred"),
            "description": "pytest ONTAP bad credential",
            "provider": "ontap",
            "secretData": {
                "username": ontap_metrics_settings.ontap_username,
                "password": f"{ontap_metrics_settings.ontap_password}_invalid",
            },
        },
    )
    assert bad_cred.status_code == 201, bad_cred.text
    e2e_resources.credential_id = bad_cred.json()["id"]

    connector_resp = platform_client.config_post(
        f"{prefix}/datasources",
        {
            "name": unique_name("e2e-ontap-bad-connector"),
            "type": "connector",
            "description": "pytest ONTAP connector with bad credential",
            "credential_id": e2e_resources.credential_id,
            "connector_config": {
                "scope": "account",
                "provider": "ontap",
                "connector_type": "storage",
                "cluster_url": ontap_metrics_settings.ontap_cluster_url,
                "verify_tls": ontap_metrics_settings.ontap_verify_tls,
            },
        },
    )
    assert connector_resp.status_code == 201, connector_resp.text
    e2e_resources.datasource_id = connector_resp.json()["id"]

    ds_resp, test_resp = platform_client.datasource_connection_test(prefix, e2e_resources.datasource_id)
    assert ds_resp.status_code == 200, ds_resp.text
    assert test_resp.status_code == 200, test_resp.text
    workflow_id = test_resp.json()["workflowId"]

    with pytest.raises(AssertionError, match="workflow failed"):
        wait_for_workflow_terminal(
            lambda: platform_client.workflow_get(f"api/v1/workflows/{workflow_id}/status"),
            timeout_sec=ontap_metrics_settings.connection_test_timeout_sec,
        )
