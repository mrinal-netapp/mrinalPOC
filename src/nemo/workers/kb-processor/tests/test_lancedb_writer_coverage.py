"""Additional unit tests for processing/lancedb_writer.py filling gaps left by
test_lancedb_writer.py: constructor path variants, write()/write_stream()
orchestration, storage stats, retry/backoff logic for index creation,
metadata read/write, and existing-table detection. LanceDB itself is mocked
throughout -- these are pure unit tests of LanceDBWriter's own logic.
"""

from pathlib import Path
import sys
from unittest import mock

import pytest

pytest.importorskip("pyarrow")
import pyarrow as pa

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

sys.modules.setdefault("lancedb", mock.MagicMock())

import processing.lancedb_writer as lancedb_writer_mod
from processing.lancedb_writer import AUTO_INDEX_MIN_ROWS, LanceDBWriter, _peek_or_raise_empty


@pytest.fixture(autouse=True)
def _no_real_sleep():
    with mock.patch.object(lancedb_writer_mod.time, "sleep"):
        yield


@pytest.fixture
def store_root(tmp_path, monkeypatch):
    root = tmp_path / "store"
    root.mkdir()
    monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(root))
    return root


@pytest.fixture
def writer(tmp_path, store_root):
    return LanceDBWriter(kb_id="kb12345678", s3_path_prefix="projects/p1", temp_dir=tmp_path / "work")


class _FakeLanceTable:
    def __init__(self, rows=0):
        self._rows = rows
        self.create_index = mock.Mock()
        self.create_fts_index = mock.Mock()
        self.added_batches = []

    def count_rows(self):
        return self._rows

    def add(self, data):
        self.added_batches.append(data)
        # Simulate row growth on append.
        try:
            self._rows += sum(getattr(b, "num_rows", 1) for b in data)
        except TypeError:
            self._rows += 1


class _FakeDb:
    def __init__(self):
        self.tables = {}
        self.create_table = mock.Mock(side_effect=self._create_table)

    def _create_table(self, name, data=None, table=None, schema=None, mode="overwrite"):
        rows = 0
        if data is not None:
            rows = sum(getattr(b, "num_rows", 1) for b in data)
        elif table is not None:
            rows = len(table)
        t = _FakeLanceTable(rows=rows)
        self.tables[name] = t
        return t

    def table_names(self):
        return list(self.tables.keys())

    def open_table(self, name):
        return self.tables[name]


class TestPeekOrRaiseEmpty:
    def test_empty_iterator_raises_clear_error(self):
        with pytest.raises(RuntimeError, match="zero record batches"):
            list(_peek_or_raise_empty(iter([]), phase="merge"))

    def test_non_empty_iterator_reyields_all_items_in_order(self):
        items = [1, 2, 3]
        result = list(_peek_or_raise_empty(iter(items), phase="merge"))
        assert result == items


class TestConstructor:
    def test_deterministic_prefix_with_workflow_run_id(self, tmp_path):
        w = LanceDBWriter(kb_id="kb1", s3_path_prefix="projects/p1", workflow_run_id="run-42")
        assert w._lancedb_prefix == "projects/p1/knowledgebases/kb1/lancedb-run-run-42"
        assert w._metadata_key == "projects/p1/knowledgebases/kb1/metadata.json"

    def test_timestamp_based_prefix_without_workflow_run_id(self):
        w = LanceDBWriter(kb_id="kb1", s3_path_prefix="projects/p1")
        assert w._lancedb_prefix.startswith("projects/p1/knowledgebases/kb1/lancedb-")
        assert "lancedb-run-" not in w._lancedb_prefix

    def test_no_s3_path_prefix(self):
        w = LanceDBWriter(kb_id="kb1", workflow_run_id="run-1")
        assert w._base_prefix == "knowledgebases/kb1"
        assert w._lancedb_prefix == "knowledgebases/kb1/lancedb-run-run-1"

    def test_default_temp_dir_used_when_not_provided(self):
        w = LanceDBWriter(kb_id="kb1")
        assert w.temp_dir == Path("/tmp/kb-processor")


class TestDefaultStoreRoot:
    def test_returns_none_when_unset(self, monkeypatch):
        monkeypatch.delenv("NEMO_DEFAULT_STORE_ROOT", raising=False)
        assert LanceDBWriter._default_store_root() is None

    def test_returns_stripped_value_when_set(self, monkeypatch):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", "  /mnt/data  ")
        assert LanceDBWriter._default_store_root() == "/mnt/data"


class TestGetLanceTablePath:
    def test_joins_root_and_prefix(self, writer, store_root):
        path = writer.get_lance_table_path()
        assert path == str(store_root / writer._lancedb_prefix)


class TestWriteDispatch:
    def test_write_full_mode_delegates(self, writer):
        table = pa.table({"id": ["a"]})
        with mock.patch.object(writer, "_write_full", return_value="path-full") as mock_full, \
             mock.patch.object(writer, "_clear_prefix"):
            result = writer.write(table, mode="full")
        mock_full.assert_called_once()
        assert result == "path-full"

    def test_write_incremental_mode_delegates(self, writer):
        table = pa.table({"id": ["a"]})
        with mock.patch.object(writer, "_write_incremental", return_value="path-inc") as mock_inc, \
             mock.patch.object(writer, "_clear_prefix"):
            result = writer.write(table, mode="incremental")
        mock_inc.assert_called_once()
        assert result == "path-inc"

    def test_write_logs_and_reraises_on_exception(self, writer):
        table = pa.table({"id": ["a"]})
        with mock.patch.object(writer, "_write_full", side_effect=RuntimeError("boom")), \
             mock.patch.object(writer, "_clear_prefix"):
            with pytest.raises(RuntimeError, match="boom"):
                writer.write(table, mode="full")

    def test_write_stream_full_mode_delegates(self, writer):
        with mock.patch.object(writer, "_write_stream_full", return_value="path-full") as mock_full, \
             mock.patch.object(writer, "_clear_prefix"):
            result = writer.write_stream(iter([]), pa.schema([]), mode="full")
        mock_full.assert_called_once()
        assert result == "path-full"

    def test_write_stream_incremental_mode_delegates(self, writer):
        with mock.patch.object(writer, "_write_stream_incremental", return_value="path-inc") as mock_inc, \
             mock.patch.object(writer, "_clear_prefix"):
            result = writer.write_stream(iter([]), pa.schema([]), mode="incremental")
        mock_inc.assert_called_once()
        assert result == "path-inc"

    def test_write_stream_logs_and_reraises_on_exception(self, writer):
        with mock.patch.object(writer, "_write_stream_full", side_effect=RuntimeError("boom")), \
             mock.patch.object(writer, "_clear_prefix"):
            with pytest.raises(RuntimeError, match="boom"):
                writer.write_stream(iter([]), pa.schema([]), mode="full")


class TestGetStorageStats:
    def test_counts_files_and_bytes(self, writer, store_root):
        base = store_root / writer._lancedb_prefix
        base.mkdir(parents=True)
        (base / "a.lance").write_bytes(b"x" * 10)
        (base / "sub").mkdir()
        (base / "sub" / "b.lance").write_bytes(b"y" * 5)

        stats = writer._get_storage_stats()
        assert stats["file_count"] == 2
        assert stats["total_bytes"] == 15

    def test_missing_dir_returns_zero_stats(self, writer):
        stats = writer._get_storage_stats()
        assert stats == {"file_count": 0, "total_bytes": 0}

    def test_exception_during_scan_is_caught(self, writer, store_root):
        base = store_root / writer._lancedb_prefix
        base.mkdir(parents=True)
        (base / "a.lance").write_bytes(b"x")
        with mock.patch.object(Path, "rglob", side_effect=RuntimeError("scan failed")):
            stats = writer._get_storage_stats()
        assert stats == {"file_count": 0, "total_bytes": 0}


class TestWriteStreamFull:
    def test_creates_table_and_reports_phases(self, writer):
        fake_db = _FakeDb()
        batches = iter([pa.RecordBatch.from_arrays([pa.array([1, 2])], names=["x"])])
        phases = []

        with mock.patch.object(lancedb_writer_mod.lancedb, "connect", return_value=fake_db):
            result = writer._write_stream_full(
                batches, pa.schema([("x", pa.int64())]),
                indexing_mode="fts", quantization_type="none", quantization_options={},
            )
        assert result == writer.get_lance_table_path()
        assert writer._last_index_results == {
            "vector_index_created": False,
            "fts_index_created": True,
        }

    def test_phase_callback_invoked_for_each_phase(self, writer):
        fake_db = _FakeDb()
        batches = iter([pa.RecordBatch.from_arrays([pa.array([1] * (AUTO_INDEX_MIN_ROWS))], names=["x"])])
        calls = []

        def on_phase(phase, detail):
            calls.append(phase)

        with mock.patch.object(lancedb_writer_mod.lancedb, "connect", return_value=fake_db):
            writer._phase_progress_callback = on_phase
            writer._write_stream_full(
                batches, pa.schema([("x", pa.int64())]),
                indexing_mode="hybrid", quantization_type="auto", quantization_options={},
            )
        assert "creating_table" in calls
        assert "creating_vector_index" in calls
        assert "creating_fts_index" in calls
        assert "write_complete" in calls

    def test_no_index_when_quantization_none_and_semantic_only(self, writer):
        fake_db = _FakeDb()
        batches = iter([pa.RecordBatch.from_arrays([pa.array([1, 2])], names=["x"])])

        with mock.patch.object(lancedb_writer_mod.lancedb, "connect", return_value=fake_db):
            writer._write_stream_full(
                batches, pa.schema([("x", pa.int64())]),
                indexing_mode="semantic", quantization_type="none", quantization_options={},
            )
        assert writer._last_index_results["vector_index_created"] is False
        assert writer._last_index_results["fts_index_created"] is False

    def test_raises_clear_error_for_empty_batches(self, writer):
        fake_db = _FakeDb()
        with mock.patch.object(lancedb_writer_mod.lancedb, "connect", return_value=fake_db):
            with pytest.raises(RuntimeError, match="zero record batches"):
                writer._write_stream_full(iter([]), pa.schema([("x", pa.int64())]))


class TestWriteStreamIncremental:
    def test_appends_to_existing_table(self, writer, store_root):
        fake_db = _FakeDb()
        fake_db.tables[writer.TABLE_NAME] = _FakeLanceTable(rows=10)

        with mock.patch.object(lancedb_writer_mod.lancedb, "connect", return_value=fake_db), \
             mock.patch.object(writer, "_check_existing_lancedb", return_value=True):
            batches = iter([pa.RecordBatch.from_arrays([pa.array([1, 2, 3])], names=["x"])])
            result = writer._write_stream_incremental(
                batches, pa.schema([("x", pa.int64())]),
                indexing_mode="fts", quantization_type="none", quantization_options={},
            )
        assert result == writer.get_lance_table_path()
        assert writer._last_index_results["fts_index_created"] is True

    def test_creates_new_table_when_none_exists(self, writer):
        fake_db = _FakeDb()

        with mock.patch.object(lancedb_writer_mod.lancedb, "connect", return_value=fake_db), \
             mock.patch.object(writer, "_check_existing_lancedb", return_value=False):
            batches = iter([pa.RecordBatch.from_arrays([pa.array([1, 2])], names=["x"])])
            result = writer._write_stream_incremental(
                batches, pa.schema([("x", pa.int64())]),
                indexing_mode="hybrid", quantization_type="none", quantization_options={},
            )
        assert result == writer.get_lance_table_path()
        assert writer._last_index_results["fts_index_created"] is True

    def test_existing_found_but_table_missing_from_db_creates_new(self, writer):
        fake_db = _FakeDb()  # table_names() is empty even though existing_found True

        with mock.patch.object(lancedb_writer_mod.lancedb, "connect", return_value=fake_db), \
             mock.patch.object(writer, "_check_existing_lancedb", return_value=True):
            batches = iter([pa.RecordBatch.from_arrays([pa.array([1])], names=["x"])])
            writer._write_stream_incremental(
                batches, pa.schema([("x", pa.int64())]),
                indexing_mode="semantic", quantization_type="none", quantization_options={},
            )
        assert writer.TABLE_NAME in fake_db.tables

    def test_none_quantization_options_defaults_to_empty_dict(self, writer):
        fake_db = _FakeDb()
        with mock.patch.object(lancedb_writer_mod.lancedb, "connect", return_value=fake_db), \
             mock.patch.object(writer, "_check_existing_lancedb", return_value=False):
            batches = iter([pa.RecordBatch.from_arrays([pa.array([1])], names=["x"])])
            result = writer._write_stream_incremental(
                batches, pa.schema([("x", pa.int64())]),
                indexing_mode="semantic", quantization_type="none", quantization_options=None,
            )
        assert result == writer.get_lance_table_path()


class TestWriteFullLegacy:
    def test_creates_table_from_pa_table(self, writer):
        fake_db = _FakeDb()
        table = pa.table({"id": ["a", "b"]})

        with mock.patch.object(lancedb_writer_mod.lancedb, "connect", return_value=fake_db):
            result = writer._write_full(table, indexing_mode="fts", quantization_type="none", quantization_options={})

        assert result == writer.get_lance_table_path()
        assert writer._last_index_results["fts_index_created"] is True
        fake_db.create_table.assert_called_once()

    def test_none_quantization_options_defaults_to_empty_dict(self, writer):
        fake_db = _FakeDb()
        table = pa.table({"id": ["a", "b"]})
        with mock.patch.object(lancedb_writer_mod.lancedb, "connect", return_value=fake_db):
            result = writer._write_full(table, indexing_mode="semantic", quantization_type="none", quantization_options=None)
        assert result == writer.get_lance_table_path()


class TestWriteIncrementalLegacy:
    def test_appends_to_existing_table(self, writer):
        fake_db = _FakeDb()
        fake_db.tables[writer.TABLE_NAME] = _FakeLanceTable(rows=3)
        table = pa.table({"id": ["a", "b"]})

        with mock.patch.object(lancedb_writer_mod.lancedb, "connect", return_value=fake_db), \
             mock.patch.object(writer, "_check_existing_lancedb", return_value=True):
            result = writer._write_incremental(table, indexing_mode="hybrid", quantization_type="none", quantization_options={})

        assert result == writer.get_lance_table_path()

    def test_creates_new_table_when_none_exists(self, writer):
        fake_db = _FakeDb()
        table = pa.table({"id": ["a", "b"]})

        with mock.patch.object(lancedb_writer_mod.lancedb, "connect", return_value=fake_db), \
             mock.patch.object(writer, "_check_existing_lancedb", return_value=False):
            result = writer._write_incremental(table, indexing_mode="hybrid", quantization_type="none", quantization_options={})

        assert result == writer.get_lance_table_path()
        assert writer._last_index_results["fts_index_created"] is True

    def test_none_quantization_options_defaults_to_empty_dict(self, writer):
        fake_db = _FakeDb()
        table = pa.table({"id": ["a", "b"]})
        with mock.patch.object(lancedb_writer_mod.lancedb, "connect", return_value=fake_db), \
             mock.patch.object(writer, "_check_existing_lancedb", return_value=False):
            result = writer._write_incremental(table, indexing_mode="semantic", quantization_type="none", quantization_options=None)
        assert result == writer.get_lance_table_path()


class TestEnsureVectorIndexAdditional:
    def test_auto_with_fts_only_indexing_mode_skips(self, writer):
        table = mock.MagicMock()
        ok = writer._ensure_vector_index(table, AUTO_INDEX_MIN_ROWS, "auto", {}, "fts")
        assert ok is False
        table.create_index.assert_not_called()

    def test_specific_quantization_ignores_indexing_mode(self, writer):
        table = mock.MagicMock()
        ok = writer._ensure_vector_index(table, 1, "ivf_pq", {"numPartitions": 8, "numSubVectors": 2}, "fts")
        assert ok is True


class TestCreateVectorIndexRetries:
    def test_unknown_quantization_type_returns_false(self, writer):
        table = mock.MagicMock()
        ok = writer._create_vector_index(table, "not-a-type", {})
        assert ok is False
        table.create_index.assert_not_called()

    def test_transient_failure_then_success(self, writer):
        table = mock.MagicMock()
        table.create_index.side_effect = [RuntimeError("transient"), None]
        ok = writer._create_vector_index(table, "ivf_pq", {})
        assert ok is True
        assert table.create_index.call_count == 2

    def test_exhausted_retries_raises_runtime_error(self, writer):
        table = mock.MagicMock()
        table.create_index.side_effect = RuntimeError("persistent failure")
        with pytest.raises(RuntimeError, match="Failed to create vector index"):
            writer._create_vector_index(table, "scalar", {})
        assert table.create_index.call_count == lancedb_writer_mod._INDEX_RETRY_ATTEMPTS


class TestCreateFtsIndexRetries:
    def test_type_error_falls_back_to_minimal_params(self, writer):
        table = mock.MagicMock()
        table.create_fts_index.side_effect = [TypeError("bad kwarg"), None]
        ok = writer._create_fts_index(table)
        assert ok is True
        assert table.create_fts_index.call_count == 2

    def test_type_error_fallback_also_fails_then_retries_and_succeeds(self, writer):
        table = mock.MagicMock()
        table.create_fts_index.side_effect = [
            TypeError("bad kwarg"), RuntimeError("still failing"),
            None,
        ]
        ok = writer._create_fts_index(table)
        assert ok is True
        assert table.create_fts_index.call_count == 3

    def test_type_error_fallback_exhausted_raises_runtime_error(self, writer):
        table = mock.MagicMock()

        def always_fail(*args, **kwargs):
            if kwargs.get("stem") is not None:
                raise TypeError("bad kwarg")
            raise RuntimeError("fallback also fails")

        table.create_fts_index.side_effect = always_fail
        with pytest.raises(RuntimeError, match="Failed to create FTS index"):
            writer._create_fts_index(table)

    def test_generic_exception_retries_then_succeeds(self, writer):
        table = mock.MagicMock()
        table.create_fts_index.side_effect = [RuntimeError("transient"), None]
        ok = writer._create_fts_index(table)
        assert ok is True

    def test_generic_exception_exhausted_raises_runtime_error(self, writer):
        table = mock.MagicMock()
        table.create_fts_index.side_effect = RuntimeError("persistent")
        with pytest.raises(RuntimeError, match="Failed to create FTS index"):
            writer._create_fts_index(table)


class TestGetCurrentLancedbPath:
    def test_absolute_path_in_metadata_used_directly(self, writer):
        with mock.patch.object(writer, "read_metadata", return_value={"lancedbPath": "/abs/path"}):
            assert writer._get_current_lancedb_path() == "/abs/path"

    def test_relative_s3_style_path_resolved_against_root(self, writer, store_root):
        metadata = {"lancedbPath": f"s3://{writer.kb_id}/lancedb-run-1"}
        with mock.patch.object(writer, "read_metadata", return_value=metadata):
            result = writer._get_current_lancedb_path()
        assert result == str(store_root / "lancedb-run-1")

    def test_no_metadata_falls_back_to_legacy_path(self, writer, store_root):
        with mock.patch.object(writer, "read_metadata", return_value=None):
            result = writer._get_current_lancedb_path()
        assert result == str(store_root / writer._base_prefix / "lancedb")

    def test_metadata_missing_lancedb_path_key_falls_back_to_legacy(self, writer, store_root):
        with mock.patch.object(writer, "read_metadata", return_value={"other": "value"}):
            result = writer._get_current_lancedb_path()
        assert result == str(store_root / writer._base_prefix / "lancedb")

    def test_read_metadata_exception_falls_back_to_legacy(self, writer, store_root):
        with mock.patch.object(writer, "read_metadata", side_effect=RuntimeError("boom")):
            result = writer._get_current_lancedb_path()
        assert result == str(store_root / writer._base_prefix / "lancedb")


class TestCheckExistingLancedb:
    def test_returns_true_when_files_present(self, writer, store_root):
        current = store_root / "current-lancedb"
        current.mkdir()
        (current / "data.lance").write_bytes(b"x")
        with mock.patch.object(writer, "_get_current_lancedb_path", return_value=str(current)):
            assert writer._check_existing_lancedb() is True

    def test_returns_false_when_dir_missing(self, writer, store_root):
        with mock.patch.object(writer, "_get_current_lancedb_path", return_value=str(store_root / "missing")):
            assert writer._check_existing_lancedb() is False

    def test_returns_false_when_dir_empty(self, writer, store_root):
        current = store_root / "empty-lancedb"
        current.mkdir()
        with mock.patch.object(writer, "_get_current_lancedb_path", return_value=str(current)):
            assert writer._check_existing_lancedb() is False

    def test_exception_is_caught_and_returns_false(self, writer):
        with mock.patch.object(writer, "_get_current_lancedb_path", side_effect=RuntimeError("boom")):
            assert writer._check_existing_lancedb() is False


class TestGetUploadStatsAndIndexResults:
    def test_get_upload_stats_default_empty(self, writer):
        assert writer.get_upload_stats() == {}

    def test_get_upload_stats_after_set(self, writer):
        writer._last_upload_stats = {"file_count": 3}
        assert writer.get_upload_stats() == {"file_count": 3}

    def test_get_index_results_default(self, writer):
        assert writer.get_index_results() == {
            "vector_index_created": False,
            "fts_index_created": False,
        }

    def test_get_index_results_after_set(self, writer):
        writer._last_index_results = {"vector_index_created": True, "fts_index_created": True}
        assert writer.get_index_results()["vector_index_created"] is True


class TestClearPrefix:
    def test_removes_existing_directory(self, writer, store_root):
        target = store_root / writer._lancedb_prefix
        target.mkdir(parents=True)
        (target / "a.lance").write_bytes(b"x")
        writer._clear_prefix()
        assert not target.exists()

    def test_missing_directory_is_a_no_op(self, writer):
        writer._clear_prefix()  # must not raise

    def test_exception_during_rmtree_is_swallowed(self, writer, store_root):
        target = store_root / writer._lancedb_prefix
        target.mkdir(parents=True)
        with mock.patch.object(lancedb_writer_mod.shutil, "rmtree", side_effect=RuntimeError("busy")):
            writer._clear_prefix()  # must not raise


class TestReadMetadata:
    def test_missing_file_returns_none(self, writer):
        assert writer.read_metadata() is None

    def test_valid_metadata_returned_as_dict(self, writer, store_root):
        p = store_root / writer._metadata_key
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text('{"lancedbPath": "/x"}', encoding="utf-8")
        assert writer.read_metadata() == {"lancedbPath": "/x"}


class TestUploadMetadata:
    def test_writes_metadata_with_timestamps(self, writer, store_root):
        path = writer.upload_metadata({"lancedbPath": "/x"})
        assert Path(path).is_file()
        saved = writer.read_metadata()
        assert saved["lancedbPath"] == "/x"
        assert "createdAt" in saved
        assert "updatedAt" in saved
        assert saved["createdAt"] == saved["updatedAt"]

    def test_preserves_existing_created_at(self, writer, store_root):
        writer.upload_metadata({"lancedbPath": "/x", "createdAt": "2020-01-01T00:00:00+00:00"})
        saved = writer.read_metadata()
        assert saved["createdAt"] == "2020-01-01T00:00:00+00:00"
        assert saved["updatedAt"] != saved["createdAt"]

    def test_no_tmp_file_left_behind(self, writer, store_root):
        writer.upload_metadata({"lancedbPath": "/x"})
        p = store_root / writer._metadata_key
        assert not p.with_suffix(p.suffix + ".tmp").exists()
