"""
KB detail-page API coverage — the calls the agent-studio-ui KB detail page makes:
GET KB (Overview/Activity/Sync tabs read facets/stats/status embedded here), the
assigned-dataset GET (Dataset tab), edit via the project-scoped PUT (Edit sync
settings), and the config-service detail endpoints (facets/dependents/history).

Runs against the shared ready KB/dataset (gated on S3_*).
"""

from __future__ import annotations

import allure
import pytest

pytestmark = [
    pytest.mark.kb,
    allure.feature("Knowledge base detail page"),
]


@allure.title("Detail GET exposes facets/stats/status/sync config the tabs render")
def test_kb_detail_get(s3_ready_kb: str, s3_ready_dataset) -> None:
    ctx = s3_ready_dataset
    resp = ctx.client.config_get(f"{ctx.prefix}/knowledgebases/{s3_ready_kb}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body.get("status") == "ready", body
    assert "facets" in body, body                 # Activity tab
    assert "stats" in body, body                  # Overview metrics
    assert "synchronizationConfig" in body, body  # Sync tab
    assert body.get("sourceDataset"), body        # Dataset linkage


@allure.title("Dataset tab: assigned dataset is fetchable")
def test_kb_dataset_linkage(s3_ready_kb: str, s3_ready_dataset) -> None:
    ctx = s3_ready_dataset
    kb = ctx.client.config_get(f"{ctx.prefix}/knowledgebases/{s3_ready_kb}").json()
    dataset_id = kb["sourceDataset"]
    ds = ctx.client.config_get(f"{ctx.prefix}/datasets/{dataset_id}")
    assert ds.status_code == 200, ds.text
    assert ds.json().get("id") == dataset_id, ds.text


@allure.title("Edit sync settings via PUT (no re-index) persists")
def test_kb_edit_sync_settings(s3_ready_kb: str, s3_ready_dataset) -> None:
    ctx = s3_ready_dataset
    sync_config = {
        "sync_mode": "scheduled",
        "schedule_type": "daily",
        "time_of_day": "02:00",
        "data_change_threshold_enabled": False,
    }
    put = ctx.client.config_put(
        f"{ctx.prefix}/knowledgebases/{s3_ready_kb}",
        {"description": "edited via detail page", "synchronizationConfig": sync_config},
    )
    assert put.status_code == 200, put.text
    got = ctx.client.config_get(f"{ctx.prefix}/knowledgebases/{s3_ready_kb}").json()
    assert got.get("description") == "edited via detail page", got
    assert (got.get("synchronizationConfig") or {}).get("sync_mode") == "scheduled", got


@allure.title("Detail endpoints: facets, dependents, history")
def test_kb_detail_endpoints(s3_ready_kb: str, s3_ready_dataset) -> None:
    ctx = s3_ready_dataset
    facets = ctx.client.config_get(f"{ctx.prefix}/knowledgebases/{s3_ready_kb}/facets")
    assert facets.status_code == 200, facets.text
    deps = ctx.client.config_get(f"{ctx.prefix}/knowledgebases/{s3_ready_kb}/dependents")
    assert deps.status_code == 200, deps.text
    hist = ctx.client.config_get(f"{ctx.prefix}/knowledgebases/{s3_ready_kb}/history")
    # History may be empty (404) for a KB that hasn't versioned yet.
    assert hist.status_code in (200, 404), hist.text
