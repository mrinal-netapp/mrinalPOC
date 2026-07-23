"""Unit tests for the PostgreSQL explorer adapter (mocked psycopg2 connections)."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

from adapters.postgresql_adapter import PostgreSQLAdapter  # noqa: E402

CFG = {"host": "postgres.example.com", "port": 5432}
CRED = {"username": "app", "password": "secret"}

PG_SYSTEM_SCHEMAS = frozenset({"information_schema", "pg_catalog", "pg_toast"})


def _adapter() -> PostgreSQLAdapter:
    return PostgreSQLAdapter()


@pytest.fixture
def mock_postgres(monkeypatch):
    """Patch connect_postgres; return (mock_connect, mock_conn, mock_cursor)."""
    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_conn.cursor.return_value.__enter__ = MagicMock(return_value=mock_cursor)
    mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
    mock_connect = MagicMock(return_value=mock_conn)
    monkeypatch.setattr("adapters.postgresql_adapter.connect_postgres", mock_connect)
    return mock_connect, mock_conn, mock_cursor


class TestDispatcher:
    def test_unsupported_action_returns_error(self):
        resp = _adapter().execute(CFG, CRED, "listBuckets", {})
        assert resp.error is not None
        assert resp.error.code == "UNSUPPORTED_ACTION"

    def test_provider_error_when_connect_raises(self, mock_postgres):
        mock_postgres[0].side_effect = RuntimeError("connection refused")
        resp = _adapter().execute(CFG, CRED, "listDatabases", {})
        assert resp.error is not None
        assert resp.error.code == "PROVIDER_ERROR"
        assert "connection refused" in resp.error.message


class TestListDatabases:
    def test_lists_non_template_databases(self, mock_postgres):
        mock_postgres[2].fetchall.return_value = [("appdb",), ("postgres",)]
        resp = _adapter()._list_databases(CFG, CRED, {})
        assert resp.error is None
        labels = {n.label for n in resp.nodes}
        assert labels == {"appdb", "postgres"}
        sql = mock_postgres[2].execute.call_args[0][0]
        assert "pg_database" in sql
        assert "datistemplate = false" in sql
        assert mock_postgres[1].close.called

    def test_node_shape(self, mock_postgres):
        mock_postgres[2].fetchall.return_value = [("appdb",)]
        node = _adapter()._list_databases(CFG, CRED, {}).nodes[0]
        assert node.id == "pg:db/appdb"
        assert node.type == "database"
        assert node.children_hint == "hasChildren"
        assert node.resource == {"database": "appdb"}
        assert node.actions == ["listSchemas"]


class TestListSchemas:
    def test_defaults_database_to_postgres(self, mock_postgres):
        mock_postgres[2].fetchall.return_value = [("public",)]
        resp = _adapter()._list_schemas(CFG, CRED, {})
        assert resp.error is None
        connect_cfg = mock_postgres[0].call_args[0][0]
        assert connect_cfg["database"] == "postgres"
        sql = mock_postgres[2].execute.call_args[0][0]
        for system_schema in PG_SYSTEM_SCHEMAS:
            assert system_schema in sql

    def test_lists_schemas_for_database(self, mock_postgres):
        mock_postgres[2].fetchall.return_value = [("public",), ("app",)]
        resp = _adapter()._list_schemas(CFG, CRED, {"database": "appdb"})
        assert resp.error is None
        assert len(resp.nodes) == 2
        node = resp.nodes[0]
        assert node.label == "public"
        assert node.type == "schema"
        assert node.resource == {"database": "appdb", "schema": "public"}
        assert node.actions == ["listTables"]
        connect_cfg = mock_postgres[0].call_args[0][0]
        assert connect_cfg["database"] == "appdb"

    def test_database_from_connector_config(self, mock_postgres):
        mock_postgres[2].fetchall.return_value = [("public",)]
        resp = _adapter()._list_schemas({**CFG, "database": "appdb"}, CRED, {})
        assert resp.error is None
        assert resp.nodes[0].resource["database"] == "appdb"


class TestListTables:
    def test_lists_tables_and_views(self, mock_postgres):
        mock_postgres[2].fetchall.return_value = [
            ("users", "BASE TABLE"),
            ("active_users", "VIEW"),
        ]
        resp = _adapter()._list_tables(
            CFG,
            CRED,
            {"database": "appdb", "schema": "public"},
        )
        assert resp.error is None
        types = {n.type for n in resp.nodes}
        assert types == {"table", "view"}
        assert mock_postgres[2].execute.call_args[0][1] == ("public",)

    def test_schema_defaults_to_public(self, mock_postgres):
        mock_postgres[2].fetchall.return_value = [("users", "BASE TABLE")]
        _adapter()._list_tables(CFG, CRED, {"database": "appdb"})
        assert mock_postgres[2].execute.call_args[0][1] == ("public",)

    def test_schema_from_connector_config(self, mock_postgres):
        mock_postgres[2].fetchall.return_value = [("users", "BASE TABLE")]
        _adapter()._list_tables(
            {**CFG, "database": "appdb", "schema": "app"},
            CRED,
            {"database": "appdb"},
        )
        assert mock_postgres[2].execute.call_args[0][1] == ("app",)


class TestDescribeTable:
    def test_requires_table(self):
        resp = _adapter()._describe_table(CFG, CRED, {"database": "appdb", "schema": "public"})
        assert resp.error is not None
        assert resp.error.code == "VALIDATION_ERROR"
        assert "table" in resp.error.message.lower()

    def test_returns_columns(self, mock_postgres):
        mock_postgres[2].fetchall.return_value = [
            ("id", "integer", "NO"),
            ("email", "character varying", "YES"),
        ]
        resp = _adapter()._describe_table(
            CFG,
            CRED,
            {"database": "appdb", "schema": "public", "table": "users"},
        )
        assert resp.error is None
        assert len(resp.nodes) == 2
        col = resp.nodes[0]
        assert col.type == "column"
        assert col.children_hint == "leaf"
        assert col.label == "id"
        assert col.metadata == {"dataType": "integer", "nullable": False}
        assert col.resource["column"] == "id"
        assert mock_postgres[2].execute.call_args[0][1] == ("public", "users")


class TestResolve:
    def test_merges_resource_selector(self):
        cfg = {**CFG, "database": "old", "schema": "old_schema"}
        out = _adapter().resolve(
            cfg,
            CRED,
            {"database": "appdb", "schema": "public", "table": "users"},
        )
        assert out["database"] == "appdb"
        assert out["schema"] == "public"
        assert out["table"] == "users"
        assert out["host"] == CFG["host"]
