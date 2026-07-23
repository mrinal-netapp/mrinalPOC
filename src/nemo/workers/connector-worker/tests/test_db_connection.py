"""Unit tests for activities.db_connection SSL helpers."""
from __future__ import annotations

import ssl
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

from activities.db_connection import (  # noqa: E402
    _mysql_ssl_context,
    _normalize_ssl_mode,
    _postgres_sslmode,
    connect_mysql,
    connect_postgres,
)


class TestSslModeHelpers:
    def test_normalize_ssl_mode_snake_and_camel(self):
        assert _normalize_ssl_mode({"ssl_mode": "require"}) == "require"
        assert _normalize_ssl_mode({"sslMode": "REQUIRE"}) == "require"
        assert _normalize_ssl_mode({}) == "prefer"

    def test_postgres_sslmode_maps_known_values(self):
        assert _postgres_sslmode("require") == "require"
        assert _postgres_sslmode("verify-full") == "verify-full"
        assert _postgres_sslmode("bogus") == "prefer"

    def test_mysql_ssl_disable(self):
        assert _mysql_ssl_context("disable") is None

    def test_mysql_ssl_require_uses_encryption_without_verify(self):
        ctx = _mysql_ssl_context("require")
        assert isinstance(ctx, ssl.SSLContext)
        assert ctx.verify_mode == ssl.CERT_NONE
        assert ctx.check_hostname is False

    def test_mysql_ssl_verify_full_uses_default_context(self):
        ctx = _mysql_ssl_context("verify-full")
        assert isinstance(ctx, ssl.SSLContext)
        assert ctx.verify_mode == ssl.CERT_REQUIRED


class TestConnectMysql:
    def test_passes_ssl_context_when_required(self, monkeypatch):
        mock_pymysql = MagicMock()
        monkeypatch.setitem(sys.modules, "pymysql", mock_pymysql)
        connect_mysql(
            {"host": "h", "port": 3306, "ssl_mode": "require"},
            {"username": "u", "password": "p"},
        )
        kwargs = mock_pymysql.connect.call_args.kwargs
        assert "ssl" in kwargs
        assert isinstance(kwargs["ssl"], ssl.SSLContext)

    def test_no_ssl_when_disabled(self, monkeypatch):
        mock_pymysql = MagicMock()
        monkeypatch.setitem(sys.modules, "pymysql", mock_pymysql)
        connect_mysql(
            {"host": "h", "port": 3306, "ssl_mode": "disable"},
            {"username": "u", "password": "p"},
        )
        kwargs = mock_pymysql.connect.call_args.kwargs
        assert "ssl" not in kwargs

    def test_empty_database_becomes_none(self, monkeypatch):
        mock_pymysql = MagicMock()
        monkeypatch.setitem(sys.modules, "pymysql", mock_pymysql)
        connect_mysql(
            {"host": "h", "database": ""},
            {"username": "u", "password": "p"},
        )
        assert mock_pymysql.connect.call_args.kwargs["database"] is None


class TestConnectPostgres:
    def test_passes_sslmode(self, monkeypatch):
        mock_psycopg2 = MagicMock()
        mock_conn = MagicMock()
        mock_psycopg2.connect.return_value = mock_conn
        monkeypatch.setitem(sys.modules, "psycopg2", mock_psycopg2)
        connect_postgres(
            {"host": "h", "port": 5432, "ssl_mode": "verify-full"},
            {"username": "u", "password": "p"},
        )
        assert mock_psycopg2.connect.call_args.kwargs["sslmode"] == "verify-full"
        mock_conn.set_session.assert_called_once_with(autocommit=True)

    def test_default_dbname_is_postgres(self, monkeypatch):
        mock_psycopg2 = MagicMock()
        mock_conn = MagicMock()
        mock_psycopg2.connect.return_value = mock_conn
        monkeypatch.setitem(sys.modules, "psycopg2", mock_psycopg2)
        connect_postgres({"host": "h"}, {"username": "u", "password": "p"})
        assert mock_psycopg2.connect.call_args.kwargs["dbname"] == "postgres"

    def test_sets_statement_timeout(self, monkeypatch):
        mock_psycopg2 = MagicMock()
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_conn.cursor.return_value.__enter__ = MagicMock(return_value=mock_cursor)
        mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=False)
        mock_psycopg2.connect.return_value = mock_conn
        monkeypatch.setitem(sys.modules, "psycopg2", mock_psycopg2)
        connect_postgres({"host": "h"}, {"username": "u", "password": "p"}, timeout_ms=15000)
        mock_cursor.execute.assert_called_once_with("SET statement_timeout = 15000")
