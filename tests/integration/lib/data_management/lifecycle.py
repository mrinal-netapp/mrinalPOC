"""Shared CRUD steps for data-management integration tests."""

from __future__ import annotations

import allure
import pytest

from lib.common.platform_client import PlatformClient, unique_name
from lib.common.settings import IntegrationSettings
from lib.utils.cleanup import PipelineResources
from lib.utils.waits import wait_for_project_ready, wait_for_workflow_terminal


def create_project(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    *,
    label: str,
    metadata: dict | None = None,
) -> str:
    """Create a project and return its config-service path prefix.

    Same flow as the shared ``created_project`` fixture: POST as the test user,
    then wait for project-init (Keycloak UMA + built-in models) before any
    project-scoped API calls.
    """
    with allure.step("Create project"):
        body: dict = {"name": unique_name(f"e2e-{label}")}
        if metadata:
            body["metadata"] = metadata
        resp = client.create_project(body)
        assert resp.status_code == 201, resp.text
        project = resp.json()
        resources.project_id = project["id"]
        resources.project_home_dir = project.get("home_dir")
        allure.attach(
            resources.project_id,
            name="project_id",
            attachment_type=allure.attachment_type.TEXT,
        )
        prefix = client.project_prefix(resources.project_id)
        print(f"\n[data_mgmt:{label}] project={resources.project_id} name={body['name']}")

    with allure.step("Wait for project-init (UMA + built-in models)"):
        wait_for_project_ready(
            lambda: client.config_get(f"{prefix}/models"),
            timeout_sec=settings.project_init_timeout_sec,
            poll_interval_sec=settings.project_init_poll_interval_sec,
        )

    with allure.step("Bootstrap project service account"):
        sa_resp = client.create_project_service_account(resources.project_id)
        assert sa_resp.status_code in (200, 201), sa_resp.text

    return prefix


def assert_connector_connection(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    prefix: str,
    *,
    step_label: str = "connector",
) -> None:
    """Run connector test workflow and persist result like the Studio UI."""
    if settings.skip_connection_test:
        print("[data_mgmt] SKIP_CONNECTION_TEST=1 — connection test skipped")
        return

    assert resources.datasource_id
    datasource_id = resources.datasource_id

    with allure.step(f"Test {step_label} connection (datasource API)"):
        ds_resp, test_resp = client.datasource_connection_test(prefix, datasource_id)
        assert ds_resp.status_code == 200, (
            f"GET datasource failed: HTTP {ds_resp.status_code} {ds_resp.text}"
        )
        body = ds_resp.json()
        if not body.get("connector_config") or not body.get("credential_id"):
            pytest.fail(
                "Datasource missing connector_config or credential_id — "
                "cannot run platform connection test"
            )
        assert test_resp.status_code == 200, (
            f"workflow connection test request failed: "
            f"HTTP {test_resp.status_code} {test_resp.text}"
        )
        workflow_id = test_resp.json()["workflowId"]
        try:
            wait_for_workflow_terminal(
                lambda: client.workflow_get(
                    f"api/v1/workflows/{workflow_id}/status"
                ),
                timeout_sec=settings.connection_test_timeout_sec,
            )
        except (AssertionError, TimeoutError) as exc:
            fail_msg = str(exc)
            with allure.step("Record connection test result (failed)"):
                record = client.record_datasource_connection_test_result(
                    prefix,
                    datasource_id,
                    success=False,
                    message=fail_msg,
                )
                assert record.status_code == 200, record.text
            pytest.fail(
                f"Platform datasource connection test failed ({step_label}) "
                f"[datasource={datasource_id}]: {exc}"
            )

        with allure.step("Record connection test result (success)"):
            record = client.record_datasource_connection_test_result(
                prefix,
                datasource_id,
                success=True,
                message="Connection successful.",
            )
            assert record.status_code == 200, record.text
            persisted = record.json()
            assert persisted.get("last_connection_test_status") == "success", (
                persisted
            )


def create_credential_and_store(
    client: PlatformClient,
    resources: PipelineResources,
    prefix: str,
    body: dict,
    *,
    step_label: str = "credential",
) -> str:
    """POST credential, store id on resources, return credential id."""
    with allure.step(f"Create {step_label}"):
        resp = client.create_credential(prefix, body)
        assert resp.status_code == 201, resp.text
        cred_id = resp.json()["id"]
        resources.credential_id = cred_id
        assert resp.json().get("secretData") is None, "secretData must not be echoed"
        return cred_id


def reconcile_reference_edges(
    client: PlatformClient,
    project_id: str,
    *,
    step_label: str = "reference edges",
) -> None:
    """Backfill credential→datasource edges when create-path extraction missed snake_case FKs."""
    with allure.step(f"Reconcile {step_label}"):
        resp = client.config_post(
            "api/v1/internal/reference-edges/reconcile",
            {"projectId": project_id},
        )
        assert resp.status_code == 200, resp.text


def create_datasource_and_store(
    client: PlatformClient,
    resources: PipelineResources,
    prefix: str,
    body: dict,
    *,
    step_label: str = "datasource",
) -> str:
    """POST datasource, store id on resources, return datasource id."""
    with allure.step(f"Create {step_label}"):
        resp = client.create_datasource(prefix, body)
        assert resp.status_code == 201, resp.text
        ds_id = resp.json()["id"]
        resources.datasource_id = ds_id
        if body.get("credential_id") and resources.project_id:
            reconcile_reference_edges(client, resources.project_id)
        return ds_id


def create_dataset_and_store(
    client: PlatformClient,
    resources: PipelineResources,
    prefix: str,
    body: dict,
    *,
    step_label: str = "dataset",
) -> str:
    """POST dataset, store id on resources, return dataset id."""
    with allure.step(f"Create {step_label}"):
        resp = client.create_dataset(prefix, body)
        assert resp.status_code == 201, resp.text
        dataset_id = resp.json()["id"]
        resources.dataset_id = dataset_id
        return dataset_id
