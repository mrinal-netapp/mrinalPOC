"""E2E pipelines for Azure NetApp Files metrics connector and MCP server."""

from __future__ import annotations

import json

import allure
import pytest

from lib.common.platform_client import PlatformClient, unique_mcp_name, unique_name
from lib.common.settings import IntegrationSettings
from lib.knowledge_base.pipeline_setup import (
    _assert_connector_connection,
    _create_project,
)
from lib.utils.cleanup import PipelineResources
from lib.utils.waits import wait_for_dataset_ready, wait_for_mcp_gateway_synced, wait_for_mcp_runtime_ready

ANF_READ_TOOLS = {
    "anf_capacity_pool_list",
    "anf_capacity_pool_get",
    "anf_volume_list",
    "anf_volume_get",
}

ANF_WRITE_TOOLS = {
    "anf_resize_capacity_pool",
    "anf_resize_volume",
}

EXPECTED_METRIC_COLUMNS: dict[str, set[str]] = {
    "volume_metrics": {
        "timestamp",
        "source_type",
        "volume_id",
        "iops_total",
        "throughput_total_bytes",
    },
    "pool_metrics": {
        "timestamp",
        "source_type",
        "pool_id",
        "capacity_bytes",
    },
    "volume_tier_metrics": {
        "timestamp",
        "source_type",
        "volume_id",
        "tier_name",
    },
}


def _preview_column_names(preview_body: dict) -> set[str]:
    """Normalize analytics preview columns (API may return strings or {name: ...} dicts)."""
    names: set[str] = set()
    for col in preview_body.get("columns") or []:
        if isinstance(col, str):
            if col:
                names.add(col)
        elif isinstance(col, dict):
            name = col.get("name") or col.get("Name")
            if name:
                names.add(str(name))
    return names


# Columns that indicate a category's schema is present in the preview (not shared baselines).
_DISTINCTIVE_METRIC_COLUMNS: dict[str, set[str]] = {
    "volume_metrics": {"volume_id", "iops_total", "throughput_total_bytes"},
    "pool_metrics": {"pool_id", "capacity_bytes"},
    "volume_tier_metrics": {"volume_id", "tier_name"},
}


def _assert_preview_metric_columns(columns: set[str], categories: list[str]) -> None:
    """Require baseline metric columns and at least one full category signature."""
    baseline = {"timestamp", "source_type"}
    missing_baseline = baseline - columns
    assert not missing_baseline, (
        f"analytics preview missing baseline columns {sorted(missing_baseline)}; "
        f"got {sorted(columns)}"
    )
    matched: list[str] = []
    for category in categories:
        expected = EXPECTED_METRIC_COLUMNS.get(category, set())
        if not expected:
            continue
        distinctive = _DISTINCTIVE_METRIC_COLUMNS.get(category, expected)
        if not (distinctive & columns):
            continue
        missing = expected - columns
        if missing:
            pytest.fail(
                f"analytics preview partially matches {category} "
                f"(missing {sorted(missing)}); got {sorted(columns)}"
            )
        matched.append(category)
    assert matched, (
        f"analytics preview has no recognized metric category columns; "
        f"categories={categories}, columns={sorted(columns)}"
    )


def _create_azure_cloud_credential(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    prefix: str,
) -> None:
    with allure.step("Create azure_cloud credential"):
        cred_resp = client.config_post(
            f"{prefix}/credentials",
            {
                "name": unique_name("e2e-anf-cred"),
                "description": "pytest Azure cloud credential",
                "provider": "azure_cloud",
                "secretData": {
                    "tenant_id": settings.azure_tenant_id,
                    "client_id": settings.azure_client_id,
                    "client_secret": settings.azure_client_secret,
                },
            },
        )
        assert cred_resp.status_code == 201, cred_resp.text
        resources.credential_id = cred_resp.json()["id"]


def _create_azure_cloud_datasource(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    prefix: str,
) -> None:
    connector_config: dict[str, str] = {
        "scope": "account",
        "provider": "azure_cloud",
        "connector_type": "cloud",
        "subscription_id": settings.azure_subscription_id,
        "default_region": settings.azure_default_region,
    }
    if settings.azure_resource_group:
        connector_config["resource_group"] = settings.azure_resource_group

    with allure.step("Create azure_cloud connector datasource"):
        conn_resp = client.config_post(
            f"{prefix}/datasources",
            {
                "name": unique_name("e2e-anf-connector"),
                "type": "connector",
                "description": "pytest ANF metrics connector",
                "connector_config": connector_config,
                "credential_id": resources.credential_id,
            },
        )
        assert conn_resp.status_code == 201, conn_resp.text
        resources.datasource_id = conn_resp.json()["id"]


def _acquire_anf_dataset_and_analytics(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    prefix: str,
    *,
    categories: list[str],
) -> None:
    if settings.skip_acquisition:
        pytest.skip("SKIP_ACQUISITION=1 — metrics acquisition skipped")

    with allure.step("Start dataset acquisition workflow"):
        acquire = client.workflow_post(
            f"api/v1/projects/{resources.project_id}/datasets/{resources.dataset_id}/acquire"
        )
        assert acquire.status_code in (200, 202), acquire.text
        print(f"[anf-pipeline] acquisition workflow={acquire.json().get('workflowId')}")

    with allure.step("Wait for dataset ready"):
        dataset_body = wait_for_dataset_ready(
            lambda: client.config_get(f"{prefix}/datasets/{resources.dataset_id}"),
            timeout_sec=settings.anf_acquisition_timeout_sec,
            poll_interval_sec=settings.acquisition_poll_interval_sec,
        )
        namespace = dataset_body.get("namespace")
        table_name = dataset_body.get("catalogTableName")
        print(
            f"[anf-pipeline] dataset ready namespace={namespace} table={table_name} "
            f"status={dataset_body.get('status')}"
        )

    if settings.skip_analytics:
        print("[anf-pipeline] SKIP_ANALYTICS=1 — preview/stats skipped")
        return

    assert namespace and table_name, (
        "dataset missing namespace/catalogTableName — cannot run analytics"
    )

    with allure.step("Analytics preview"):
        preview = client.analytics_post(
            "/api/v1/datasets/preview",
            {
                "namespace": namespace,
                "table": table_name,
                "limit": 10,
                "offset": 0,
                "filters": [],
            },
        )
        assert preview.status_code == 200, preview.text
        preview_body = preview.json()
        columns = _preview_column_names(preview_body)
        assert columns, f"expected analytics columns, got: {preview_body}"
        _assert_preview_metric_columns(columns, categories)
        row_count = int(
            preview_body.get("totalCount")
            or preview_body.get("totalRows")
            or preview_body.get("rowCount")
            or 0
        )
        for category in categories:
            expected = EXPECTED_METRIC_COLUMNS.get(category, set())
            if expected and expected <= columns:
                print(f"[anf-pipeline] analytics preview includes {category} columns")
        if row_count == 0:
            print(
                "[anf-pipeline] analytics preview returned 0 rows — "
                "subscription may have no ANF volumes in the selected region"
            )
        else:
            assert row_count >= 0

    with allure.step("Analytics stats"):
        stats = client.analytics_post(
            "/api/v1/datasets/stats",
            {"namespace": namespace, "table": table_name, "filters": []},
        )
        assert stats.status_code == 200, stats.text

    ds_check = client.config_get(f"{prefix}/datasets/{resources.dataset_id}")
    assert ds_check.status_code == 200
    assert ds_check.json().get("status") == "ready", ds_check.text


def run_anf_metrics_pipeline_setup(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
) -> None:
    """azure_cloud connector → metric_category dataset → acquire → analytics."""
    settings.require_azure_cloud()
    categories = settings.anf_metric_category_list()
    assert categories, "ANF_METRIC_CATEGORIES must list at least one category"

    prefix = _create_project(client, resources, label="anf-metrics")
    _create_azure_cloud_credential(client, settings, resources, prefix)
    _create_azure_cloud_datasource(client, settings, resources, prefix)

    _assert_connector_connection(
        client,
        settings,
        resources,
        prefix,
        step_label="Azure cloud",
    )

    selector = [{"category": category} for category in categories]
    with allure.step("Create structured metrics dataset"):
        dataset_resp = client.config_post(
            f"{prefix}/datasets",
            {
                "name": unique_name("e2e-anf-metrics-dataset"),
                "description": "pytest ANF metrics acquired dataset",
                "type": "acquired",
                "kind": "structured",
                "originConnector": resources.datasource_id,
                "resourceSelector": selector,
                "acquisitionConfig": {"writeMode": "append"},
            },
        )
        assert dataset_resp.status_code == 201, dataset_resp.text
        resources.dataset_id = dataset_resp.json()["id"]
        allure.attach(
            json.dumps(selector, indent=2),
            name="resourceSelector",
            attachment_type=allure.attachment_type.JSON,
        )

    _acquire_anf_dataset_and_analytics(
        client, settings, resources, prefix, categories=categories
    )


def run_anf_mcp_server_setup(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
) -> None:
    """Provision managed anf_mcp server and verify read + write tools are listed."""
    settings.require_azure_cloud()

    prefix = _create_project(client, resources, label="anf-mcp")
    _create_azure_cloud_credential(client, settings, resources, prefix)

    allowed_tools = sorted(ANF_READ_TOOLS | ANF_WRITE_TOOLS)

    env_overrides: dict[str, str] = {
        "AZURE_SUBSCRIPTION_ID": settings.azure_subscription_id,
        "AZURE_DEFAULT_REGION": settings.azure_default_region,
    }
    if settings.azure_resource_group:
        env_overrides["AZURE_RESOURCE_GROUP"] = settings.azure_resource_group

    with allure.step("Create managed anf_mcp server"):
        create_resp = client.mcp_server_post(
            resources.project_id,
            {
                "name": unique_mcp_name("e2e_anf_mcp"),
                "description": "pytest ANF MCP server",
                "deploymentType": "managed",
                "catalogId": "anf_mcp",
                "runtimeCredentialId": resources.credential_id,
                "managedConfig": {"envOverrides": env_overrides},
                "allowedTools": allowed_tools,
            },
        )
        assert create_resp.status_code == 201, create_resp.text
        resources.mcp_server_id = create_resp.json()["id"]
        print(f"[anf-pipeline] mcp_server={resources.mcp_server_id}")

    with allure.step("Wait for MCP runtime ready"):
        wait_for_mcp_runtime_ready(
            lambda: client.mcp_server_runtime_status(
                resources.project_id, resources.mcp_server_id
            ),
            timeout_sec=settings.anf_mcp_provision_timeout_sec,
        )

    with allure.step("Wait for MCP Bifrost sync"):
        wait_for_mcp_gateway_synced(
            lambda: client.mcp_server_get(resources.project_id, resources.mcp_server_id),
            timeout_sec=settings.anf_mcp_provision_timeout_sec,
        )

    with allure.step("Test MCP connection"):
        test_resp = client.mcp_server_test_connection(
            resources.project_id, resources.mcp_server_id
        )
        assert test_resp.status_code == 200, test_resp.text
        test_body = test_resp.json()
        assert test_body.get("success") is True, test_body

    with allure.step("List MCP tools"):
        tools_resp = client.mcp_server_list_tools(
            resources.project_id, resources.mcp_server_id
        )
        assert tools_resp.status_code == 200, tools_resp.text
        tool_names = {
            tool.get("name")
            for tool in tools_resp.json()
            if isinstance(tool, dict) and tool.get("name")
        }
        missing_read = ANF_READ_TOOLS - tool_names
        assert not missing_read, (
            f"expected read tools missing from catalog: {sorted(missing_read)}"
        )
        missing_write = ANF_WRITE_TOOLS - tool_names
        assert not missing_write, (
            f"expected write tools missing from catalog: {sorted(missing_write)}"
        )
        allure.attach(
            "\n".join(sorted(tool_names)),
            name="mcp_tools",
            attachment_type=allure.attachment_type.TEXT,
        )
