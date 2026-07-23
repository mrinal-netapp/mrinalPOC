"""Unit tests for the Analytics Datasets MCP server (server.py).

All tests mock httpx and the FastMCP HTTP request context so they run without
any external dependencies (no analytics-engine required).
"""

import asyncio
import json
from unittest.mock import MagicMock, patch

import pytest

import server


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_response(status_code=200, json_body=None, text="", raise_on_json=False):
    """Build a mock httpx.Response."""
    resp = MagicMock()
    resp.status_code = status_code
    resp.text = text
    if raise_on_json:
        resp.json.side_effect = ValueError("not json")
    else:
        resp.json.return_value = json_body if json_body is not None else {}
    return resp


def _patch_httpx(resp):
    """Patch server.httpx.Client so _call_engine returns `resp` from .post()."""
    client_cm = MagicMock()
    client_cm.__enter__.return_value.post.return_value = resp
    client_cm.__exit__.return_value = False
    return patch.object(server.httpx, "Client", return_value=client_cm)


def _make_request(headers):
    """Build a mock Starlette request whose .headers.get mimics a header map."""
    req = MagicMock()
    lowered = {k.lower(): v for k, v in headers.items()}
    req.headers.get.side_effect = lambda name, default="": lowered.get(name.lower(), default)
    return req


def _tool(srv, name):
    """Return the underlying function for a registered tool.

    Works across FastMCP versions: older builds expose
    ``_tool_manager._tools``; newer ones use the async ``get_tool``.
    """
    tm = getattr(srv, "_tool_manager", None)
    if tm is not None and hasattr(tm, "_tools"):
        return tm._tools[name].fn
    return asyncio.run(srv.get_tool(name)).fn


def _tool_names(srv):
    tm = getattr(srv, "_tool_manager", None)
    if tm is not None and hasattr(tm, "_tools"):
        return set(tm._tools.keys())
    tools = asyncio.run(srv.list_tools())
    return {t.name for t in tools}


def _run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# _build_headers
# ---------------------------------------------------------------------------

class TestBuildHeaders:
    def test_forwards_all_headers(self):
        req = _make_request({
            "authorization": "Bearer abc",
            "x-project-id": "proj1",
            "x-user-id": "user1",
        })
        with patch.object(server, "get_http_request", return_value=req):
            hdrs = server._build_headers()
        assert hdrs == {
            "Authorization": "Bearer abc",
            "X-Project-ID": "proj1",
            "X-User-ID": "user1",
        }

    def test_skips_empty_values(self):
        req = _make_request({"authorization": "Bearer abc"})
        with patch.object(server, "get_http_request", return_value=req):
            hdrs = server._build_headers()
        assert hdrs == {"Authorization": "Bearer abc"}
        assert "X-Project-ID" not in hdrs

    def test_returns_empty_on_exception(self):
        with patch.object(server, "get_http_request", side_effect=RuntimeError("no ctx")):
            hdrs = server._build_headers()
        assert hdrs == {}


# ---------------------------------------------------------------------------
# _call_engine
# ---------------------------------------------------------------------------

class TestCallEngine:
    def test_success_returns_parsed_json(self):
        resp = _make_response(200, {"rows": [1, 2, 3]})
        with _patch_httpx(resp):
            result = server._call_engine("/api/v1/agent/datasets", {}, {})
        assert result == {"rows": [1, 2, 3]}

    def test_posts_to_correct_url_and_headers(self):
        resp = _make_response(200, {"ok": True})
        with _patch_httpx(resp) as client_patch:
            server._call_engine("/api/v1/agent/query", {"query": "SELECT 1"}, {"X-Project-ID": "p1"})
        client_cm = client_patch.return_value
        post = client_cm.__enter__.return_value.post
        args, kwargs = post.call_args
        assert args[0] == f"{server.ANALYTICS_ENGINE_URL}/api/v1/agent/query"
        assert kwargs["json"] == {"query": "SELECT 1"}
        assert kwargs["headers"]["X-Project-ID"] == "p1"
        assert kwargs["headers"]["Content-Type"] == "application/json"

    def test_401_returns_auth_error(self):
        resp = _make_response(401)
        with _patch_httpx(resp):
            result = server._call_engine("/x", {}, {})
        assert result["status"] == 401
        assert "expired" in result["error"]

    def test_403_returns_access_denied(self):
        resp = _make_response(403)
        with _patch_httpx(resp):
            result = server._call_engine("/x", {}, {})
        assert result["status"] == 403
        assert "Access denied" in result["error"]

    def test_403_passes_through_engine_rejection_reason(self):
        resp = _make_response(
            403,
            {"error": "query rejected: access denied: catalog \"\" not allowed (only 'iceberg')"},
        )
        with _patch_httpx(resp):
            result = server._call_engine("/x", {}, {})
        assert result["status"] == 403
        assert "query rejected" in result["error"]
        assert "catalog" in result["error"]

    def test_429_returns_rate_limited(self):
        resp = _make_response(429)
        with _patch_httpx(resp):
            result = server._call_engine("/x", {}, {})
        assert result["status"] == 429
        assert "Too many requests" in result["error"]

    def test_4xx_with_json_detail(self):
        resp = _make_response(400, {"detail": "bad sql"})
        with _patch_httpx(resp):
            result = server._call_engine("/x", {}, {})
        assert result["status"] == 400
        assert "bad sql" in result["error"]

    def test_4xx_with_json_error_field(self):
        resp = _make_response(422, {"error": "schema mismatch"})
        with _patch_httpx(resp):
            result = server._call_engine("/x", {}, {})
        assert result["status"] == 422
        assert "schema mismatch" in result["error"]

    def test_5xx_with_non_json_body(self):
        resp = _make_response(500, raise_on_json=True, text="upstream boom")
        with _patch_httpx(resp):
            result = server._call_engine("/x", {}, {})
        assert result["status"] == 500
        assert "upstream boom" in result["error"]


# ---------------------------------------------------------------------------
# Tools — engine path + payload + project_id injection
# ---------------------------------------------------------------------------

class TestTools:
    def setup_method(self):
        self.srv = server.create_server()

    def test_list_datasets(self):
        with patch.object(server, "_build_headers", return_value={}), \
             patch.object(server, "_call_engine", return_value={"tables": []}) as call:
            out = _run(_tool(self.srv, "list_datasets")(project_id="p1"))
        call.assert_called_once()
        path, payload, hdrs = call.call_args[0]
        assert path == "/api/v1/agent/datasets"
        assert payload == {}
        assert hdrs["X-Project-ID"] == "p1"
        assert json.loads(out) == {"tables": []}

    def test_describe_table(self):
        with patch.object(server, "_build_headers", return_value={}), \
             patch.object(server, "_call_engine", return_value={"cols": []}) as call:
            _run(_tool(self.srv, "describe_table")(table="t1", project_id="p1"))
        path, payload, _ = call.call_args[0]
        assert path == "/api/v1/agent/describe"
        assert payload == {"table": "t1"}

    def test_dataset_stats(self):
        with patch.object(server, "_build_headers", return_value={}), \
             patch.object(server, "_call_engine", return_value={"stats": {}}) as call:
            _run(_tool(self.srv, "dataset_stats")(table="t1"))
        path, payload, _ = call.call_args[0]
        assert path == "/api/v1/agent/stats"
        assert payload == {"table": "t1"}

    def test_dataset_histogram(self):
        with patch.object(server, "_build_headers", return_value={}), \
             patch.object(server, "_call_engine", return_value={"buckets": []}) as call:
            _run(_tool(self.srv, "dataset_histogram")(table="t1", column="age"))
        path, payload, _ = call.call_args[0]
        assert path == "/api/v1/agent/histogram"
        assert payload == {"table": "t1", "column": "age"}

    def test_project_id_not_injected_when_header_present(self):
        with patch.object(server, "_build_headers", return_value={"X-Project-ID": "from-header"}), \
             patch.object(server, "_call_engine", return_value={}) as call:
            _run(_tool(self.srv, "list_datasets")(project_id="from-arg"))
        _, _, hdrs = call.call_args[0]
        assert hdrs["X-Project-ID"] == "from-header"

    def test_preview_dataset_clamps_limit(self):
        with patch.object(server, "_build_headers", return_value={}), \
             patch.object(server, "_call_engine", return_value={"rows": []}) as call:
            _run(_tool(self.srv, "preview_dataset")(table="t1", limit=9999))
        path, payload, _ = call.call_args[0]
        assert path == "/api/v1/agent/preview"
        assert payload["limit"] == server.MAX_ROWS

    def test_preview_dataset_keeps_small_limit(self):
        with patch.object(server, "_build_headers", return_value={}), \
             patch.object(server, "_call_engine", return_value={"rows": []}) as call:
            _run(_tool(self.srv, "preview_dataset")(table="t1", limit=10))
        _, payload, _ = call.call_args[0]
        assert payload["limit"] == 10


# ---------------------------------------------------------------------------
# Tool — execute_query branches
# ---------------------------------------------------------------------------

class TestExecuteQuery:
    def setup_method(self):
        self.srv = server.create_server()

    def test_success(self):
        with patch.object(server, "_build_headers", return_value={}), \
             patch.object(server, "_call_engine", return_value={"rows": [[1]]}) as call:
            out = _run(_tool(self.srv, "execute_query")(sql="SELECT 1"))
        path, payload, _ = call.call_args[0]
        assert path == "/api/v1/agent/query"
        assert payload == {"query": "SELECT 1"}
        assert json.loads(out) == {"rows": [[1]]}

    def test_error_passthrough(self):
        with patch.object(server, "_build_headers", return_value={}), \
             patch.object(server, "_call_engine", return_value={"error": "denied", "status": 403}):
            out = _run(_tool(self.srv, "execute_query")(sql="SELECT 1"))
        assert json.loads(out) == {"error": "denied", "status": 403}

    def test_response_too_large(self, monkeypatch):
        monkeypatch.setattr(server, "MAX_RESPONSE_BYTES", 10)
        with patch.object(server, "_build_headers", return_value={}), \
             patch.object(server, "_call_engine", return_value={"data": "x" * 100}):
            out = _run(_tool(self.srv, "execute_query")(sql="SELECT 1"))
        parsed = json.loads(out)
        assert parsed["truncated"] is True
        assert "Response too large" in parsed["error"]


# ---------------------------------------------------------------------------
# create_server smoke
# ---------------------------------------------------------------------------

class TestCreateServer:
    def test_registers_expected_tools(self):
        srv = server.create_server()
        names = _tool_names(srv)
        assert names == {
            "list_datasets",
            "describe_table",
            "execute_query",
            "preview_dataset",
            "dataset_stats",
            "dataset_histogram",
        }


# ---------------------------------------------------------------------------
# Health endpoint + middleware + app
# ---------------------------------------------------------------------------

class TestHealth:
    def test_health_handler(self):
        resp = _run(server._health(MagicMock()))
        assert resp.status_code == 200
        assert json.loads(bytes(resp.body)) == {"status": "ok"}

    def test_middleware_answers_health_paths(self):
        mw = server._KubernetesHealthMiddleware(app=MagicMock())
        for path in ("/health", "/healthz", "/healthz/"):
            req = MagicMock()
            req.method = "GET"
            req.url.path = path
            call_next = MagicMock()
            resp = _run(mw.dispatch(req, call_next))
            assert resp.status_code == 200
            call_next.assert_not_called()

    def test_middleware_passes_through_non_health(self):
        mw = server._KubernetesHealthMiddleware(app=MagicMock())
        req = MagicMock()
        req.method = "GET"
        req.url.path = "/mcp"
        sentinel = MagicMock()

        async def _next(_req):
            return sentinel

        resp = _run(mw.dispatch(req, _next))
        assert resp is sentinel

    def test_middleware_passes_through_non_get(self):
        mw = server._KubernetesHealthMiddleware(app=MagicMock())
        req = MagicMock()
        req.method = "POST"
        req.url.path = "/health"
        sentinel = MagicMock()

        async def _next(_req):
            return sentinel

        resp = _run(mw.dispatch(req, _next))
        assert resp is sentinel

    def test_create_app_builds_starlette(self):
        app = server.create_app()
        paths = {getattr(r, "path", None) for r in app.routes}
        assert "/health" in paths
        assert "/healthz" in paths
