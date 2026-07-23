"""Small reusable KB helpers for the config/detail/playground test modules."""

from __future__ import annotations

from typing import Any

import httpx

from lib.common.platform_client import PlatformClient, unique_name
from lib.common.settings import IntegrationSettings
from lib.utils.waits import wait_for_kb_ready


def kb_body(settings: IntegrationSettings, dataset_id: str, **overrides: Any) -> dict:
    """Default KB create body (built-in embedding model, hybrid), with overrides."""
    body = {
        "name": unique_name("e2e-kb"),
        "description": "pytest kb config/detail/playground",
        "sourceDataset": dataset_id,
        "embeddingModel": settings.kb_embedding_model,
        "chunkSize": settings.kb_chunk_size,
        "vectorSize": settings.kb_vector_size,
        "chunkStrategy": "fixed",
        "chunkOverlap": 50,
        "indexingMode": "hybrid",
    }
    body.update(overrides)
    return body


def create_kb(
    client: PlatformClient, settings: IntegrationSettings, prefix: str, dataset_id: str, **overrides: Any
) -> tuple[str, dict]:
    """POST a KB (201, no warning). Returns (kb_id, created_body). Does NOT wait for ready."""
    resp = client.config_post(f"{prefix}/knowledgebases", kb_body(settings, dataset_id, **overrides))
    assert resp.status_code == 201, resp.text
    created = resp.json()
    assert not created.get("warning"), created.get("warning")
    return created["id"], created


def build_kb(
    client: PlatformClient, settings: IntegrationSettings, prefix: str, dataset_id: str, **overrides: Any
) -> str:
    """Create a KB and wait until it is ready. Returns the KB id."""
    kb_id, _ = create_kb(client, settings, prefix, dataset_id, **overrides)
    wait_for_kb_ready(
        lambda: client.config_get(f"{prefix}/knowledgebases/{kb_id}"),
        timeout_sec=settings.kb_timeout_sec,
        poll_interval_sec=settings.kb_poll_interval_sec,
    )
    return kb_id


def search_kb(
    client: PlatformClient, project_id: str, kb_id: str, **body: Any
) -> httpx.Response:
    """Single-KB retrieval (the playground call). Body kwargs: query, topK, minScore, searchMode, distanceMetric."""
    return client.kb_post(
        f"api/v1/projects/{project_id}/knowledgebases/{kb_id}/search", body
    )


def search_multi_kb(
    client: PlatformClient, project_id: str, **body: Any
) -> httpx.Response:
    """Multi-KB retrieval. Body kwargs: query, knowledgeBaseIds, topK, aggregationStrategy, searchMode."""
    return client.kb_post(
        f"api/v1/projects/{project_id}/knowledgebases/search", body
    )
