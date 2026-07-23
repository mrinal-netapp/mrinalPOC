"""Unit tests for PostgreSQL DiscoverDatabaseSchema activity (mocked psycopg2)."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

pytest.importorskip("temporalio")

from activities import database as db_mod  # noqa: E402


def _call_activity(fn, *args, **kwargs):
    target = getattr(fn, "__wrapped__", fn)
    return target(*args, **kwargs)


def _base_input(**overrides):
    body = {
        "projectID": "proj-1",
        "credentialID": "cred-1",
        "configServiceURL": "http://config-service:3000",
        "connectorConfig": {
            "provider": "postgresql",
            "database_type": "postgresql",
            "host": "postgres.example.com",
            "port": 5432,
            "schema": "public",
        },
    }
    body.update(overrides)
    return body


@pytest.fixture
def mock_creds(monkeypatch):
    monkeypatch.setattr(
        db_mod,
        "resolve_credential",
        lambda *_a, **_kw: {"username": "app", "password": "secret"},
    )


@pytest.fixture
def mock_postgres_connect(monkeypatch):
    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_cursor.fetchall.side_effect = [
        [("public", "users")],
        [("id", "integer", "NO"), ("email", "character varying", "YES")],
    ]
    mock_conn.cursor.return_value.__enter__ = MagicMock(return_value=mock_cursor)
    mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
    mock_connect = MagicMock(return_value=mock_conn)
    monkeypatch.setattr(db_mod, "connect_postgres", mock_connect)
    return mock_connect, mock_conn, mock_cursor


class TestDiscoverDatabaseSchemaPostgresql:
    def test_returns_schemas_and_columns(self, mock_creds, mock_postgres_connect):
        out = _call_activity(db_mod.discover_database_schema, _base_input())
        assert "schemas" in out
        assert "public" in out["schemas"]
        tables = out["schemas"]["public"]
        assert len(tables) == 1
        assert tables[0]["name"] == "users"
        assert tables[0]["columns"][0]["name"] == "id"
        mock_postgres_connect[0].assert_called_once()
        assert mock_postgres_connect[2].execute.call_args_list[0][0][1] == ("public",)
