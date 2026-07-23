"""Additional unit tests for database activities (discover, acquire, preview)."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

pytest.importorskip("temporalio")

from activities import database as db_mod


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
        },
        "sqlQuery": "SELECT id, name FROM users",
        "outputPath": "projects/proj-1/datasets/d1/data",
    }
    body.update(overrides)
    return body


@pytest.fixture(autouse=True)
def patch_heartbeat(monkeypatch):
    monkeypatch.setattr(
        "activities.database.activity.heartbeat", lambda *_a, **_k: None
    )


@pytest.fixture
def store_root(tmp_path, monkeypatch):
    monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
    return tmp_path


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
    mock_conn.cursor.return_value.__enter__ = MagicMock(return_value=mock_cursor)
    mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
    mock_connect = MagicMock(return_value=mock_conn)
    monkeypatch.setattr(db_mod, "connect_postgres", mock_connect)
    return mock_connect, mock_conn, mock_cursor


class TestDatabaseHelpers:
    def test_parse_database_from_sql_comment(self):
        sql = "-- Database: analytics\nSELECT 1"
        assert db_mod._parse_database_from_sql_comment(sql) == "analytics"

    def test_effective_db_config_uses_input_database(self):
        cfg = db_mod._effective_db_config(
            {"database": "override_db", "connectorConfig": {}}
        )
        assert cfg["database"] == "override_db"

    def test_sanitize_identifier_rejects_invalid(self):
        with pytest.raises(ValueError, match="Invalid identifier"):
            db_mod._sanitize_identifier("bad-name")

    def test_rows_to_parquet_empty(self, tmp_path):
        out = tmp_path / "empty.parquet"
        db_mod._rows_to_parquet([], [], out)
        assert out.exists()


class TestDiscoverDatabaseSchema:
    def test_returns_schema_tree(self, mock_creds, mock_postgres_connect):
        mock_postgres_connect[2].fetchall.side_effect = [
            [("public", "users")],
            [("id", "integer", "NO"), ("name", "text", "YES")],
        ]
        out = _call_activity(db_mod.discover_database_schema, _base_input())
        assert "public" in out["schemas"]
        assert out["schemas"]["public"][0]["name"] == "users"
        assert len(out["schemas"]["public"][0]["columns"]) == 2


class TestPreviewDatabase:
    def test_limits_rows(self, mock_creds, mock_postgres_connect):
        mock_postgres_connect[2].description = [("id",), ("name",)]
        mock_postgres_connect[2].fetchall.return_value = [(1, "alice")]
        out = _call_activity(db_mod.preview_database, _base_input())
        assert out["rowCount"] == 1
        assert out["rows"][0]["name"] == "alice"
        executed = mock_postgres_connect[2].execute.call_args[0][0]
        assert "LIMIT 100" in executed


class TestAcquireFromDatabase:
    def test_requires_output_path(self, mock_creds, store_root):
        inp = _base_input()
        del inp["outputPath"]
        with pytest.raises(ValueError, match="outputPath"):
            _call_activity(db_mod.acquire_from_database, inp)

    def test_writes_parquet_to_store(
        self, mock_creds, mock_postgres_connect, store_root, monkeypatch
    ):
        mock_postgres_connect[2].description = [("id",), ("updated_at",)]
        mock_postgres_connect[2].fetchall.return_value = [
            (1, "2024-01-02"),
            (2, "2024-01-03"),
        ]
        monkeypatch.delenv("WORKFLOW_ENGINE_URL", raising=False)

        out = _call_activity(
            db_mod.acquire_from_database,
            _base_input(
                writeMode="incremental",
                watermarkCol="updated_at",
                lastWatermark="2024-01-01",
            ),
        )

        assert out["rowCount"] == 2
        assert out["newWatermarkValue"] == "2024-01-03"
        dest = store_root / "projects/proj-1/datasets/d1/data/output.parquet"
        assert dest.exists()

    def test_max_rows_wrapper(self, mock_creds, mock_postgres_connect, store_root):
        mock_postgres_connect[2].description = [("id",)]
        mock_postgres_connect[2].fetchall.return_value = [(1,)]
        out = _call_activity(db_mod.acquire_from_database, _base_input(maxRows=50))
        assert out["rowCount"] == 1
        executed = mock_postgres_connect[2].execute.call_args[0][0]
        assert "LIMIT 50" in executed
