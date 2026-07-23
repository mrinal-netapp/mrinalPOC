"""Dataset acquire / import polling for data-management integration tests."""

from __future__ import annotations

import allure
import pytest

from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings
from lib.data_management.analytics_validation import AnalyticsKind, validate_dataset_analytics
from lib.utils.cleanup import PipelineResources
from lib.utils.waits import wait_for_dataset_ready


def acquire_until_ready(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    prefix: str,
    *,
    run_analytics: bool = True,
    analytics_kind: AnalyticsKind = "basic",
    metrics_provider: str | None = None,
    categories: list[str] | None = None,
    min_preview_rows: int = 1,
) -> tuple[str | None, str | None]:
    """Trigger acquisition workflow and poll until dataset status is ready."""
    if settings.skip_acquisition:
        pytest.skip("SKIP_ACQUISITION=1")

    namespace: str | None = None
    table_name: str | None = None

    with allure.step("Start dataset acquisition workflow"):
        acquire = client.acquire_dataset(resources.project_id, resources.dataset_id)
        assert acquire.status_code in (200, 202), acquire.text
        print(f"[data_mgmt] acquisition workflow={acquire.json().get('workflowId')}")

    with allure.step("Wait for dataset ready"):
        dataset_body = wait_for_dataset_ready(
            lambda: client.get_dataset(prefix, resources.dataset_id),
            timeout_sec=settings.acquisition_timeout_sec,
            poll_interval_sec=settings.acquisition_poll_interval_sec,
        )
        namespace = dataset_body.get("namespace")
        table_name = dataset_body.get("catalogTableName")
        print(
            f"[data_mgmt] dataset ready namespace={namespace} table={table_name} "
            f"catalogTableRef={dataset_body.get('catalogTableRef')}"
        )

    if run_analytics and not settings.skip_analytics:
        assert namespace and table_name, (
            "dataset missing namespace/catalogTableName — cannot run analytics"
        )
        validate_dataset_analytics(
            client,
            settings,
            namespace,
            table_name,
            kind=analytics_kind,
            metrics_provider=metrics_provider,
            categories=categories,
            min_rows=min_preview_rows,
        )

    ds_check = client.get_dataset(prefix, resources.dataset_id)
    assert ds_check.status_code == 200
    assert ds_check.json().get("status") == "ready", ds_check.text
    return namespace, table_name


def import_until_ready(
    client: PlatformClient,
    settings: IntegrationSettings,
    resources: PipelineResources,
    prefix: str,
) -> None:
    """Trigger manual dataset import workflow and poll until ready."""
    with allure.step("Start dataset import workflow"):
        resp = client.import_dataset(resources.project_id, resources.dataset_id)
        assert resp.status_code in (200, 202), resp.text
        print(f"[data_mgmt] import workflow={resp.json().get('workflowId')}")

    wait_for_dataset_ready(
        lambda: client.get_dataset(prefix, resources.dataset_id),
        timeout_sec=settings.acquisition_timeout_sec,
        poll_interval_sec=settings.acquisition_poll_interval_sec,
    )
    ds_check = client.get_dataset(prefix, resources.dataset_id)
    assert ds_check.status_code == 200
    assert ds_check.json().get("status") == "ready", ds_check.text
