"""Unit tests for PostgreSQL database connector activities (mocked drivers)."""
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
            "connector_type": "database",
            "provider": "postgresql",
            "database_type": "postgresql",
            "host": "postgres.example.com",
            "port": 5432,
            "database": "appdb",
            "schema": "public",
            "ssl_mode": "require",
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
    mock_cursor.description = [("ok",)]
    mock_cursor.fetchall.return_value = [(1,)]
    mock_conn.cursor.return_value.__enter__ = MagicMock(return_value=mock_cursor)
    mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
    mock_connect = MagicMock(return_value=mock_conn)
    monkeypatch.setattr(db_mod, "connect_postgres", mock_connect)
    return mock_connect, mock_conn, mock_cursor


class TestTestDatabaseConnection:
    def test_postgresql_success(self, mock_creds, mock_postgres_connect):
        out = _call_activity(db_mod.test_database_connection, _base_input())
        assert out["success"] is True
        assert out["message"] == "Connection successful"
        calls = [c[0][0] for c in mock_postgres_connect[2].execute.call_args_list]
        assert "SELECT 1" in calls
        assert not any("max_execution_time" in c for c in calls)

    def test_postgresql_failure_surfaces_message(self, mock_creds, mock_postgres_connect):
        mock_postgres_connect[0].side_effect = Exception("password authentication failed")
        out = _call_activity(db_mod.test_database_connection, _base_input())
        assert out["success"] is False
        assert "password authentication failed" in out["message"]

    def test_defaults_to_postgresql_when_database_type_missing(self, mock_creds, mock_postgres_connect):
        inp = _base_input()
        cfg = dict(inp["connectorConfig"])
        del cfg["database_type"]
        inp["connectorConfig"] = cfg
        out = _call_activity(db_mod.test_database_connection, inp)
        assert out["success"] is True
        mock_postgres_connect[0].assert_called_once()


class TestRunQueryPostgresql:
    def test_does_not_set_mysql_max_execution_time(self, mock_creds, mock_postgres_connect):
        db_mod._run_query(
            _base_input()["connectorConfig"],
            {"username": "app", "password": "secret"},
            "SELECT 1",
            timeout_ms=5000,
        )
        calls = [c[0][0] for c in mock_postgres_connect[2].execute.call_args_list]
        assert "SELECT 1" in calls
        assert not any("max_execution_time" in c for c in calls)
