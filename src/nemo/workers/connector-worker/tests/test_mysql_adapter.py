"""Unit tests for the MySQL explorer adapter (mocked PyMySQL connections)."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

from adapters.mysql_adapter import MYSQL_SYSTEM_SCHEMAS, MySQLAdapter  # noqa: E402


CFG = {"host": "mysql.example.com", "port": 3306}
CRED = {"username": "app", "password": "secret"}


def _adapter() -> MySQLAdapter:
    return MySQLAdapter()


@pytest.fixture
def mock_mysql(monkeypatch):
    """Patch connect_mysql; return (mock_connect, mock_conn, mock_cursor)."""
    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_conn.cursor.return_value.__enter__ = MagicMock(return_value=mock_cursor)
    mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
    mock_connect = MagicMock(return_value=mock_conn)
    monkeypatch.setattr("adapters.mysql_adapter.connect_mysql", mock_connect)
    return mock_connect, mock_conn, mock_cursor


class TestDispatcher:
    def test_unsupported_action_returns_error(self):
        resp = _adapter().execute(CFG, CRED, "listBuckets", {})
        assert resp.error is not None
        assert resp.error.code == "UNSUPPORTED_ACTION"

    def test_provider_error_when_connect_raises(self, mock_mysql):
        mock_mysql[0].side_effect = RuntimeError("connection refused")
        resp = _adapter().execute(CFG, CRED, "listDatabases", {})
        assert resp.error is not None
        assert resp.error.code == "PROVIDER_ERROR"
        assert "connection refused" in resp.error.message


class TestListDatabases:
    def test_excludes_system_databases(self, mock_mysql):
        mock_mysql[2].fetchall.return_value = [("sakila",), ("app_db",)]
        resp = _adapter()._list_databases(CFG, CRED, {})
        assert resp.error is None
        labels = {n.label for n in resp.nodes}
        assert labels == {"app_db", "sakila"}
        assert not labels & MYSQL_SYSTEM_SCHEMAS
        sql = mock_mysql[2].execute.call_args[0][0]
        for system_db in MYSQL_SYSTEM_SCHEMAS:
            assert system_db in sql
        assert mock_mysql[1].close.called

    def test_returns_empty_when_only_system_catalogs(self, mock_mysql):
        mock_mysql[2].fetchall.return_value = []
        resp = _adapter()._list_databases(CFG, CRED, {})
        assert resp.error is None
        assert resp.nodes == []

    def test_node_shape(self, mock_mysql):
        mock_mysql[2].fetchall.return_value = [("sakila",)]
        node = _adapter()._list_databases(CFG, CRED, {}).nodes[0]
        assert node.id == "mysql:db/sakila"
        assert node.type == "database"
        assert node.children_hint == "hasChildren"
        assert node.resource == {"database": "sakila"}
        assert node.actions == ["listSchemas"]


class TestListSchemas:
    def test_requires_database(self):
        resp = _adapter()._list_schemas(CFG, CRED, {})
        assert resp.error is not None
        assert resp.error.code == "VALIDATION_ERROR"

    def test_lists_schemas_for_database(self, mock_mysql):
        mock_mysql[2].fetchall.return_value = [("sakila",)]
        resp = _adapter()._list_schemas(CFG, CRED, {"database": "sakila"})
        assert resp.error is None
        assert len(resp.nodes) == 1
        node = resp.nodes[0]
        assert node.label == "sakila"
        assert node.type == "schema"
        assert node.resource == {"database": "sakila", "schema": "sakila"}
        assert node.actions == ["listTables"]
        sql = mock_mysql[2].execute.call_args[0][0]
        assert "information_schema.schemata" in sql
        for system_db in MYSQL_SYSTEM_SCHEMAS:
            assert system_db in sql
        connect_cfg = mock_mysql[0].call_args[0][0]
        assert connect_cfg["database"] == "sakila"

    def test_database_from_connector_config(self, mock_mysql):
        mock_mysql[2].fetchall.return_value = [("sakila",)]
        resp = _adapter()._list_schemas({**CFG, "database": "sakila"}, CRED, {})
        assert resp.error is None
        assert resp.nodes[0].label == "sakila"


class TestListTables:
    def test_requires_database(self):
        resp = _adapter()._list_tables(CFG, CRED, {"schema": "sakila"})
        assert resp.error is not None
        assert resp.error.code == "VALIDATION_ERROR"

    def test_lists_tables_and_views(self, mock_mysql):
        mock_mysql[2].fetchall.return_value = [
            ("actor", "BASE TABLE"),
            ("actor_info", "VIEW"),
        ]
        resp = _adapter()._list_tables(
            CFG,
            CRED,
            {"database": "sakila", "schema": "sakila"},
        )
        assert resp.error is None
        types = {n.type for n in resp.nodes}
        assert types == {"table", "view"}
        assert mock_mysql[2].execute.call_args[0][1] == ("sakila",)

    def test_schema_defaults_to_database_name(self, mock_mysql):
        mock_mysql[2].fetchall.return_value = [("actor", "BASE TABLE")]
        _adapter()._list_tables(CFG, CRED, {"database": "sakila"})
        assert mock_mysql[2].execute.call_args[0][1] == ("sakila",)

    def test_schema_from_connector_config(self, mock_mysql):
        mock_mysql[2].fetchall.return_value = [("actor", "BASE TABLE")]
        _adapter()._list_tables(
            {**CFG, "database": "sakila", "schema": "custom"},
            CRED,
            {"database": "sakila"},
        )
        assert mock_mysql[2].execute.call_args[0][1] == ("custom",)


class TestDescribeTable:
    def test_requires_database(self):
        resp = _adapter()._describe_table(CFG, CRED, {"schema": "s", "table": "t"})
        assert resp.error is not None
        assert resp.error.code == "VALIDATION_ERROR"

    def test_requires_table(self):
        resp = _adapter()._describe_table(CFG, CRED, {"database": "sakila", "schema": "sakila"})
        assert resp.error is not None
        assert resp.error.code == "VALIDATION_ERROR"
        assert "table" in resp.error.message.lower()

    def test_returns_columns(self, mock_mysql):
        mock_mysql[2].fetchall.return_value = [
            ("actor_id", "smallint", "NO"),
            ("first_name", "varchar", "YES"),
        ]
        resp = _adapter()._describe_table(
            CFG,
            CRED,
            {"database": "sakila", "schema": "sakila", "table": "actor"},
        )
        assert resp.error is None
        assert len(resp.nodes) == 2
        col = resp.nodes[0]
        assert col.type == "column"
        assert col.children_hint == "leaf"
        assert col.label == "actor_id"
        assert col.metadata == {"dataType": "smallint", "nullable": False}
        assert col.resource["column"] == "actor_id"
        assert mock_mysql[2].execute.call_args[0][1] == ("sakila", "actor")


class TestResolve:
    def test_merges_resource_selector(self):
        cfg = {**CFG, "database": "old"}
        out = _adapter().resolve(
            cfg,
            CRED,
            {"database": "sakila", "schema": "sakila", "table": "actor"},
        )
        assert out["database"] == "sakila"
        assert out["schema"] == "sakila"
        assert out["table"] == "actor"
        assert out["host"] == CFG["host"]
