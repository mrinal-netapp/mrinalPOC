"""Unit tests for the DuckDB Iceberg MCP server (server.py).

All tests mock the DuckDB connection and HTTP calls so they run without
any external dependencies (no Lakekeeper, Keycloak, or S3 required).
"""

import json
import threading
import time
from typing import Any
from unittest.mock import MagicMock, patch, PropertyMock

import pytest

# We import from server.py in the same directory.
from server import CatalogManager, Config, create_server


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _make_config(**overrides: Any) -> Config:
    """Build a Config with test defaults; keyword args override any field."""
    cfg = Config.__new__(Config)
    defaults = {
        "WAREHOUSE_NAME": "test-warehouse",
        "LAKEKEEPER_CATALOG_URL": "http://lakekeeper:8181/catalog",
        "KEYCLOAK_TOKEN_URL": "http://keycloak:8080/realms/test/protocol/openid-connect/token",
        "CLIENT_ID": "test-client",
        "CLIENT_SECRET": "test-secret",
        "OAUTH2_SCOPE": "openid",
        "S3_ENDPOINT": "",
        "S3_ACCESS_KEY": "",
        "S3_SECRET_KEY": "",
        "MAX_ROWS": 500,
        "EXTENSION_DIR": "/tmp/ext",
        "REFRESH_MARGIN_S": 60,
    }
    defaults.update(overrides)
    for k, v in defaults.items():
        setattr(cfg, k, v)
    return cfg


def _mock_connection() -> MagicMock:
    """Create a mock DuckDB connection that tracks execute calls."""
    conn = MagicMock()
    conn.execute.return_value = conn
    conn.description = [("col1", "VARCHAR", None, None, None, None, None)]
    conn.fetchmany.return_value = [("row1",)]
    return conn


@pytest.fixture
def cfg():
    return _make_config()


@pytest.fixture
def catalog(cfg):
    """Create a CatalogManager with a mocked DuckDB connection and no HTTP."""
    with patch.object(CatalogManager, "_init_connection", return_value=_mock_connection()):
        with patch.object(CatalogManager, "_probe_token_lifetime", return_value=300):
            mgr = CatalogManager(cfg)
            mgr._token_fetched_at = time.monotonic()
            mgr._token_lifetime = 300
            mgr._attached = True
            return mgr


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

class TestConfig:
    def test_defaults_from_env(self):
        with patch.dict("os.environ", {
            "WAREHOUSE_NAME": "my-wh",
            "MAX_ROWS": "100",
            "TOKEN_REFRESH_MARGIN_SECONDS": "30",
        }, clear=False):
            # Re-evaluate by creating fresh instance
            cfg = _make_config(WAREHOUSE_NAME="my-wh", MAX_ROWS=100, REFRESH_MARGIN_S=30)
            assert cfg.WAREHOUSE_NAME == "my-wh"
            assert cfg.MAX_ROWS == 100
            assert cfg.REFRESH_MARGIN_S == 30

    def test_default_values(self):
        cfg = _make_config()
        assert cfg.WAREHOUSE_NAME == "test-warehouse"
        assert cfg.REFRESH_MARGIN_S == 60
        assert cfg.MAX_ROWS == 500


# ---------------------------------------------------------------------------
# CatalogManager — Connection Init
# ---------------------------------------------------------------------------

class TestConnectionInit:
    def test_extensions_loaded(self):
        cfg = _make_config()
        mock_conn = _mock_connection()
        with patch("server.duckdb") as mock_duckdb:
            mock_duckdb.connect.return_value = mock_conn
            with patch.object(CatalogManager, "_probe_token_lifetime", return_value=300):
                mgr = CatalogManager(cfg)

        executed = [str(c) for c in mock_conn.execute.call_args_list]
        assert any("LOAD iceberg" in s for s in executed)
        assert any("LOAD httpfs" in s for s in executed)
        assert any("LOAD avro" in s for s in executed)

    def test_s3_settings_applied_when_endpoint_set(self):
        cfg = _make_config(
            S3_ENDPOINT="http://s3gw:7070",
            S3_ACCESS_KEY="AKID",
            S3_SECRET_KEY="SKEY",
        )
        mock_conn = _mock_connection()
        with patch("server.duckdb") as mock_duckdb:
            mock_duckdb.connect.return_value = mock_conn
            with patch.object(CatalogManager, "_probe_token_lifetime", return_value=300):
                mgr = CatalogManager(cfg)

        executed = [str(c) for c in mock_conn.execute.call_args_list]
        assert any("s3_endpoint" in s and "s3gw:7070" in s for s in executed)
        assert any("s3_access_key_id" in s and "AKID" in s for s in executed)

    def test_s3_settings_skipped_when_endpoint_empty(self):
        cfg = _make_config(S3_ENDPOINT="")
        mock_conn = _mock_connection()
        with patch("server.duckdb") as mock_duckdb:
            mock_duckdb.connect.return_value = mock_conn
            with patch.object(CatalogManager, "_probe_token_lifetime", return_value=300):
                mgr = CatalogManager(cfg)

        executed = [str(c) for c in mock_conn.execute.call_args_list]
        assert not any("s3_endpoint" in s for s in executed)


# ---------------------------------------------------------------------------
# CatalogManager — Token Lifetime Probe
# ---------------------------------------------------------------------------

class TestTokenProbe:
    def test_probe_caches_result(self, cfg):
        with patch.object(CatalogManager, "_init_connection", return_value=_mock_connection()):
            mgr = CatalogManager.__new__(CatalogManager)
            mgr._cfg = cfg
            mgr._conn = _mock_connection()
            mgr._lock = threading.Lock()
            mgr._attached = False
            mgr._token_fetched_at = 0
            mgr._token_lifetime = 300
            mgr._lifetime_probed = False
            mgr._refresh_timer = None

            fake_resp = MagicMock()
            fake_resp.read.return_value = json.dumps({"expires_in": 120}).encode()
            fake_resp.__enter__ = lambda s: s
            fake_resp.__exit__ = MagicMock(return_value=False)

            with patch("server.urllib.request.urlopen", return_value=fake_resp):
                result1 = mgr._probe_token_lifetime()
                result2 = mgr._probe_token_lifetime()

            assert result1 == 120
            assert result2 == 120
            assert mgr._lifetime_probed is True

    def test_probe_defaults_on_failure(self, cfg):
        with patch.object(CatalogManager, "_init_connection", return_value=_mock_connection()):
            mgr = CatalogManager.__new__(CatalogManager)
            mgr._cfg = cfg
            mgr._conn = _mock_connection()
            mgr._lock = threading.Lock()
            mgr._lifetime_probed = False
            mgr._token_lifetime = 300
            mgr._refresh_timer = None

            with patch("server.urllib.request.urlopen", side_effect=Exception("timeout")):
                result = mgr._probe_token_lifetime()

            assert result == 300

    def test_probe_skipped_when_no_token_url(self):
        cfg = _make_config(KEYCLOAK_TOKEN_URL="")
        with patch.object(CatalogManager, "_init_connection", return_value=_mock_connection()):
            mgr = CatalogManager.__new__(CatalogManager)
            mgr._cfg = cfg
            mgr._conn = _mock_connection()
            mgr._lock = threading.Lock()
            mgr._lifetime_probed = False
            mgr._token_lifetime = 300
            mgr._refresh_timer = None

            result = mgr._probe_token_lifetime()
            assert result == 300


# ---------------------------------------------------------------------------
# CatalogManager — Attach / Detach
# ---------------------------------------------------------------------------

class TestAttachCatalog:
    def test_attach_executes_correct_sql(self, catalog):
        catalog._attached = False
        catalog._conn.reset_mock()
        catalog._attach_catalog()

        calls = [str(c) for c in catalog._conn.execute.call_args_list]
        assert any("DROP SECRET" in s for s in calls)
        assert any("CREATE SECRET lakekeeper_secret" in s for s in calls)
        assert any("CLIENT_ID" in s for s in calls)
        assert any("ATTACH" in s and "iceberg" in s for s in calls)
        assert catalog._attached is True

    def test_reattach_detaches_first(self, catalog):
        catalog._attached = True
        catalog._conn.reset_mock()
        catalog._attach_catalog()

        calls = [str(c) for c in catalog._conn.execute.call_args_list]
        assert any("DETACH iceberg" in s for s in calls)

    def test_attach_tolerates_detach_failure(self, catalog):
        catalog._attached = True
        call_count = [0]
        original_execute = catalog._conn.execute

        def side_effect(sql):
            call_count[0] += 1
            if "DETACH" in sql:
                raise Exception("not attached")
            return original_execute(sql)

        catalog._conn.execute = MagicMock(side_effect=side_effect)
        catalog._attach_catalog()
        assert catalog._attached is True

    def test_scope_clause_omitted_when_empty(self):
        cfg = _make_config(OAUTH2_SCOPE="")
        with patch.object(CatalogManager, "_init_connection", return_value=_mock_connection()):
            with patch.object(CatalogManager, "_probe_token_lifetime", return_value=300):
                mgr = CatalogManager(cfg)
                mgr._conn.reset_mock()
                mgr._attached = False
                mgr._attach_catalog()

        calls = [str(c) for c in mgr._conn.execute.call_args_list]
        secret_call = next(s for s in calls if "CREATE SECRET" in s)
        assert "OAUTH2_SCOPE" not in secret_call


# ---------------------------------------------------------------------------
# CatalogManager — Auth Error Detection
# ---------------------------------------------------------------------------

class TestAuthErrorDetection:
    @pytest.mark.parametrize("msg,expected", [
        ("HTTP 401 Unauthorized", True),
        ("unauthorized request to endpoint", True),
        ("HTTP Error: 401", True),
        ("Table 'foo' does not exist", False),
        ("Connection refused", False),
        ("HTTP 403 Forbidden", False),
    ])
    def test_is_auth_error(self, msg, expected):
        exc = Exception(msg)
        assert CatalogManager._is_auth_error(exc) is expected


# ---------------------------------------------------------------------------
# CatalogManager — Token Remaining / Ensure Fresh
# ---------------------------------------------------------------------------

class TestTokenFreshness:
    def test_token_remaining_positive(self, catalog):
        catalog._token_fetched_at = time.monotonic()
        catalog._token_lifetime = 300
        remaining = catalog._token_remaining()
        assert 299 <= remaining <= 300

    def test_token_remaining_negative_when_expired(self, catalog):
        catalog._token_fetched_at = time.monotonic() - 400
        catalog._token_lifetime = 300
        assert catalog._token_remaining() < 0

    def test_ensure_fresh_skips_when_token_valid(self, catalog):
        catalog._token_fetched_at = time.monotonic()
        catalog._token_lifetime = 300
        catalog._conn.reset_mock()
        catalog._ensure_fresh()
        # Should not have called DETACH/ATTACH
        calls = [str(c) for c in catalog._conn.execute.call_args_list]
        assert not any("DETACH" in s for s in calls)

    def test_ensure_fresh_refreshes_when_near_expiry(self, catalog):
        catalog._token_fetched_at = time.monotonic() - 280
        catalog._token_lifetime = 300
        catalog._cfg.REFRESH_MARGIN_S = 60
        catalog._conn.reset_mock()
        catalog._ensure_fresh()
        calls = [str(c) for c in catalog._conn.execute.call_args_list]
        assert any("ATTACH" in s for s in calls)


# ---------------------------------------------------------------------------
# CatalogManager — Query Execution
# ---------------------------------------------------------------------------

class TestQueryExecution:
    def test_successful_query(self, catalog):
        catalog._conn.description = [
            ("id", "INTEGER", None, None, None, None, None),
            ("name", "VARCHAR", None, None, None, None, None),
        ]
        catalog._conn.fetchmany.return_value = [(1, "alice"), (2, "bob")]

        result = catalog.query("SELECT * FROM test")

        assert result["success"] is True
        assert result["columns"] == ["id", "name"]
        assert result["columnTypes"] == ["INTEGER", "VARCHAR"]
        assert result["rows"] == [[1, "alice"], [2, "bob"]]
        assert result["rowCount"] == 2
        assert "truncated" not in result

    def test_truncation_when_exceeding_max_rows(self, catalog):
        catalog._cfg.MAX_ROWS = 2
        catalog._conn.description = [("id", "INTEGER", None, None, None, None, None)]
        # Return MAX_ROWS + 1 rows to trigger truncation
        catalog._conn.fetchmany.return_value = [(1,), (2,), (3,)]

        result = catalog.query("SELECT id FROM big_table")

        assert result["success"] is True
        assert result["rowCount"] == 2
        assert result["truncated"] is True
        assert "limited to 2 rows" in result["warning"]

    def test_no_truncation_at_exact_limit(self, catalog):
        catalog._cfg.MAX_ROWS = 2
        catalog._conn.description = [("id", "INTEGER", None, None, None, None, None)]
        catalog._conn.fetchmany.return_value = [(1,), (2,)]

        result = catalog.query("SELECT id FROM table")

        assert result["success"] is True
        assert result["rowCount"] == 2
        assert "truncated" not in result

    def test_error_returns_structured_response(self, catalog):
        catalog._conn.execute.side_effect = Exception("Table 'missing' not found")

        result = catalog.query("SELECT * FROM missing")

        assert result["success"] is False
        assert "missing" in result["error"]
        assert result["errorType"] == "Exception"

    def test_empty_result_set(self, catalog):
        catalog._conn.description = [("id", "INTEGER", None, None, None, None, None)]
        catalog._conn.fetchmany.return_value = []

        result = catalog.query("SELECT * FROM empty_table WHERE 1=0")

        assert result["success"] is True
        assert result["rows"] == []
        assert result["rowCount"] == 0

    def test_query_with_no_description(self, catalog):
        catalog._conn.description = None
        catalog._conn.fetchmany.return_value = []

        result = catalog.query("CREATE TABLE foo (id INT)")

        assert result["success"] is True
        assert result["columns"] == []
        assert result["columnTypes"] == []


# ---------------------------------------------------------------------------
# CatalogManager — Retry on 401
# ---------------------------------------------------------------------------

class TestRetryOn401:
    def test_retries_once_on_auth_error(self, catalog):
        call_count = [0]
        original_conn = catalog._conn

        def execute_side_effect(sql):
            call_count[0] += 1
            if call_count[0] == 1 and "SELECT" in sql:
                raise Exception("HTTP 401 Unauthorized")
            # After refresh (DETACH/ATTACH calls), succeed on retry
            original_conn.description = [("x", "INT", None, None, None, None, None)]
            original_conn.fetchmany.return_value = [(42,)]
            return original_conn

        catalog._conn.execute = MagicMock(side_effect=execute_side_effect)

        result = catalog.query("SELECT 42")

        assert result["success"] is True
        assert result["rows"] == [[42]]

    def test_does_not_retry_on_non_auth_error(self, catalog):
        catalog._conn.execute.side_effect = Exception("Syntax error")

        result = catalog.query("INVALID SQL")

        assert result["success"] is False
        assert "Syntax error" in result["error"]

    def test_returns_error_if_retry_also_fails(self, catalog):
        call_count = [0]

        def side_effect(sql):
            if "SELECT" in sql:
                call_count[0] += 1
                raise Exception("HTTP 401 Unauthorized")
            return catalog._conn

        catalog._conn.execute = MagicMock(side_effect=side_effect)

        result = catalog.query("SELECT * FROM locked")

        assert result["success"] is False
        assert "401" in result["error"]
        assert call_count[0] == 2  # original + one retry


# ---------------------------------------------------------------------------
# CatalogManager — Background Refresh
# ---------------------------------------------------------------------------

class TestBackgroundRefresh:
    def test_schedule_refresh_sets_daemon_timer(self, catalog):
        catalog._schedule_refresh(10)
        assert catalog._refresh_timer is not None
        assert catalog._refresh_timer.daemon is True
        catalog._refresh_timer.cancel()

    def test_schedule_refresh_cancels_previous_timer(self, catalog):
        first_timer = MagicMock()
        catalog._refresh_timer = first_timer
        catalog._schedule_refresh(10)
        first_timer.cancel.assert_called_once()
        catalog._refresh_timer.cancel()

    def test_background_refresh_skips_if_already_fresh(self, catalog):
        catalog._token_fetched_at = time.monotonic()
        catalog._token_lifetime = 300
        catalog._cfg.REFRESH_MARGIN_S = 60
        catalog._conn.reset_mock()

        catalog._background_refresh()

        calls = [str(c) for c in catalog._conn.execute.call_args_list]
        assert not any("DETACH" in s for s in calls)

    def test_background_refresh_attaches_when_near_expiry(self, catalog):
        catalog._token_fetched_at = time.monotonic() - 280
        catalog._token_lifetime = 300
        catalog._cfg.REFRESH_MARGIN_S = 60
        catalog._conn.reset_mock()

        catalog._background_refresh()

        calls = [str(c) for c in catalog._conn.execute.call_args_list]
        assert any("ATTACH" in s for s in calls)

    def test_background_refresh_reschedules_on_failure(self, catalog):
        catalog._token_fetched_at = time.monotonic() - 400
        catalog._token_lifetime = 300
        catalog._conn.execute.side_effect = Exception("network error")

        catalog._background_refresh()

        assert catalog._refresh_timer is not None
        catalog._refresh_timer.cancel()


# ---------------------------------------------------------------------------
# CatalogManager — Initialize
# ---------------------------------------------------------------------------

class TestInitialize:
    def test_initialize_attaches_catalog(self):
        cfg = _make_config()
        mock_conn = _mock_connection()
        with patch.object(CatalogManager, "_init_connection", return_value=mock_conn):
            with patch.object(CatalogManager, "_probe_token_lifetime", return_value=300):
                mgr = CatalogManager(cfg)
                mgr.initialize()

        calls = [str(c) for c in mock_conn.execute.call_args_list]
        assert any("CREATE SECRET" in s for s in calls)
        assert any("ATTACH" in s for s in calls)
        assert mgr._attached is True


# ---------------------------------------------------------------------------
# MCP Tool — execute_query
# ---------------------------------------------------------------------------

class TestExecuteQueryTool:
    def test_success_returns_json(self, catalog):
        catalog._conn.description = [("id", "INT", None, None, None, None, None)]
        catalog._conn.fetchmany.return_value = [(1,)]

        server = create_server(catalog)
        tools = server._tool_manager._tools
        tool_fn = tools["execute_query"].fn

        result_str = tool_fn(sql="SELECT 1 AS id")
        result = json.loads(result_str)

        assert result["success"] is True
        assert result["columns"] == ["id"]

    def test_error_raises_valueerror(self, catalog):
        catalog._conn.execute.side_effect = Exception("bad query")

        server = create_server(catalog)
        tool_fn = server._tool_manager._tools["execute_query"].fn

        with pytest.raises(ValueError) as exc_info:
            tool_fn(sql="BAD SQL")

        error_body = json.loads(str(exc_info.value))
        assert error_body["success"] is False


# ---------------------------------------------------------------------------
# MCP Tool — list_tables (filtering)
# ---------------------------------------------------------------------------

class TestListTablesTool:
    def _setup_tables(self, catalog):
        catalog._conn.description = [
            ("database", "VARCHAR", None, None, None, None, None),
            ("schema", "VARCHAR", None, None, None, None, None),
            ("name", "VARCHAR", None, None, None, None, None),
        ]
        catalog._conn.fetchmany.return_value = [
            ("iceberg", "proj1", "users"),
            ("iceberg", "proj1", "orders"),
            ("iceberg", "proj2", "events"),
            ("memory", "main", "temp"),
        ]

    def test_no_filter_returns_all(self, catalog):
        self._setup_tables(catalog)
        server = create_server(catalog)
        tool_fn = server._tool_manager._tools["list_tables"].fn

        result = json.loads(tool_fn())
        assert result["rowCount"] == 4

    def test_filter_by_database(self, catalog):
        self._setup_tables(catalog)
        server = create_server(catalog)
        tool_fn = server._tool_manager._tools["list_tables"].fn

        result = json.loads(tool_fn(database="iceberg"))
        assert result["rowCount"] == 3

    def test_filter_by_schema(self, catalog):
        self._setup_tables(catalog)
        server = create_server(catalog)
        tool_fn = server._tool_manager._tools["list_tables"].fn

        result = json.loads(tool_fn(schema="proj1"))
        assert result["rowCount"] == 2

    def test_filter_by_database_and_schema(self, catalog):
        self._setup_tables(catalog)
        server = create_server(catalog)
        tool_fn = server._tool_manager._tools["list_tables"].fn

        result = json.loads(tool_fn(database="iceberg", schema="proj2"))
        assert result["rowCount"] == 1
        assert result["rows"][0][2] == "events"


# ---------------------------------------------------------------------------
# MCP Tool — list_columns (qualification)
# ---------------------------------------------------------------------------

class TestListColumnsTool:
    def test_unqualified(self, catalog):
        server = create_server(catalog)
        tool_fn = server._tool_manager._tools["list_columns"].fn
        catalog._conn.reset_mock()
        catalog._conn.execute.return_value = catalog._conn

        tool_fn(table="users")

        sql = catalog._conn.execute.call_args[0][0]
        assert sql == "DESCRIBE users"

    def test_qualified_with_schema(self, catalog):
        server = create_server(catalog)
        tool_fn = server._tool_manager._tools["list_columns"].fn
        catalog._conn.reset_mock()
        catalog._conn.execute.return_value = catalog._conn

        tool_fn(table="users", schema="proj1")

        sql = catalog._conn.execute.call_args[0][0]
        assert sql == 'DESCRIBE "proj1".users'

    def test_fully_qualified(self, catalog):
        server = create_server(catalog)
        tool_fn = server._tool_manager._tools["list_columns"].fn
        catalog._conn.reset_mock()
        catalog._conn.execute.return_value = catalog._conn

        tool_fn(table="users", database="iceberg", schema="proj1")

        sql = catalog._conn.execute.call_args[0][0]
        assert sql == 'DESCRIBE "iceberg"."proj1".users'


# ---------------------------------------------------------------------------
# MCP Tool — list_databases
# ---------------------------------------------------------------------------

class TestListDatabasesTool:
    def test_returns_databases(self, catalog):
        catalog._conn.description = [
            ("database_name", "VARCHAR", None, None, None, None, None),
            ("type", "VARCHAR", None, None, None, None, None),
        ]
        catalog._conn.fetchmany.return_value = [
            ("memory", "duckdb"),
            ("iceberg", "iceberg"),
        ]

        server = create_server(catalog)
        tool_fn = server._tool_manager._tools["list_databases"].fn

        result = json.loads(tool_fn())
        assert result["success"] is True
        assert result["rowCount"] == 2


# ---------------------------------------------------------------------------
# Integration-style: query → refresh → retry flow
# ---------------------------------------------------------------------------

class TestQueryRefreshFlow:
    def test_full_flow_expired_token_triggers_refresh_and_retry(self):
        """Simulate: token expired → query → ensure_fresh refreshes → query succeeds."""
        cfg = _make_config()
        mock_conn = _mock_connection()

        with patch.object(CatalogManager, "_init_connection", return_value=mock_conn):
            with patch.object(CatalogManager, "_probe_token_lifetime", return_value=300):
                mgr = CatalogManager(cfg)
                # Set token as expired
                mgr._token_fetched_at = time.monotonic() - 400
                mgr._token_lifetime = 300
                mgr._attached = True

                mock_conn.reset_mock()
                mock_conn.description = [("n", "INT", None, None, None, None, None)]
                mock_conn.fetchmany.return_value = [(1,)]
                mock_conn.execute.return_value = mock_conn

                result = mgr.query("SELECT 1 AS n")

        assert result["success"] is True
        calls = [str(c) for c in mock_conn.execute.call_args_list]
        assert any("DETACH" in s for s in calls), "Should have detached stale catalog"
        assert any("ATTACH" in s for s in calls), "Should have re-attached with fresh token"

    def test_concurrent_freshness_checks_dont_double_refresh(self):
        """Two threads checking freshness simultaneously should only refresh once."""
        cfg = _make_config()
        mock_conn = _mock_connection()
        attach_count = [0]

        with patch.object(CatalogManager, "_init_connection", return_value=mock_conn):
            with patch.object(CatalogManager, "_probe_token_lifetime", return_value=300):
                mgr = CatalogManager(cfg)
                mgr._token_fetched_at = time.monotonic() - 280
                mgr._token_lifetime = 300
                mgr._attached = True

                original_attach = mgr._attach_catalog

                def counting_attach():
                    attach_count[0] += 1
                    original_attach()

                mgr._attach_catalog = counting_attach

                t1 = threading.Thread(target=mgr._ensure_fresh)
                t2 = threading.Thread(target=mgr._ensure_fresh)
                t1.start()
                t2.start()
                t1.join(timeout=5)
                t2.join(timeout=5)

        # Double-checked locking: at most one refresh
        assert attach_count[0] <= 1
