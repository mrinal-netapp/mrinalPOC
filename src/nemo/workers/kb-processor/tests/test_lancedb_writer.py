"""Unit tests for LanceDBWriter index branch selection (mocked table, no real LanceDB)."""

from pathlib import Path
import sys
from unittest.mock import MagicMock

import pytest

pytest.importorskip("pyarrow")

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

# LanceDBWriter imports lancedb at module load; stub for index unit tests.
sys.modules.setdefault("lancedb", MagicMock())

from processing.lancedb_writer import LanceDBWriter, AUTO_INDEX_MIN_ROWS


@pytest.fixture
def writer(tmp_path):
    return LanceDBWriter(kb_id="kb12345678", s3_path_prefix="projects/p1", temp_dir=tmp_path)


def test_create_vector_index_ivf_pq(writer):
    table = MagicMock()
    ok = writer._create_vector_index(
        table,
        "ivf_pq",
        {"numPartitions": 64, "numSubVectors": 48},
    )
    assert ok is True
    table.create_index.assert_called_once()
    kwargs = table.create_index.call_args.kwargs
    assert kwargs["num_partitions"] == 64
    assert kwargs["num_sub_vectors"] == 48


def test_create_vector_index_scalar_hnsw_sq(writer):
    table = MagicMock()
    ok = writer._create_vector_index(
        table,
        "scalar",
        {"numPartitions": 32, "efConstruction": 100, "m": 16},
    )
    assert ok is True
    kwargs = table.create_index.call_args.kwargs
    assert kwargs["index_type"] == "IVF_HNSW_SQ"
    assert kwargs["num_partitions"] == 32
    assert kwargs["ef_construction"] == 100
    assert kwargs["m"] == 16


def test_create_vector_index_ivf_rq(writer):
    table = MagicMock()
    ok = writer._create_vector_index(table, "ivf_rq", {"numBits": 2, "numPartitions": 16})
    assert ok is True
    kwargs = table.create_index.call_args.kwargs
    assert kwargs["index_type"] == "IVF_RQ"
    assert kwargs["num_bits"] == 2


def test_create_vector_index_none_type_skips(writer):
    table = MagicMock()
    ok = writer._create_vector_index(table, "none", {})
    assert ok is False
    table.create_index.assert_not_called()


def test_ensure_vector_index_none_never_indexes(writer):
    table = MagicMock()
    ok = writer._ensure_vector_index(table, 5000, "none", {}, "hybrid")
    assert ok is False
    table.create_index.assert_not_called()


def test_ensure_vector_index_auto_skips_below_threshold(writer):
    table = MagicMock()
    ok = writer._ensure_vector_index(
        table,
        AUTO_INDEX_MIN_ROWS - 1,
        "auto",
        {},
        "hybrid",
    )
    assert ok is False


def test_ensure_vector_index_auto_creates_scalar_at_threshold(writer):
    table = MagicMock()
    ok = writer._ensure_vector_index(
        table,
        AUTO_INDEX_MIN_ROWS,
        "auto",
        {},
        "semantic",
    )
    assert ok is True
    kwargs = table.create_index.call_args.kwargs
    assert kwargs["index_type"] == "IVF_HNSW_SQ"


def test_create_fts_index_called_for_hybrid_modes(writer):
    table = MagicMock()
    ok = writer._create_fts_index(table)
    assert ok is True
    table.create_fts_index.assert_called()
    args, kwargs = table.create_fts_index.call_args
    assert args[0] == "text"
    assert kwargs.get("use_tantivy") is False
