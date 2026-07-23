"""Unit tests for ANF MCP server tool gating, handlers, and audit redaction."""
from __future__ import annotations

import importlib
import json
import os
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

_IMAGE_ROOT = Path(__file__).resolve().parents[1]
if str(_IMAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(_IMAGE_ROOT))

_POOL_ARM_ID = (
    "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-anf-dev/"
    "providers/Microsoft.NetApp/netAppAccounts/acct1/capacityPools/pool1"
)
_VOLUME_ARM_ID = f"{_POOL_ARM_ID}/volumes/vol1"
_ALL_TOOLS = (
    "anf_capacity_pool_list,anf_capacity_pool_get,anf_volume_list,anf_volume_get,"
    "anf_resize_capacity_pool,anf_resize_volume"
)
_BASE_ENV = {
    "AZURE_SUBSCRIPTION_ID": "00000000-0000-0000-0000-000000000001",
    "AZURE_DEFAULT_REGION": "eastus",
    "AZURE_TENANT_ID": "tenant",
    "AZURE_CLIENT_ID": "client",
    "AZURE_CLIENT_SECRET": "secret-value",
}


def _install_mcp_stub() -> None:
    fastmcp = types.ModuleType("mcp.server.fastmcp")

    class _StubFastMCP:
        def __init__(self, name: str) -> None:
            self.name = name

        def tool(self):
            def decorator(fn):
                return fn

            return decorator

        def run(self) -> None:
            return None

    fastmcp.FastMCP = _StubFastMCP
    mcp_pkg = types.ModuleType("mcp")
    mcp_server = types.ModuleType("mcp.server")
    mcp_pkg.server = mcp_server
    mcp_server.fastmcp = fastmcp
    sys.modules["mcp"] = mcp_pkg
    sys.modules["mcp.server"] = mcp_server
    sys.modules["mcp.server.fastmcp"] = fastmcp


def _reload_server(*, allowed_tools: str = "", extra_env: dict | None = None) -> object:
    _install_mcp_stub()
    env = {
        "AZURE_SUBSCRIPTION_ID": "00000000-0000-0000-0000-000000000001",
        "AZURE_DEFAULT_REGION": "eastus",
        "AZURE_TENANT_ID": "tenant",
        "AZURE_CLIENT_ID": "client",
        "AZURE_CLIENT_SECRET": "secret-value",
        "ANF_ALLOWED_TOOLS": allowed_tools,
    }
    if extra_env:
        env.update(extra_env)
    with patch.dict(os.environ, env, clear=False):
        if "server" in sys.modules:
            del sys.modules["server"]
        with patch("anf_common.build_credential"):
            return importlib.import_module("server")


def _mock_client() -> MagicMock:
    client = MagicMock()
    client.list_capacity_pools.return_value = [{"id": _POOL_ARM_ID, "name": "pool1"}]
    client.get_capacity_pool.return_value = {"id": _POOL_ARM_ID, "properties": {"size": 1 << 40}}
    client.list_volumes.return_value = [{"volume_id": _VOLUME_ARM_ID, "volume_name": "vol1"}]
    client.get_volume.return_value = {"id": _VOLUME_ARM_ID, "properties": {}}
    client.patch_capacity_pool_size.return_value = {"id": _POOL_ARM_ID}
    client.patch_volume_usage_threshold.return_value = {"id": _VOLUME_ARM_ID}
    return client


class TestToolGating:
    def test_default_read_only(self):
        mod = _reload_server()
        assert "anf_resize_capacity_pool" not in mod.ALLOWED
        assert "anf_resize_volume" not in mod.ALLOWED
        assert "anf_volume_list" in mod.ALLOWED

    def test_write_tools_when_allowed(self):
        mod = _reload_server(
            allowed_tools="anf_resize_capacity_pool,anf_resize_volume,anf_volume_get"
        )
        assert "anf_resize_capacity_pool" in mod.ALLOWED
        assert "anf_resize_volume" in mod.ALLOWED

    def test_unknown_tool_names_ignored(self):
        mod = _reload_server(allowed_tools="anf_volume_list,not_a_real_tool")
        assert "anf_volume_list" in mod.ALLOWED
        assert "not_a_real_tool" not in mod.ALLOWED


class TestAuditRedaction:
    def test_redact_secrets(self):
        mod = _reload_server()
        redacted = mod._redact(
            {
                "pool_arm_id": "/subscriptions/x",
                "client_secret": "s3cret",
                "password": "p",
            }
        )
        assert redacted["client_secret"] == "***"
        assert redacted["password"] == "***"
        assert redacted["pool_arm_id"].startswith("/subscriptions")

    def test_audit_line_emitted_stdout(self, capsys):
        mod = _reload_server()
        mod._audit("anf_resize_volume", {"client_secret": "x"}, "started")
        captured = capsys.readouterr()
        line = captured.out.strip().splitlines()[-1]
        record = json.loads(line)
        assert record["audit"] is True
        assert record["tool"] == "anf_resize_volume"
        assert record["args"]["client_secret"] == "***"

    def test_audit_line_emitted_stderr(self, capsys):
        mod = _reload_server()
        with patch.dict(os.environ, {"ANF_MCP_AUDIT_DEST": "stderr"}, clear=False):
            mod._audit("anf_resize_volume", {"token": "x"}, "failed", error="boom")
        captured = capsys.readouterr()
        line = captured.err.strip().splitlines()[-1]
        record = json.loads(line)
        assert record["status"] == "failed"
        assert record["error"] == "boom"
        assert record["args"]["token"] == "***"


class TestBuildAnfClient:
    def test_missing_subscription_exits(self):
        mod = _reload_server()
        mod._CLIENT_CACHE = None
        env = {**_BASE_ENV, "AZURE_SUBSCRIPTION_ID": ""}
        with patch.dict(os.environ, env, clear=False):
            with pytest.raises(SystemExit, match="AZURE_SUBSCRIPTION_ID"):
                mod._build_anf_client()

    def test_missing_region_exits(self):
        mod = _reload_server()
        mod._CLIENT_CACHE = None
        env = {**_BASE_ENV, "AZURE_DEFAULT_REGION": ""}
        with patch.dict(os.environ, env, clear=False):
            with pytest.raises(SystemExit, match="AZURE_DEFAULT_REGION"):
                mod._build_anf_client()

    def test_client_cached(self):
        mod = _reload_server()
        mod._CLIENT_CACHE = None
        first = MagicMock()
        second = MagicMock()
        with patch.dict(os.environ, _BASE_ENV, clear=False):
            with patch.object(mod, "AnfClient", side_effect=[first, second]):
                assert mod._build_anf_client() is first
                assert mod._build_anf_client() is first
        mod._CLIENT_CACHE = None


class TestAnfErrorMapping:
    def test_maps_known_errors(self):
        mod = _reload_server()
        from anf_common import AnfAuthError, AnfError, AnfHTTPError, AnfValidationError

        auth = mod._anf_error(AnfAuthError("denied"))
        assert auth["error"]["code"] == "UNAUTHORIZED"
        val = mod._anf_error(AnfValidationError("bad"))
        assert val["error"]["code"] == "VALIDATION_ERROR"
        http = mod._anf_error(AnfHTTPError("fail"))
        assert http["error"]["code"] == "PROVIDER_ERROR"
        generic = mod._anf_error(AnfError("oops"))
        assert generic["error"]["code"] == "PROVIDER_ERROR"
        unknown = mod._anf_error(RuntimeError("x"))
        assert unknown["error"]["code"] == "PROVIDER_ERROR"


class TestToolHandlers:
    @pytest.fixture
    def mod(self):
        return _reload_server(allowed_tools=_ALL_TOOLS)

    def test_capacity_pool_list_ok(self, mod):
        client = _mock_client()
        with patch.object(mod, "_build_anf_client", return_value=client):
            result = mod.anf_capacity_pool_list()
        assert result["ok"] is True
        assert result["data"]["count"] == 1
        client.list_capacity_pools.assert_called_once_with(netapp_account=None)

    def test_capacity_pool_list_with_netapp_account_filter(self, mod):
        client = _mock_client()
        with patch.object(mod, "_build_anf_client", return_value=client):
            result = mod.anf_capacity_pool_list(netapp_account="acct1")
        assert result["ok"] is True
        client.list_capacity_pools.assert_called_once_with(netapp_account="acct1")

    def test_capacity_pool_get_ok(self, mod):
        client = _mock_client()
        with patch.object(mod, "_build_anf_client", return_value=client):
            result = mod.anf_capacity_pool_get(pool_arm_id=_POOL_ARM_ID)
        assert result["ok"] is True
        assert result["data"]["id"] == _POOL_ARM_ID
        client.get_capacity_pool.assert_called_once_with(
            _POOL_ARM_ID,
            netapp_account=None,
            pool_name=None,
        )

    def test_volume_list_ok(self, mod):
        client = _mock_client()
        with patch.object(mod, "_build_anf_client", return_value=client):
            result = mod.anf_volume_list()
        assert result["ok"] is True
        assert result["data"]["records"][0]["volume_name"] == "vol1"
        client.list_volumes.assert_called_once_with(netapp_account=None)

    def test_volume_get_ok(self, mod):
        client = _mock_client()
        with patch.object(mod, "_build_anf_client", return_value=client):
            result = mod.anf_volume_get(_VOLUME_ARM_ID)
        assert result["ok"] is True
        assert result["data"]["id"] == _VOLUME_ARM_ID

    def test_resize_capacity_pool_ok(self, mod, capsys):
        client = _mock_client()
        with patch.object(mod, "_build_anf_client", return_value=client):
            result = mod.anf_resize_capacity_pool(_POOL_ARM_ID, 2 * (1 << 40))
        assert result["ok"] is True
        client.patch_capacity_pool_size.assert_called_once()
        lines = [json.loads(l) for l in capsys.readouterr().out.strip().splitlines()]
        assert lines[-1]["status"] == "ok"
        assert lines[0]["status"] == "started"

    def test_resize_volume_ok(self, mod, capsys):
        client = _mock_client()
        with patch.object(mod, "_build_anf_client", return_value=client):
            result = mod.anf_resize_volume(_VOLUME_ARM_ID, 50 * (1 << 30))
        assert result["ok"] is True
        client.patch_volume_usage_threshold.assert_called_once()
        lines = [json.loads(l) for l in capsys.readouterr().out.strip().splitlines()]
        assert lines[-1]["status"] == "ok"

    def test_read_tool_error_mapping(self, mod):
        from anf_common import AnfAuthError

        with patch.object(
            mod, "_build_anf_client", side_effect=AnfAuthError("denied")
        ):
            result = mod.anf_volume_get(_VOLUME_ARM_ID)
        assert result["ok"] is False
        assert result["error"]["code"] == "UNAUTHORIZED"

    def test_list_tools_map_exceptions(self, mod):
        from anf_common import AnfHTTPError

        client = _mock_client()
        client.list_capacity_pools.side_effect = AnfHTTPError("fail")
        client.get_capacity_pool.side_effect = AnfHTTPError("fail")
        client.list_volumes.side_effect = AnfHTTPError("fail")
        with patch.object(mod, "_build_anf_client", return_value=client):
            assert mod.anf_capacity_pool_list()["ok"] is False
            assert mod.anf_capacity_pool_get(pool_arm_id=_POOL_ARM_ID)["ok"] is False
            assert mod.anf_volume_list()["ok"] is False

    def test_resize_capacity_pool_failure_audited(self, mod, capsys):
        from anf_common import AnfValidationError

        client = _mock_client()
        client.patch_capacity_pool_size.side_effect = AnfValidationError("too small")
        with patch.object(mod, "_build_anf_client", return_value=client):
            result = mod.anf_resize_capacity_pool(_POOL_ARM_ID, 100)
        assert result["ok"] is False
        lines = [json.loads(l) for l in capsys.readouterr().out.strip().splitlines()]
        assert lines[-1]["status"] == "failed"

    def test_resize_volume_failure_audited(self, mod, capsys):
        from anf_common import AnfValidationError

        client = _mock_client()
        client.patch_volume_usage_threshold.side_effect = AnfValidationError("bad size")
        with patch.object(mod, "_build_anf_client", return_value=client):
            result = mod.anf_resize_volume(_VOLUME_ARM_ID, 0)
        assert result["ok"] is False
        lines = [json.loads(l) for l in capsys.readouterr().out.strip().splitlines()]
        assert lines[-1]["status"] == "failed"
