"""
KB create-config coverage: chunking strategies and vector-index (quantization)
types, on the shared session dataset.

- Chunking strategies (recursive/token/markdown) build to `ready` (with the
  default `auto` quantization no index forms on the small corpus) and the
  strategy is asserted persisted.
- Vector-index quantization (ivf_pq/scalar/ivf_rq) is validated at the config
  level: the create is accepted (201) and the quantizationType/quantizationOptions
  persist. A real IVF index needs a much larger corpus to train (PQ codebooks etc.),
  so per the agreed scope we assert config acceptance/persistence and do not wait
  for the build (which is deleted immediately).

Gated on S3_* via the shared `s3_ready_dataset` fixture (skips otherwise).
"""

from __future__ import annotations

import allure
import pytest

from lib.common.settings import IntegrationSettings
from lib.knowledge_base.kb_helpers import build_kb, create_kb

pytestmark = [
    pytest.mark.kb,
    allure.feature("Knowledge base config matrix"),
]


@pytest.mark.parametrize("chunk_strategy", ["recursive", "token", "markdown"])
@allure.title("Chunking strategy: {chunk_strategy} builds ready + persists")
def test_chunk_strategy(
    s3_ready_dataset, integration_settings: IntegrationSettings, chunk_strategy: str
) -> None:
    ctx = s3_ready_dataset
    kb_id = build_kb(
        ctx.client, integration_settings, ctx.prefix, ctx.dataset_id, chunkStrategy=chunk_strategy
    )
    try:
        got = ctx.client.config_get(f"{ctx.prefix}/knowledgebases/{kb_id}").json()
        assert got.get("chunkStrategy") == chunk_strategy, got
        assert got.get("status") == "ready", got
    finally:
        ctx.client.config_delete(f"{ctx.prefix}/knowledgebases/{kb_id}")


# Small quantizationOptions per type so config-service accepts them; a real index
# still needs a larger corpus than the shared seed, so we only assert the config
# path (accepted + persisted), not the async build outcome.
QUANTIZATION_CASES = [
    ("ivf_pq", {"numPartitions": 1, "numSubVectors": 4}),
    ("scalar", {"numPartitions": 1, "efConstruction": 64}),
    ("ivf_rq", {"numPartitions": 1, "numBits": 1}),
]


@pytest.mark.parametrize("quantization_type,quant_opts", QUANTIZATION_CASES)
@allure.title("Vector index: {quantization_type} config accepted + persisted")
def test_vector_index_quantization(
    s3_ready_dataset,
    integration_settings: IntegrationSettings,
    quantization_type: str,
    quant_opts: dict,
) -> None:
    ctx = s3_ready_dataset
    kb_id, created = create_kb(
        ctx.client,
        integration_settings,
        ctx.prefix,
        ctx.dataset_id,
        chunkSize=32,  # more chunks from the small seed doc
        quantizationType=quantization_type,
        quantizationOptions=quant_opts,
    )
    try:
        assert created.get("quantizationType") == quantization_type, created
        got = ctx.client.config_get(f"{ctx.prefix}/knowledgebases/{kb_id}").json()
        assert got.get("quantizationType") == quantization_type, got
        assert got.get("quantizationOptions") == quant_opts, got
    finally:
        # Delete now (terminates the in-progress build); we don't wait for ready
        # because IVF index training needs a larger corpus than the shared seed.
        ctx.client.config_delete(f"{ctx.prefix}/knowledgebases/{kb_id}")


@allure.title("Index type (indexingMode) persists on the shared KB + metadata reflects it")
def test_indexing_mode_persisted(
    s3_ready_kb: str, s3_ready_dataset, integration_settings: IntegrationSettings
) -> None:
    ctx = s3_ready_dataset
    got = ctx.client.config_get(f"{ctx.prefix}/knowledgebases/{s3_ready_kb}").json()
    assert got.get("indexingMode") == "hybrid", got
    meta = ctx.client.kb_get(
        f"api/v1/projects/{ctx.project_id}/knowledgebases/{s3_ready_kb}/metadata"
    )
    assert meta.status_code == 200, meta.text
