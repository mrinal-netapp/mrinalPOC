"""Unit tests for processing/embedder.py.

After the unified-embedding port (Phase 4), the embedder calls Bifrost over
HTTP instead of running SentenceTransformer in-process. These tests use
`unittest.mock.patch` on `processing.embedder._post_embeddings` (or the
requests Session) to verify the streaming/batch/record-batch behavior
without touching the network.
"""

from pathlib import Path
import sys
from unittest.mock import MagicMock, patch

import pytest
import requests

np = pytest.importorskip("numpy")
pa = pytest.importorskip("pyarrow")

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

# processing/__init__.py pulls lancedb_writer; avoid heavy deps in unit tests.
sys.modules.setdefault("lancedb", MagicMock())

from processing.chunker import Chunk
from processing.embedder import EmbeddingGenerator


def _sample_chunks(n: int = 3) -> list[Chunk]:
    # NB: `Chunk` is a dataclass with a `metadata: Dict[str, Any]` field;
    # `metadata_json` is a read-only @property derived from `metadata`. Pass
    # the dict, not the serialized form, or the constructor raises
    # TypeError("got an unexpected keyword argument 'metadata_json'").
    return [
        Chunk(
            chunk_id=f"doc-1_{i}",
            document_id="doc-1",
            chunk_index=i,
            text=f"chunk text {i}",
            source="doc-1.txt",
            metadata={},
        )
        for i in range(n)
    ]


def _make_embedder(dim: int = 4, batch_size: int = 2) -> EmbeddingGenerator:
    """Build an embedder with a stubbed HTTP layer."""
    return EmbeddingGenerator(
        model_name="test-model",
        proxy_url="http://stubbed-bifrost:8080",
        api_key="stub-vk-token",
        dim=dim,
        batch_size=batch_size,
    )


def test_constructor_validates_required_args():
    with pytest.raises(ValueError, match="model_name"):
        EmbeddingGenerator(model_name="", proxy_url="x", api_key="x", dim=4)
    with pytest.raises(ValueError, match="proxy_url"):
        EmbeddingGenerator(model_name="m", proxy_url="", api_key="x", dim=4)
    with pytest.raises(ValueError, match="api_key"):
        EmbeddingGenerator(model_name="m", proxy_url="x", api_key="", dim=4)
    with pytest.raises(ValueError, match="dim"):
        EmbeddingGenerator(model_name="m", proxy_url="x", api_key="x", dim=0)


def test_get_schema_shape():
    schema = EmbeddingGenerator.get_schema(384)
    names = schema.names
    assert names == [
        "id",
        "document_id",
        "source",
        "text",
        "chunk_index",
        "vector",
        "metadata",
    ]


def test_stream_yields_record_batches_via_stubbed_post():
    """`_post_embeddings` is the only network surface; stub it to return
    deterministic vectors and verify the RecordBatch shape."""
    emb = _make_embedder(dim=4, batch_size=2)

    def fake_post(self, inputs):
        # One row per input, all zeros — easy to assert on shape.
        return np.zeros((len(inputs), 4), dtype=np.float32)

    with patch.object(EmbeddingGenerator, "_post_embeddings", new=fake_post):
        chunks = _sample_chunks(3)
        batches = list(emb.stream_record_batches(chunks))

    # 3 chunks at batch_size=2 → 2 batches (2 + 1).
    assert len(batches) == 2
    assert sum(b.num_rows for b in batches) == 3
    for b in batches:
        # vector column is a FixedSizeList<float32, 4>
        v = b.column("vector")
        assert v.type.equals(pa.list_(pa.float32(), 4))


def test_embedding_dimension_property():
    emb = _make_embedder(dim=768)
    assert emb.embedding_dimension == 768


def test_stream_raises_on_empty_chunks():
    emb = _make_embedder()
    with pytest.raises(ValueError, match="No chunks"):
        list(emb.stream_record_batches([]))


class TestFmtDuration:
    def test_seconds_only(self):
        assert EmbeddingGenerator._fmt_duration(12.3) == "12.3s"

    def test_minutes_and_seconds(self):
        assert EmbeddingGenerator._fmt_duration(125) == "2m 5s"

    def test_hours_and_minutes(self):
        assert EmbeddingGenerator._fmt_duration(3725) == "1h 2m"


def _resp(status_code, json_body=None, text=""):
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = json_body or {}
    resp.text = text
    return resp


class TestPostEmbeddings:
    def test_success_on_first_attempt(self):
        emb = _make_embedder(dim=2, batch_size=2)
        payload = {"data": [
            {"embedding": [0.1, 0.2], "index": 0},
            {"embedding": [0.3, 0.4], "index": 1},
        ]}
        with patch.object(emb._session, "post", return_value=_resp(200, payload)) as mock_post:
            result = emb._post_embeddings(["a", "b"])
        mock_post.assert_called_once()
        assert result.shape == (2, 2)

    def test_retries_on_network_error_then_succeeds(self):
        emb = _make_embedder(dim=2, batch_size=2)
        payload = {"data": [{"embedding": [0.1, 0.2], "index": 0}]}
        with patch.object(
            emb._session, "post",
            side_effect=[requests.ConnectionError("down"), _resp(200, payload)],
        ), patch("time.sleep"):
            result = emb._post_embeddings(["a"])
        assert result.shape == (1, 2)

    def test_permanent_4xx_error_raises_immediately(self):
        emb = _make_embedder(dim=2, batch_size=2)
        with patch.object(emb._session, "post", return_value=_resp(400, text="bad request")):
            with pytest.raises(RuntimeError, match="HTTP 400"):
                emb._post_embeddings(["a"])

    def test_429_retries_then_raises_with_status_code_attr(self):
        emb = _make_embedder(dim=2, batch_size=2)
        with patch.object(emb._session, "post", return_value=_resp(429, text="throttled")), \
             patch("time.sleep"):
            with pytest.raises(RuntimeError) as excinfo:
                emb._post_embeddings(["a"])
        assert excinfo.value.status_code == 429

    def test_413_retries_then_raises_with_status_code_attr(self):
        emb = _make_embedder(dim=2, batch_size=2)
        with patch.object(emb._session, "post", return_value=_resp(413, text="too large")), \
             patch("time.sleep"):
            with pytest.raises(RuntimeError) as excinfo:
                emb._post_embeddings(["a"])
        assert excinfo.value.status_code == 413

    def test_5xx_retries_then_raises_with_status_code_attr(self):
        emb = _make_embedder(dim=2, batch_size=2)
        with patch.object(emb._session, "post", return_value=_resp(503, text="unavailable")), \
             patch("time.sleep"):
            with pytest.raises(RuntimeError) as excinfo:
                emb._post_embeddings(["a"])
        assert excinfo.value.status_code == 503

    def test_all_network_errors_raises_without_status_code(self):
        emb = _make_embedder(dim=2, batch_size=2)
        with patch.object(
            emb._session, "post", side_effect=requests.Timeout("timed out")
        ), patch("time.sleep"):
            with pytest.raises(RuntimeError) as excinfo:
                emb._post_embeddings(["a"])
        assert getattr(excinfo.value, "status_code", None) is None


class TestParseResponse:
    def test_shape_mismatch_raises(self):
        emb = _make_embedder(dim=2)
        with pytest.raises(RuntimeError, match="shape mismatch"):
            emb._parse_response({"data": [{"embedding": [0.1, 0.2], "index": 0}]}, expected_count=2)

    def test_non_list_data_raises(self):
        emb = _make_embedder(dim=2)
        with pytest.raises(RuntimeError, match="shape mismatch"):
            emb._parse_response({"data": "not-a-list"}, expected_count=1)

    def test_entry_wrong_dimension_raises(self):
        emb = _make_embedder(dim=4)
        with pytest.raises(RuntimeError, match="wrong shape"):
            emb._parse_response({"data": [{"embedding": [0.1, 0.2], "index": 0}]}, expected_count=1)

    def test_entry_non_list_embedding_raises(self):
        emb = _make_embedder(dim=4)
        with pytest.raises(RuntimeError, match="wrong shape"):
            emb._parse_response({"data": [{"embedding": "oops", "index": 0}]}, expected_count=1)

    def test_reorders_by_index(self):
        emb = _make_embedder(dim=1)
        payload = {"data": [
            {"embedding": [2.0], "index": 1},
            {"embedding": [1.0], "index": 0},
        ]}
        result = emb._parse_response(payload, expected_count=2)
        assert result.tolist() == [[1.0], [2.0]]


class TestStreamAdaptiveBehavior:
    def test_shrinks_batch_on_429_then_succeeds(self):
        emb = _make_embedder(dim=2, batch_size=4)
        calls = {"n": 0}

        def fake_post(self, inputs):
            calls["n"] += 1
            if calls["n"] == 1:
                err = RuntimeError("throttled")
                err.status_code = 429
                raise err
            return np.zeros((len(inputs), 2), dtype=np.float32)

        with patch.object(EmbeddingGenerator, "_post_embeddings", new=fake_post):
            chunks = _sample_chunks(4)
            batches = list(emb.stream_record_batches(chunks))

        assert sum(b.num_rows for b in batches) == 4
        assert calls["n"] > 1

    def test_non_shrinkable_error_propagates(self):
        emb = _make_embedder(dim=2, batch_size=4)

        def fake_post(self, inputs):
            err = RuntimeError("permanent failure")
            err.status_code = 400
            raise err

        with patch.object(EmbeddingGenerator, "_post_embeddings", new=fake_post):
            with pytest.raises(RuntimeError, match="permanent failure"):
                list(emb.stream_record_batches(_sample_chunks(2)))

    def test_grows_batch_back_after_consecutive_successes(self):
        # self.batch_size stays 8 (the configured ceiling to grow back toward);
        # the first call is throttled to shrink current_batch_size to 4, then
        # every subsequent call succeeds. After 4 consecutive successful
        # batches of size 4, the loop should double current_batch_size back to 8.
        emb = _make_embedder(dim=2, batch_size=8)
        calls = {"n": 0}

        def fake_post(self, inputs):
            calls["n"] += 1
            if calls["n"] == 1:
                err = RuntimeError("throttled")
                err.status_code = 429
                raise err
            return np.zeros((len(inputs), 2), dtype=np.float32)

        with patch.object(EmbeddingGenerator, "_post_embeddings", new=fake_post):
            chunks = _sample_chunks(40)
            batches = list(emb.stream_record_batches(chunks))
        assert sum(b.num_rows for b in batches) == 40
        # Last batch(es) should be back at the full configured batch_size (8)
        # once growth kicks back in.
        assert any(b.num_rows == 8 for b in batches)

    def test_progress_callback_invoked(self):
        emb = _make_embedder(dim=2, batch_size=1)

        def fake_post(self, inputs):
            return np.zeros((len(inputs), 2), dtype=np.float32)

        progress_calls = []

        def on_progress(completed, total):
            progress_calls.append((completed, total))

        with patch.object(EmbeddingGenerator, "_post_embeddings", new=fake_post):
            chunks = _sample_chunks(3)
            list(emb.stream_record_batches(chunks, progress_callback=on_progress))

        assert progress_calls
        assert progress_calls[-1] == (3, 3)
