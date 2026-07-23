"""
Knowledge Base happy path — mirrors the agent-studio-ui KB create form
(source dataset + embedding model + chunk/vector config) -> create -> wait
ready -> list/get/facets -> search.

KB needs a READY source dataset, built via the proven
lib/knowledge_base/pipeline_setup helper (S3_* configured), then asserts
list/get. Uses a built-in TEI embedding model, so the KB also proves a
platform-hosted model is usable end to end. Skips when its config is absent.
"""

from __future__ import annotations

import allure
import pytest

from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings
from lib.knowledge_base.pipeline_setup import run_s3compatible_kb_pipeline_setup
from lib.utils.cleanup import PipelineResources

pytestmark = [
    pytest.mark.kb,
    allure.feature("Knowledge base happy path"),
]


def _assert_kb_listed_and_fetchable(
    platform_client: PlatformClient, prefix: str, kb_id: str
) -> dict:
    with allure.step("List knowledge bases includes the created KB"):
        list_resp = platform_client.config_get(f"{prefix}/knowledgebases")
        assert list_resp.status_code == 200, list_resp.text
        kbs = list_resp.json()
        assert isinstance(kbs, list), kbs
        assert any(kb.get("id") == kb_id for kb in kbs), (
            f"KB {kb_id} not in list: {[kb.get('id') for kb in kbs]}"
        )

    with allure.step("Get knowledge base by id (with facets)"):
        get_resp = platform_client.config_get(f"{prefix}/knowledgebases/{kb_id}")
        assert get_resp.status_code == 200, get_resp.text
        detail = get_resp.json()
        assert detail.get("id") == kb_id, detail
        assert "facets" in detail, detail
        return detail


@allure.title("KB (S3 pipeline): connector -> dataset -> KB -> list/get/search")
def test_kb_happy_path_s3(
    e2e_resources: PipelineResources,
    platform_client: PlatformClient,
    integration_settings: IntegrationSettings,
) -> None:
    if not integration_settings.has_s3compatible():
        pytest.skip(
            "KB S3 happy path skipped — set S3_ENDPOINT/S3_BUCKET/AWS_ACCESS_KEY_ID/"
            "AWS_SECRET_ACCESS_KEY in .env.local (or use the KB_SOURCE_DATASET_ID variant)"
        )

    # Full pipeline: project -> credential -> connector -> dataset (ready) ->
    # KB (built-in embedding model) -> search. Sets e2e_resources ids; teardown
    # deletes KB + dataset + connector + credential + project.
    run_s3compatible_kb_pipeline_setup(platform_client, integration_settings, e2e_resources)

    assert e2e_resources.knowledge_base_id, "pipeline did not create a KB"
    prefix = platform_client.project_prefix(e2e_resources.project_id)
    detail = _assert_kb_listed_and_fetchable(
        platform_client, prefix, e2e_resources.knowledge_base_id
    )
    assert detail.get("status") == "ready", detail
