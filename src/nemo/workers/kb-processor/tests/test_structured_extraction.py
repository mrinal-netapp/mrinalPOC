"""Unit tests for StructuredDataSource row-to-Document extraction (mocked Iceberg/Arrow)."""

from pathlib import Path
import sys
from unittest.mock import MagicMock, call, patch

import pytest

pa = pytest.importorskip("pyarrow")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from data_sources.base import Document
from data_sources.structured import StructuredDataSource


def _make_source(text_columns: list[str]) -> StructuredDataSource:
    return StructuredDataSource(
        catalog_table_ref="warehouse.articles",
        lakekeeper_url="http://lakekeeper:8181",
        warehouse_id="nemo",
        token="token",
        text_columns=text_columns,
        s3_endpoint="http://s3:9000",
        s3_access_key="ak",
        s3_secret_key="sk",
    )


def test_process_row_builds_document_from_text_columns():
    source = _make_source(["title", "body"])
    source._arrow_table = pa.table({
        "title": ["Hello"],
        "body": ["World"],
        "id": [1],
    })
    source._row_count = 1

    doc = source._process_row(0)
    assert doc is not None
    assert doc.doc_id == "row_0"
    assert "title: Hello" in doc.content
    assert "body: World" in doc.content
    assert doc.metadata["table_ref"] == "warehouse.articles"
    assert doc.metadata["source_type"] == "structured"
    assert doc.metadata["columns_used"] == ["title", "body"]


def test_process_row_skips_empty_and_null_text_columns():
    source = _make_source(["title", "body"])
    source._arrow_table = pa.table({
        "title": [None],
        "body": ["   "],
    })
    source._row_count = 1

    assert source._process_row(0) is None


def test_connect_merges_catalog_s3_config_into_table_fileio():
    pytest.importorskip("pyiceberg")

    mock_table = MagicMock()
    mock_table.io.properties = {"existing": "keep"}
    mock_field = MagicMock()
    mock_field.name = "title"
    mock_table.schema.return_value.fields = [mock_field]
    mock_arrow = pa.table({"title": ["hello"]})
    mock_table.scan.return_value.to_arrow.return_value = mock_arrow

    mock_catalog = MagicMock()
    mock_catalog.load_table.return_value = mock_table

    with patch("pyiceberg.catalog.rest.RestCatalog", return_value=mock_catalog) as mock_catalog_cls:
        source = _make_source(["title"])
        source.connect()

    mock_catalog_cls.assert_called_once()
    _, kwargs = mock_catalog_cls.call_args
    assert kwargs["s3.access-key-id"] == "ak"
    assert kwargs["s3.secret-access-key"] == "sk"
    assert kwargs["s3.endpoint"] == "http://s3:9000"

    assert mock_table.io.properties["existing"] == "keep"
    assert mock_table.io.properties["s3.access-key-id"] == "ak"
    assert mock_table.io.properties["s3.secret-access-key"] == "sk"
    assert mock_table.io.properties["s3.endpoint"] == "http://s3:9000"
    assert mock_table.io.properties["s3.region"] == "us-east-1"
    assert mock_table.io.properties["s3.path-style-access"] == "true"
    assert mock_table.io.properties["s3.remote-signing-enabled"] == "false"
    mock_table.scan.assert_called_once()


def test_get_documents_yields_only_rows_with_text():
    source = _make_source(["note"])
    source._arrow_table = pa.table({
        "note": ["ok", None, "second"],
    })
    source._row_count = 3

    docs = list(source.get_documents())
    assert len(docs) == 2
    assert docs[0].doc_id == "row_0"
    assert docs[1].doc_id == "row_2"


def test_get_documents_raises_when_not_connected():
    source = _make_source(["note"])
    with pytest.raises(RuntimeError, match="not connected"):
        list(source.get_documents())


def test_get_documents_skips_row_raising_exception_and_continues():
    source = _make_source(["note"])
    source._arrow_table = pa.table({"note": ["ok", "second"]})
    source._row_count = 2

    # Row 0 raises; row 1 succeeds with a real Document. Asserting the row-1
    # document is yielded (and that _process_row was called for both rows)
    # guards against a regression where get_documents() stops iterating
    # after the first exception instead of continuing.
    second_doc = Document(doc_id="row_1", content="note: second", metadata={})
    with patch.object(
        source, "_process_row", side_effect=[RuntimeError("boom"), second_doc]
    ) as mock_process_row:
        docs = list(source.get_documents())
    assert docs == [second_doc]
    assert mock_process_row.call_args_list == [call(0), call(1)]


def test_process_row_column_extraction_exception_is_skipped():
    source = _make_source(["title", "body"])
    bad_column = MagicMock()
    bad_column.__getitem__.side_effect = RuntimeError("bad column access")

    arrow_table = MagicMock()

    def _column(name):
        if name == "title":
            return bad_column
        return pa.table({"body": ["World"]}).column("body")

    arrow_table.column.side_effect = _column
    source._arrow_table = arrow_table

    doc = source._process_row(0)
    assert doc is not None
    assert "body: World" in doc.content
    assert "title" not in doc.content


def test_get_total_count_returns_row_count():
    source = _make_source(["note"])
    source._row_count = 42
    assert source.get_total_count() == 42


def test_source_type_is_structured():
    source = _make_source(["note"])
    assert source.source_type == "structured"


def test_connect_raises_runtime_error_when_pyiceberg_missing():
    source = _make_source(["title"])
    with patch.dict(sys.modules, {"pyiceberg.catalog.rest": None}):
        with pytest.raises(RuntimeError, match="PyIceberg is required"):
            source.connect()


def test_connect_raises_value_error_for_malformed_catalog_ref():
    pytest.importorskip("pyiceberg")
    source = _make_source(["title"])
    source.catalog_table_ref = "no_dot_in_this_ref"
    with pytest.raises(ValueError, match="Invalid catalog_table_ref format"):
        source.connect()


def test_connect_reraises_catalog_creation_exception():
    pytest.importorskip("pyiceberg")
    source = _make_source(["title"])
    with patch("pyiceberg.catalog.rest.RestCatalog", side_effect=RuntimeError("catalog down")):
        with pytest.raises(RuntimeError, match="catalog down"):
            source.connect()


def test_connect_wraps_load_table_failure_as_runtime_error():
    pytest.importorskip("pyiceberg")
    mock_catalog = MagicMock()
    mock_catalog.load_table.side_effect = Exception("no such table")

    source = _make_source(["title"])
    with patch("pyiceberg.catalog.rest.RestCatalog", return_value=mock_catalog):
        with pytest.raises(RuntimeError, match="not found in catalog"):
            source.connect()


def test_connect_raises_value_error_for_missing_text_columns_in_schema():
    pytest.importorskip("pyiceberg")
    mock_table = MagicMock()
    mock_field = MagicMock()
    mock_field.name = "other_column"
    mock_table.schema.return_value.fields = [mock_field]

    mock_catalog = MagicMock()
    mock_catalog.load_table.return_value = mock_table

    source = _make_source(["title", "body"])
    with patch("pyiceberg.catalog.rest.RestCatalog", return_value=mock_catalog):
        with pytest.raises(ValueError, match="Text columns not found in table schema"):
            source.connect()
