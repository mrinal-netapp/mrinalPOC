"""Unit tests for AcquireFromAPI / Redash acquisition helpers."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pyarrow as pa
import pytest

pytest.importorskip("temporalio")

from activities import redash_acquisition as ra


def _run(coro):
    return asyncio.run(coro)


def _call_acquire_from_api(input_body: dict):
    target = getattr(ra.acquire_from_api, "__wrapped__", ra.acquire_from_api)
    return _run(target(input_body))


@pytest.fixture
def store_root(tmp_path, monkeypatch):
    monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
    return tmp_path


@pytest.fixture
def temporal_ctx(monkeypatch):
    monkeypatch.setattr(
        ra.activity,
        "info",
        lambda: SimpleNamespace(workflow_run_id="run12345678"),
    )
    monkeypatch.setattr(ra.activity, "heartbeat", lambda *_a, **_k: None)


class TestRedashHelpers:
    def test_slug_sanitizes_name(self):
        assert ra._slug("My Query #1", "fallback") == "my_query_1"
        assert ra._slug("", "fallback") == "fallback"

    def test_quote_identifier_postgres(self):
        assert ra._quote_identifier("public.users", "postgresql") == '"public"."users"'

    def test_quote_identifier_mysql(self):
        assert ra._quote_identifier("db.users", "mysql") == "`db`.`users`"

    def test_query_result_to_table(self):
        result = {
            "data": {
                "columns": [
                    {"name": "id", "type": "integer"},
                    {"name": "name", "type": "string"},
                ],
                "rows": [{"id": 1, "name": "alice"}, {"id": 2, "name": "bob"}],
            },
        }
        table = ra._query_result_to_table(result)
        assert table.num_rows == 2
        assert table.column_names == ["id", "name"]

    def test_query_result_to_table_returns_none_without_columns(self):
        assert ra._query_result_to_table({"data": {"columns": [], "rows": []}}) is None

    def test_query_result_to_table_coerces_invalid_types(self):
        result = {
            "data": {
                "columns": [{"name": "n", "type": "integer"}],
                "rows": [{"n": "not-a-number"}],
            },
        }
        table = ra._query_result_to_table(result)
        assert table.schema.field("n").type == pa.string()


class TestAcquireFromApi:
    def test_unknown_provider(self, temporal_ctx):
        with pytest.raises(ValueError, match="Unknown API provider"):
            _call_acquire_from_api({"provider": "unknown"})

    def test_redash_requires_base_url(self, temporal_ctx):
        with pytest.raises(ValueError, match="base_url is required"):
            _call_acquire_from_api({"provider": "redash", "connectionInfo": {}})

    def test_redash_requires_api_key(self, temporal_ctx):
        with pytest.raises(ValueError, match="api_key"):
            _call_acquire_from_api(
                {
                    "provider": "redash",
                    "connectionInfo": {"base_url": "https://redash.example.com"},
                },
            )

    @patch(
        "activities.redash_acquisition.resolve_credential",
        return_value={"api_key": "key-1"},
    )
    @patch("activities.redash_acquisition.RedashClient")
    def test_catalog_mode_writes_parquet_and_filelist(
        self,
        mock_client_cls,
        _mock_cred,
        store_root,
        temporal_ctx,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.list_queries.return_value = [
            {
                "id": 10,
                "name": "Users",
                "query": "SELECT 1",
                "data_source_id": 1,
                "is_archived": False,
                "created_at": "t1",
                "updated_at": "t2",
            },
            {"id": 99, "name": "Archived", "is_archived": True},
        ]
        client.get_query_result.return_value = {
            "data": {
                "columns": [{"name": "x", "type": "integer"}],
                "rows": [{"x": 1}],
            },
        }
        client.list_dashboards.return_value = []
        client.list_data_sources.return_value = []

        out = _call_acquire_from_api(
            {
                "provider": "redash",
                "projectID": "p1",
                "datasetID": "d1",
                "credentialId": "c1",
                "configServiceURL": "http://config-service:3000",
                "connectionInfo": {
                    "base_url": "https://redash.example.com",
                    "include_dashboards": False,
                    "include_data_sources": False,
                },
            },
        )

        assert out["filesCopied"] >= 1.0
        assert out["rowCount"] >= 1
        filelist = json.loads(
            (store_root / out["fileListKey"]).read_text(encoding="utf-8")
        )
        assert filelist["provider"] == "redash"
        assert any(f["format"] == "parquet" for f in filelist["files"])

    @patch(
        "activities.redash_acquisition.resolve_credential",
        return_value={"api_key": "key-1"},
    )
    @patch("activities.redash_acquisition.RedashClient")
    def test_query_execution_mode(
        self,
        mock_client_cls,
        _mock_cred,
        store_root,
        temporal_ctx,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.get_query.return_value = {"id": 5, "name": "Revenue"}
        client.execute_query.return_value = {
            "data": {
                "columns": [{"name": "amount", "type": "float"}],
                "rows": [{"amount": 42.0}],
            },
        }
        client.list_data_sources.return_value = []

        out = _call_acquire_from_api(
            {
                "provider": "redash",
                "projectID": "p1",
                "datasetID": "d1",
                "credentialId": "c1",
                "configServiceURL": "http://config-service:3000",
                "connectionInfo": {"base_url": "https://redash.example.com"},
                "resourceSelector": [{"query_id": 5}],
            },
        )

        assert out["filesCopied"] == 1.0
        client.execute_query.assert_called_once()
        stored = list((store_root / "projects/p1/datasets/d1/data").rglob("*.parquet"))
        assert stored

    @patch(
        "activities.redash_acquisition.resolve_credential",
        return_value={"api_key": "key-1"},
    )
    @patch("activities.redash_acquisition.RedashClient")
    def test_table_execution_mode(
        self,
        mock_client_cls,
        _mock_cred,
        store_root,
        temporal_ctx,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.list_data_sources.return_value = [{"id": 2, "type": "postgresql"}]
        client.execute_sql.return_value = {
            "data": {
                "columns": [{"name": "id", "type": "integer"}],
                "rows": [{"id": 7}],
            },
        }

        out = _call_acquire_from_api(
            {
                "provider": "redash",
                "projectID": "p1",
                "datasetID": "d1",
                "credentialId": "c1",
                "configServiceURL": "http://config-service:3000",
                "connectionInfo": {"base_url": "https://redash.example.com"},
                "resourceSelector": [{"data_source_id": 2, "table": "public.users"}],
            },
        )

        assert out["filesCopied"] == 1.0
        client.execute_sql.assert_called_once()
        sql = client.execute_sql.call_args.kwargs["sql"]
        assert '"public"."users"' in sql

    @patch(
        "activities.redash_acquisition.resolve_credential",
        return_value={"api_key": "key-1"},
    )
    @patch("activities.redash_acquisition.RedashClient")
    def test_includes_dashboards_and_data_sources(
        self,
        mock_client_cls,
        _mock_cred,
        store_root,
        temporal_ctx,
    ):
        client = MagicMock()
        mock_client_cls.return_value = client
        client.list_queries.return_value = []
        client.list_dashboards.return_value = [
            {"id": 1, "slug": "ops", "name": "Ops", "is_archived": False},
        ]
        client.get_dashboard.return_value = {"widgets": [{"id": 10}]}
        client.list_data_sources.return_value = [
            {"id": 4, "name": "Warehouse", "type": "snowflake", "options": {}},
        ]

        out = _call_acquire_from_api(
            {
                "provider": "redash",
                "projectID": "p1",
                "datasetID": "d1",
                "credentialId": "c1",
                "configServiceURL": "http://config-service:3000",
                "connectionInfo": {
                    "base_url": "https://redash.example.com",
                    "include_query_results": False,
                },
            },
        )

        assert out["filesCopied"] == 2.0
        client.get_dashboard.assert_called_once_with("ops")
        client.list_data_sources.assert_called_once()
