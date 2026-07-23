"""
KB playground / retrieval with different configs (pure retrieval — the playground
is not a RAG chat). Exercises the single-KB search the playground calls plus the
retrieval params the API supports, and the multi-KB search endpoint.

Runs against the shared ready KB/dataset (gated on S3_*).
"""

from __future__ import annotations

import allure
import pytest

from lib.knowledge_base.kb_helpers import build_kb, search_kb, search_multi_kb

pytestmark = [
    pytest.mark.kb,
    allure.feature("Knowledge base retrieval / playground"),
]


@pytest.mark.parametrize("search_mode", ["vector", "fts", "hybrid"])
@allure.title("Playground search mode: {search_mode}")
def test_playground_search_modes(
    s3_ready_kb: str, s3_ready_dataset, search_mode: str
) -> None:
    ctx = s3_ready_dataset
    # Exact playground body: query + topK + searchMode.
    resp = search_kb(
        ctx.client, ctx.project_id, s3_ready_kb,
        query=ctx.search_marker, topK=10, searchMode=search_mode,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body.get("results") or []), f"{search_mode}: expected >=1 hit: {resp.text[:300]}"
    # The service echoes the resolved mode (vector|fts|hybrid).
    assert body.get("searchMode") in ("vector", "fts", "hybrid"), body


@allure.title("Retrieval: topK bounds + minScore filtering")
def test_topk_and_min_score(s3_ready_kb: str, s3_ready_dataset) -> None:
    ctx = s3_ready_dataset
    q = ctx.search_marker

    with allure.step("topK=1 -> at most 1 result"):
        r = search_kb(ctx.client, ctx.project_id, s3_ready_kb, query=q, topK=1, searchMode="hybrid")
        assert r.status_code == 200, r.text
        assert len(r.json().get("results") or []) <= 1

    with allure.step("minScore above 1.0 filters everything -> 0 results"):
        r = search_kb(
            ctx.client, ctx.project_id, s3_ready_kb,
            query=q, topK=10, minScore=2.0, searchMode="hybrid",
        )
        assert r.status_code == 200, r.text
        assert (r.json().get("results") or []) == []

    with allure.step("invalid params -> 400"):
        for bad in ({"query": q, "topK": 0}, {"query": q, "topK": 200}, {"query": "", "topK": 5}):
            rb = search_kb(ctx.client, ctx.project_id, s3_ready_kb, **bad)
            assert rb.status_code == 400, f"{bad}: {rb.status_code} {rb.text}"


@pytest.mark.parametrize("distance_metric", ["cosine", "l2", "dot"])
@allure.title("Retrieval distanceMetric: {distance_metric}")
def test_distance_metric(s3_ready_kb: str, s3_ready_dataset, distance_metric: str) -> None:
    ctx = s3_ready_dataset
    resp = search_kb(
        ctx.client, ctx.project_id, s3_ready_kb,
        query=ctx.search_marker, topK=10, searchMode="vector", distanceMetric=distance_metric,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "distanceMetric" in body, body
    if distance_metric == "cosine":
        assert (body.get("results") or []), body


@allure.title("Multi-KB search: merge + per_kb, and input validation")
def test_multi_kb_search(s3_ready_kb: str, s3_ready_dataset, integration_settings) -> None:
    ctx = s3_ready_dataset
    kb2 = build_kb(ctx.client, integration_settings, ctx.prefix, ctx.dataset_id, indexingMode="hybrid")
    try:
        with allure.step("merge aggregation across two KBs"):
            r = search_multi_kb(
                ctx.client, ctx.project_id,
                query=ctx.search_marker, knowledgeBaseIds=[s3_ready_kb, kb2],
                topK=5, aggregationStrategy="merge",
            )
            assert r.status_code == 200, r.text
            assert "results" in r.json(), r.text

        with allure.step("per_kb aggregation"):
            r = search_multi_kb(
                ctx.client, ctx.project_id,
                query=ctx.search_marker, knowledgeBaseIds=[s3_ready_kb, kb2],
                topK=5, aggregationStrategy="per_kb",
            )
            assert r.status_code == 200, r.text
            assert "results" in r.json(), r.text

        with allure.step("validation: empty knowledgeBaseIds and >10 -> 400"):
            r_empty = search_multi_kb(
                ctx.client, ctx.project_id, query=ctx.search_marker, knowledgeBaseIds=[]
            )
            assert r_empty.status_code == 400, r_empty.text
            r_many = search_multi_kb(
                ctx.client, ctx.project_id,
                query=ctx.search_marker, knowledgeBaseIds=[s3_ready_kb] * 11,
            )
            assert r_many.status_code == 400, r_many.text
    finally:
        ctx.client.config_delete(f"{ctx.prefix}/knowledgebases/{kb2}")
