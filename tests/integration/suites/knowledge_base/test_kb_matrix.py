"""
KB matrix: create-config variations, edit/reprocess/delete, retrieval modes, and
a second (manual-upload) data source — reusing one ready dataset where possible.

Config/retrieval matrix + edit/reprocess are gated on S3_* (they need a ready
dataset); the create-validation cases are deterministic (project only). The
manual-dataset path is best-effort and skips if presigned upload isn't reachable.
"""

from __future__ import annotations

import os

import allure
import pytest

from lib.common.platform_client import PlatformClient, unique_name
from lib.common.settings import IntegrationSettings
from lib.knowledge_base.manual_dataset import ManualDatasetUnavailable, setup_manual_dataset
from lib.knowledge_base.pipeline_setup import setup_s3compatible_ready_dataset
from lib.utils.cleanup import PipelineResources
from lib.utils.waits import wait_for_kb_ready, wait_for_project_ready

pytestmark = [
    pytest.mark.kb,
    allure.feature("Knowledge base matrix"),
]


def _project_ready_timeout() -> int:
    return int(os.environ.get("PROJECT_READY_TIMEOUT_SEC") or "300")


def _kb_body(settings: IntegrationSettings, **overrides) -> dict:
    body = {
        "name": unique_name("e2e-kb"),
        "description": "pytest kb matrix",
        "embeddingModel": settings.kb_embedding_model,
        "chunkSize": settings.kb_chunk_size,
        "vectorSize": settings.kb_vector_size,
        "chunkStrategy": "fixed",
        "chunkOverlap": 50,
        "indexingMode": "hybrid",
    }
    body.update(overrides)
    return body


def _build_kb(
    client: PlatformClient, settings: IntegrationSettings, prefix: str, dataset_id: str, **overrides
) -> str:
    body = _kb_body(settings, sourceDataset=dataset_id, **overrides)
    resp = client.config_post(f"{prefix}/knowledgebases", body)
    assert resp.status_code == 201, resp.text
    created = resp.json()
    assert not created.get("warning"), created.get("warning")
    kb_id = created["id"]
    wait_for_kb_ready(
        lambda: client.config_get(f"{prefix}/knowledgebases/{kb_id}"),
        timeout_sec=settings.kb_timeout_sec,
        poll_interval_sec=settings.kb_poll_interval_sec,
    )
    return kb_id


def _search(client: PlatformClient, project_id: str, kb_id: str, query: str, search_mode: str):
    return client.kb_post(
        f"api/v1/projects/{project_id}/knowledgebases/{kb_id}/search",
        {"query": query, "topK": 5, "minScore": 0.0, "searchMode": search_mode},
    )


@allure.title("KB create validation: missing fields, bad enums, unknown embedding model -> 400")
def test_kb_create_validation(
    created_project: PipelineResources, platform_client: PlatformClient
) -> None:
    prefix = platform_client.project_prefix(created_project.project_id)
    base = {
        "name": unique_name("kb"),
        "sourceDataset": "dummy-dataset-id",
        "embeddingModel": "sentence-transformers/all-MiniLM-L6-v2",
        "chunkSize": 512,
        "vectorSize": 384,
    }
    cases = [
        ("missing chunkSize+vectorSize", {k: v for k, v in base.items() if k not in ("chunkSize", "vectorSize")}),
        ("missing embedding", {k: v for k, v in base.items() if k != "embeddingModel"}),
        ("bad chunkStrategy", {**base, "chunkStrategy": "banana"}),
        ("bad indexingMode", {**base, "indexingMode": "quantum"}),
        ("bad quantizationType", {**base, "quantizationType": "zip"}),
    ]
    for label, body in cases:
        resp = platform_client.config_post(f"{prefix}/knowledgebases", body)
        assert resp.status_code == 400, f"{label}: {resp.status_code} {resp.text}"

    with allure.step("Unknown embedding model -> 400 EMBEDDING_MODEL_NOT_FOUND"):
        resp = platform_client.config_post(
            f"{prefix}/knowledgebases", {**base, "embeddingModel": "no-such-embedding-model-xyz"}
        )
        assert resp.status_code == 400, resp.text
        assert resp.json().get("code") == "EMBEDDING_MODEL_NOT_FOUND", resp.text


@allure.title("KB matrix (S3): indexingMode + config variants, retrieval, edit, reprocess, delete")
def test_kb_config_retrieval_edit_reprocess(
    e2e_resources: PipelineResources,
    platform_client: PlatformClient,
    integration_settings: IntegrationSettings,
) -> None:
    settings = integration_settings
    if not settings.has_s3compatible():
        pytest.skip("KB matrix needs a ready dataset — set S3_* in .env.local")

    with allure.step("Set up one ready S3 dataset (reused by all KBs)"):
        prefix, search_marker = setup_s3compatible_ready_dataset(
            platform_client, settings, e2e_resources
        )
        dataset_id = e2e_resources.dataset_id
        project_id = e2e_resources.project_id
    # Use the marker the setup actually seeded / the configured search query,
    # instead of a hard-coded phrase, so retrieval doesn't depend on
    # INTEGRATION_SEED_S3 or the seed document's exact wording.
    query = search_marker

    # indexingMode x searchMode retrieval matrix.
    for indexing_mode, search_mode in (("fts", "fts"), ("semantic", "vector"), ("hybrid", "hybrid")):
        with allure.step(f"indexingMode={indexing_mode} -> build, search({search_mode}), delete"):
            kb_id = _build_kb(
                platform_client, settings, prefix, dataset_id, indexingMode=indexing_mode
            )
            search = _search(platform_client, project_id, kb_id, query, search_mode)
            assert search.status_code == 200, search.text
            assert (search.json().get("results") or []), (
                f"{indexing_mode}: expected >=1 hit: {search.text[:300]}"
            )
            assert platform_client.config_delete(
                f"{prefix}/knowledgebases/{kb_id}"
            ).status_code in (200, 202, 204)

    # Config variants (build-only).
    for label, overrides in (
        ("chunkStrategy=sentence", {"chunkStrategy": "sentence"}),
        ("quantizationType=none", {"quantizationType": "none"}),
    ):
        with allure.step(f"config variant: {label} -> build ready, delete"):
            kb_id = _build_kb(platform_client, settings, prefix, dataset_id, **overrides)
            assert platform_client.config_delete(
                f"{prefix}/knowledgebases/{kb_id}"
            ).status_code in (200, 202, 204)

    # Edit + retrieval validation + reprocess + delete on one KB.
    kb_id = _build_kb(platform_client, settings, prefix, dataset_id, indexingMode="hybrid")
    e2e_resources.knowledge_base_id = kb_id  # ensure cleanup deletes KB before dataset

    with allure.step("Edit KB (name/description/labels) -> 200; GET reflects (no re-index)"):
        new_name = unique_name("kb-edited")
        put = platform_client.config_put(
            f"{prefix}/knowledgebases/{kb_id}",
            {"name": new_name, "description": "edited", "labels": ["e2e", "edited"]},
        )
        assert put.status_code == 200, put.text
        got = platform_client.config_get(f"{prefix}/knowledgebases/{kb_id}").json()
        assert got.get("name") == new_name, got

    with allure.step("Retrieval param validation: topK out of 1..100 -> 400"):
        for bad_topk in (0, 200):
            r = platform_client.kb_post(
                f"api/v1/projects/{project_id}/knowledgebases/{kb_id}/search",
                {"query": query, "topK": bad_topk},
            )
            assert r.status_code == 400, f"topK={bad_topk}: {r.status_code} {r.text}"

    with allure.step("Metadata endpoint -> 200"):
        meta = platform_client.kb_get(
            f"api/v1/projects/{project_id}/knowledgebases/{kb_id}/metadata"
        )
        assert meta.status_code == 200, meta.text

    with allure.step("Reprocess (POST /:id/create) -> 202 -> ready"):
        rep = platform_client.config_post(f"{prefix}/knowledgebases/{kb_id}/create", {})
        assert rep.status_code == 202, rep.text
        assert rep.json().get("status") == "running", rep.text
        wait_for_kb_ready(
            lambda: platform_client.config_get(f"{prefix}/knowledgebases/{kb_id}"),
            timeout_sec=settings.kb_timeout_sec,
            poll_interval_sec=settings.kb_poll_interval_sec,
        )

    with allure.step("Delete KB -> 200"):
        deleted = platform_client.config_delete(f"{prefix}/knowledgebases/{kb_id}")
        assert deleted.status_code in (200, 202, 204), deleted.text
        e2e_resources.knowledge_base_id = None
    # dataset/connector/credential/project cleaned by e2e_resources finalizer.


@allure.title("KB on a manual (uploaded) dataset — no external connector")
def test_kb_manual_dataset(
    created_project: PipelineResources,
    platform_client: PlatformClient,
    integration_settings: IntegrationSettings,
) -> None:
    settings = integration_settings
    prefix = platform_client.project_prefix(created_project.project_id)
    with allure.step("Wait for project-init"):
        wait_for_project_ready(
            lambda: platform_client.config_get(f"{prefix}/models"),
            timeout_sec=_project_ready_timeout(),
        )

    marker = unique_name("E2EMANUAL").replace("-", "")
    with allure.step("Create manual dataset with an uploaded file"):
        try:
            dataset_id = setup_manual_dataset(
                platform_client, settings, created_project, marker=marker
            )
        except ManualDatasetUnavailable as exc:
            pytest.skip(f"manual dataset path not reachable from this runner: {exc}")

    with allure.step("Build KB on the manual dataset and search"):
        kb_id = _build_kb(platform_client, settings, prefix, dataset_id, indexingMode="hybrid")
        created_project.knowledge_base_id = kb_id
        search = _search(platform_client, created_project.project_id, kb_id, marker, "hybrid")
        assert search.status_code == 200, search.text
        assert (search.json().get("results") or []), search.text
