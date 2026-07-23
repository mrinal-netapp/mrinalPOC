"""Manual unstructured dataset upload → import → ready."""

from __future__ import annotations

import allure
import pytest

from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings
from lib.data_management.dataset_lifecycle import run_manual_unstructured_upload
from lib.utils.cleanup import PipelineResources

pytestmark = [
    pytest.mark.data_management,
    pytest.mark.dataset,
    pytest.mark.manual_upload,
    pytest.mark.unstructured,
    allure.feature("Manual unstructured dataset upload"),
]


@allure.title("Manual upload: create → S3 PUT → register → ready (project prerequisite)")
def test_manual_unstructured_dataset_upload(
    dm_project_prereq: str,
    e2e_resources: PipelineResources,
    platform_client: PlatformClient,
    integration_settings: IntegrationSettings,
) -> None:
    run_manual_unstructured_upload(
        platform_client, integration_settings, e2e_resources, dm_project_prereq
    )
    assert e2e_resources.project_id
    assert e2e_resources.dataset_id
    ds = platform_client.get_dataset(dm_project_prereq, e2e_resources.dataset_id)
    assert ds.status_code == 200, ds.text
    assert ds.json().get("type") == "manual"
    assert ds.json().get("kind") == "unstructured"
    assert ds.json().get("status") == "ready"
